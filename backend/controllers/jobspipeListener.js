/**
 * ── REAL-TIME JOB INGESTION (JobsPipe push webhook) ───────────────────
 *
 * A second door into the posting pool, running beside the scheduled discovery
 * cycle and changing nothing about it.
 *
 *   the cycle   PULLS. Wakes on a heartbeat, asks a search provider for pages
 *               of results, pays a credit per page, and finds jobs that were
 *               published some time in the last day.
 *   this        is PUSHED to. JobsPipe posts a job the moment it is published.
 *               No credit is spent, and the delay between publication and a
 *               consultant seeing it is seconds rather than hours.
 *
 * ── WHY THIS EXISTS AS A TRIAL ────────────────────────────────────────
 *
 * We are on the JobsPipe Free Tier, so the question is not "does the code
 * work" but "is this feed worth paying for". That question is answered by
 * numbers this module records for every single delivery: how many jobs arrive,
 * how many are new rather than jobs the cycle already found, how many survive
 * the pre-filter, how many reach a consultant, and how long we take to answer.
 * See `jobspipe_webhook_events` (migration 043) — the log IS the experiment.
 *
 * ── EVERYTHING DOWNSTREAM IS THE EXISTING PIPELINE ────────────────────
 *
 * Once normalised, a pushed job is treated exactly like one the cycle found:
 *
 *   fingerprintPosting()   R-15 company+title+location de-duplication, so a
 *   / upsertPosting()      job pushed here and later found by the cycle lands
 *                          on ONE row, and nobody applies to it twice.
 *   evaluate()             the same hard filter → cheap pre-filter (R-16) →
 *                          score, with the same MATCH_THRESHOLD.
 *   promoteToReady()       the same gate into the AI preparation stage, which
 *                          enqueues a background job for the worker.
 *
 * None of that is reimplemented here. A parallel path with its own copy of the
 * de-duplication rule would be two rules pretending to be one, and the copy
 * would drift — at which point the same job reaches a consultant twice, which
 * is the exact failure R-15 exists to prevent.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────
 *
 * · It never writes a `discovery_runs` row. `uq_one_running_discovery` permits
 *   exactly one open run per organisation, so a webhook that opened a run
 *   would race the scheduler and could block the cycle from starting. Matches
 *   and queue items created here carry `run_id = NULL`, which is already the
 *   nullable column's meaning: this did not come from a run.
 * · It never calls a model. `promoteToReady()` enqueues; the worker spends the
 *   money, off the request path, exactly as the cycle arranges it.
 * · It never touches the scheduler, the SerpAPI connector, or any source row
 *   other than its own.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { laneFor } from '../config/queueLanes.js';
import { evaluate } from '../config/jobMatcher.js';
import { jobspipeToPosting, unwrapBatch, SOURCE_NAME } from '../connectors/jobspipe.js';
import {
    promoteToReady, loadMatchableConsultants, upsertPosting,
} from './discoveryController.js';
import { hashToken, newToken } from '../middleware/verifyDevice.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { logAction } from './auditLogController.js';

/**
 * How much of a delivery we keep.
 *
 * The same reasoning as `job_source_payloads.body`: enough to re-parse a
 * delivery after fixing the adapter, not enough to turn our database into a
 * mirror of JobsPipe. A job description is a few kilobytes; anything much
 * larger than this is a batch, and the per-job rows already record the parts
 * that matter.
 */
const PAYLOAD_KEEP_BYTES = 20_000;

/**
 * A ceiling on one delivery, so a sender that starts batching under load
 * cannot hold a request open long enough for its own timeout to fire and
 * deliver everything a second time.
 */
const MAX_JOBS_PER_DELIVERY = 25;

/* ── the shared secret ────────────────────────────────────────────────── */

/**
 * Read the presented secret out of the request.
 *
 * Three spellings accepted because push senders differ and the one thing that
 * must not happen during a trial is a whole day of deliveries silently
 * rejected over a header name.
 *
 * NOTE ON SIGNATURES. A shared bearer secret is weaker than an HMAC over the
 * body: it proves the sender knows the secret, not that this particular body
 * came from them unmodified. HMAC is the right answer and the hook belongs
 * here — it is not implemented because JobsPipe's signing scheme has not been
 * confirmed, and a signature check written against a guessed scheme rejects
 * every real delivery. Until then the endpoint should be behind TLS, which is
 * what makes a bearer secret acceptable in the first place.
 */
