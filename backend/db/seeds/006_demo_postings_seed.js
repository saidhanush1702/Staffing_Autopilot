/**
 * Seed 006 — demo job postings.
 * Phase: 5/6
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────
 *
 * Without it, nothing about matching, de-duplication, the daily cap, lane
 * routing or the queue can be demonstrated or tested without a paid API key and
 * real credits. That made the most intricate part of the system the one part
 * nobody could look at.
 *
 * ── THESE POSTINGS ARE ENGINEERED, NOT DECORATIVE ─────────────────────
 *
 * Each one is here to make a specific rule visible:
 *
 *   · strong matches        the scorer should queue these
 *   · near-misses           the cheap pre-filter (R-16) should drop them
 *                           BEFORE any expensive work
 *   · an excluded company   a hard no, however well it otherwise scores
 *   · an excluded keyword   the same, via the description
 *   · a punctuation twin    R-15 must collapse it into one posting with two
 *                           sightings, not create a second row
 *   · both lanes            portals the app can fill, and portals it cannot
 *
 * So a run against this set is a readable assertion about the engine, and a
 * demo shows the rules actually working rather than a list of jobs.
 *
 * Attributed to MANUAL, because nothing here came from a provider — pretending
 * otherwise would corrupt per-board yield reporting.
 */
import { v4 as uuidv4 } from 'uuid';
import { fingerprintPosting } from '../../config/fingerprint.js';

const R = 'React Developer';

/**
 * `portal` decides the lane: an automatable portal goes to the desktop app,
 * anything else goes to the consultant in the portal. Both are represented so
 * the split is visible the moment a run happens.
 */
const POSTINGS = [
    // ── strong matches, BOT lane ──────────────────────────────────────
    { company: 'Globex', title: R, location: 'Dallas, TX', portal: 'LINKEDIN', source: 'LINKEDIN',
        pay: [65, 80, 'HOURLY'], desc: 'React and TypeScript on a modern front end. Hooks, testing, CI.' },
    { company: 'Initech', title: 'Frontend Engineer', location: 'Austin, TX', portal: 'WELLFOUND', source: 'WELLFOUND',
        pay: [70, 85, 'HOURLY'], desc: 'Building customer-facing React interfaces in TypeScript.' },
    { company: 'Umbrella Systems', title: 'Senior React Developer', location: 'Remote', remote: true,
        portal: 'BUILTIN', source: 'BUILTIN', pay: [120000, 150000, 'ANNUAL'],
        desc: 'Senior React role. TypeScript throughout, design system ownership.' },
    { company: 'Vandelay Industries', title: R, location: 'Dallas, TX', portal: 'CRUNCHBOARD', source: 'CRUNCHBOARD',
        pay: [60, 72, 'HOURLY'], desc: 'React, TypeScript, REST APIs. Contract to hire.' },
    { company: 'Hooli', title: 'Frontend Engineer', location: 'Remote', remote: true,
        portal: 'LINKEDIN', source: 'LINKEDIN', pay: [110000, 135000, 'ANNUAL'],
        desc: 'React and TypeScript. Accessibility-minded team.' },

    // ── strong matches, HUMAN lane (apply through an ATS) ─────────────
    { company: 'Stark Industries', title: R, location: 'Austin, TX', portal: 'GREENHOUSE', source: 'LINKEDIN',
        pay: [68, 82, 'HOURLY'], desc: 'React, TypeScript, GraphQL. Applications through Greenhouse.' },
    { company: 'Wayne Enterprises', title: 'Frontend Engineer', location: 'Dallas, TX', portal: 'LEVER', source: 'BUILTIN',
        pay: [115000, 140000, 'ANNUAL'], desc: 'TypeScript and React. Apply on Lever.' },
    { company: 'Cyberdyne', title: 'Senior Frontend Engineer', location: 'Remote', remote: true,
        portal: 'WORKDAY', source: 'INDEED', pay: [130000, 160000, 'ANNUAL'],
        desc: 'React, TypeScript, micro-frontends. Workday application.' },
    { company: 'Soylent Corp', title: R, location: 'Houston, TX', portal: 'COMPANY_SITE', source: 'OTHER',
        pay: [62, 75, 'HOURLY'], desc: 'React and TypeScript on the careers site.' },

    // ── a second discipline, so one bench does not match everything ────
    { company: 'Massive Dynamic', title: 'Data Analyst', location: 'Dallas, TX', portal: 'LINKEDIN', source: 'LINKEDIN',
        pay: [55, 68, 'HOURLY'], desc: 'SQL and Power BI reporting for a commercial team.' },
    { company: 'Tyrell Corporation', title: 'Data Analyst', location: 'Remote', remote: true,
        portal: 'BUILTIN', source: 'BUILTIN', pay: [95000, 115000, 'ANNUAL'],
        desc: 'SQL, Power BI, dashboards and forecasting.' },

    // ── near-misses: the CHEAP pre-filter should drop these (R-16) ────
    // Right shape, wrong work. If any of these reach the scorer, the
    // pre-filter has stopped doing its job.
    { company: 'Bluth Company', title: 'Sous Chef', location: 'Dallas, TX', portal: 'COMPANY_SITE', source: 'OTHER',
        pay: [22, 28, 'HOURLY'], desc: 'Busy kitchen, evening service.' },
    { company: 'Dunder Mifflin', title: 'Warehouse Associate', location: 'Dallas, TX', portal: 'INDEED', source: 'INDEED',
        pay: [18, 22, 'HOURLY'], desc: 'Picking, packing and stock control.' },
    { company: 'Sterling Cooper', title: 'Account Executive', location: 'Austin, TX', portal: 'COMPANY_SITE', source: 'OTHER',
        pay: [60000, 80000, 'ANNUAL'], desc: 'B2B sales, outbound pipeline.' },
    // Right title, wrong city — location is half the pre-filter.
    { company: 'Pied Piper', title: R, location: 'Boston, MA', portal: 'LINKEDIN', source: 'LINKEDIN',
        pay: [70, 85, 'HOURLY'], desc: 'React and TypeScript. On-site in Boston only.' },

    // ── hard noes: these must NEVER queue, however well they score ────
    // Excluded company. A perfect match on every other axis, which is the
    // point — it proves exclusion runs before scoring, not after.
    { company: 'Acme Staffing', title: 'Senior React Developer', location: 'Dallas, TX',
        portal: 'LINKEDIN', source: 'LINKEDIN', pay: [90, 110, 'HOURLY'],
        desc: 'React and TypeScript. Excellent rate.' },
    // Excluded keyword, and it is in the DESCRIPTION rather than the title,
    // so it only fails if the whole text is being read.
    { company: 'Nakatomi Trading', title: R, location: 'Dallas, TX', portal: 'WELLFOUND', source: 'WELLFOUND',
        pay: null, desc: 'Unpaid internship building React and TypeScript components.' },

    // ── the R-15 twin ────────────────────────────────────────────────
    // Same job as Globex above, differently punctuated and cased, with hiring
    // noise in the title. It must collapse into ONE posting with two sightings.
    // If a second row appears, a consultant gets queued the same job twice and
    // applies twice to one employer.
    { company: 'Globex, Inc.', title: 'React Developer - URGENT HIRING', location: 'dallas tx',
        portal: 'LINKEDIN', source: 'LINKEDIN', pay: [65, 80, 'HOURLY'],
        desc: 'React and TypeScript on a modern front end.' },

    // ── volume, so the cap has something to hold back ─────────────────
    { company: 'Aperture Labs', title: 'Frontend Engineer', location: 'Dallas, TX', portal: 'BUILTIN', source: 'BUILTIN',
        pay: [64, 78, 'HOURLY'], desc: 'React, TypeScript, component library work.' },
    { company: 'Black Mesa', title: R, location: 'Austin, TX', portal: 'GREENHOUSE', source: 'LINKEDIN',
        pay: [66, 79, 'HOURLY'], desc: 'React and TypeScript, data-heavy interfaces.' },
];

