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
 *       create a queue item per match — the cap is NOT applied here
 *   promoteToReady()
 *       promote QUEUED → READY up to the daily cap (R-17); surplus waits
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
 * · Caps stop an item becoming READY, not discovery. A match over the cap waits
 *   at QUEUED and is reconsidered on the next promotion pass rather than
 *   discarded (R-17). The slot is spent on reaching READY, so a preparation
 *   failure never burns a consultant's day.
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
    schedulerTimezone, isSchedulerAvailable, nextRunAfter, isDue,
    clampCycleHours, runsPerDay, MIN_CYCLE_HOURS, MAX_CYCLE_HOURS,
} from '../config/discoverySchedule.js';
import { countsAgainstCap } from '../config/queueStates.js';
import { logAction } from './auditLogController.js';

/**
 * Share of the monthly budget scheduled runs may not touch.
 *
 * Without it the cycle can quietly consume the entire month by the 20th, and a
 * person pressing "Run discovery now" on the 25th — usually because something
 * needs checking urgently — finds the budget gone.
 */
const MANUAL_RESERVE = 0.10;

/** Recency handles rot; Google rotates them. Re-discover after this. */
const FILTER_CACHE_TTL_DAYS = 7;

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
        // Health lives on organization_providers now, per agency — see
        // migration 031. Selecting it here was a leftover that made every run
        // fail with "column consecutive_failures does not exist".
        `SELECT id, name, label, fetch_mode, is_enabled, is_priority,
                rate_limit_ms, max_pages
           FROM lkp_job_sources
          ORDER BY id`,
    );
    return {
        provider: rows.find((r) => r.fetch_mode === 'PROVIDER') ?? null,
        byName: new Map(rows.map((r) => [r.name, r])),
    };
};

/** The tenant's own pacing, housekeeping and clock settings. */
const loadOrgSettings = async (orgId) => {
    const { rows } = await query(
        `SELECT name, timezone,
                discovery_schedule_enabled, discovery_cycle_hours, discovery_date_posted,
                lease_expiry_minutes, unprepared_expiry_hours,
                review_expiry_days, posting_stale_days
           FROM organizations WHERE id = $1`,
        [orgId],
    );
    return rows[0] ?? null;
};

/**
 * This agency's relationship with each search provider.
 *
 * Health, budget and enablement live here rather than on `lkp_job_sources`,
 * which is a global lookup with no organisation column — two agencies sharing
 * an installation were sharing one health record, so one tenant's failure
 * marked the provider broken for the other.
 *
 * Credentials are NOT stored: the row names the environment variable holding
 * the key, and the key stays in the server environment.
 */
const loadProviders = async (orgId) => {
    const { rows } = await query(
        `SELECT op.id, op.source_id, op.is_enabled, op.monthly_budget, op.max_pages,
                op.rate_limit_ms, op.credential_env,
                op.last_success_at, op.last_error, op.consecutive_failures,
                s.name, s.label
           FROM organization_providers op
           JOIN lkp_job_sources s ON s.id = op.source_id
          WHERE op.organization_id = $1 AND s.fetch_mode = 'PROVIDER'
          ORDER BY s.label`,
        [orgId],
    );
    return rows;
};

/**
 * Credits already spent this calendar month, and what remains.
 *
 * Counted from `discovery_runs.provider_calls` rather than a separate ledger:
 * the runs table is already the record of every call made, so a second counter
 * could only ever disagree with it.
 *
 * Scheduled runs are held to a lower ceiling than manual ones — see
 * MANUAL_RESERVE.
 */
const monthlyBudgetState = async (orgId, budget, trigger) => {
    const { rows } = await query(
        `SELECT COALESCE(SUM(provider_calls), 0)::int AS used
           FROM discovery_runs
          WHERE organization_id = $1
            AND started_at >= date_trunc('month', now())`,
        [orgId],
    );

    const used = rows[0].used;
    const ceiling = trigger === 'SCHEDULED'
        ? Math.floor(budget * (1 - MANUAL_RESERVE))
        : budget;

    return {
        used,
        budget,
        ceiling,
        remaining: Math.max(0, ceiling - used),
        percentUsed: budget > 0 ? Math.round((used / budget) * 100) : 0,
    };
};

/* ── the provider's recency filter handles ────────────────────────────── */

