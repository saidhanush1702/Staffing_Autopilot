/**
 * ── THE DISCOVERY CYCLE ───────────────────────────────────────────────
 *
 * Runs every 4 hours, or on demand. One pass:
 *
 *   for each search term derived from the bench
 *       ask the provider → adapt → store the raw response
 *   for each posting
 *       fingerprint → new, or a repeat sighting of one already known
 *   for each ACTIVE consultant with ACTIVE criteria
 *       hard filter → pre-filter (R-16) → score → match
 *   for each consultant
 *       fill the queue up to their daily cap; HOLD the surplus (R-17)
 *
 * ── ACQUISITION (PHASE 5 v2) ──────────────────────────────────────────
 *
 * Postings come from Google Jobs through a paid SERP API, not from crawling
 * job boards. v1 crawled five boards directly; four refused every HTTP client
 * and always would — LinkedIn at robots.txt, Wellfound and TheLadders behind
 * Cloudflare. Google already indexes all of them and says which board listed
 * each posting, so the boards live on as attribution rather than as targets.
 *
 * EVERYTHING THE PROVIDER RETURNS IS KEPT. The five named boards are the
 * priority set, not an allowlist: a good role from Indeed, a Greenhouse board
 * or an employer's own careers page is a real lead. Per-board switches exist
 * for the operator who wants them, and default to on.
 *
 * ── THE RULES THAT SHAPE IT ───────────────────────────────────────────
 *
 * · A provider failure never aborts the run. It is recorded, and the matching
 *   half still runs over postings already in the pool (spec feature 14).
 * · Two runs never overlap — `uq_one_running_discovery` makes a concurrent
 *   start impossible at the database rather than merely unlikely.
 * · Caps stop ASSIGNMENT, not discovery. A match over the cap is HELD and
 *   reconsidered next run rather than discarded (R-17).
 * · Overlap across consultants is expected, flagged, and never blocked
 *   (R-01, R-03).
 * · Every API call is one paid credit, so the run is bounded twice: pages per
 *   term, and a hard ceiling on calls for the whole run.
 *
 * Scope: this phase stops at finding and matching. Nothing here fills or
 * submits anything.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { fingerprintPosting } from '../config/fingerprint.js';
import { evaluate } from '../config/jobMatcher.js';
import { createSession, isConfigured, providerConfig } from '../connectors/serpapi.js';
import { jobResultToPosting } from '../connectors/googleJobs.js';
import {
    CYCLE_HOURS, RUNS_PER_DAY, schedulerTimezone, isSchedulerAvailable, nextRunAfter,
} from '../config/discoverySchedule.js';
import { logAction } from './auditLogController.js';

/** Keep only enough of a payload to diagnose an adapter later. */
const PAYLOAD_KEEP_BYTES = 200_000;

/* ── loading what a run needs ─────────────────────────────────────────── */

/**
 * Every source row, split by what it is for.
 *
 * `provider` is the only row that is fetched. `portals` are attribution plus an
 * on/off switch. `byName` resolves what the adapter detected back to a row.
 */
const loadSources = async () => {
    const { rows } = await query(
        `SELECT id, name, label, fetch_mode, is_enabled, is_priority,
                rate_limit_ms, max_pages, consecutive_failures
           FROM lkp_job_sources
          ORDER BY id`,
    );
    return {
        provider: rows.find((r) => r.fetch_mode === 'PROVIDER') ?? null,
        byName: new Map(rows.map((r) => [r.name, r])),
    };
};

/**
 * Every consultant the engine should consider this run, with their live
 * criteria flattened into the shape the matcher wants.
 *
 * The WHERE clause is the whole of R-17's and Phase 3's preconditions in one
 * place: active employment, active criteria, and a version actually saved.
 * A consultant who is paused, terminated or never set up is simply absent —
 * matching them and filtering later would be an easy way to leak a job to
 * somebody who should not receive one.
 */
