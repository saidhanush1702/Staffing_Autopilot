/**
 * ── THE JOBSPIPE PULL PATH, FROM THE UI ───────────────────────────────
 *
 * The operator surface for the third ingestion door, shaped to match the
 * SerpApi one so the two read the same way on the Job Discovery screen:
 *
 *   SerpApi    POST /api/management/discovery/run   → triggerRun
 *   JobsPipe   POST /api/management/jobspipe/poll   → runPollNow   (this file)
 *
 * Both spend real money, both write into the same pool through the same
 * fingerprint and matcher, and both are ORG_ADMIN because of it.
 *
 * ── WHY THE SETTINGS ROUTE IS SEPARATE FROM THE WEBHOOK'S ─────────────
 *
 * `jobspipeListener.js` already serves `GET /api/management/jobspipe`, which
 * describes the PUSH endpoint: its secret, its delivery log, its funnel. This
 * file describes the PULL path: the credit ledger, the month's allowance, and
 * the search terms a poll would use. They share a provider name and nothing
 * else — one is billed per delivery received, the other per request made — so
 * merging them would produce a screen where "is it working" has two different
 * answers under one heading.
 *
 * ── THE CREDIT RULE THAT SHAPES EVERY ROUTE HERE ──────────────────────
 *
 * 1 credit = 1 REQUEST, the Free Tier is 100 a MONTH, and a page is capped at
 * 25 jobs. So:
 *
 *   · `GET /poll/preview` spends NOTHING. It returns the exact filters a run
 *     would send, so the expensive button is never the way to find out what
 *     the cheap question would have answered.
 *   · every poll writes a `jobspipe_poll_runs` row, and the guard reads the
 *     month-to-date sum BEFORE spending.
 *   · the response carries `creditsSpent` and what remains, because a number
 *     that only appears in a log is a number nobody sees until it is gone.
 */
import Joi from 'joi';
import { query } from '../db.js';
import { runPoll, remainingCredits } from '../jobs/jobspipePoller.js';
import { isConfigured } from '../connectors/jobspipeApi.js';
import { SOURCE_NAME } from '../connectors/jobspipeSearch.js';
import { loadMatchableConsultants } from './discoveryController.js';
import { logAction } from './auditLogController.js';

/** Same cap the poller applies, restated so the preview cannot disagree. */
const MAX_TITLES_PER_POLL = 12;

/**
 * The search terms a poll would use, derived from the bench.
 *
 * Ranked by how many consultants asked for each title, alphabetical tie-break
 * so the answer is reproducible — the same non-determinism that made the
 * webhook's test button generate a different job on every press.
 */
const benchTitles = (bench) => {
    const demand = new Map();
    for (const consultant of bench) {
        for (const t of consultant.criteria.jobTitles ?? []) {
            demand.set(t, (demand.get(t) ?? 0) + 1);
        }
    }
    return [...demand.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_TITLES_PER_POLL)
        .map(([title, count]) => ({ title, consultants: count }));
};

/* ── every other JobsPipe filter, under its own API name ──────────────── */
//
// Validated against the allowed values in JobsPipe's Filter reference
// (docs.jobspipe.dev/api-reference/filters). A value outside those lists is
// refused HERE rather than sent: the API does not reject an unknown enum, it
// matches nothing — an empty page that still costs the credits.
//
// The filters the panel already exposes by friendlier names (titles,
// countries, employmentTypes, sources, remote, maxAgeDays, limit) stay out of
// this object so there is exactly one way to send each of them.

