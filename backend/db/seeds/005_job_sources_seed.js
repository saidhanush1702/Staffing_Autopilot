/**
 * Seed 005 — the search provider, the boards it attributes to, portal types,
 * and the queue vocabulary.
 * Phase: 5 (v2)
 *
 * ── ONE PROVIDER, MANY BOARDS ─────────────────────────────────────────
 *
 * Exactly one row is ever fetched: GOOGLE_JOBS, and it ships DISABLED. Nothing
 * reaches the network until somebody turns it on deliberately, so the first
 * outbound request — and the first API credit spent — is a decision rather than
 * a side effect of running the migrations.
 *
 * Every other row is a PORTAL: a board Google attributes postings to. Portals
 * are never fetched, so they ship ENABLED. The five named in the specification
 * are flagged `is_priority` and lead the list; the rest are bonus coverage that
 * the crawler era could not reach at all.
 *
 * ── WHY EVERYTHING IS KEPT ────────────────────────────────────────────
 *
 * A job is a job. If Google surfaces a good role from Indeed, a Greenhouse
 * board or an employer's own careers page, that is a real lead for a real
 * consultant and throwing it away to honour a list of five would be the tail
 * wagging the dog. The five boards are the PRIORITY set — what we make sure to
 * cover — not an allowlist that discards the rest.
 *
 * The switches still exist, per board, for the operator who wants them.
 */

/** Fetched. Exactly one, and it starts switched off. */
const PROVIDER = {
    name: 'GOOGLE_JOBS',
    label: 'Google Jobs (SerpApi)',
    fetch_mode: 'PROVIDER',
    base_url: 'https://serpapi.com/search.json',
    // Pacing between successive API calls. A paid API does not need the long
    // courtesy gaps a crawler did — this only smooths bursts.
    rate_limit_ms: 1000,
    // Result pages per search term, ten results each. EVERY PAGE IS ONE CREDIT,
    // so this is a budget dial before it is a coverage dial.
    max_pages: 2,
    is_enabled: false,
    is_priority: false,
    notes: 'The only source that is fetched. Needs SERPAPI_KEY in .env. '
        + 'Every other row below is attribution: which board Google says a '
        + 'posting came from. Credits per run = search terms x pages.',
};

/** The five named in the specification, in the priority order given. */
const PRIORITY_PORTALS = [
    ['LINKEDIN', 'LinkedIn', 'Reached through Google\'s index. LinkedIn refuses every '
        + 'crawler at robots.txt, so this was unreachable before — and no request is '
        + 'ever made to LinkedIn now, which satisfies R-22 more cleanly than a slow '
        + 'crawler did. Dense in Google Jobs.'],
    ['WELLFOUND', 'Wellfound', 'Reached through Google\'s index. Cloudflare blocks all '
        + 'direct access. Moderate volume — startup roles, often remote.'],
    ['BUILTIN', 'Built In', 'Reached through Google\'s index, including their per-city '
        + 'sites (Chicago, NYC, Austin and the rest), which count as one board here. '
        + 'Dense in Google Jobs.'],
    ['THELADDERS', 'TheLadders', 'Reached through Google\'s index. Thin — TheLadders is '
        + 'a subscription board and Google indexes little of it. Expect quiet, not broken.'],
    ['CRUNCHBOARD', 'CrunchBoard', 'Reached through Google\'s index. Thin — a small board '
        + 'with low posting volume. Expect quiet, not broken.'],
];

/**
 * Boards Google Jobs surfaces often. None of these were reachable under the
 * crawler design; all of them carry real roles.
 */
const OTHER_PORTALS = [
    ['INDEED', 'Indeed', 'High volume. The largest single contributor in most searches.'],
    ['GLASSDOOR', 'Glassdoor', 'Good volume, frequently mirrors employer career pages.'],
    ['ZIPRECRUITER', 'ZipRecruiter', 'Good volume, strong on contract and staffing roles.'],
    ['DICE', 'Dice', 'Technology contract roles — a close fit for most consultant benches.'],
    ['MONSTER', 'Monster', 'Moderate volume.'],
    ['SIMPLYHIRED', 'SimplyHired', 'Aggregator; often duplicates other boards, which R-15 collapses.'],
    ['TALENT_COM', 'Talent.com', 'Aggregator, moderate volume.'],
    ['JOOBLE', 'Jooble', 'Aggregator, moderate volume.'],
    ['CAREERBUILDER', 'CareerBuilder', 'Moderate volume.'],
    ['SNAGAJOB', 'Snagajob', 'Mostly hourly and shift work. Low relevance to most benches.'],
    ['GREENHOUSE_BOARD', 'Greenhouse job board', 'Employer boards hosted on Greenhouse.'],
    ['LEVER_BOARD', 'Lever job board', 'Employer boards hosted on Lever.'],
    ['OTHER', 'Other source', 'Anything Google attributes to a board not listed above — '
        + 'most often an employer\'s own careers page. Kept, because a good job is a '
        + 'good job wherever it was listed.'],
];