export const runSeed006 = async (connection) => {
    console.log('Seeding demo job postings...');

    const { rows: orgs } = await connection.query(
        "SELECT id, name FROM organizations WHERE name = 'Molina Staffing'",
    );
    if (orgs.length === 0) {
        console.log('  ~ no demo organisation — skipped');
        return;
    }

    const ids = async (table) => {
        const { rows } = await connection.query(`SELECT id, name FROM ${table}`);
        return Object.fromEntries(rows.map((r) => [r.name, r.id]));
    };
    const portals = await ids('lkp_portal_types');
    const sources = await ids('lkp_job_sources');

    for (const org of orgs) {
        let created = 0;
        let merged = 0;

        for (const p of POSTINGS) {
            const posting = {
                company: p.company,
                title: p.title,
                locationText: p.location,
                isRemote: p.remote ?? false,
            };
            // The same fingerprint the discovery engine computes, so the twin
            // above genuinely collides rather than merely looking similar.
            const fingerprint = fingerprintPosting(posting);

            const { rows: existing } = await connection.query(
                'SELECT id FROM job_postings WHERE organization_id = $1 AND fingerprint = $2',
                [org.id, fingerprint],
            );

            let postingId;
            if (existing[0]) {
                postingId = existing[0].id;
                merged += 1;
                await connection.query(
                    `UPDATE job_postings
                        SET last_seen_at = now(), times_seen = times_seen + 1
                      WHERE id = $1`,
                    [postingId],
                );
            } else {
                postingId = uuidv4();
                created += 1;
                await connection.query(
                    `INSERT INTO job_postings
                        (id, organization_id, company, title, location_text, is_remote,
                         description, source_url, portal_type_id, first_source_id,
                         pay_min, pay_max, pay_unit, pay_currency, fingerprint, posted_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())`,
                    [postingId, org.id, p.company, p.title, p.location, p.remote ?? false,
                        p.desc,
                        `https://example.invalid/demo/${fingerprint.slice(0, 12)}`,
                        portals[p.portal] ?? portals.OTHER,
                        sources[p.source] ?? sources.MANUAL,
                        p.pay?.[0] ?? null, p.pay?.[1] ?? null, p.pay?.[2] ?? null,
                        p.pay ? 'USD' : null,
                        fingerprint],
                );
            }

            // A sighting either way, so a merged twin is inspectable rather
            // than silently absorbed.
            await connection.query(
                `INSERT INTO job_posting_sightings
                    (id, organization_id, posting_id, source_id, source_url)
                 VALUES ($1,$2,$3,$4,$5)`,
                [uuidv4(), org.id, postingId, sources[p.source] ?? sources.MANUAL,
                    `https://example.invalid/demo/${fingerprint.slice(0, 12)}`],
            );
        }

        console.log(`  ✓ ${org.name}: ${created} postings, ${merged} merged by fingerprint `
            + `(from ${POSTINGS.length} rows — the merge is R-15 working)`);
    }
};