export const JOBSPIPE_SOURCES = [
    'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday',
    'paylocity', 'linkedin', 'indeed', 'ycombinator',
];
const SENIORITY = ['entry_level', 'mid_level', 'senior', 'director', 'executive'];
const EMPLOYER_TYPES = ['employer', 'agency', 'broker'];
const WORK_ARRANGEMENTS = ['remote', 'hybrid', 'onsite'];
const VISA = ['offers', 'no', 'citizenship_required'];
const UNKNOWN_FIELDS = [
    'employment_type', 'seniority', 'work_arrangement', 'location', 'occupation',
    'industry', 'visa_sponsorship', 'benefits', 'company_size', 'salary',
];
const BENEFITS = [
    'health_insurance', 'dental_insurance', 'vision_insurance', 'life_insurance',
    'disability_insurance', 'paid_time_off', 'paid_holidays', '401k', '401k_matching',
    'retirement_plan', 'tuition_reimbursement', 'parental_leave',
    'flexible_spending_account', 'health_savings_account', 'employee_discount',
    'commuter_assistance', 'employee_assistance_program', 'flexible_schedule', 'bonus',
    'signing_bonus', 'profit_sharing', 'equity', 'paid_training',
    'professional_development', 'free_parking', 'relocation_assistance',
    'wellness_program', 'referral_program', 'childcare', 'loan_repayment',
    'phone_reimbursement', 'work_from_home',
];

const textList = (max = 20) => Joi.array().items(Joi.string().trim().min(1).max(120)).max(max);
const pick = (values) => Joi.array().items(Joi.string().valid(...values)).max(values.length);