/** Never fetched, always available. */
const ENTRY_SOURCES = [
    ['MANUAL', 'Added by hand', 'Always available. Never fetched.'],
    ['CSV', 'CSV import', 'Bulk import. Never fetched.'],
];

/**
 * Which system the application is actually filled on — read from the apply
 * link's host, not from the board.
 *
 * A job listed on LinkedIn that applies through Workday is a LINKEDIN source
 * and a WORKDAY portal type. The distinction is load-bearing for the phase that
 * fills forms: a Workday form and a Greenhouse form share nothing.
 */
/**
 * Which system an application is filled on, and whether the desktop app has a
 * form recipe for it.
 *
 * `automatable` drives the BOT/HUMAN lane on every new queue item. It is a flag
 * rather than a hard-coded list precisely because the set will grow: teaching
 * the app a new system should be a row update and a recipe file, never a schema
 * change.
 *
 * Only the boards that host their own application form are automatable today.
 * The rest — Greenhouse, Lever, Workday, an employer's own careers page — are
 * where a redirected job lands, and those go to the consultant as "needs you".
 */
const PORTAL_TYPES = [
    // Applicant tracking systems. A redirected job lands on one of these.
    ['GREENHOUSE', 'Greenhouse', false],
    ['LEVER', 'Lever', false],
    ['WORKDAY', 'Workday', false],
    ['ASHBY', 'Ashby', false],
    ['SMARTRECRUITERS', 'SmartRecruiters', false],
    ['ICIMS', 'iCIMS', false],
    ['TALEO', 'Oracle Taleo', false],
    ['JOBVITE', 'Jobvite', false],
    ['WORKABLE', 'Workable', false],
    ['BAMBOOHR', 'BambooHR', false],
    ['RECRUITEE', 'Recruitee', false],
    ['BREEZY', 'Breezy HR', false],
    // Boards you can apply on without leaving them — the automated set.
    // LinkedIn is included because Easy Apply is hosted here; a LinkedIn job
    // that turns out to redirect is reclassified to the HUMAN lane when the
    // app opens it, since that cannot be told from the link alone.
    ['LINKEDIN', 'LinkedIn', true],
    ['WELLFOUND', 'Wellfound', true],
    ['BUILTIN', 'Built In', true],
    ['CRUNCHBOARD', 'CrunchBoard', true],
    // Deferred pending the subscription decision — it requires a paid
    // membership per consultant to apply.
    ['THELADDERS', 'TheLadders', false],
    ['INDEED', 'Indeed', false],
    ['GLASSDOOR', 'Glassdoor', false],
    ['ZIPRECRUITER', 'ZipRecruiter', false],
    ['DICE', 'Dice', false],
    ['MONSTER', 'Monster', false],
    // Fallbacks.
    ['COMPANY_SITE', 'Company careers page', false],
    ['OTHER', 'Other', false],
];

/** The four final states an application can rest in. */
const APPLICATION_STATUSES = [
    ['SUBMITTED', 'Submitted', 1],
    ['WAITING_ON_CONSULTANT', 'Waiting on the consultant', 2],
    ['STALLED_ON_LOGIN', 'Stalled on login', 3],
    ['SKIPPED', 'Skipped', 4],
];

/**
 * How an application was made — a different question from whether it succeeded.
 *
 * `is_witnessed` is the one that matters for trust: the first two were observed
 * by software, the last two are somebody's account of something that happened
 * elsewhere. Reporting that cannot tell them apart overstates what it knows.
 */
const SUBMISSION_METHODS = [
    ['DESKTOP_BOT', 'Filled by the app, submitted by the consultant', true, 1],
    ['DESKTOP_ASSISTED', 'Filled by the consultant in the app', true, 2],
    ['PORTAL_SELF_REPORTED', 'Reported by the consultant', false, 3],
    ['RECORDED_BY_STAFF', 'Recorded by a recruiter or admin', false, 4],
];