const cacheKey = (q) => ({ q: q.q, l: q.l ?? '' });

/** Cached handles for this run's search terms, fresh ones only. */
const loadFilterCache = async (orgId, window) => {
    const { rows } = await query(
        `SELECT query_text, location_text, uds, q_override
           FROM provider_filter_cache
          WHERE organization_id = $1
            AND date_window = $2
            AND fetched_at > now() - ($3 || ' days')::interval`,
        [orgId, window, String(FILTER_CACHE_TTL_DAYS)],
    );
    return new Map(rows.map((r) => [`${r.query_text} ${r.location_text}`, r]));
};

const rememberFilter = async (orgId, q, window, filter) => {
    const key = cacheKey(q);
    await query(
        `INSERT INTO provider_filter_cache
            (id, organization_id, query_text, location_text, date_window, uds, q_override)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id, query_text, location_text, date_window)
         DO UPDATE SET uds = EXCLUDED.uds,
                       q_override = EXCLUDED.q_override,
                       fetched_at = now(),
                       failures = 0`,
        [uuidv4(), orgId, key.q.slice(0, 255), key.l.slice(0, 255),
            window, filter.uds, filter.q ? filter.q.slice(0, 500) : null],
    );
};

/**
 * Drop a handle that stopped working.
 *
 * Google rotates these, and a rotated handle does not error — it simply returns
 * nothing. Deleting the row means the next run rediscovers it on a call it was
 * making anyway, so a rotation costs one unfiltered cycle rather than silently
 * returning no jobs forever.
 */