const apiFiltersSchema = Joi.object({
    // role
    job_title_not: textList(),
    description_or: textList(),
    description_not: textList(),
    job_seniority_or: pick(SENIORITY),
    include_unlabeled_seniority: Joi.boolean(),
    include_unlabeled_employment_type: Joi.boolean(),
    skills_or: textList(40),
    esco_skill_id_or: textList(40),
    occupation_code_or: Joi.array().items(Joi.string().pattern(/^\d{1,4}$/)).max(20),
    isic_division_or: Joi.array().items(Joi.string().pattern(/^\d{2}$/)).max(20),
    // location
    job_country_code_not: Joi.array().items(Joi.string().trim().uppercase().length(2)).max(20),
    job_location_or: textList(),
    region_or: Joi.array().items(Joi.string().trim().uppercase().pattern(/^[A-Z]{2}-[A-Z0-9]{1,3}$/)).max(60),
    metro_code_or: Joi.array().items(Joi.string().trim().pattern(/^\d{5}$/)).max(20),
    work_arrangement_or: pick(WORK_ARRANGEMENTS),
    // dates and freshness
    posted_at_gte: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
    posted_at_lte: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
    discovered_at_gte: Joi.string().pattern(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    status: Joi.string().valid('active', 'closed', 'any'),
    last_verified_max_age_days: Joi.number().integer().min(1).max(365),
    // company and source
    company_name_or: textList(),
    company_name_partial_match_or: textList(),
    min_employee_count: Joi.number().integer().min(0),
    max_employee_count: Joi.number().integer().min(0),
    source_not: pick(JOBSPIPE_SOURCES),
    employer_type_or: pick(EMPLOYER_TYPES),
    employer_type_not: pick(EMPLOYER_TYPES),
    // pay, perks, quality
    min_salary_usd: Joi.number().min(0).max(10_000_000),
    visa_sponsorship_or: pick(VISA),
    benefits_or: pick(BENEFITS),
    include_unknown: pick(UNKNOWN_FIELDS),
    max_applicant_count: Joi.number().integer().min(0),
    has_recruiter_email: Joi.boolean(),
    max_ghost_score: Joi.number().min(0).max(100),
});

/* ── the filter payload the Advanced panel sends ──────────────────────── */

export const pollSchema = Joi.object({
    // Absent means "use the bench", which is what the one-click button sends.
    titles: Joi.array().items(Joi.string().trim().min(2).max(120)).max(MAX_TITLES_PER_POLL),
    countries: Joi.array().items(Joi.string().trim().uppercase().length(2)).max(10),
    employmentTypes: Joi.array().items(Joi.string().trim().max(40)).max(10),
    sources: Joi.array().items(Joi.string().trim().max(40)).max(15),
    remote: Joi.boolean(),
    maxAgeDays: Joi.number().integer().min(1).max(30),
    // Capped at 25 because that is the Free Tier's page ceiling — asking for
    // more is not refused by the API, it is silently truncated, which looks
    // like a thin feed rather than a plan limit.
    limit: Joi.number().integer().min(1).max(100),
    // Everything else JobsPipe accepts, by its API name — see apiFiltersSchema.
    filters: apiFiltersSchema,
}).default({});

export const pullEnabledSchema = Joi.object({
    isEnabled: Joi.boolean().required(),
});

/* ── GET /api/management/jobspipe/pull ────────────────────────────────── */

/**
 * Status, allowance, and the last few polls. Spends nothing.
 */
export const getPullStatus = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const budget = await remainingCredits(orgId);
        const bench = await loadMatchableConsultants(orgId);

        const { rows: runs } = await query(
            `SELECT id, started_at, finished_at, trigger, outcome, filters,
                    credits_spent, jobs_returned, unusable, new_postings,
                    duplicates, matches_created, queued_count,
                    preparation_enqueued, age_hours_min, age_hours_median,
                    age_hours_max, posted_last_24h, duration_ms, error,
                    board_breakdown
               FROM jobspipe_poll_runs
              WHERE organization_id = $1
              ORDER BY started_at DESC
              LIMIT 25`,
            [orgId],
        );

        // Attributed postings, the same honest yield figure the SerpApi board
        // list shows: a source switched on that has contributed nothing is
        // visible here and nowhere else.
        const { rows: yieldRows } = await query(
            `SELECT COUNT(*)::int AS postings
               FROM job_postings p
               JOIN lkp_job_sources s ON s.id = p.first_source_id
              WHERE p.organization_id = $1 AND s.name = $2`,
            [orgId, SOURCE_NAME],
        );

        // Per-board yield — the JobsPipe counterpart of the SerpApi board list.
        // SerpApi can count by first_source_id because each board is a source
        // row; every JobsPipe posting shares ONE source row (so pushed and
        // polled jobs de-duplicate), so the board lives on origin_board instead
        // (migration 046). NULL groups the postings ingested before the board
        // was stored, kept visible rather than silently dropped.
        const { rows: boardRows } = await query(
            `SELECT p.origin_board AS board, COUNT(*)::int AS postings
               FROM job_postings p
               JOIN lkp_job_sources s ON s.id = p.first_source_id
              WHERE p.organization_id = $1 AND s.name = $2
              GROUP BY p.origin_board
              ORDER BY postings DESC`,
            [orgId, SOURCE_NAME],
        );

        return res.json({
            configured: isConfigured(),
            enabled: budget.enabled,
            budget: {
                monthly: budget.budget,
                spent: budget.spent,
                remaining: budget.remaining,
            },
            // What a one-click run would ask for, so the cheap question is
            // answerable without pressing the expensive button.
            plan: {
                titles: benchTitles(bench),
                benchSize: bench.length,
                maxAgeDays: Number(process.env.JOBSPIPE_MAX_AGE_DAYS ?? 2),
                limit: Number(process.env.JOBSPIPE_PAGE_SIZE ?? 50),
            },
            // The poller's cron is off unless this is true; the button works
            // regardless, which is the distinction the screen has to make.
            scheduleEnabled: process.env.JOBSPIPE_POLL_ENABLED === 'true',
            scheduleCron: process.env.JOBSPIPE_POLL_CRON ?? '0 */6 * * *',
            postings: yieldRows[0]?.postings ?? 0,
            boards: boardRows,
            runs,
        });
    } catch (err) { return next(err); }
};

/* ── GET /api/management/jobspipe/poll/preview ────────────────────────── */

/**
 * Exactly what a run would send, without sending it. FREE.
 *
 * This exists because the alternative — press the button and read the filters
 * off the resulting ledger row — costs a credit to answer a question about
 * configuration. On a hundred-a-month plan that is not a rounding error.
 */