const presentedToken = (req) => {
    const header = req.get('x-jobspipe-token')
        ?? req.get('x-webhook-token')
        ?? null;
    if (header) return header.trim();

    const auth = req.get('authorization');
    if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();

    return null;
};

/** The endpoint row this secret belongs to, or null. Hash lookup, never plaintext. */
const resolveEndpoint = async (token) => {
    if (!token) return null;
    const { rows } = await query(
        `SELECT e.id, e.organization_id, e.is_enabled, o.is_active AS org_active, o.name AS org_name
           FROM jobspipe_endpoints e
           JOIN organizations o ON o.id = e.organization_id
          WHERE e.token_hash = $1`,
        [hashToken(token)],
    );
    return rows[0] ?? null;
};

/* ── the event log ────────────────────────────────────────────────────── */

/**
 * One row per delivery, including the ones we refused.
 *
 * Never throws. A logging failure must not turn a delivery we successfully
 * processed into a 500 the sender will retry — that would duplicate work to
 * record that work happened.
 */
const logEvent = async (row) => {
    try {
        await query(
            `INSERT INTO jobspipe_webhook_events
                (id, organization_id, outcome, posting_id, company, title, location_text,
                 is_new_posting, consultants_considered, prefiltered_out, matches_created,
                 queued_count, preparation_enqueued, duration_ms, detail,
                 raw_payload, payload_bytes, delivery_id, remote_ip)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [uuidv4(), row.orgId ?? null, row.outcome, row.postingId ?? null,
                row.company ?? null, row.title ?? null, row.locationText ?? null,
                row.isNew ?? false, row.considered ?? 0, row.prefilteredOut ?? 0,
                row.matches ?? 0, row.queued ?? 0, row.prepared ?? 0,
                row.durationMs ?? null, row.detail?.slice(0, 500) ?? null,
                row.rawPayload ?? null, row.payloadBytes ?? null,
                row.deliveryId?.slice(0, 120) ?? null, row.remoteIp?.slice(0, 64) ?? null],
        );
    } catch (err) {
        console.error('[jobspipe] could not write the event log:', err.message);
    }
};

/** Running health on the endpoint row, so the screen can show it without a scan. */
const touchEndpoint = async (endpointId, { rejected = false, error = null } = {}) => {
    try {
        await query(
            `UPDATE jobspipe_endpoints
                SET last_event_at   = now(),
                    events_received = events_received + 1,
                    events_rejected = events_rejected + $2,
                    last_error      = $3
              WHERE id = $1`,
            [endpointId, rejected ? 1 : 0, error?.slice(0, 500) ?? null],
        );
    } catch (err) {
        console.error('[jobspipe] could not update endpoint health:', err.message);
    }
};

/* ── the pipeline ─────────────────────────────────────────────────────── */

/** The lookup ids one ingest needs. Four small tables; read per delivery. */
const loadLookups = async () => {
    const [src, wt, pt, qs] = await Promise.all([
        query('SELECT id, is_enabled FROM lkp_job_sources WHERE name = $1', [SOURCE_NAME]),
        query('SELECT id, name FROM lkp_work_types'),
        query('SELECT id, name FROM lkp_portal_types'),
        query('SELECT id, name FROM lkp_queue_statuses'),
    ]);
    return {
        source: src.rows[0] ?? null,
        workType: Object.fromEntries(wt.rows.map((r) => [r.name, r.id])),
        portalType: Object.fromEntries(pt.rows.map((r) => [r.name, r.id])),
        queueStatus: Object.fromEntries(qs.rows.map((r) => [r.name, r.id])),
    };
};

/**
 * One pushed job, all the way through.
 *
 * Exported so the test-delivery button and the unit suite drive the SAME code
 * path a real delivery takes. A "test" that exercised a separate function
 * would prove only that the separate function works.
 *
 * @returns {{ outcome, postingId, isNew, considered, prefilteredOut, matches,
 *             queued, prepared, company, title, locationText, detail }}
 */
export const ingestJob = async (orgId, rawJob, opts = {}) => {
    const adapted = jobspipeToPosting(rawJob);
    if (!adapted) {
        return {
            outcome: 'INVALID',
            detail: 'Payload has no company, title or usable apply URL — the three '
                + 'fields a posting cannot be de-duplicated or opened without.',
        };
    }

    return ingestAdapted(orgId, adapted, opts);
};

/**
 * The pipeline, from an ALREADY-ADAPTED posting onwards.
 *
 * ── WHY THIS IS SPLIT OUT ─────────────────────────────────────────────
 *
 * There are now two JobsPipe doors, and they receive different shapes:
 *
 *   the webhook       a pushed envelope, normalised by connectors/jobspipe.js
 *   the search API    a flat search result, normalised by
 *                     connectors/jobspipeSearch.js — see jobs/jobspipePoller.js
 *
 * Only the NORMALISER differs. Everything after it — the R-15 fingerprint, the
 * pre-filter, the match, the queue item, the preparation gate — must be one
 * implementation, or the two doors de-duplicate separately and the same job
 * reaches a consultant twice. That is the exact failure R-15 exists to
 * prevent, and it is why this body is shared rather than copied.
 *
 * @param {object} adapted  { posting, portalType, originBoard } from either
 *                          adapter. Both return the identical shape, which is
 *                          what makes this possible.
 */
export const ingestAdapted = async (orgId, adapted, {
    lookups = null, consultants = null,
    // Which door this came through, for the transition log. A queue item that
    // says "pushed" when it was polled sends whoever reads it looking for a
    // webhook delivery that never happened.
    via = 'Pushed by JobsPipe',
} = {}) => {
    const { posting, portalType, originBoard } = adapted;
    const look = lookups ?? await loadLookups();

    if (!look.source) {
        return {
            outcome: 'ERROR',
            company: posting.company,
            title: posting.title,
            detail: `No '${SOURCE_NAME}' row in lkp_job_sources — run the migrations.`,
        };
    }

    /* ── store, or record a repeat sighting ───────────────────────── */
    //
    // upsertPosting is the discovery cycle's own function, imported rather than
    // copied. It fingerprints on company+title+location (R-15), inserts a new
    // row or bumps last_seen/times_seen on the existing one, and writes a
    // sighting either way. run_id is null: this is not a run.
    const stored = await withTransaction(async (client) => upsertPosting(client, {
        orgId,
        sourceId: look.source.id,
        runId: null,
        posting,
        workTypeId: posting.workType ? (look.workType[posting.workType] ?? null) : null,
        portalTypeId: look.portalType[portalType] ?? null,
        // The board the job was actually listed on. JobsPipe's nine boards all
        // share one source row (so the webhook and the poller de-duplicate
        // against each other), which means this is the ONLY place the board
        // survives — see migration 046. It used to reach nothing but a queue
        // transition's free text, so a posting that suited nobody lost it.
        originBoard,
    }));

    const result = {
        postingId: stored.id,
        isNew: stored.isNew,
        company: posting.company,
        title: posting.title,
        locationText: posting.locationText,
        considered: 0,
        prefilteredOut: 0,
        matches: 0,
        queued: 0,
        prepared: 0,
    };

    /* ── match against the bench ──────────────────────────────────── */
    //
    // Matching runs even on a repeat sighting. The cycle does the same, and for
    // the same reason: a posting already in the pool is still worth offering to
    // a consultant whose criteria changed this morning.
    const bench = consultants ?? await loadMatchableConsultants(orgId);
    const workTypeName = posting.workType ?? null;

    for (const consultant of bench) {
        result.considered += 1;

        const verdict = evaluate(posting, consultant.criteria, { workTypeName });
        // 'hard' and 'prefilter' are both cheap rejections — the stages that
        // exist precisely so nothing expensive runs on a job nobody wants.
        if (verdict.stage !== 'score') result.prefilteredOut += 1;
        if (!verdict.matched) continue;

        // ON CONFLICT: a consultant is matched to a posting once, ever. A feed
        // that redelivers the same job — and a free tier will — must not
        // multiply matches.
        const matchId = uuidv4();
        const { rowCount } = await query(
            `INSERT INTO job_matches
                (id, organization_id, consultant_id, posting_id,
                 criteria_version_id, score, reason, status, run_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',NULL)
             ON CONFLICT (consultant_id, posting_id) DO NOTHING`,
            [matchId, orgId, consultant.id, stored.id, consultant.versionId,
                verdict.score, `${verdict.reason} [via JobsPipe]`],
        );
        if (rowCount === 0) continue;   // already matched on an earlier delivery
        result.matches += 1;

        /* ── the queue item ───────────────────────────────────────── */
        //
        // No cap is applied here, matching the cycle exactly: a slot is spent
        // when an item becomes genuinely available, which is promoteToReady().
        const { rows: portal } = await query(
            `SELECT COALESCE(pt.is_automatable, FALSE) AS automatable
               FROM job_postings p
          LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
              WHERE p.id = $1`,
            [stored.id],
        );
        // BOT, AGENT or HUMAN — one rule for every door a job comes in by.
        const channel = await laneFor(orgId, portal[0]?.automatable);

        // R-01 / R-03: the same posting legitimately reaches several
        // consultants. Flagged for visibility, never blocked.
        const { rows: others } = await query(
            'SELECT 1 FROM queue_items WHERE posting_id = $1 AND consultant_id <> $2 LIMIT 1',
            [stored.id, consultant.id],
        );
        const isOverlap = others.length > 0;

        const inserted = await query(
            `INSERT INTO queue_items
                (id, organization_id, consultant_id, posting_id, match_id,
                 status_id, is_overlap, run_id, channel)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)
             ON CONFLICT (consultant_id, posting_id) DO NOTHING
             RETURNING id`,
            [uuidv4(), orgId, consultant.id, stored.id, matchId,
                look.queueStatus.QUEUED, isOverlap, channel],
        );

        if (inserted.rowCount > 0) {
            await query(
                `INSERT INTO queue_item_transitions
                    (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                 VALUES ($1,$2,$3,NULL,$4,$5)`,
                [uuidv4(), orgId, inserted.rows[0].id, look.queueStatus.QUEUED,
                    `${via}${originBoard ? ` (via ${originBoard})` : ''} `
                    + `— score ${verdict.score}, ${channel} lane`],
            );
            result.queued += 1;

            if (isOverlap) {
                await query(
                    'UPDATE queue_items SET is_overlap = TRUE WHERE posting_id = $1',
                    [stored.id],
                );
            }
        }
        await query("UPDATE job_matches SET status = 'QUEUED' WHERE id = $1", [matchId]);
    }

    /* ── hand it to the AI preparation stage ──────────────────────── */
    //
    // promoteToReady() is the cycle's own gate and is called unchanged. It
    // moves QUEUED → PREPARING and enqueues one background job per item; the
    // worker parses the resume, tailors it against this job description,
    // checks the result for fabrication and renders the PDF. Every paid model
    // call happens there, not on this request.
    //
    // Called only when this delivery actually queued something. It promotes the
    // organisation's whole backlog, not just our item — which is correct, and
    // is also why it is not run on a delivery that queued nothing: a webhook
    // must answer quickly, and doing the tenant's housekeeping on a job that
    // suited nobody is latency spent for no reason.
    if (result.queued > 0) {
        const { promoted } = await promoteToReady(orgId);
        result.prepared = promoted;
    }

    result.outcome = result.queued > 0
        ? 'QUEUED'
        : (result.isNew ? 'FILTERED' : 'DUPLICATE');

    return result;
};

/* ── the public endpoint ──────────────────────────────────────────────── */

/**
 * POST /api/webhooks/jobspipe
 *
 * Public and unauthenticated in the session sense: JobsPipe has no cookie and
 * no user. The shared secret in the header IS the identity, and it answers
 * both questions at once — may this caller in, and whose pool is this job for.
 * Resolving the tenant from the secret rather than from a field in the body is
 * what stops one agency's feed writing into another's pool.
 *
 * ── STATUS CODES ARE CHOSEN FOR THE SENDER'S RETRY LOGIC ──────────────
 *
 *   200  we processed it. INCLUDING when the job suited nobody or we already
 *        had it — those are correct outcomes, not failures, and answering
 *        anything else would make the sender redeliver a job we deliberately
 *        dropped, forever.
 *   400  the body is not a job. Retrying will not change that.
 *   401  the secret is wrong or missing.
 *   403  the secret is right but this tenant has the endpoint switched off.
 *   500  we broke. This one SHOULD be retried, which is why nothing above
 *        borrows it.
 */
export const receiveWebhook = async (req, res) => {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / 1_000n) / 1000;

    const remoteIp = req.ip ?? null;
    const deliveryId = req.get('x-jobspipe-delivery')
        ?? req.get('x-delivery-id')
        ?? req.body?.delivery_id
        ?? req.body?.id
        ?? null;

    // Serialised once, up front: this must survive a parser failure, since the
    // delivery that breaks the adapter is the one whose body we most need.
    let rawPayload = null;
    let payloadBytes = null;
    try {
        const json = JSON.stringify(req.body ?? null);
        payloadBytes = Buffer.byteLength(json ?? '', 'utf8');
        rawPayload = json?.slice(0, PAYLOAD_KEEP_BYTES) ?? null;
    } catch {
        rawPayload = '[unserialisable body]';
    }

    const base = { rawPayload, payloadBytes, deliveryId, remoteIp };

    try {
        /* ── who is this ──────────────────────────────────────────── */
        const endpoint = await resolveEndpoint(presentedToken(req));

        if (!endpoint || !endpoint.org_active) {
            // One message for every rejection reason. Distinguishing "no such
            // secret" from "wrong tenant" would let someone probe for valid
            // secrets against a public endpoint.
            await logEvent({
                ...base,
                outcome: 'UNAUTHORISED',
                durationMs: Math.round(elapsedMs()),
                detail: 'No endpoint matched the presented secret.',
            });
            console.warn(`[jobspipe] rejected delivery from ${remoteIp}: bad or missing secret`);
            return res.status(401).json({ error: 'Unauthorised.' });
        }

        if (!endpoint.is_enabled) {
            await touchEndpoint(endpoint.id, {
                rejected: true, error: 'Delivery refused — the endpoint is switched off.',
            });
            await logEvent({
                ...base,
                orgId: endpoint.organization_id,
                outcome: 'DISABLED',
                durationMs: Math.round(elapsedMs()),
                detail: 'The endpoint is switched off for this organisation.',
            });
            return res.status(403).json({ error: 'This endpoint is switched off.' });
        }

        const orgId = endpoint.organization_id;

        // Raw body first, before anything can reject it. During a trial the
        // deliveries that teach you something are the ones that fail.
        console.log(
            `[jobspipe] ← delivery${deliveryId ? ` ${deliveryId}` : ''} `
            + `for ${endpoint.org_name} (${payloadBytes} bytes) from ${remoteIp}\n`
            + `[jobspipe]   payload: ${rawPayload}`,
        );

        /* ── one job, or a batch ──────────────────────────────────── */
        const batch = unwrapBatch(req.body);
        const jobs = batch ?? [req.body];

        if (jobs.length === 0) {
            await touchEndpoint(endpoint.id, { rejected: true, error: 'Empty delivery.' });
            await logEvent({
                ...base,
                orgId,
                outcome: 'INVALID',
                durationMs: Math.round(elapsedMs()),
                detail: 'Delivery contained no jobs.',
            });
            return res.status(400).json({ error: 'No job in this delivery.' });
        }

        const accepted = jobs.slice(0, MAX_JOBS_PER_DELIVERY);
        const overflow = jobs.length - accepted.length;

        // Loaded once for the whole delivery rather than per job: the bench and
        // the lookup tables cannot change inside one request, and re-reading
        // them per job is what turns a batch of 25 into a slow request.
        const lookups = await loadLookups();
        const consultants = await loadMatchableConsultants(orgId);

        const results = [];
        for (const job of accepted) {
            const perJob = process.hrtime.bigint();
            let outcome;
            try {
                outcome = await ingestJob(orgId, job, { lookups, consultants });
            } catch (err) {
                // One bad job in a batch must not discard the rest.
                console.error('[jobspipe] job failed:', err.message);
                outcome = { outcome: 'ERROR', detail: err.message };
            }
            const jobMs = Number((process.hrtime.bigint() - perJob) / 1_000n) / 1000;

            results.push(outcome);
            await logEvent({
                ...base,
                orgId,
                outcome: outcome.outcome,
                postingId: outcome.postingId,
                company: outcome.company,
                title: outcome.title,
                locationText: outcome.locationText,
                isNew: outcome.isNew,
                considered: outcome.considered,
                prefilteredOut: outcome.prefilteredOut,
                matches: outcome.matches,
                queued: outcome.queued,
                prepared: outcome.prepared,
                durationMs: Math.round(jobMs),
                detail: outcome.detail,
                // Only the first row of a batch keeps the body. Twenty-five
                // copies of the same delivery is storage spent to say one thing.
                rawPayload: results.length === 1 ? rawPayload : null,
            });

            console.log(
                `[jobspipe]   → ${outcome.outcome}`
                + (outcome.title ? ` "${outcome.title}" @ ${outcome.company}` : '')
                + ` — ${outcome.considered ?? 0} consultant(s) considered, `
                + `${outcome.prefilteredOut ?? 0} pre-filtered out, `
                + `${outcome.matches ?? 0} matched, ${outcome.queued ?? 0} queued, `
                + `${outcome.prepared ?? 0} sent to preparation `
                + `(${jobMs.toFixed(1)}ms)`,
            );
        }

        const failed = results.filter((r) => r.outcome === 'ERROR' || r.outcome === 'INVALID');
        await touchEndpoint(endpoint.id, {
            rejected: failed.length > 0,
            error: failed[0]?.detail ?? null,
        });

        const totals = results.reduce((acc, r) => ({
            queued: acc.queued + (r.queued ?? 0),
            matched: acc.matched + (r.matches ?? 0),
            newPostings: acc.newPostings + (r.isNew ? 1 : 0),
        }), { queued: 0, matched: 0, newPostings: 0 });

        const totalMs = Math.round(elapsedMs());
        console.log(
            `[jobspipe] ✓ delivery handled in ${totalMs}ms — ${accepted.length} job(s), `
            + `${totals.newPostings} new, ${totals.matched} matched, ${totals.queued} queued`,
        );

        // Every job invalid is a body we could not use, so the delivery failed
        // even though the request was authorised.
        if (results.every((r) => r.outcome === 'INVALID')) {
            return res.status(400).json({
                error: 'No usable job in this delivery.',
                detail: results[0]?.detail,
                durationMs: totalMs,
            });
        }

        return res.status(200).json({
            received: jobs.length,
            processed: accepted.length,
            skipped: overflow,
            newPostings: totals.newPostings,
            matched: totals.matched,
            queued: totals.queued,
            durationMs: totalMs,
            outcomes: results.map((r) => r.outcome),
        });
    } catch (err) {
        // 500 is the ONLY code the sender should retry, so it is reserved for
        // our own faults and never borrowed for a rejected or unusable body.
        console.error('[jobspipe] delivery failed:', err.stack ?? err.message);
        await logEvent({
            ...base,
            outcome: 'ERROR',
            durationMs: Math.round(elapsedMs()),
            detail: err.message,
        });
        return res.status(500).json({ error: 'Could not process this delivery.' });
    }
};

/* ── the operator surface ─────────────────────────────────────────────── */

/**
 * GET /api/management/jobspipe — the endpoint, its health, and the funnel.
 *
 * The secret is NOT in this response. Revealing it is a separate, audited
 * request, so merely opening the screen does not put a live credential into a
 * browser cache or a screenshot.
 */
export const getSettings = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;

        const [endpoint, source, funnel] = await Promise.all([
            query(
                `SELECT id, is_enabled, last_event_at, last_error, events_received,
                        events_rejected, rotated_at, created_at,
                        (token_enc IS NOT NULL) AS can_reveal
                   FROM jobspipe_endpoints WHERE organization_id = $1`,
                [orgId],
            ),
            query('SELECT id, label, is_enabled FROM lkp_job_sources WHERE name = $1', [SOURCE_NAME]),
            query(
                `SELECT outcome, COUNT(*)::int AS count,
                        COALESCE(SUM(queued_count), 0)::int AS queued,
                        COALESCE(ROUND(AVG(duration_ms)), 0)::int AS avg_ms
                   FROM jobspipe_webhook_events
                  WHERE organization_id = $1
                    AND received_at > now() - INTERVAL '30 days'
                  GROUP BY outcome`,
                [orgId],
            ),
        ]);

        res.json({
            endpoint: endpoint.rows[0] ?? null,
            source: source.rows[0] ?? null,
            // The URL an operator pastes into JobsPipe. Built from the request
            // so it is correct behind a proxy and in every environment, rather
            // than a string somebody has to remember to update.
            webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/jobspipe`,
            funnel: funnel.rows,
        });
    } catch (err) { next(err); }
};

