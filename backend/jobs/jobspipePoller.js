/**
 * ── THE JOBSPIPE PULL PATH ────────────────────────────────────────────
 *
 * A third ingestion door, beside the SerpApi cycle and the JobsPipe webhook,
 * changing nothing about either.
 *
 *   SerpApi cycle     PULLS. Finds what Google Jobs has INDEXED, and indexing
 *                     lags publication — which is the complaint that started
 *                     this: recently-posted roles do not turn up.
 *   JobsPipe webhook  is PUSHED to. Needs a PAID plan, so it cannot be
 *                     trialled. See controllers/jobspipeListener.js.
 *   this              PULLS from JobsPipe's search API. Free Tier, and so the
 *                     only door that can actually be measured.
 *
 * ── CREDITS DECIDE THE WHOLE DESIGN ───────────────────────────────────
 *
 * 1 credit = 1 REQUEST. Free Tier is 100 a MONTH — about three calls a day.
 * A call returning a hundred jobs and a call returning none cost the same.
 *
 * Every shape decision below falls out of that one fact:
 *
 *   · the cron defaults to SIX-HOURLY, not the cycle's fifteen minutes. A
 *     15-minute poll would spend 2,880 credits a month against an allowance
 *     of 100 — it would die on day one and look like a broken integration.
 *   · one page per poll. Pagination buys more jobs at one credit per page,
 *     and on this plan the second page is rarely the best use of the credit.
 *   · the page size is pushed HIGH, because it is free.
 *   · the budget is checked BEFORE the call and the poll refuses rather than
 *     overspending. An allowance discovered after it is gone is not a budget.
 *   · nothing retries a plain 4xx — see connectors/jobspipeApi.js.
 *
 * ── EVERYTHING DOWNSTREAM IS THE EXISTING PIPELINE ────────────────────
 *
 * `ingestAdapted()` is the webhook's own body, imported not copied, so a job
 * that arrives by poll and the same job pushed or found by the cycle collapse
 * onto ONE fingerprint (R-15) and reach a consultant once. The only thing that
 * differs between the doors is the normaliser.
 */
import 'dotenv/config';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { searchJobs, isConfigured, redact } from '../connectors/jobspipeApi.js';
import { searchJobToPosting, SOURCE_NAME } from '../connectors/jobspipeSearch.js';
import { ingestAdapted } from '../controllers/jobspipeListener.js';
import { loadMatchableConsultants } from '../controllers/discoveryController.js';

/**
 * How many distinct job titles one poll asks about.
 *
 * `job_title_or` is a single filter on a single request, so asking about more
 * titles costs nothing extra — but a very long list returns a page dominated
 * by whichever title happens to be busiest, crowding out the rest. Capped so
 * the page stays representative of the bench rather than of one role.
 */
const MAX_TITLES_PER_POLL = 12;

/* ── the budget guard ─────────────────────────────────────────────────── */

/**
 * What this organisation may still spend this calendar month.
 *
 * Two ceilings, and the LOWER wins:
 *
 *   organization_providers.monthly_budget  the agency's plan allowance
 *   JOBSPIPE_MONTHLY_CREDITS              an installation-wide brake, so one
 *                                         misconfigured agency cannot drain a
 *                                         shared key
 *
 * The key is shared across tenants here — it lives in the environment, not
 * per-agency like the webhook secret — which is exactly why the second ceiling
 * exists.
 */
export const remainingCredits = async (orgId) => {
    const { rows } = await query(
        `SELECT p.monthly_budget, p.is_enabled
           FROM organization_providers p
           JOIN lkp_job_sources s ON s.id = p.source_id
          WHERE p.organization_id = $1 AND s.name = $2`,
        [orgId, SOURCE_NAME],
    );
    const provider = rows[0];
    if (!provider) return { enabled: false, remaining: 0, budget: 0, spent: 0 };

    // date_trunc('month') in the SERVER's time, matching how the SerpApi
    // budget is counted. A provider's quota resets on their calendar, not the
    // agency's timezone — this is one of the few figures that is deliberately
    // not in the agency's local day.
    const { rows: spend } = await query(
        `SELECT COALESCE(SUM(credits_spent), 0)::int AS spent
           FROM jobspipe_poll_runs
          WHERE organization_id = $1
            AND started_at >= date_trunc('month', now())`,
        [orgId],
    );

    const envCeiling = Number(process.env.JOBSPIPE_MONTHLY_CREDITS ?? 90);
    const budget = Math.min(provider.monthly_budget, envCeiling);
    const spent = spend[0].spent;

    return {
        enabled: provider.is_enabled,
        budget,
        spent,
        remaining: Math.max(0, budget - spent),
    };
};