/**
 * The queue vocabulary. Phase 5 only ever produces QUEUED — the rest exist so
 * the states a later phase will move items through are constrained from the
 * start rather than invented ad hoc when something finally moves them.
 */
const QUEUE_STATUSES = [
    ['QUEUED', 'Queued', false, 1],
    ['PREPARING', 'Preparing', false, 2],
    ['READY', 'Ready to apply', false, 3],
    ['FILLING', 'Filling the form', false, 4],
    ['PARKED_UNKNOWN', 'Parked — needs an answer', false, 5],
    ['AWAITING_REVIEW', 'Awaiting review', false, 6],
    ['SUBMITTED', 'Submitted', true, 7],
    ['CANCELLED', 'Cancelled', true, 8],
    ['SKIPPED', 'Skipped', true, 9],
];

const toRow = ([name, label, notes], isPriority) => ({
    name,
    label,
    fetch_mode: 'PORTAL',
    base_url: null,
    rate_limit_ms: 1000,
    max_pages: 1,
    is_enabled: true,
    is_priority: isPriority,
    notes,
});

export const runSeed005 = async (connection) => {
    console.log('Seeding search provider, portals and queue states...');

    const sources = [
        PROVIDER,
        ...PRIORITY_PORTALS.map((p) => toRow(p, true)),
        ...OTHER_PORTALS.map((p) => toRow(p, false)),
        ...ENTRY_SOURCES.map(([name, label, notes]) => ({
            name,
            label,
            fetch_mode: name,
            base_url: null,
            rate_limit_ms: 1000,
            max_pages: 1,
            is_enabled: false,
            is_priority: false,
            notes,
        })),
    ];

    for (const s of sources) {
        await connection.query(
            `INSERT INTO lkp_job_sources
                (name, label, fetch_mode, base_url, rate_limit_ms, max_pages,
                 is_enabled, is_priority, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (name) DO UPDATE
                SET label       = EXCLUDED.label,
                    fetch_mode  = EXCLUDED.fetch_mode,
                    base_url    = EXCLUDED.base_url,
                    is_priority = EXCLUDED.is_priority,
                    notes       = EXCLUDED.notes`,
            // is_enabled is absent from the UPDATE on purpose: re-seeding must
            // never switch the provider back on, nor re-enable a board an
            // operator deliberately turned off. It applies to new rows only.
            [s.name, s.label, s.fetch_mode, s.base_url, s.rate_limit_ms,
                s.max_pages, s.is_enabled, s.is_priority, s.notes],
        );
    }

    for (const [name, label, automatable] of PORTAL_TYPES) {
        await connection.query(
            `INSERT INTO lkp_portal_types (name, label, is_automatable) VALUES ($1,$2,$3)
             ON CONFLICT (name) DO UPDATE
                SET label = EXCLUDED.label,
                    is_automatable = EXCLUDED.is_automatable`,
            [name, label, automatable],
        );
    }

    for (const [name, label, order] of APPLICATION_STATUSES) {
        await connection.query(
            `INSERT INTO lkp_application_statuses (name, label, sort_order) VALUES ($1,$2,$3)
             ON CONFLICT (name) DO UPDATE
                SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
            [name, label, order],
        );
    }

    for (const [name, label, witnessed, order] of SUBMISSION_METHODS) {
        await connection.query(
            `INSERT INTO lkp_submission_methods (name, label, is_witnessed, sort_order)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (name) DO UPDATE
                SET label = EXCLUDED.label,
                    is_witnessed = EXCLUDED.is_witnessed,
                    sort_order = EXCLUDED.sort_order`,
            [name, label, witnessed, order],
        );
    }

    for (const [name, label, terminal, order] of QUEUE_STATUSES) {
        await connection.query(
            `INSERT INTO lkp_queue_statuses (name, label, is_terminal, sort_order)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (name) DO UPDATE
                SET label = EXCLUDED.label,
                    is_terminal = EXCLUDED.is_terminal,
                    sort_order = EXCLUDED.sort_order`,
            [name, label, terminal, order],
        );
    }

    console.log(`  ✓ 1 provider (disabled), ${PRIORITY_PORTALS.length} priority portals, `
        + `${OTHER_PORTALS.length} other portals, ${PORTAL_TYPES.length} portal types, `
        + `${QUEUE_STATUSES.length} queue states`);
};
