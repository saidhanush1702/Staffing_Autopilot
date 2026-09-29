/**
 * ── HOW FRESH ARE JOBSPIPE'S JOBS, REALLY? ────────────────────────────
 *
 * The measurement this whole trial exists for. SerpApi finds what Google Jobs
 * has INDEXED, and indexing lags publication — the complaint that started this
 * is that recently-posted roles are not turning up. JobsPipe claims to see
 * postings as they are published. This script checks that claim with numbers
 * instead of taking it on faith.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────
 *
 * It writes NOTHING to the database. No postings, no matches, no queue items,
 * no event rows. It is a read-only probe, so it can be run against production
 * credentials without touching the pool the pipeline works from. The ingestion
 * path is a separate file (jobs/jobspipePoller.js) and is off by default.
 *
 * ── ONE RUN = ONE CREDIT ──────────────────────────────────────────────
 *
 * 1 credit = 1 request, and the Free Tier is 100 a MONTH. So this makes
 * exactly ONE call per invocation and never paginates on its own. Ask for a
 * big page instead — the page size is free, the call is not.
 *
 * It also saves the raw response to disk, which matters more than it sounds:
 * it means the field mapping can be re-checked, and the webhook adapter's
 * unverified ACCEPTED_PATHS corrected, WITHOUT spending another credit.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────
 *
 *   node scripts/jobspipe-freshness.mjs
 *   node scripts/jobspipe-freshness.mjs --titles "React Developer,Frontend Engineer"
 *   node scripts/jobspipe-freshness.mjs --max-age-days 1 --limit 100 --country US
 *   node scripts/jobspipe-freshness.mjs --dry-run     # spends nothing
 */
import { writeFileSync } from 'node:fs';
import { searchJobs, isConfigured } from '../connectors/jobspipeApi.js';
import { searchJobToPosting } from '../connectors/jobspipeSearch.js';

/* ── arguments ────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const titles = (arg('titles') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const maxAgeDays = Number(arg('max-age-days', process.env.JOBSPIPE_MAX_AGE_DAYS ?? 2));
const limit = Number(arg('limit', process.env.JOBSPIPE_PAGE_SIZE ?? 50));
const country = arg('country');
const remoteOnly = flag('remote');
const dryRun = flag('dry-run');
const outPath = arg('out', `jobspipe-raw-${Date.now()}.json`);

/* ── presentation ─────────────────────────────────────────────────────── */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

const rule = (label = '') => {
    const line = '─'.repeat(Math.max(0, 74 - label.length));
    console.log(`${DIM}${label ? `── ${label} ` : ''}${line}${OFF}`);
};

/** Age in hours, or null when the feed gave us no date at all. */
const ageHours = (iso, now) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : (now - t) / 3_600_000;
};

const humanAge = (hours) => {
    if (hours === null) return `${DIM}no date${OFF}`;
    if (hours < 1) return `${GREEN}${Math.round(hours * 60)}m${OFF}`;
    if (hours < 24) return `${GREEN}${hours.toFixed(1)}h${OFF}`;
    if (hours < 24 * 7) return `${YELLOW}${(hours / 24).toFixed(1)}d${OFF}`;
    return `${RED}${(hours / 24).toFixed(0)}d${OFF}`;
};

/* ── the buckets the decision actually turns on ───────────────────────── */
//
// Chosen against the discovery cycle's own cadence, not round numbers. The
// cycle runs every 6 hours by default, so anything JobsPipe surfaces inside
// that window is time the current setup structurally cannot beat, and anything
// older than a day is what SerpApi was already finding.
const BUCKETS = [
    { label: '< 1h    (published minutes ago)', max: 1 },
    { label: '1 – 6h  (inside one cycle)', max: 6 },
    { label: '6 – 24h (same day)', max: 24 },
    { label: '1 – 2d', max: 48 },
    { label: '2 – 7d', max: 24 * 7 },
    { label: '> 7d    (stale — SerpApi finds these too)', max: Infinity },
];