/* ── freshness arithmetic ─────────────────────────────────────────────── */

/**
 * The numbers the trial is actually judged on.
 *
 * Age is measured from `date_posted` to NOW — when the employer published to
 * when we could first have acted on it. That is the figure comparable with the
 * same calculation over SerpApi postings, and the comparison is the point.
 */
export const ageStats = (jobs, now = Date.now()) => {
    const ages = jobs
        .map((j) => {
            const t = j?.date_posted ? new Date(j.date_posted).getTime() : NaN;
            return Number.isNaN(t) ? null : (now - t) / 3_600_000;
        })
        .filter((h) => h !== null && Number.isFinite(h))
        .sort((a, b) => a - b);

    if (ages.length === 0) {
        return { min: null, median: null, max: null, last24h: 0, counted: 0 };
    }

    return {
        min: Number(ages[0].toFixed(2)),
        median: Number(ages[Math.floor(ages.length / 2)].toFixed(2)),
        max: Number(ages[ages.length - 1].toFixed(2)),
        last24h: ages.filter((h) => h <= 24).length,
        counted: ages.length,
    };
};

/* ── one poll ─────────────────────────────────────────────────────────── */

/**
 * Poll once for one organisation, and put what comes back through the pipeline.
 *
 * @param {string} orgId
 * @param {object} [opts]
 *   trigger     'SCHEDULED' | 'MANUAL'
 *   titles      override the bench-derived titles
 *   maxAgeDays  recency window; the reason this feed is being trialled
 *   limit       page size (free — ask high)
 *   dryRun      build the request, log it, spend NOTHING
 * @returns the ledger row that was written
 */