/**
 * POST /api/management/jobspipe/token — issue or rotate the shared secret.
 *
 * The new secret is returned ONCE in this response and never again in this
 * form; afterwards it comes back through the reveal route, which is audited.
 * Rotating breaks the live integration until the new secret is pasted into
 * JobsPipe, which is why the screen says so before the button is pressed.
 */
export const rotateToken = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const token = newToken();
        const sealed = encryptPassword(token);

        // The hash is what a delivery is verified against. The ciphertext beside
        // it exists only so an admin can read the secret back, and never
        // authenticates anything — migration 034's arrangement, for its reasons.
        await query(
            `INSERT INTO jobspipe_endpoints
                (id, organization_id, token_hash, token_enc, token_iv, token_tag, rotated_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())
             ON CONFLICT (organization_id) DO UPDATE
                SET token_hash = EXCLUDED.token_hash,
                    token_enc  = EXCLUDED.token_enc,
                    token_iv   = EXCLUDED.token_iv,
                    token_tag  = EXCLUDED.token_tag,
                    rotated_at = now(),
                    last_error = NULL`,
            [uuidv4(), orgId, hashToken(token), sealed.enc, sealed.iv, sealed.tag],
        );

        logAction({
            orgId,
            module: 'discovery',
            action: 'Rotated JobsPipe webhook secret',
            entityType: 'JobsPipeEndpoint',
            entityId: orgId,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: 'Any delivery using the previous secret is now refused.',
            ipAddress: req.ip,
        });

        res.json({ token });
    } catch (err) { next(err); }
};