const main = async () => {
    console.log();
    rule('JOBSPIPE FRESHNESS PROBE');
    console.log(`${DIM}Read-only. Writes nothing to the database.${OFF}`);

    if (!isConfigured()) {
        console.error(`\n${RED}JOBSPIPE_API_KEY is not set in backend/.env${OFF}\n`);
        process.exit(1);
    }

    const filters = {
        limit,
        posted_at_max_age_days: maxAgeDays,
        include_total_results: true,
    };
    if (titles.length) filters.job_title_or = titles;
    if (country) filters.job_country_code_or = [country];
    if (remoteOnly) filters.remote = true;

    console.log(`\n${BOLD}Request${OFF}  POST /v1/jobs/search`);
    console.log(`${JSON.stringify(filters, null, 2).split('\n').map((l) => `         ${l}`).join('\n')}`);

    if (dryRun) {
        console.log(`\n${YELLOW}--dry-run: no request made, no credit spent.${OFF}\n`);
        return;
    }

    console.log(`\n${YELLOW}Spending 1 credit…${OFF}`);
    const started = Date.now();
    const res = await searchJobs(filters);
    const elapsed = Date.now() - started;
    const now = Date.now();

    /* ── save the raw body before analysing it ───────────────────────── */
    //
    // Deliberately first. This body is the only artefact that lets the field
    // mapping be corrected later without paying for another call, and a crash
    // in the analysis below must not cost us it.
    writeFileSync(outPath, JSON.stringify(res, null, 2), 'utf8');

    console.log(`${GREEN}✓${OFF} ${res.data.length} job(s) in ${elapsed}ms `
        + `· ${res.requests} credit(s) spent · raw body → ${outPath}`);

    console.log();
    rule('METADATA');
    console.log(res.metadata);

    if (res.data.length === 0) {
        console.log(`\n${YELLOW}No jobs matched. Widen --max-age-days or drop --titles.${OFF}\n`);
        return;
    }

    /* ── the freshness answer ────────────────────────────────────────── */
    //
    // Ages come from the ADAPTED posting, not raw `date_posted`. Measured
    // against a live page, 11 of 25 jobs carried a date_posted in the FUTURE —
    // one claimed 2026-09-21 while discovered_at said 2026-08-11, six weeks
    // earlier. Those rows report a NEGATIVE age and sort to the top as "the
    // freshest jobs in the feed", which would make this script's headline
    // number a fabrication. resolvePostedAt() overrules them; see the adapter.
    const all = res.data.map((j) => ({ raw: j, a: searchJobToPosting(j, { now: new Date(now) }) }));
    const suspect = all.filter(({ a }) => a?.freshness.suspectDate).length;

    const ages = all
        .map(({ a }) => ageHours(a?.freshness.datePosted, now))
        .filter((h) => h !== null && h >= 0)
        .sort((a, b) => a - b);

    console.log();
    rule('AGE AT THE MOMENT WE ASKED  (corrected posted date → now)');

    if (suspect > 0) {
        const pct = Math.round((suspect / res.data.length) * 100);
        console.log(`  ${YELLOW}⚠ ${suspect}/${res.data.length} (${pct}%) had date_posted AFTER discovered_at${OFF}`);
        console.log(`  ${DIM}  — impossible, so discovered_at was used instead. Raw date_posted`);
        console.log(`      is not a publication date on those rows.${OFF}\n`);
    }

    const counts = BUCKETS.map(() => 0);
    for (const h of ages) {
        counts[BUCKETS.findIndex((b) => h < b.max)] += 1;
    }
    const widest = Math.max(...counts, 1);
    BUCKETS.forEach((b, i) => {
        const n = counts[i];
        const bar = '█'.repeat(Math.round((n / widest) * 34));
        const pct = ages.length ? ((n / ages.length) * 100).toFixed(0) : '0';
        console.log(`  ${b.label.padEnd(42)} ${String(n).padStart(4)}  ${pct.padStart(3)}%  ${bar}`);
    });

    if (ages.length) {
        const pick = (p) => ages[Math.min(ages.length - 1, Math.floor(ages.length * p))];
        console.log();
        console.log(`  ${BOLD}median${OFF} ${humanAge(pick(0.5))}`
            + `   ${BOLD}p25${OFF} ${humanAge(pick(0.25))}`
            + `   ${BOLD}p75${OFF} ${humanAge(pick(0.75))}`
            + `   ${BOLD}freshest${OFF} ${humanAge(ages[0])}`
            + `   ${BOLD}oldest${OFF} ${humanAge(ages[ages.length - 1])}`);
    }

    /* ── the feed's own latency ──────────────────────────────────────── */
    //
    // date_posted → discovered_at is how long JOBSPIPE took to see a posting.
    // That number, not the age above, is the ceiling on how fast this feed
    // could ever deliver — and it is the honest version of "real-time".
    // Only the rows where the ordering is actually possible. A negative lag is
    // not a fast discovery, it is the bad-date problem above — averaging its
    // absolute value would report "41d freshest" and mean nothing.
    const lags = all
        .filter(({ raw, a }) => raw.date_posted && raw.discovered_at && !a?.freshness.suspectDate)
        .map(({ raw }) => (new Date(raw.discovered_at).getTime()
            - new Date(raw.date_posted).getTime()) / 3_600_000)
        .filter((h) => Number.isFinite(h) && h >= 0)
        .sort((a, b) => a - b);

    console.log();
    rule("JOBSPIPE'S OWN LATENCY  (published → JobsPipe saw it)");
    if (lags.length) {
        console.log(`  ${lags.length}/${res.data.length} job(s) have a usable pair of timestamps`);
        console.log(`  median ${humanAge(lags[Math.floor(lags.length / 2)])}`
            + `   fastest ${humanAge(lags[0])}`
            + `   slowest ${humanAge(lags[lags.length - 1])}`);
        console.log(`  ${DIM}This is the floor on delivery speed — no push feed can beat`);
        console.log(`  the moment JobsPipe itself noticed the posting.${OFF}`);
    } else {
        console.log(`  ${YELLOW}Not measurable on this page: no job has both timestamps in a`);
        console.log(`  possible order.${OFF}`);
    }

    /* ── does our adapter actually survive real data? ────────────────── */
    //
    // The point the handoff flagged and could not answer: the webhook mapping
    // was written from what this pipeline wants, never from a live delivery.
    // Now there is live data, so it gets checked.
    console.log();
    rule('ADAPTER CHECK  (real payload → our posting shape)');

    const adapted = all.map(({ a }) => a);
    const ok = adapted.filter(Boolean);
    const rejected = adapted.length - ok.length;

    const missing = {
        locationText: 0, workType: 0, payUnit: 0, postedAt: 0, description: 0,
    };
    for (const a of ok) {
        for (const k of Object.keys(missing)) {
            if (a.posting[k] === null || a.posting[k] === undefined || a.posting[k] === '') {
                missing[k] += 1;
            }
        }
    }

    console.log(`  normalised ${GREEN}${ok.length}${OFF} / ${adapted.length}`
        + (rejected ? `   ${RED}rejected ${rejected}${OFF} (no company, title or usable URL)` : ''));
    console.log(`  ${DIM}fields null after mapping — a high count means a wrong path,`);
    console.log(`  not a quiet feed:${OFF}`);
    for (const [field, n] of Object.entries(missing)) {
        const pct = ok.length ? Math.round((n / ok.length) * 100) : 0;
        const tone = pct > 50 ? RED : pct > 20 ? YELLOW : GREEN;
        console.log(`    ${field.padEnd(14)} ${tone}${String(n).padStart(4)} null  ${String(pct).padStart(3)}%${OFF}`);
    }

    /* ── where in the world these jobs are ───────────────────────────── */
    //
    // The filter that decides whether this feed is usable at all. JobsPipe is
    // global and an unfiltered page is whatever the world published in the last
    // day — which for a US bench is mostly noise it paid a credit for.
    console.log();
    rule('COUNTRY  (is this feed even pointed at the right market?)');

    const byCountry = {};
    for (const { raw } of all) {
        const c = raw.country_code ?? raw.country ?? '??';
        byCountry[c] = (byCountry[c] ?? 0) + 1;
    }
    const ranked = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);
    for (const [code, n] of ranked) {
        const pct = Math.round((n / all.length) * 100);
        const tone = code === 'US' ? GREEN : DIM;
        console.log(`  ${tone}${code.padEnd(4)}${OFF} ${String(n).padStart(4)}  ${String(pct).padStart(3)}%  `
            + `${'█'.repeat(Math.round((n / all.length) * 34))}`);
    }
    if (!byCountry.US || byCountry.US / all.length < 0.5) {
        console.log(`\n  ${YELLOW}⚠ Under half this page is US. Pass --country US — an unfiltered`);
        console.log(`    poll spends the same credit on jobs nobody here can fill.${OFF}`);
    }

    /* ── the sample itself ───────────────────────────────────────────── */

    console.log();
    rule('FRESHEST 15');
    const rows = all
        .map(({ raw, a }) => ({ j: raw, a, h: ageHours(a?.freshness.datePosted, now) }))
        .sort((x, y) => (x.h ?? 1e9) - (y.h ?? 1e9))
        .slice(0, 15);

    for (const { j, a, h } of rows) {
        const pay = a?.posting.payUnit
            ? `${a.posting.payMin ?? '?'}–${a.posting.payMax ?? '?'} ${a.posting.payUnit}`
            : `${DIM}no pay${OFF}`;
        console.log(`  ${humanAge(h).padEnd(18)} ${BOLD}${String(j.job_title).slice(0, 38).padEnd(38)}${OFF} `
            + `${String(j.company ?? '—').slice(0, 22).padEnd(22)} `
            + `${String(a?.posting.locationText ?? '—').slice(0, 20).padEnd(20)} `
            + `${a?.posting.workType ?? `${DIM}—${OFF}`}  ${pay}`);
        console.log(`    ${DIM}posted ${j.date_posted ?? '—'}  ·  seen ${j.discovered_at ?? '—'}`
            + `  ·  via ${a?.originBoard ?? '—'}  ·  ${j.country_code ?? '??'}`
            + `${a?.freshness.suspectDate ? `  ${YELLOW}[date overruled]${DIM}` : ''}${OFF}`);
    }

    /* ── what to compare it against ──────────────────────────────────── */

    console.log();
    rule('NEXT');
    console.log(`  Compare against what SerpApi is giving you, same question:`);
    console.log(`  ${DIM}SELECT ROUND(AVG(EXTRACT(EPOCH FROM (now() - posted_at)) / 3600)) AS avg_age_hours,`);
    console.log(`         COUNT(*) FILTER (WHERE posted_at > now() - INTERVAL '24 hours') AS last_24h,`);
    console.log(`         COUNT(*) AS total`);
    console.log(`    FROM job_postings p JOIN lkp_job_sources s ON s.id = p.source_id`);
    console.log(`   WHERE s.name <> 'JOBSPIPE' AND p.posted_at IS NOT NULL;${OFF}`);
    console.log();
};

main().catch((err) => {
    console.error(`\n${RED}Probe failed:${OFF} ${err.message}\n`);
    process.exit(1);
});