export const runPoll = async (orgId, {
    trigger = 'MANUAL',
    titles = null,
    maxAgeDays = Number(process.env.JOBSPIPE_MAX_AGE_DAYS ?? 2),
    limit = Number(process.env.JOBSPIPE_PAGE_SIZE ?? 50),
    // ── the Advanced filters ──────────────────────────────────────────
    //
    // All optional, all narrowing. Measured against the live feed, the first
    // two are the difference between a useful page and a wasted credit:
    //
    //   countries  unfiltered, 1 of 25 jobs was US — the rest Sweden, India
    //              and France. A credit buys the same 25 either way.
    //   sources    an Indeed relay arrives ~7.7h after publication and carries
    //              a daily-granularity timestamp; a direct ATS (greenhouse,
    //              lever, ashby) arrived in 6 MINUTES with a real one. The
    //              freshness this feed is being trialled for lives entirely
    //              in that slice.
    countries = null,
    employmentTypes = null,
    sources = null,
    remote = null,
    // Any further JobsPipe filters, already under their API names and
    // validated by the controller (apiFiltersSchema).
    filters: extraFilters = null,
    dryRun = false,
} = {}) => {
    const runId = uuidv4();
    const startedAt = Date.now();

    const ledger = {
        outcome: 'SKIPPED',
        credits: 0,
        filters: null,
        returned: 0,
        unusable: 0,
        newPostings: 0,
        duplicates: 0,
        matches: 0,
        queued: 0,
        prepared: 0,
        age: { min: null, median: null, max: null, last24h: 0 },
        // Per-board counts for this poll — see migration 047.
        boards: {},
        error: null,
    };

    const finish = async () => {
        await query(
            `INSERT INTO jobspipe_poll_runs
                (id, organization_id, started_at, finished_at, trigger, outcome,
                 filters, credits_spent, jobs_returned, unusable, new_postings,
                 duplicates, matches_created, queued_count, preparation_enqueued,
                 age_hours_min, age_hours_median, age_hours_max, posted_last_24h,
                 duration_ms, error, board_breakdown)
             VALUES ($1,$2,to_timestamp($3/1000.0),now(),$4,$5,$6,$7,$8,$9,$10,
                     $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [runId, orgId, startedAt, trigger, ledger.outcome, ledger.filters,
                ledger.credits, ledger.returned, ledger.unusable, ledger.newPostings,
                ledger.duplicates, ledger.matches, ledger.queued, ledger.prepared,
                ledger.age.min, ledger.age.median, ledger.age.max, ledger.age.last24h,
                Date.now() - startedAt, ledger.error?.slice(0, 500) ?? null,
                // Only a poll that actually fetched has a breakdown; a skipped
                // or budget-refused one stores NULL rather than an empty object.
                Object.keys(ledger.boards).length ? JSON.stringify(ledger.boards) : null],
        );
        return { id: runId, ...ledger };
    };

    try {
        if (!isConfigured()) {
            ledger.error = 'JOBSPIPE_API_KEY is not set.';
            return finish();
        }

        const budget = await remainingCredits(orgId);
        if (!budget.enabled) {
            ledger.error = 'The JobsPipe pull path is switched off for this organisation.';
            return finish();
        }
        if (budget.remaining <= 0) {
            // Refused BEFORE spending. This is the whole point of the ledger.
            ledger.outcome = 'BUDGET_HIT';
            ledger.error = `Monthly allowance exhausted — ${budget.spent}/${budget.budget} `
                + 'credits used. It resets on the 1st.';
            console.warn(`[jobspipe-poll] ${orgId}: ${ledger.error}`);
            return finish();
        }

        /* ── what to ask for ─────────────────────────────────────────── */
        //
        // The bench decides. Asking the feed for everything and filtering here
        // would return a page of jobs nobody on this bench wants, and the page
        // is the thing the credit bought — so the filtering has to happen at
        // the provider, not after it.
        const bench = await loadMatchableConsultants(orgId);
        let wanted = titles;

        if (!wanted) {
            // Ranked by how many consultants asked for each title, with an
            // alphabetical tie-break so a poll is reproducible — the same
            // defect that made the webhook's test button non-deterministic.
            const demand = new Map();
            for (const consultant of bench) {
                for (const t of consultant.criteria.jobTitles ?? []) {
                    demand.set(t, (demand.get(t) ?? 0) + 1);
                }
            }
            wanted = [...demand.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, MAX_TITLES_PER_POLL)
                .map(([t]) => t);
        }

        if (wanted.length === 0) {
            // Nobody to search for. Spending a credit to confirm that would be
            // a credit spent on an empty bench.
            ledger.error = 'No active consultant has a job title to search for.';
            console.log(`[jobspipe-poll] ${orgId}: skipped — ${ledger.error}`);
            return finish();
        }

        const filters = {
            job_title_or: wanted,
            posted_at_max_age_days: maxAgeDays,
            limit,
        };
        // Only send what was actually asked for: an explicit null is not the
        // same thing to the API as an absent filter, and a filter nobody chose
        // narrowing a page they paid for is the worst kind of surprise.
        if (countries?.length) filters.job_country_code_or = countries;
        if (employmentTypes?.length) filters.employment_type_or = employmentTypes;
        if (sources?.length) filters.source_or = sources;
        if (remote === true || remote === false) filters.remote = remote;

        // The rest of the Advanced panel. Empty arrays and blank values are
        // dropped for the same reason as above: only a filter somebody chose
        // may narrow the page.
        for (const [key, value] of Object.entries(extraFilters ?? {})) {
            if (value === null || value === undefined || value === '') continue;
            if (Array.isArray(value) && value.length === 0) continue;
            filters[key] = value;
        }

        ledger.filters = JSON.stringify(filters);

        console.log(`[jobspipe-poll] ${orgId}: ${wanted.length} title(s), `
            + `last ${maxAgeDays}d, limit ${limit} — `
            + `${budget.remaining}/${budget.budget} credits left`);

        if (dryRun) {
            ledger.error = 'Dry run — no request made, no credit spent.';
            return finish();
        }

        /* ── spend the credit ────────────────────────────────────────── */
        const res = await searchJobs(filters);
        ledger.credits = res.requests;
        ledger.returned = res.data.length;
        ledger.outcome = 'OK';

        const stats = ageStats(res.data);
        ledger.age = stats;

        console.log(`[jobspipe-poll] ${orgId}: ${res.data.length} job(s), `
            + `${res.requests} credit(s) — age median `
            + `${stats.median === null ? 'n/a' : `${stats.median}h`}, `
            + `${stats.last24h} posted in the last 24h`);

        /* ── through the existing pipeline ───────────────────────────── */
        //
        // The bench and the lookups are loaded ONCE for the whole page, not per
        // job: neither can change inside one poll, and re-reading them per job
        // is what turns a page of fifty into a slow job.
        for (const job of res.data) {
            const adapted = searchJobToPosting(job);

            // Counted per board for the run's breakdown. An unusable job never
            // adapts, so its board is read straight off the raw payload — it
            // still came from somewhere, and that is part of the yield.
            const boardKey = adapted?.originBoard ?? job?.sources?.[0]?.provider ?? 'unknown';
            const board = ledger.boards[boardKey] ??= {
                returned: 0, new: 0, duplicates: 0, unusable: 0, matched: 0, queued: 0,
            };
            board.returned += 1;

            if (!adapted) {
                ledger.unusable += 1;
                board.unusable += 1;
                continue;
            }

            try {
                const out = await ingestAdapted(orgId, adapted, {
                    consultants: bench,
                    via: 'Polled from JobsPipe',
                });

                if (out.isNew) { ledger.newPostings += 1; board.new += 1; } else { ledger.duplicates += 1; board.duplicates += 1; }
                ledger.matches += out.matches ?? 0;
                ledger.queued += out.queued ?? 0;
                ledger.prepared += out.prepared ?? 0;
                board.matched += out.matches ?? 0;
                board.queued += out.queued ?? 0;
            } catch (err) {
                // One bad job must not discard the rest of a page we paid for.
                console.error(`[jobspipe-poll] job failed: ${redact(err.message)}`);
                ledger.unusable += 1;
                board.unusable += 1;
            }
        }

        console.log(`[jobspipe-poll] ${orgId}: ✓ ${ledger.newPostings} new, `
            + `${ledger.duplicates} already held, ${ledger.unusable} unusable, `
            + `${ledger.matches} matched, ${ledger.queued} queued, `
            + `${ledger.prepared} sent to preparation`);

        return finish();
    } catch (err) {
        ledger.outcome = 'ERROR';
        ledger.error = redact(err.message);
        console.error(`[jobspipe-poll] ${orgId}: failed — ${ledger.error}`);
        return finish();
    }
};

/* ── every organisation that has it switched on ───────────────────────── */

export const pollAllOrgs = async (opts = {}) => {
    const { rows } = await query(
        `SELECT p.organization_id
           FROM organization_providers p
           JOIN lkp_job_sources s ON s.id = p.source_id
           JOIN organizations o ON o.id = p.organization_id
          WHERE s.name = $1 AND p.is_enabled AND o.is_active
          ORDER BY p.organization_id`,
        [SOURCE_NAME],
    );

    const results = [];
    for (const row of rows) {
        // Sequential on purpose. The credit ceiling is per organisation but the
        // KEY is shared, so parallel polls would race each other's budget
        // checks and could overspend a shared allowance.
        results.push(await runPoll(row.organization_id, { ...opts, trigger: 'SCHEDULED' }));
    }
    return results;
};

/* ── the schedule ─────────────────────────────────────────────────────── */

/**
 * Off unless JOBSPIPE_POLL_ENABLED=true, exactly like the worker.
 *
 * A fresh checkout must never start spending somebody's credits because the
 * server booted — the same rule WORKER_ENABLED follows for model calls.
 */
export const startJobsPipePoller = () => {
    if (process.env.JOBSPIPE_POLL_ENABLED !== 'true') {
        console.log('[jobspipe-poll] disabled (JOBSPIPE_POLL_ENABLED is not "true")');
        return null;
    }
    if (!isConfigured()) {
        console.warn('[jobspipe-poll] enabled but JOBSPIPE_API_KEY is not set — not starting.');
        return null;
    }

    const expression = process.env.JOBSPIPE_POLL_CRON ?? '0 */6 * * *';
    if (!cron.validate(expression)) {
        console.error(`[jobspipe-poll] JOBSPIPE_POLL_CRON is not a valid cron: "${expression}"`);
        return null;
    }

    const task = cron.schedule(expression, () => {
        pollAllOrgs().catch((err) => {
            console.error('[jobspipe-poll] cycle failed:', redact(err.message));
        });
    });

    console.log(`✅ JobsPipe poller scheduled (${expression})`);
    return task;
};