const loadMatchableConsultants = async (orgId) => {
    const { rows } = await query(
        `SELECT u.id, u.name,
                sc.current_version_id AS version_id,
                p.daily_cap
           FROM users u
           JOIN search_criteria sc ON sc.consultant_id = u.id
           JOIN consultant_profiles p ON p.user_id = u.id
          WHERE u.organization_id = $1
            AND u.role = 'CONSULTANT'
            AND u.employment_status = 'ACTIVE'
            AND sc.is_active
            AND sc.current_version_id IS NOT NULL
            AND NOT p.is_paused`,
        [orgId],
    );

    const out = [];
    for (const row of rows) {
        const [terms, locations, workTypes, head] = await Promise.all([
            query('SELECT kind, value FROM search_criteria_terms WHERE version_id = $1 ORDER BY position',
                [row.version_id]),
            query(`SELECT city, state, work_mode FROM search_criteria_locations
                    WHERE version_id = $1 ORDER BY position`, [row.version_id]),
            query(`SELECT w.name FROM search_criteria_work_types t
                     JOIN lkp_work_types w ON w.id = t.work_type_id
                    WHERE t.version_id = $1`, [row.version_id]),
            query(`SELECT min_pay_amount, min_pay_unit FROM search_criteria_versions
                    WHERE id = $1`, [row.version_id]),
        ]);

        const byKind = (k) => terms.rows.filter((t) => t.kind === k).map((t) => t.value);
        const pay = head.rows[0];

        out.push({
            id: row.id,
            name: row.name,
            versionId: row.version_id,
            dailyCap: row.daily_cap ?? 0,
            criteria: {
                jobTitles: byKind('JOB_TITLE'),
                keywordsInclude: byKind('KEYWORD_INCLUDE'),
                keywordsExclude: byKind('KEYWORD_EXCLUDE'),
                excludedCompanies: byKind('EXCLUDED_COMPANY'),
                locations: locations.rows.map((l) => ({
                    city: l.city, state: l.state, workMode: l.work_mode,
                })),
                workTypeNames: workTypes.rows.map((w) => w.name),
                minPay: pay?.min_pay_amount == null
                    ? null
                    : { amount: Number(pay.min_pay_amount), unit: pay.min_pay_unit },
            },
        });
    }
    return out;
};

/**
 * The search terms to send to the provider.
 *
 * Derived from the consultants' own job titles rather than hardcoded, so the
 * engine looks for what this bench actually wants. De-duplicated and ranked by
 * how many consultants want each title, then capped.
 *
 * The cap is now a spending limit as much as a scope limit: every term costs
 * `max_pages` API credits, so a title nobody's criteria contain is money spent
 * on a search nobody asked for.
 */