const forgetFilter = async (orgId, q, window) => {
    const key = cacheKey(q);
    await query(
        `DELETE FROM provider_filter_cache
          WHERE organization_id = $1 AND query_text = $2
            AND location_text = $3 AND date_window = $4`,
        [orgId, key.q.slice(0, 255), key.l.slice(0, 255), window],
    );
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

/* ── the readiness gate, where the daily cap is spent ─────────────────── */

/**
 * Promote QUEUED items to READY, up to each consultant's daily cap.
 *
 * ── WHY THE CAP LIVES HERE AND NOT AT QUEUE CREATION ──────────────────
 *
 * A slot is spent when an item becomes genuinely available to apply to. The
 * discovery cycle creates items before anything has prepared them, so counting
 * at creation would let a failed preparation consume a consultant's whole day
 * without a single application going out.
 *
 * ── WHERE THE AI STAGE WILL SIT ───────────────────────────────────────
 *
 * Exactly here, between QUEUED and READY. Today the step attaches nothing and
 * marks the item ready; when resume tailoring arrives it does its work first
 * and this becomes its final act. The four-hour cycle still never calls a
 * model, because this runs outside it.
 *
 * ── "TODAY" IS THE AGENCY'S DAY ───────────────────────────────────────
 *
 * Counted in the organisation's own timezone, not the server's. Staffing
 * benches are frequently offshore, and a cap that resets at 17:00 local is not
 * a daily cap.
 */
export const promoteToReady = async (orgId) => {
    const settings = await loadOrgSettings(orgId);
    const tz = settings?.timezone || schedulerTimezone();

    const { rows: statuses } = await query('SELECT id, name FROM lkp_queue_statuses');
    const statusId = Object.fromEntries(statuses.map((r) => [r.name, r.id]));
    const holdingIds = statuses
        .filter((r) => countsAgainstCap(r.name))
        .map((r) => r.id);

    // Only consultants who can actually receive work. A paused or terminated
    // person is skipped here as well as at matching, so an item can never
    // become ready for somebody who has left.
    const { rows: consultants } = await query(
        `SELECT u.id, p.daily_cap
           FROM users u
           JOIN consultant_profiles p ON p.user_id = u.id
          WHERE u.organization_id = $1
            AND u.role = 'CONSULTANT'
            AND u.employment_status = 'ACTIVE'
            AND NOT p.is_paused`,
        [orgId],
    );

    let promoted = 0;
    let heldByCap = 0;

    for (const consultant of consultants) {
        const { rows: usedRows } = await query(
            `SELECT COUNT(*)::int AS used
               FROM queue_items
              WHERE consultant_id = $1
                AND became_ready_at IS NOT NULL
                AND (became_ready_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date
                AND status_id = ANY($3::int[])`,
            [consultant.id, tz, holdingIds],
        );
        const remaining = Math.max(0, (consultant.daily_cap ?? 0) - usedRows[0].used);

        const { rows: waiting } = await query(
            `SELECT q.id
               FROM queue_items q
          LEFT JOIN job_matches m ON m.id = q.match_id
              WHERE q.consultant_id = $1
                AND q.status_id = $2
              ORDER BY COALESCE(m.score, 0) DESC, q.queued_at ASC`,
            [consultant.id, statusId.QUEUED],
        );

        for (let i = 0; i < waiting.length; i += 1) {
            if (i >= remaining) {
                // Not discarded — it stays QUEUED and is reconsidered on the
                // next pass, which is what "held by the cap" means now.
                heldByCap += 1;
                continue;
            }

            await withTransaction(async (client) => {
                await client.query(
                    `UPDATE queue_items
                        SET status_id = $2, prepared_at = now(), became_ready_at = now()
                      WHERE id = $1 AND status_id = $3`,
                    [waiting[i].id, statusId.READY, statusId.QUEUED],
                );
                await client.query(
                    `INSERT INTO queue_item_transitions
                        (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [uuidv4(), orgId, waiting[i].id, statusId.QUEUED, statusId.READY,
                        'Prepared and within the daily cap'],
                );
            });
            promoted += 1;
        }
    }

    return { promoted, heldByCap };
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
        awaiting_cap: 0,
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
        const settings = await loadOrgSettings(orgId);
        const dateWindow = settings?.discovery_date_posted ?? 'day';
        // One provider today, several supported. The first enabled one is used;
        // adding a second is a row in organization_providers, not a code change.
        const orgProviders = await loadProviders(orgId);
        const orgProvider = orgProviders.find((p) => p.is_enabled) ?? orgProviders[0] ?? null;
        const budget = await monthlyBudgetState(
            orgId, orgProvider?.monthly_budget ?? 0, trigger,
        );

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
        // The source row records WHICH provider a payload came from; the
        // organization_providers row carries this agency's settings for it.
        const provider = orgProvider
            ? { ...sources.byName.get(orgProvider.name), ...orgProvider, id: orgProvider.source_id }
            : null;

        let blocker = null;
        if (!provider) {
            blocker = 'No search provider is configured for this organisation.';
        } else if (!provider.is_enabled) {
            blocker = `${provider.label} is switched off, so no jobs were fetched. `
                + 'Turn it on from the discovery screen.';
        } else if (!isConfigured()) {
            blocker = `${provider.label} has no API key — set ${orgProvider.credential_env} `
                + 'in the server environment. '
                + 'Matching still ran over the postings already in the pool.';
        } else if (budget.remaining <= 0) {
            // A hard stop, but only on FETCHING. The run still completes and
            // still matches everything already in the pool, because that half
            // costs nothing and is genuinely useful.
            blocker = trigger === 'SCHEDULED'
                ? `Monthly search budget reached — ${budget.used} of ${budget.budget} credits used. `
                  + `Scheduled runs stop at ${budget.ceiling} so manual runs stay possible. `
                  + 'Matching still ran over the postings already in the pool.'
                : `Monthly search budget of ${budget.budget} credits is fully used. `
                  + 'Matching still ran over the postings already in the pool.';
        }
        if (blocker) notes.push(blocker);

        if (!blocker && budget.percentUsed >= 90) {
            notes.push(`Warning: ${budget.percentUsed}% of the monthly search budget used `
                + `(${budget.used} of ${budget.budget} credits).`);
        }

        if (!blocker && queries.length > 0) {
            const filterCache = await loadFilterCache(orgId, dateWindow);

            const session = createSession({
                maxPages: provider.max_pages,
                // Never spend past what is left of the month, whatever the
                // per-run ceiling says.
                maxCalls: Math.min(cfg.maxCallsPerRun, budget.remaining),
                pacingMs: provider.rate_limit_ms,
            });

            let providerFailed = false;
            const yieldPerQuery = [];

            for (const q of queries) {
                stats.queries_sent += 1;
                let newFromQuery = 0;
                let pagesBought = 0;
                let stoppedEarly = false;
                let resultsSeen = 0;

                // The recency handle for this term, if we already hold a fresh
                // one. When we do not, this run goes out unfiltered and harvests
                // the handle from the response it was making anyway — so the
                // filter costs nothing, it just starts working next cycle.
                const cached = filterCache.get(`${q.q} ${q.l ?? ''}`);
                let harvested = null;

                // ── page by page, stopping as soon as a page stops earning ──
                //
                // Each page is a paid credit and pages are ordered by Google's
                // ranking, so a page that produced nothing new is a strong
                // signal that the next one will not either. Buying it anyway is
                // the single largest avoidable cost in a mature pool, where
                // most of what a search returns is already held.
                for await (const page of session.pages({
                    q: q.q,
                    location: q.l,
                    uds: cached?.uds ?? null,
                    qOverride: cached?.q_override ?? null,
                    dateWindow,
                })) {
                    pagesBought += 1;
                    resultsSeen += page.results.length;
                    stats.raw_items += page.results.length;
                    if (page.filter) harvested = page.filter;

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

                // Keep a freshly harvested handle for next time.
                if (harvested) {
                    await rememberFilter(orgId, q, dateWindow, harvested).catch(() => {});
                } else if (cached && resultsSeen === 0 && pagesBought > 0) {
                    // We filtered with a stored handle and Google returned
                    // nothing at all. A rotated handle behaves exactly like this
                    // — no error, just an empty result — so drop it and let the
                    // next run rediscover it rather than searching into a void
                    // every cycle from now on.
                    await forgetFilter(orgId, q, dateWindow).catch(() => {});
                    notes.push(`Recency filter for "${q.q}" returned nothing and was reset.`);
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

            // Health is recorded against THIS agency's provider row, so one
            // tenant's failed search cannot mark the provider broken for
            // another sharing the same installation.
            await query(
                `UPDATE organization_providers
                    SET last_success_at = CASE WHEN $2 THEN last_success_at ELSE now() END,
                        consecutive_failures = CASE WHEN $2 THEN consecutive_failures + 1 ELSE 0 END,
                        last_error = $3
                  WHERE id = $1`,
                [orgProvider.id, providerFailed,
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

        /* ── create queue items — NO cap here ─────────────────────── */
        //
        // The cap used to be applied at this point, which was wrong once
        // preparation became a separate stage: a slot spent here is a slot
        // spent before the item is usable, so a failed or slow preparation
        // would burn a consultant's whole day without one application going
        // out. Every match becomes a QUEUED item; the cap is applied when an
        // item reaches READY. See promoteToReady().
        for (const consultant of consultants) {
            const { rows: pending } = await query(
                `SELECT m.id, m.posting_id, m.score,
                        COALESCE(pt.is_automatable, FALSE) AS automatable
                   FROM job_matches m
                   JOIN job_postings p ON p.id = m.posting_id
              LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
                  WHERE m.consultant_id = $1 AND m.status IN ('PENDING','HELD')
                  ORDER BY m.score DESC, m.matched_at ASC`,
                [consultant.id],
            );

            for (const match of pending) {
                // R-01 / R-03: the same posting legitimately reaches several
                // consultants. Flag it for visibility; never block it.
                const { rows: others } = await query(
                    `SELECT 1 FROM queue_items
                      WHERE posting_id = $1 AND consultant_id <> $2 LIMIT 1`,
                    [match.posting_id, consultant.id],
                );
                const isOverlap = others.length > 0;

                // The lane, decided here because the portal is known here.
                // Recorded rather than recomputed later: teaching the app a new
                // system must not silently rewrite what happened historically.
                const channel = match.automatable ? 'BOT' : 'HUMAN';

                const inserted = await query(
                    `INSERT INTO queue_items
                        (id, organization_id, consultant_id, posting_id, match_id,
                         status_id, is_overlap, run_id, channel)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                     ON CONFLICT (consultant_id, posting_id) DO NOTHING
                     RETURNING id`,
                    [uuidv4(), orgId, consultant.id, match.posting_id, match.id,
                        lookups.queueStatus.QUEUED, isOverlap, runId, channel],
                );

                if (inserted.rowCount > 0) {
                    await query(
                        `INSERT INTO queue_item_transitions
                            (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                         VALUES ($1,$2,$3,NULL,$4,$5)`,
                        [uuidv4(), orgId, inserted.rows[0].id, lookups.queueStatus.QUEUED,
                            `Matched by discovery run (score ${match.score}, ${channel} lane)`],
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

        /* ── promote to READY under the daily cap (R-17) ───────────── */
        const promoted = await promoteToReady(orgId);
        stats.queued = promoted.promoted;
        stats.awaiting_cap = promoted.heldByCap;
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
                + `${stats.matches_found} matches, ${stats.queued} queued, ${stats.awaiting_cap} held by cap`
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
        const settings = await loadOrgSettings(req.user.orgId);
        const cycleHours = clampCycleHours(settings?.discovery_cycle_hours);
        const orgProviders = await loadProviders(req.user.orgId);
        const orgProvider = orgProviders.find((p) => p.is_enabled) ?? orgProviders[0] ?? null;
        const spend = await monthlyBudgetState(
            req.user.orgId, orgProvider?.monthly_budget ?? 0, 'MANUAL',
        );

        // PROVIDER rows carry a global `is_enabled` that no longer decides
        // anything — enablement is per agency. Overlaying it here keeps the
        // screen from showing a toggle in the opposite position to reality.
        const byId = new Map(orgProviders.map((p) => [p.source_id, p]));
        const sources = rows.map((s) => (s.fetch_mode === 'PROVIDER' && byId.has(s.id)
            ? {
                ...s,
                is_enabled: byId.get(s.id).is_enabled,
                max_pages: byId.get(s.id).max_pages,
                rate_limit_ms: byId.get(s.id).rate_limit_ms,
            }
            : s));

        return res.json({
            sources,
            // Every provider this agency could use. One today; the shape takes
            // several so adding one is a row rather than a release.
            providers: orgProviders.map((p) => ({
                sourceId: p.source_id,
                name: p.name,
                label: p.label,
                enabled: p.is_enabled,
                monthlyBudget: p.monthly_budget,
                maxPages: p.max_pages,
                lastSuccessAt: p.last_success_at,
                lastError: p.last_error,
                consecutiveFailures: p.consecutive_failures,
            })),
            provider: {
                name: cfg.name,
                label: orgProvider?.label ?? cfg.label,
                sourceId: orgProvider?.source_id ?? null,
                // Whether a key is present. The key itself is never returned,
                // and never leaves the server.
                configured: isConfigured(),
                enabled: orgProvider?.is_enabled ?? false,
                maxQueries: cfg.maxQueries,
                maxPages: orgProvider?.max_pages ?? cfg.maxPages,
                maxCallsPerRun: cfg.maxCallsPerRun,
                // What "recent" means to this tenant, how often it asks, and
                // what it has spent. All three drive the bill, so all three
                // belong on the screen next to the estimate.
                datePosted: settings?.discovery_date_posted ?? 'day',
                cycleHours,
                runsPerDay: runsPerDay(cycleHours),
                monthlyBudget: spend.budget,
                creditsUsedThisMonth: spend.used,
                creditsRemaining: spend.remaining,
                percentUsed: spend.percentUsed,
                lastSuccessAt: orgProvider?.last_success_at ?? null,
                lastError: orgProvider?.last_error ?? null,
                consecutiveFailures: orgProvider?.consecutive_failures ?? 0,
            },
        });
    } catch (err) {
        return next(err);
    }
};

/* ── the automatic cycle ──────────────────────────────────────────────── */

/**
 * Every field optional, at least one required — the screen sends only what
 * changed, so a toggle does not have to restate the budget and vice versa.
 */
export const scheduleSchema = Joi.object({
    enabled: Joi.boolean(),
    cycleHours: Joi.number().integer().min(MIN_CYCLE_HOURS).max(MAX_CYCLE_HOURS),
    datePosted: Joi.string().valid('day', '3days', 'week', 'month'),
    timezone: Joi.string().max(64),
    // Housekeeping. Bounds match the database CHECK, so a bad value is refused
    // with a readable message instead of a constraint violation.
    leaseExpiryMinutes: Joi.number().integer().min(5).max(1440),
    unpreparedExpiryHours: Joi.number().integer().min(1).max(168),
    reviewExpiryDays: Joi.number().integer().min(1).max(90),
    postingStaleDays: Joi.number().integer().min(1).max(365),
    // Belongs to the agency-provider pair now, not the agency: an agency
    // running two providers has two quotas.
    monthlyBudget: Joi.number().integer().min(0).max(1_000_000),
}).min(1);

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
        const settings = await loadOrgSettings(req.user.orgId);
        if (!settings) return res.status(404).json({ error: 'Organization not found.' });

        const enabled = settings.discovery_schedule_enabled;
        const cycleHours = clampCycleHours(settings.discovery_cycle_hours);
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

        const lastRunAt = last[0]?.started_at ?? null;
        const cfg = providerConfig();
        const orgProviders = await loadProviders(req.user.orgId);
        const orgProvider = orgProviders.find((p) => p.is_enabled) ?? orgProviders[0] ?? null;
        const spend = await monthlyBudgetState(
            req.user.orgId, orgProvider?.monthly_budget ?? 0, 'MANUAL',
        );

        return res.json({
            enabled,
            timezone: settings.timezone || schedulerTimezone(),
            // Housekeeping intervals, all editable.
            leaseExpiryMinutes: settings.lease_expiry_minutes,
            unpreparedExpiryHours: settings.unprepared_expiry_hours,
            reviewExpiryDays: settings.review_expiry_days,
            postingStaleDays: settings.posting_stale_days,
            // Whether the server process runs the cycle at all. When this is
            // false the switch below still saves, but nothing will fire — and
            // the screen says so rather than looking armed.
            schedulerAvailable: available,
            cycleHours,
            minCycleHours: MIN_CYCLE_HOURS,
            maxCycleHours: MAX_CYCLE_HOURS,
            datePosted: settings.discovery_date_posted,
            monthlyBudget: spend.budget,
            creditsUsedThisMonth: spend.used,
            percentUsed: spend.percentUsed,
            // What a cycle at this interval costs, so the admin sees the
            // consequence of the number they are typing as they type it.
            creditsPerRun: Math.min(
                cfg.maxQueries * (orgProvider?.max_pages ?? cfg.maxPages),
                cfg.maxCallsPerRun,
            ),
            runsPerDay: runsPerDay(cycleHours),
            serverTime: now.toISOString(),
            nextRunAt: enabled && available
                ? nextRunAfter(lastRunAt, cycleHours, now).toISOString()
                : null,
            dueNow: enabled && available && isDue(lastRunAt, cycleHours, now),
            lastScheduledRunAt: lastRunAt,
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
        const before = await loadOrgSettings(req.user.orgId);
        if (!before) return res.status(404).json({ error: 'Organization not found.' });

        const providersBefore = await loadProviders(req.user.orgId);
        const target = providersBefore.find((p) => p.is_enabled) ?? providersBefore[0] ?? null;

        // COALESCE so the screen can send one field without restating the rest.
        const { rows } = await query(
            `UPDATE organizations
                SET discovery_schedule_enabled = COALESCE($2, discovery_schedule_enabled),
                    discovery_cycle_hours      = COALESCE($3, discovery_cycle_hours),
                    discovery_date_posted      = COALESCE($4, discovery_date_posted),
                    timezone                   = COALESCE($5, timezone),
                    lease_expiry_minutes       = COALESCE($6, lease_expiry_minutes),
                    unprepared_expiry_hours    = COALESCE($7, unprepared_expiry_hours),
                    review_expiry_days         = COALESCE($8, review_expiry_days),
                    posting_stale_days         = COALESCE($9, posting_stale_days)
              WHERE id = $1
              RETURNING name, discovery_schedule_enabled, discovery_cycle_hours,
                        discovery_date_posted, timezone, lease_expiry_minutes,
                        unprepared_expiry_hours, review_expiry_days, posting_stale_days`,
            [req.user.orgId,
                req.body.enabled ?? null,
                req.body.cycleHours ?? null,
                req.body.datePosted ?? null,
                req.body.timezone ?? null,
                req.body.leaseExpiryMinutes ?? null,
                req.body.unpreparedExpiryHours ?? null,
                req.body.reviewExpiryDays ?? null,
                req.body.postingStaleDays ?? null],
        );

        // The budget belongs to this agency's row for the provider, not to the
        // agency itself — two providers mean two quotas.
        if (req.body.monthlyBudget !== undefined && target) {
            await query(
                'UPDATE organization_providers SET monthly_budget = $2 WHERE id = $1',
                [target.id, req.body.monthlyBudget],
            );
        }

        const after = rows[0];

        // One audit row per thing that actually changed. A no-op PATCH writes
        // nothing, so the log stays a record of changes rather than of clicks.
        const changes = [];
        if (req.body.enabled !== undefined
            && req.body.enabled !== before.discovery_schedule_enabled) {
            changes.push({
                action: req.body.enabled ? 'Enabled Schedule' : 'Disabled Schedule',
                description: `${req.body.enabled ? 'Switched on' : 'Switched off'} the automatic `
                    + `${after.discovery_cycle_hours}-hour job discovery cycle`,
            });
        }
        if (req.body.cycleHours !== undefined
            && req.body.cycleHours !== before.discovery_cycle_hours) {
            changes.push({
                action: 'Changed Cycle Interval',
                description: `Discovery interval ${before.discovery_cycle_hours}h → `
                    + `${after.discovery_cycle_hours}h `
                    + `(${runsPerDay(after.discovery_cycle_hours)} run(s) per day)`,
            });
        }
        if (req.body.monthlyBudget !== undefined && target
            && req.body.monthlyBudget !== target.monthly_budget) {
            changes.push({
                action: 'Changed Search Budget',
                description: `${target.label} monthly search budget `
                    + `${target.monthly_budget} → ${req.body.monthlyBudget} credits`,
            });
        }
        for (const [field, column, what] of [
            ['leaseExpiryMinutes', 'lease_expiry_minutes', 'Lease expiry (minutes)'],
            ['unpreparedExpiryHours', 'unprepared_expiry_hours', 'Unprepared expiry (hours)'],
            ['reviewExpiryDays', 'review_expiry_days', 'Review expiry (days)'],
            ['postingStaleDays', 'posting_stale_days', 'Posting ageing (days)'],
            ['timezone', 'timezone', 'Agency timezone'],
        ]) {
            if (req.body[field] !== undefined && req.body[field] !== before[column]) {
                changes.push({
                    action: 'Changed Discovery Setting',
                    description: `${what} ${before[column]} → ${after[column]}`,
                });
            }
        }
        if (req.body.datePosted !== undefined
            && req.body.datePosted !== before.discovery_date_posted) {
            changes.push({
                action: 'Changed Recency Window',
                description: `Job recency window ${before.discovery_date_posted} → `
                    + `${after.discovery_date_posted}`,
            });
        }

        for (const change of changes) {
            logAction({
                orgId: req.user.orgId,
                module: 'discovery',
                action: change.action,
                entityType: 'DiscoverySchedule',
                entityId: req.user.orgId,
                entityName: after.name,
                performedBy: req.user.id,
                performedByRole: req.user.role,
                description: change.description,
                ipAddress: req.ip,
            }).catch(() => {});
        }

        const now = new Date();
        const available = isSchedulerAvailable();
        const cycleHours = clampCycleHours(after.discovery_cycle_hours);

        const { rows: last } = await query(
            `SELECT started_at FROM discovery_runs
              WHERE organization_id = $1 AND trigger = 'SCHEDULED'
              ORDER BY started_at DESC LIMIT 1`,
            [req.user.orgId],
        );
        const lastRunAt = last[0]?.started_at ?? null;
        const providersAfter = await loadProviders(req.user.orgId);
        const activeProvider = providersAfter.find((p) => p.is_enabled) ?? providersAfter[0] ?? null;
        const spend = await monthlyBudgetState(
            req.user.orgId, activeProvider?.monthly_budget ?? 0, 'MANUAL',
        );

        return res.json({
            message: 'Discovery settings saved.',
            enabled: after.discovery_schedule_enabled,
            cycleHours,
            datePosted: after.discovery_date_posted,
            timezone: after.timezone || schedulerTimezone(),
            leaseExpiryMinutes: after.lease_expiry_minutes,
            unpreparedExpiryHours: after.unprepared_expiry_hours,
            reviewExpiryDays: after.review_expiry_days,
            postingStaleDays: after.posting_stale_days,
            monthlyBudget: spend.budget,
            creditsUsedThisMonth: spend.used,
            percentUsed: spend.percentUsed,
            runsPerDay: runsPerDay(cycleHours),
            schedulerAvailable: available,
            serverTime: now.toISOString(),
            nextRunAt: after.discovery_schedule_enabled && available
                ? nextRunAfter(lastRunAt, cycleHours, now).toISOString()
                : null,
            lastScheduledRunAt: lastRunAt,
        });
    } catch (err) {
        return next(err);
    }
};