export const previewPoll = async (req, res, next) => {
    try {
        const bench = await loadMatchableConsultants(req.user.orgId);
        const titles = benchTitles(bench).map((t) => t.title);
        const budget = await remainingCredits(req.user.orgId);

        return res.json({
            filters: {
                job_title_or: titles,
                posted_at_max_age_days: Number(process.env.JOBSPIPE_MAX_AGE_DAYS ?? 2),
                limit: Number(process.env.JOBSPIPE_PAGE_SIZE ?? 50),
            },
            benchSize: bench.length,
            wouldSpend: titles.length > 0 ? 1 : 0,
            blocked: titles.length === 0
                ? 'No active consultant has a job title to search for.'
                : null,
            budget,
        });
    } catch (err) { return next(err); }
};

/* ── POST /api/management/jobspipe/poll ───────────────────────────────── */

/**
 * Run one poll now. SPENDS ONE CREDIT and writes into the pool.
 *
 * Mirrors `triggerRun` for SerpApi: ORG_ADMIN only, audited, and it returns
 * the run record rather than a bare acknowledgement so the screen can show
 * what the credit bought without a second request.
 *
 * An empty body is the one-click case — the bench decides. A body is the
 * Advanced panel, and every field in it only ever NARROWS the search.
 */
export const runPollNow = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;

        if (!isConfigured()) {
            return res.status(503).json({
                error: 'JOBSPIPE_API_KEY is not set on the server.',
            });
        }

        const budget = await remainingCredits(orgId);
        if (!budget.enabled) {
            return res.status(409).json({
                error: 'The JobsPipe pull path is switched off for this organisation. '
                    + 'Turn it on before running a poll.',
            });
        }
        // Refused here as well as inside runPoll, so the screen gets a 429 it
        // can explain rather than a run row that says BUDGET_HIT.
        if (budget.remaining <= 0) {
            return res.status(429).json({
                error: `This month's JobsPipe allowance is used up — `
                    + `${budget.spent}/${budget.budget} credits. It resets on the 1st.`,
                budget,
            });
        }

        const body = req.body ?? {};
        const run = await runPoll(orgId, {
            trigger: 'MANUAL',
            titles: body.titles?.length ? body.titles : null,
            countries: body.countries ?? null,
            employmentTypes: body.employmentTypes ?? null,
            sources: body.sources ?? null,
            remote: typeof body.remote === 'boolean' ? body.remote : null,
            filters: body.filters ?? null,
            ...(body.maxAgeDays ? { maxAgeDays: body.maxAgeDays } : {}),
            ...(body.limit ? { limit: body.limit } : {}),
        });

        logAction({
            orgId,
            module: 'discovery',
            action: 'Ran a JobsPipe poll',
            entityType: 'JobsPipePollRun',
            entityId: run.id,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `${run.outcome} — ${run.credits} credit(s), `
                + `${run.returned} job(s) returned, ${run.queued} queued.`,
            ipAddress: req.ip,
        });

        const after = await remainingCredits(orgId);
        return res.status(201).json({
            message: 'JobsPipe poll complete.',
            run,
            budget: after,
        });
    } catch (err) { return next(err); }
};

/* ── PATCH /api/management/jobspipe/pull ──────────────────────────────── */

/**
 * Switch the pull path on or off for this agency.
 *
 * The same shape as enabling a search board, and audited for the same reason:
 * this is the moment an agency starts spending a metered allowance.
 */
export const setPullEnabled = async (req, res, next) => {
    try {
        const { rowCount } = await query(
            `UPDATE organization_providers op
                SET is_enabled = $2
              WHERE op.organization_id = $1
                AND op.source_id = (SELECT id FROM lkp_job_sources WHERE name = $3)`,
            [req.user.orgId, req.body.isEnabled, SOURCE_NAME],
        );
        if (rowCount === 0) {
            return res.status(404).json({
                error: 'No JobsPipe provider row for this organisation. Run the migrations.',
            });
        }

        logAction({
            orgId: req.user.orgId,
            module: 'discovery',
            action: req.body.isEnabled
                ? 'Enabled the JobsPipe pull path'
                : 'Disabled the JobsPipe pull path',
            entityType: 'JobsPipeProvider',
            entityId: req.user.orgId,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            ipAddress: req.ip,
        });

        return res.json({ isEnabled: req.body.isEnabled });
    } catch (err) { return next(err); }
};