const buildQueries = (consultants, limit = 6) => {
    const titles = new Map();
    for (const c of consultants) {
        for (const t of c.criteria.jobTitles) {
            const key = t.toLowerCase();
            titles.set(key, (titles.get(key) ?? 0) + 1);
        }
    }
    const ranked = [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

    const locations = new Set();
    for (const c of consultants) {
        for (const l of c.criteria.locations) {
            locations.add(l.workMode === 'REMOTE' ? 'Remote' : (l.city ?? ''));
        }
    }
    const location = [...locations].filter(Boolean)[0] ?? '';

    return ranked.map(([q]) => ({ q, l: location }));
};

/* ── storing what a run finds ─────────────────────────────────────────── */

/**
 * Insert a posting, or record a repeat sighting of one already known (R-15).
 * @returns {{ id, isNew }}
 */
const upsertPosting = async (client, { orgId, sourceId, runId, posting, workTypeId, portalTypeId }) => {
    const fingerprint = fingerprintPosting(posting);

    const { rows: existing } = await client.query(
        'SELECT id FROM job_postings WHERE organization_id = $1 AND fingerprint = $2',
        [orgId, fingerprint],
    );

    let postingId;
    let isNew;

    if (existing[0]) {
        postingId = existing[0].id;
        isNew = false;
        // A repeat sighting updates last_seen. It never creates a second row.
        //
        // The provider id is backfilled when it is missing but never
        // overwritten: the first sighting's id is the one every later reference
        // was made against, and Google issues a different one per surfacing.
        await client.query(
            `UPDATE job_postings
                SET last_seen_at = now(), times_seen = times_seen + 1, is_active = TRUE,
                    provider_job_id = COALESCE(provider_job_id, $2)
              WHERE id = $1`,
            [postingId, posting.providerJobId ?? null],
        );
    } else {
        postingId = uuidv4();
        isNew = true;
        await client.query(
            `INSERT INTO job_postings
                (id, organization_id, company, title, location_text, is_remote,
                 description, source_url, work_type_id, portal_type_id,
                 pay_min, pay_max, pay_unit, pay_currency,
                 fingerprint, first_source_id, posted_at, provider_job_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [postingId, orgId, posting.company, posting.title, posting.locationText,
                posting.isRemote, posting.description, posting.sourceUrl,
                workTypeId, portalTypeId,
                posting.payMin, posting.payMax, posting.payUnit, posting.payCurrency,
                fingerprint, sourceId, posting.postedAt, posting.providerJobId ?? null],
        );
    }

    await client.query(
        `INSERT INTO job_posting_sightings
            (id, organization_id, posting_id, source_id, run_id, source_url)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuidv4(), orgId, postingId, sourceId, runId, posting.sourceUrl ?? ''],
    );

    return { id: postingId, isNew };
};

/* ── the run ──────────────────────────────────────────────────────────── */

/**
 * Execute one discovery cycle for one organisation.
 *
 * Returns the run row. Never throws for an operational failure — the failure
 * is recorded on the run and on the board, because a cycle that aborts on the
 * first bad board is a cycle that stops working the first week.
 */
export const executeRun = async (orgId, { trigger = 'MANUAL', userId = null } = {}) => {
    // The partial unique index refuses a second open run. Catching it here
    // turns a raw constraint violation into an answer the caller can act on.
    let runId;
    try {
        runId = uuidv4();
        await query(
            `INSERT INTO discovery_runs (id, organization_id, trigger, triggered_by)
             VALUES ($1,$2,$3,$4)`,
            [runId, orgId, trigger, userId],
        );
    } catch (err) {
        if (err.code === '23505') {
            return { alreadyRunning: true };
        }
        throw err;
    }

    const stats = {
        queries_sent: 0,
        queries_failed: 0,
        provider_calls: 0,
        credits_saved: 0,
        raw_items: 0,
        parsed_ok: 0,
        filtered_by_portal: 0,
        quarantined: 0,
        postings_new: 0,
        postings_duplicate: 0,
        prefilter_in: 0,
        prefilter_out: 0,
        matches_found: 0,
        queued: 0,
        held_by_cap: 0,
    };
    const notes = [];

    try {
        const [sources, consultants, lookups] = await Promise.all([
            loadSources(),
            loadMatchableConsultants(orgId),
            (async () => {
                const [wt, pt, qs] = await Promise.all([
                    query('SELECT id, name FROM lkp_work_types'),
                    query('SELECT id, name FROM lkp_portal_types'),
                    query('SELECT id, name FROM lkp_queue_statuses'),
                ]);
                return {
                    workType: Object.fromEntries(wt.rows.map((r) => [r.name, r.id])),
                    portalType: Object.fromEntries(pt.rows.map((r) => [r.name, r.id])),
                    queueStatus: Object.fromEntries(qs.rows.map((r) => [r.name, r.id])),
                };
            })(),
        ]);

        if (consultants.length === 0) {
            notes.push('No consultant has active criteria — nothing to search for.');
        }

        const cfg = providerConfig();
        const queries = buildQueries(consultants, cfg.maxQueries);
        if (queries.length === 0 && consultants.length > 0) {
            notes.push('Consultants have criteria but no job titles — no search terms to send.');
        }

        /* ── acquire ──────────────────────────────────────────────── */
        //
        // Every early return here is a NOTE, not a throw. A run that cannot
        // reach the provider can still match yesterday's postings against
        // criteria that changed this morning, and that is real work. A stack
        // trace would throw it away and tell the operator nothing.
        const provider = sources.provider;
        let blocker = null;
        if (!provider) {
            blocker = 'No search provider row exists — re-run the seeds.';
        } else if (!provider.is_enabled) {
            blocker = `${provider.label} is switched off, so no jobs were fetched. `
                + 'Turn it on from the discovery screen.';
        } else if (!isConfigured()) {
            blocker = `${provider.label} has no API key — set SERPAPI_KEY in .env. `
                + 'Matching still ran over the postings already in the pool.';
        }
        if (blocker) notes.push(blocker);

        if (!blocker && queries.length > 0) {
            const session = createSession({
                maxPages: provider.max_pages,
                maxCalls: cfg.maxCallsPerRun,
                pacingMs: provider.rate_limit_ms,
            });

            let providerFailed = false;
            const yieldPerQuery = [];

            for (const q of queries) {
                stats.queries_sent += 1;
                let newFromQuery = 0;
                let pagesBought = 0;
                let stoppedEarly = false;

                // ── page by page, stopping as soon as a page stops earning ──
                //
                // Each page is a paid credit and pages are ordered by Google's
                // ranking, so a page that produced nothing new is a strong
                // signal that the next one will not either. Buying it anyway is
                // the single largest avoidable cost in a mature pool, where
                // most of what a search returns is already held.
                for await (const page of session.pages({ q: q.q, location: q.l })) {
                    pagesBought += 1;
                    stats.raw_items += page.results.length;

                    // Stored before anything is parsed. When the adapter turns
                    // out to be wrong next month, a fix can be replayed over
                    // retained history instead of losing every posting that
                    // arrived while it was wrong. The URL is already redacted.
                    await query(
                        `INSERT INTO job_source_payloads
                            (id, organization_id, source_id, run_id, request_url,
                             http_status, content_type, body, body_bytes, postings_found)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                        [uuidv4(), orgId, provider.id, runId, page.payload.url.slice(0, 1000),
                            page.payload.status, page.payload.contentType,
                            page.payload.body ? page.payload.body.slice(0, PAYLOAD_KEEP_BYTES) : null,
                            page.payload.bytes, page.payload.found],
                    );

                    if (page.error) {
                        providerFailed = true;
                        stats.queries_failed += 1;
                        notes.push(`${provider.label}: ${page.error}`);
                        break;
                    }

                    let newInPage = 0;

                    for (const raw of page.results) {
                        const adapted = jobResultToPosting(raw);

                        // Quarantined, never dropped. A result the adapter
                        // cannot read is the first sign of a changed contract,
                        // and it is only visible if somebody kept it.
                        if (!adapted) {
                            stats.quarantined += 1;
                            await query(
                                `INSERT INTO job_parse_quarantine
                                    (id, organization_id, source_id, run_id, reason, raw_fragment)
                                 VALUES ($1,$2,$3,$4,$5,$6)`,
                                [uuidv4(), orgId, provider.id, runId,
                                    'Missing company, title or apply link',
                                    JSON.stringify(raw).slice(0, 4000)],
                            );
                            continue;
                        }

                        // Attribution resolves to a row so per-board yield stays
                        // measurable (spec item 16). An unrecognised board lands
                        // on OTHER rather than being lost.
                        const sourceRow = sources.byName.get(adapted.source)
                            ?? sources.byName.get('OTHER')
                            ?? provider;

                        if (!sourceRow.is_enabled) {
                            stats.filtered_by_portal += 1;
                            continue;
                        }

                        stats.parsed_ok += 1;
                        const { isNew } = await withTransaction((client) => upsertPosting(client, {
                            orgId,
                            sourceId: sourceRow.id,
                            runId,
                            posting: adapted.posting,
                            workTypeId: lookups.workType[adapted.posting.workType] ?? null,
                            portalTypeId: lookups.portalType[adapted.portalType] ?? null,
                        }));

                        if (isNew) {
                            stats.postings_new += 1;
                            newInPage += 1;
                        } else {
                            stats.postings_duplicate += 1;
                        }
                    }

                    newFromQuery += newInPage;

                    if (newInPage === 0) {
                        // Nothing new on a page we already paid for. Do not buy
                        // the next one.
                        stoppedEarly = true;
                        break;
                    }
                }

                // Credits this query chose not to spend. Counted rather than
                // estimated, so the saving is auditable next to the spend.
                if (stoppedEarly) {
                    stats.credits_saved += Math.max(0, provider.max_pages - pagesBought);
                }

                yieldPerQuery.push(
                    `"${q.q}": ${newFromQuery} new from ${pagesBought} page(s)`
                    + (stoppedEarly ? ' — stopped early, last page was all repeats' : ''),
                );
            }

            // Per-term yield, so the terms that never earn their credits are
            // visible rather than inferred. This is what an operator reads
            // before cutting DISCOVERY_MAX_QUERIES.
            if (yieldPerQuery.length > 0) notes.push(yieldPerQuery.join('\n'));

            stats.provider_calls = session.calls;
            if (session.budgetExhausted) {
                notes.push(`Stopped at the per-run ceiling of ${cfg.maxCallsPerRun} API `
                    + 'calls. Raise DISCOVERY_MAX_CALLS_PER_RUN, or send fewer search terms.');
            }

            await query(
                `UPDATE lkp_job_sources
                    SET last_success_at = CASE WHEN $2 THEN last_success_at ELSE now() END,
                        consecutive_failures = CASE WHEN $2 THEN consecutive_failures + 1 ELSE 0 END,
                        last_error = $3
                  WHERE id = $1`,
                [provider.id, providerFailed,
                    providerFailed ? notes[notes.length - 1]?.slice(0, 500) : null],
            );
        }

        /* ── match ────────────────────────────────────────────────── */
        // Everything active, not merely what arrived this run: a posting seen
        // yesterday is still worth matching to a consultant whose criteria
        // changed since, and to one who was at their cap.
        const { rows: candidates } = await query(
            `SELECT p.id, p.company, p.title, p.description, p.location_text, p.is_remote,
                    p.pay_min, p.pay_max, p.pay_unit, w.name AS work_type_name
               FROM job_postings p
          LEFT JOIN lkp_work_types w ON w.id = p.work_type_id
              WHERE p.organization_id = $1 AND p.is_active
              ORDER BY p.first_seen_at DESC
              LIMIT 500`,
            [orgId],
        );

        for (const consultant of consultants) {
            for (const row of candidates) {
                const posting = {
                    company: row.company,
                    title: row.title,
                    description: row.description,
                    locationText: row.location_text,
                    isRemote: row.is_remote,
                    payMin: row.pay_min == null ? null : Number(row.pay_min),
                    payMax: row.pay_max == null ? null : Number(row.pay_max),
                    payUnit: row.pay_unit,
                };

                stats.prefilter_in += 1;
                const verdict = evaluate(posting, consultant.criteria, {
                    workTypeName: row.work_type_name,
                });
                if (verdict.stage !== 'score') stats.prefilter_out += 1;
                if (!verdict.matched) continue;

                // ON CONFLICT: a consultant is matched to a posting once, ever.
                // Re-running must not multiply matches.
                const { rowCount } = await query(
                    `INSERT INTO job_matches
                        (id, organization_id, consultant_id, posting_id,
                         criteria_version_id, score, reason, status, run_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)
                     ON CONFLICT (consultant_id, posting_id) DO NOTHING`,
                    [uuidv4(), orgId, consultant.id, row.id,
                        consultant.versionId, verdict.score, verdict.reason, runId],
                );
                if (rowCount > 0) stats.matches_found += 1;
            }
        }

        /* ── fill queues, respecting the daily cap (R-17) ──────────── */
        for (const consultant of consultants) {
            const { rows: usedRows } = await query(
                `SELECT COUNT(*)::int AS used
                   FROM queue_items
                  WHERE consultant_id = $1 AND queued_at::date = CURRENT_DATE`,
                [consultant.id],
            );
            const remaining = Math.max(0, consultant.dailyCap - usedRows[0].used);

            const { rows: pending } = await query(
                `SELECT id, posting_id, score
                   FROM job_matches
                  WHERE consultant_id = $1 AND status IN ('PENDING','HELD')
                  ORDER BY score DESC, matched_at ASC`,
                [consultant.id],
            );

            for (let i = 0; i < pending.length; i += 1) {
                const match = pending[i];

                if (i >= remaining) {
                    // Held, not discarded. Tomorrow's run reconsiders it.
                    await query(
                        "UPDATE job_matches SET status = 'HELD' WHERE id = $1 AND status <> 'QUEUED'",
                        [match.id],
                    );
                    stats.held_by_cap += 1;
                    continue;
                }

                // R-01 / R-03: the same posting legitimately reaches several
                // consultants. Flag it for visibility; never block it.
                const { rows: others } = await query(
                    `SELECT 1 FROM queue_items
                      WHERE posting_id = $1 AND consultant_id <> $2 LIMIT 1`,
                    [match.posting_id, consultant.id],
                );
                const isOverlap = others.length > 0;

                const inserted = await query(
                    `INSERT INTO queue_items
                        (id, organization_id, consultant_id, posting_id, match_id,
                         status_id, is_overlap, run_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (consultant_id, posting_id) DO NOTHING
                     RETURNING id`,
                    [uuidv4(), orgId, consultant.id, match.posting_id, match.id,
                        lookups.queueStatus.QUEUED, isOverlap, runId],
                );

                if (inserted.rowCount > 0) {
                    await query(
                        `INSERT INTO queue_item_transitions
                            (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                         VALUES ($1,$2,$3,NULL,$4,$5)`,
                        [uuidv4(), orgId, inserted.rows[0].id, lookups.queueStatus.QUEUED,
                            `Matched by discovery run (score ${match.score})`],
                    );
                    stats.queued += 1;

                    if (isOverlap) {
                        await query(
                            'UPDATE queue_items SET is_overlap = TRUE WHERE posting_id = $1',
                            [match.posting_id],
                        );
                    }
                }
                await query("UPDATE job_matches SET status = 'QUEUED' WHERE id = $1", [match.id]);
            }
        }
    } catch (err) {
        notes.push(`Run aborted: ${err.message}`);
        await query(
            'UPDATE discovery_runs SET finished_at = now(), error = $2, notes = $3 WHERE id = $1',
            [runId, err.message.slice(0, 1000), notes.join('\n')],
        );
        throw err;
    }

    const setClause = Object.keys(stats).map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(
        `UPDATE discovery_runs
            SET finished_at = now(), notes = $${Object.keys(stats).length + 2}, ${setClause}
          WHERE id = $1`,
        [runId, ...Object.values(stats), notes.join('\n') || null],
    );

    // Audited only when a PERSON triggered it. `audit_logs.performed_by` is
    // NOT NULL by design — that table answers "who did this", and a scheduled
    // run has no who. Inventing a system user to satisfy the column would put
    // a fabricated actor in the one table that exists to be trustworthy.
    //
    // Scheduled runs are not unrecorded: `discovery_runs` holds the trigger,
    // both timestamps, every per-stage count and every source error — a richer
    // account than an audit row, and the right place to read it from.
    if (userId) {
        logAction({
            orgId, module: 'discovery', action: 'Ran Discovery',
            entityType: 'DiscoveryRun', entityId: runId,
            entityName: `${trigger.toLowerCase()} run`,
            performedBy: userId, performedByRole: null,
            description: `Discovery ${trigger.toLowerCase()}: `
                + `${stats.provider_calls} API call(s), `
                + `${stats.postings_new} new postings, ${stats.postings_duplicate} repeats, `
                + `${stats.matches_found} matches, ${stats.queued} queued, ${stats.held_by_cap} held by cap`
                + (stats.queries_failed ? ` — ${stats.queries_failed} search(es) failed` : ''),
            ipAddress: null,
        }).catch(() => {});
    }

    const { rows } = await query('SELECT * FROM discovery_runs WHERE id = $1', [runId]);
    return { run: rows[0] };
};

/* ── endpoints ────────────────────────────────────────────────────────── */

/** POST /api/management/discovery/run — ORG_ADMIN only. */
export const triggerRun = async (req, res, next) => {
    try {
        const result = await executeRun(req.user.orgId, {
            trigger: 'MANUAL',
            userId: req.user.id,
        });
        if (result.alreadyRunning) {
            return res.status(409).json({ error: 'A discovery run is already in progress.' });
        }
        return res.status(201).json({ message: 'Discovery run complete.', run: result.run });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/discovery/runs */
export const listRuns = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT r.*, u.name AS triggered_by_name
               FROM discovery_runs r
          LEFT JOIN users u ON u.id = r.triggered_by
              WHERE r.organization_id = $1
              ORDER BY r.started_at DESC
              LIMIT 50`,
            [req.user.orgId],
        );
        return res.json({ runs: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/discovery/sources
 *
 * Provider health, and per-board yield.
 *
 * `postings` is the count actually attributed to each board, which is the only
 * honest way to answer "is this board worth having on". A board switched on
 * that has contributed nothing in a month is visible here and nowhere else.
 */
export const listSources = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT s.*,
                    (SELECT COUNT(*)::int FROM job_parse_quarantine q
                      WHERE q.source_id = s.id AND NOT q.resolved) AS quarantined,
                    (SELECT COUNT(*)::int FROM job_postings p
                      WHERE p.first_source_id = s.id AND p.organization_id = $1) AS postings
               FROM lkp_job_sources s
              ORDER BY s.fetch_mode = 'PROVIDER' DESC, s.is_priority DESC, s.label`,
            [req.user.orgId],
        );

        const cfg = providerConfig();
        const provider = rows.find((r) => r.fetch_mode === 'PROVIDER') ?? null;

        return res.json({
            sources: rows,
            provider: {
                name: cfg.name,
                label: provider?.label ?? cfg.label,
                // Whether a key is present. The key itself is never returned,
                // and never leaves the server.
                configured: isConfigured(),
                enabled: provider?.is_enabled ?? false,
                maxQueries: cfg.maxQueries,
                maxPages: provider?.max_pages ?? cfg.maxPages,
                maxCallsPerRun: cfg.maxCallsPerRun,
                // What "recent" means to this deployment, and how often that
                // question gets asked. Both drive the monthly bill, so both
                // belong on the screen next to the estimate.
                datePosted: cfg.datePosted,
                cycleHours: CYCLE_HOURS,
                runsPerDay: RUNS_PER_DAY,
                lastSuccessAt: provider?.last_success_at ?? null,
                lastError: provider?.last_error ?? null,
                consecutiveFailures: provider?.consecutive_failures ?? 0,
            },
        });
    } catch (err) {
        return next(err);
    }
};

/* ── the automatic cycle ──────────────────────────────────────────────── */

export const scheduleSchema = Joi.object({
    enabled: Joi.boolean().required(),
});

/**
 * GET /api/management/discovery/schedule
 *
 * `serverTime` is returned alongside `nextRunAt` on purpose. The screen shows
 * a live countdown, and a browser clock that is wrong by ten minutes would
 * otherwise produce a countdown that is wrong by ten minutes. Sending both
 * lets the client measure its own offset and count down against the server's
 * clock instead of its own.
 */
export const getSchedule = async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT discovery_schedule_enabled FROM organizations WHERE id = $1',
            [req.user.orgId],
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Organization not found.' });

        const enabled = rows[0].discovery_schedule_enabled;
        const available = isSchedulerAvailable();
        const now = new Date();

        const { rows: last } = await query(
            `SELECT started_at, finished_at
               FROM discovery_runs
              WHERE organization_id = $1 AND trigger = 'SCHEDULED'
              ORDER BY started_at DESC
              LIMIT 1`,
            [req.user.orgId],
        );

        return res.json({
            enabled,
            // Whether the server process runs the cycle at all. When this is
            // false the switch below still saves, but nothing will fire — and
            // the screen says so rather than looking armed.
            schedulerAvailable: available,
            cycleHours: CYCLE_HOURS,
            timezone: schedulerTimezone(),
            serverTime: now.toISOString(),
            nextRunAt: enabled && available ? nextRunAfter(now).toISOString() : null,
            lastScheduledRunAt: last[0]?.started_at ?? null,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PATCH /api/management/discovery/schedule — ORG_ADMIN only.
 *
 * Audited: switching the cycle on is what makes this system reach out to job
 * boards unattended, which is exactly the kind of change somebody will want
 * attributed later.
 */
export const updateSchedule = async (req, res, next) => {
    try {
        const enabled = req.body.enabled;

        const { rows } = await query(
            `UPDATE organizations
                SET discovery_schedule_enabled = $2
              WHERE id = $1
              RETURNING name, discovery_schedule_enabled`,
            [req.user.orgId, enabled],
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Organization not found.' });

        logAction({
            orgId: req.user.orgId,
            module: 'discovery',
            action: enabled ? 'Enabled Schedule' : 'Disabled Schedule',
            entityType: 'DiscoverySchedule',
            entityId: req.user.orgId,
            entityName: rows[0].name,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `${enabled ? 'Switched on' : 'Switched off'} the automatic `
                + `${CYCLE_HOURS}-hour job discovery cycle`,
            ipAddress: req.ip,
        }).catch(() => {});

        const now = new Date();
        return res.json({
            message: enabled
                ? 'Automatic discovery is on.'
                : 'Automatic discovery is off.',
            enabled,
            schedulerAvailable: isSchedulerAvailable(),
            serverTime: now.toISOString(),
            nextRunAt: enabled && isSchedulerAvailable()
                ? nextRunAfter(now).toISOString()
                : null,
        });
    } catch (err) {
        return next(err);
    }
};
