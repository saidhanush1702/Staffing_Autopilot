/**
 * Seed 005 — job boards, portal types, queue states.
 * Phase: 5
 *
 * ── EVERY BOARD IS SEEDED DISABLED ────────────────────────────────────
 *
 * `is_enabled = FALSE` for all five. Nothing is fetched from the open web
 * until somebody turns a board on deliberately, which makes the first outbound
 * request a decision somebody made rather than a side effect of running a
 * migration.
 *
 * Rate limits are deliberately slow. LinkedIn is slowest and shallowest of the
 * five, per R-22's demand for "the most conservative treatment" — lowest
 * volume, and a full stop for the rest of the run on any bot-check challenge.
 *
 * ── WHAT EACH BOARD ACTUALLY DOES, AS VERIFIED BY LIVE PROBE ──────────
 *
 * The notes below are the honest state of each board rather than an
 * aspiration, because they are what an operator reads before deciding what to
 * switch on. Two boards work over plain HTTP; three cannot, for two quite
 * different reasons — one policy, two technical. See connectors/boards.js.
 */

const SOURCES = [
    {
        name: 'LINKEDIN',
        label: 'LinkedIn Jobs',
        fetch_mode: 'HTTP',
        base_url: 'https://www.linkedin.com',
        rate_limit_ms: 15000,
        max_pages: 1,
        notes: 'Not fetchable. LinkedIn\'s robots.txt is a single site-wide '
            + '"Disallow: /" for all crawlers, so every request is refused before it '
            + 'is sent, and an auth wall sits behind it regardless. R-22 anticipated '
            + 'this. Use manual entry for LinkedIn roles.',
    },
    {
        name: 'WELLFOUND',
        label: 'Wellfound',
        fetch_mode: 'HTTP',
        base_url: 'https://wellfound.com',
        rate_limit_ms: 8000,
        max_pages: 2,
        notes: 'Needs a rendered browser. robots.txt permits the job paths, but '
            + 'Cloudflare answers 403 to every HTTP client — including the sitemap '
            + 'Wellfound declares itself. No RSS feed. Skipped until browser '
            + 'rendering exists; enabling it now costs nothing and yields nothing.',
    },
    {
        name: 'BUILTIN',
        label: 'Built In',
        fetch_mode: 'HTTP',
        base_url: 'https://builtin.com',
        rate_limit_ms: 6000,
        max_pages: 2,
        notes: 'Working — the board to enable first. Entry pages come from Built In\'s '
            + 'published job-board sitemap, since robots.txt disallows the ?search= URL. '
            + 'Most detail pages carry schema.org JobPosting; the rest fall back to the '
            + 'meta description.',
    },
    {
        name: 'THELADDERS',
        label: 'TheLadders',
        fetch_mode: 'HTTP',
        base_url: 'https://www.theladders.com',
        rate_limit_ms: 8000,
        max_pages: 2,
        notes: 'Needs a rendered browser. Cloudflare answers 403 to everything, '
            + 'including robots.txt itself — so their crawl policy cannot even be read, '
            + 'and we correctly stay away. Subscription board; most detail is behind a '
            + 'login even for a person.',
    },
    {
        name: 'CRUNCHBOARD',
        label: 'CrunchBoard',
        fetch_mode: 'HTTP',
        base_url: 'https://www.crunchboard.com',
        rate_limit_ms: 5000,
        max_pages: 2,
        notes: 'Working, via RSS. Every HTML page answers 403, but the feed at '
            + '/jobs.rss returns 200 — so the feed is the only door, and it is one meant '
            + 'for machines. The feed ignores search terms and carries very few jobs, so '
            + 'expect low volume rather than a broken board.',
    },
    {
        name: 'MANUAL',
        label: 'Added by hand',
        fetch_mode: 'MANUAL',
        base_url: null,
        rate_limit_ms: 1000,
        max_pages: 1,
        notes: 'Always available. Never fetched.',
    },
    {
        name: 'CSV',
        label: 'CSV import',
        fetch_mode: 'CSV',
        base_url: null,
        rate_limit_ms: 1000,
        max_pages: 1,
        notes: 'Bulk import. Never fetched.',
    },
];

const PORTAL_TYPES = [
    ['LINKEDIN', 'LinkedIn'],
    ['WELLFOUND', 'Wellfound'],
    ['BUILTIN', 'Built In'],
    ['THELADDERS', 'TheLadders'],
    ['CRUNCHBOARD', 'CrunchBoard'],
    ['COMPANY_SITE', 'Company careers page'],
    ['OTHER', 'Other'],
];

/**
 * The queue vocabulary. Phase 5 only ever produces QUEUED — the rest exist so
 * the states a later phase will move items through are constrained from the
 * start rather than invented ad hoc when something finally moves them.
 */
const QUEUE_STATUSES = [
    ['QUEUED', 'Queued', false, 1],
    ['FILLED', 'Form filled', false, 2],
    ['PARKED_UNKNOWN', 'Parked — needs an answer', false, 3],
    ['AWAITING_SUBMIT', 'Awaiting submit', false, 4],
    ['SUBMITTED', 'Submitted', true, 5],
    ['SKIPPED', 'Skipped', true, 6],
];

export const runSeed005 = async (connection) => {
    console.log('Seeding job sources and queue states...');

    for (const s of SOURCES) {
        await connection.query(
            `INSERT INTO lkp_job_sources
                (name, label, fetch_mode, base_url, rate_limit_ms, max_pages, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (name) DO UPDATE
                SET label = EXCLUDED.label,
                    fetch_mode = EXCLUDED.fetch_mode,
                    base_url = EXCLUDED.base_url,
                    notes = EXCLUDED.notes`,
            // is_enabled is absent on purpose: re-seeding must never silently
            // switch a board back on that an operator turned off.
            [s.name, s.label, s.fetch_mode, s.base_url, s.rate_limit_ms, s.max_pages, s.notes],
        );
    }

    for (const [name, label] of PORTAL_TYPES) {
        await connection.query(
            `INSERT INTO lkp_portal_types (name, label) VALUES ($1,$2)
             ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label`,
            [name, label],
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

    console.log(`  ✓ ${SOURCES.length} sources (all disabled), `
        + `${PORTAL_TYPES.length} portal types, ${QUEUE_STATUSES.length} queue states`);
};