/** GET /api/management/jobspipe/token — read the secret back. Audited. */
export const revealToken = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT token_enc, token_iv, token_tag FROM jobspipe_endpoints
              WHERE organization_id = $1`,
            [req.user.orgId],
        );
        const row = rows[0];
        if (!row?.token_enc) {
            return res.status(404).json({
                error: 'No secret has been issued yet. Generate one first.',
            });
        }

        logAction({
            orgId: req.user.orgId,
            module: 'discovery',
            action: 'Revealed JobsPipe webhook secret',
            entityType: 'JobsPipeEndpoint',
            entityId: req.user.orgId,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            ipAddress: req.ip,
        });

        res.json({
            token: decryptPassword({ enc: row.token_enc, iv: row.token_iv, tag: row.token_tag }),
        });
    } catch (err) { next(err); }
};

export const enabledSchema = Joi.object({
    isEnabled: Joi.boolean().required(),
});

/** PATCH /api/management/jobspipe — switch the endpoint on or off. */
export const setEnabled = async (req, res, next) => {
    try {
        const { rowCount } = await query(
            'UPDATE jobspipe_endpoints SET is_enabled = $2 WHERE organization_id = $1',
            [req.user.orgId, req.body.isEnabled],
        );
        if (rowCount === 0) {
            return res.status(404).json({
                error: 'Generate a webhook secret before switching the endpoint on.',
            });
        }

        logAction({
            orgId: req.user.orgId,
            module: 'discovery',
            action: req.body.isEnabled ? 'Enabled JobsPipe webhook' : 'Disabled JobsPipe webhook',
            entityType: 'JobsPipeEndpoint',
            entityId: req.user.orgId,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            ipAddress: req.ip,
        });

        res.json({ isEnabled: req.body.isEnabled });
    } catch (err) { next(err); }
};

/**
 * GET /api/management/jobspipe/events — the trial's raw evidence.
 *
 * Newest first, and the raw payload comes with it. Reading what actually
 * arrived is the whole reason the log exists; hiding it behind a second
 * request would mean nobody looks.
 */
export const listEvents = async (req, res, next) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const { rows } = await query(
            `SELECT id, received_at, outcome, company, title, location_text,
                    is_new_posting, consultants_considered, prefiltered_out,
                    matches_created, queued_count, preparation_enqueued,
                    duration_ms, detail, raw_payload, payload_bytes, delivery_id
               FROM jobspipe_webhook_events
              WHERE organization_id = $1
              ORDER BY received_at DESC
              LIMIT $2`,
            [req.user.orgId, limit],
        );
        res.json({ events: rows });
    } catch (err) { next(err); }
};

/**
 * POST /api/management/jobspipe/test — push a sample job at ourselves.
 *
 * ── WHY THIS IS NOT A MOCK ────────────────────────────────────────────
 *
 * It calls `ingestJob` — the same function a real delivery calls, with a body
 * shaped the way JobsPipe shapes one. So pressing it proves the parts that
 * actually break: that the adapter maps the fields, that the fingerprint
 * de-duplicates, that the pre-filter runs, that a match becomes a queue item,
 * and that preparation is enqueued. The only thing it does not exercise is the
 * secret check and the HTTP layer, which is what curl is for.
 *
 * It is logged like any other event, with a delivery id that says it was
 * synthetic — a trial's numbers are worthless if test traffic is
 * indistinguishable from the feed.
 */
export const sendTestEvent = async (req, res, next) => {
    const startedAt = Date.now();
    try {
        const orgId = req.user.orgId;

        /* ── pick a title somebody can actually receive ──────────────── */
        //
        // Taken from the SAME bench ingestJob will match against, not from a
        // second query over search_criteria. Those two sets are not the same:
        // search_criteria holds rows for consultants who are paused,
        // terminated or have no profile, and loadMatchableConsultants excludes
        // every one of them. Picking from the wider set produced test jobs
        // titled for somebody who cannot receive work, which always came back
        // "Suited nobody" and read as a broken feed rather than a bad sample.
        //
        // The tie-break is load-bearing too. Titles are counted across the
        // bench and a small bench ties at one apiece, so
        // `ORDER BY COUNT(*) DESC` alone let Postgres return any of them — the
        // button generated a different job each press with no way to tell why.
        // Sorting the tie alphabetically makes a press reproducible.
        const bench = await loadMatchableConsultants(orgId);

        const demand = new Map();
        for (const consultant of bench) {
            for (const jobTitle of consultant.criteria.jobTitles ?? []) {
                demand.set(jobTitle, (demand.get(jobTitle) ?? 0) + 1);
            }
        }
        const ranked = [...demand.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

        const title = req.body?.title || ranked[0]?.[0] || 'Senior Software Engineer';

        /* ── make each press a genuinely new posting ─────────────────── */
        //
        // The fingerprint is company + title + location, and all three used to
        // be constant — so the first press created a posting and every press
        // after it collapsed onto that same row by R-15, reporting "Already
        // had it, 0 queued". Correct de-duplication, useless as a smoke test:
        // the one press that proves the path works is the one you cannot
        // repeat.
        //
        // A short marker on the company makes each press its own posting, so
        // the whole path runs every time. It is on the COMPANY rather than the
        // title because the title has to stay exactly what a consultant asked
        // for or the matcher drops it, which is the thing being tested.
        const marker = uuidv4().slice(0, 6);
        const company = req.body?.company || `JobsPipe Test Employer ${marker}`;

        const sample = {
            event: 'job.created',
            delivery_id: `test_${Date.now()}`,
            job: {
                id: `jp_test_${marker}`,
                title,
                company: { name: company },
                location: { city: 'Austin', region: 'TX', remote: true },
                employment_type: 'contract',
                description_html:
                    `<p>This is a synthetic ${title} posting generated from the JobsPipe `
                    + 'screen to exercise the ingestion path end to end.</p>'
                    + '<ul><li>React, TypeScript, Node.js</li>'
                    + '<li>Remote, contract, W2 or C2C</li></ul>',
                apply_url: `https://boards.greenhouse.io/jobspipe-test/jobs/${Date.now()}`,
                salary: { min: 65, max: 85, currency: 'USD', interval: 'hourly' },
                published_at: new Date().toISOString(),
                source: 'jobspipe-test',
            },
        };

        // The bench is handed over rather than re-loaded, so the consultant the
        // title was chosen for is provably the consultant it is matched against.
        const result = await ingestJob(orgId, sample, { consultants: bench });
        const durationMs = Date.now() - startedAt;

        await logEvent({
            orgId,
            outcome: result.outcome,
            postingId: result.postingId,
            company: result.company,
            title: result.title,
            locationText: result.locationText,
            isNew: result.isNew,
            considered: result.considered,
            prefilteredOut: result.prefilteredOut,
            matches: result.matches,
            queued: result.queued,
            prepared: result.prepared,
            durationMs,
            detail: `Test delivery sent by ${req.user.id}. ${result.detail ?? ''}`.trim(),
            rawPayload: JSON.stringify(sample),
            payloadBytes: Buffer.byteLength(JSON.stringify(sample), 'utf8'),
            deliveryId: sample.delivery_id,
            remoteIp: req.ip,
        });

        // benchSize and the chosen title travel with the result so the screen
        // can tell the two quiet outcomes apart. "Suited nobody" on a bench of
        // four is a pre-filter verdict; the same words on a bench of zero mean
        // there was nobody to suit, and only one of those is worth acting on.
        res.json({
            result: {
                ...result, durationMs, title, benchSize: bench.length,
            },
            payload: sample,
        });
    } catch (err) { next(err); }
};
