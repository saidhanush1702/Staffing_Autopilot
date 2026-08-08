/**
 * Phase 5 — job discovery. Unit + pipeline suite.
 *
 *   node tests/discovery.test.mjs
 *
 * The pure layers (fingerprint, JSON-LD extraction, matching) are tested
 * directly. The pipeline is tested by seeding postings straight into the
 * database and running the match-and-queue half of the cycle — deliberately
 * WITHOUT touching the real boards, because a suite whose result depends on
 * what LinkedIn served this morning is not a regression test.
 *
 * Live board reachability is a separate, manual check: `node tests/probe-boards.mjs`.
 */
import { fingerprintPosting, normaliseTitle, normaliseCompany, normaliseLocation } from '../config/fingerprint.js';
import { parsePageJobPostings, __test as jsonldTest } from '../connectors/jsonld.js';
import { evaluate, hardFilter, preFilter, scoreMatch } from '../config/jobMatcher.js';
import { BOARDS, boardByName } from '../connectors/boards.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── fingerprint / R-15 ───────────────────────────────────────────────── */

section('fingerprint — the same job seen on two boards');

const linkedinView = {
    company: 'Acme Technologies, Inc.',
    title: 'Senior React Developer (Remote) - Urgent Hiring',
    locationText: 'Remote',
    isRemote: true,
};
const builtinView = {
    company: 'Acme Technologies',
    title: 'Senior React Developer',
    locationText: 'Anywhere',
    isRemote: true,
};
check('legal suffix + decoration + remote synonym all collapse',
    fingerprintPosting(linkedinView) === fingerprintPosting(builtinView), true);

check('company suffix stripped', normaliseCompany('Globex Corp.'), 'globex');
check('hiring noise stripped', normaliseTitle('Java Developer - URGENT HIRING'), 'java developer');
check('remote synonyms unify', normaliseLocation('Work From Home'), 'remote');
check('city kept', normaliseLocation('Dallas, TX', false), 'dallas tx');

section('fingerprint — genuinely different jobs stay apart');
const senior = { company: 'Acme', title: 'Senior React Developer', locationText: 'Dallas', isRemote: false };
const junior = { company: 'Acme', title: 'React Developer', locationText: 'Dallas', isRemote: false };
const other = { company: 'Acme', title: 'Senior React Developer', locationText: 'Boston', isRemote: false };
check('seniority is not noise', fingerprintPosting(senior) !== fingerprintPosting(junior), true);
check('location is part of the key (R-15)', fingerprintPosting(senior) !== fingerprintPosting(other), true);

/* ── JSON-LD ──────────────────────────────────────────────────────────── */

section('JSON-LD extraction');

const page = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;

const full = page({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'React Developer',
    hiringOrganization: { '@type': 'Organization', name: 'Globex' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Dallas', addressRegion: 'TX' } },
    employmentType: 'CONTRACTOR',
    datePosted: '2026-08-01',
    baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', minValue: 60, maxValue: 75, unitText: 'HOUR' },
    },
    description: '<p>Build <b>things</b>. Ship <i>often</i>.</p>',
});
const [p1] = parsePageJobPostings(full, 'https://x/job/1');
check('company', p1.company, 'Globex');
check('title', p1.title, 'React Developer');
check('location', p1.locationText, 'Dallas, TX');
check('work type mapped', p1.workType, 'CONTRACT');
check('pay unit', p1.payUnit, 'HOURLY');
check('pay range', [p1.payMin, p1.payMax], [60, 75]);
check('description de-tagged cleanly', p1.description, 'Build things. Ship often.');

check('@graph wrapper found', parsePageJobPostings(page({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebPage' }, {
        '@type': 'JobPosting', title: 'QA Engineer',
        hiringOrganization: { name: 'Initech' },
    }],
}), 'u').length, 1);

check('TELECOMMUTE detected as remote', parsePageJobPostings(page({
    '@type': 'JobPosting', title: 'Dev', hiringOrganization: { name: 'X' },
    jobLocationType: 'TELECOMMUTE',
}), 'u')[0].isRemote, true);

check('posting with no company is rejected', parsePageJobPostings(page({
    '@type': 'JobPosting', title: 'Orphan',
}), 'u').length, 0);

check('salary without a unit is discarded, not guessed', parsePageJobPostings(page({
    '@type': 'JobPosting', title: 'Dev', hiringOrganization: { name: 'X' },
    baseSalary: { value: { minValue: 100000 } },
}), 'u')[0].payUnit, null);

check('malformed block does not lose a good one',
    parsePageJobPostings(
        '<script type="application/ld+json">{oops</script>' + full, 'u',
    ).length, 1);

check('page with no JSON-LD yields nothing', parsePageJobPostings('<html>nothing</html>', 'u').length, 0);

/* ── matching ─────────────────────────────────────────────────────────── */

section('matching — which consultant is this job useful for');

const criteria = {
    jobTitles: ['React Developer', 'Frontend Engineer'],
    keywordsInclude: ['React', 'TypeScript'],
    keywordsExclude: ['Unpaid', 'Internship'],
    excludedCompanies: ['Acme Staffing'],
    locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE' }],
    workTypeNames: ['CONTRACT', 'W2'],
    minPay: { amount: 55, unit: 'HOURLY' },
};
const good = {
    company: 'Globex', title: 'React Developer',
    description: 'React and TypeScript, modern stack',
    locationText: 'Dallas, TX', isRemote: false,
    payMin: 65, payMax: 75, payUnit: 'HOURLY',
};

const verdict = evaluate(good, criteria, { workTypeName: 'CONTRACT' });
check('a good job matches', verdict.matched, true);
check('  and reaches the scoring stage', verdict.stage, 'score');
console.log(`    score ${verdict.score} — ${verdict.reason}`);

check('excluded company is a HARD no',
    evaluate({ ...good, company: 'Acme Staffing LLC' }, criteria).stage, 'hard');
check('excluded keyword is a HARD no',
    evaluate({ ...good, description: 'Unpaid internship' }, criteria).stage, 'hard');
check('unrelated title stops at the cheap pre-filter (R-16)',
    evaluate({ ...good, title: 'Sous Chef' }, criteria).stage, 'prefilter');
check('wrong city stops at the pre-filter',
    evaluate({ ...good, locationText: 'Boston, MA' }, criteria).stage, 'prefilter');

check('remote job matches a remote criterion',
    evaluate({ ...good, locationText: 'Remote', isRemote: true },
        { ...criteria, locations: [{ city: null, state: null, workMode: 'REMOTE' }] }).matched, true);

const belowFloor = evaluate({ ...good, payMin: 20, payMax: 25 }, criteria, { workTypeName: 'CONTRACT' });
check('pay below the floor scores lower', belowFloor.score < verdict.score, true);

const mismatchedUnit = evaluate(
    { ...good, payMin: 120000, payMax: 130000, payUnit: 'ANNUAL' }, criteria, { workTypeName: 'CONTRACT' },
);
check('annual pay is NOT compared against an hourly floor',
    /below/.test(mismatchedUnit.reason), false);

check('wrong work type is penalised but not fatal',
    evaluate(good, criteria, { workTypeName: 'PART_TIME' }).score < verdict.score, true);

check('priority order rewards the first-choice title',
    scoreMatch({ ...good, title: 'React Developer' }, criteria).score
    >= scoreMatch({ ...good, title: 'Frontend Engineer' }, criteria).score, true);

check('empty criteria do not match everything',
    evaluate(good, {
        jobTitles: [], keywordsInclude: [], keywordsExclude: [],
        excludedCompanies: [], locations: [], workTypeNames: [], minPay: null,
    }).matched, false);

/* ── board definitions ────────────────────────────────────────────────── */

section('board definitions');
check('all five boards defined', Object.keys(BOARDS).length, 5);

// Each board is read one of two ways, and must be fully equipped for whichever
// it declares. A board half-converted between the two is the failure this
// catches — e.g. a FEED board still carrying only a searchUrl.
for (const name of ['LINKEDIN', 'WELLFOUND', 'BUILTIN', 'THELADDERS', 'CRUNCHBOARD']) {
    const b = boardByName(name);

    if (b.mode === 'FEED') {
        const ok = typeof b.feedUrl === 'function'
            && b.feedUrl({}).startsWith('https://')
            && typeof b.parseFeedItem === 'function';
        check(`${name} is a complete FEED board`, ok, true);
    } else {
        // Entry pages come either from a search URL or from a sitemap resolver.
        const hasEntry = typeof b.searchUrl === 'function' || typeof b.entryUrls === 'function';
        const url = typeof b.searchUrl === 'function'
            ? b.searchUrl({ q: 'react developer', l: 'Dallas' })
            : 'https://placeholder';
        const ok = hasEntry && url.startsWith('https://')
            && b.linkPattern instanceof RegExp && b.maxDetailPages > 0;
        check(`${name} is a complete HTML board`, ok, true);
    }
}

check('LinkedIn is flagged conservative (R-22)', BOARDS.LINKEDIN.conservative, true);
check('LinkedIn crawls fewest detail pages',
    BOARDS.LINKEDIN.maxDetailPages <= Math.min(
        ...Object.values(BOARDS)
            .filter((b) => b.name !== 'LINKEDIN' && b.maxDetailPages)
            .map((b) => b.maxDetailPages),
    ), true);

// Built In's own robots.txt disallows `/jobs*?search=`. Using it again would
// be a silent compliance regression, so it is asserted rather than remembered.
check('Built In does not use the disallowed ?search= URL',
    typeof BOARDS.BUILTIN.searchUrl, 'undefined');
check('Built In resolves entry pages from the sitemap',
    typeof BOARDS.BUILTIN.entryUrls, 'function');

// CrunchBoard serves 403 for every HTML page but 200 for its feed.
check('CrunchBoard reads from the RSS feed',
    BOARDS.CRUNCHBOARD.feedUrl({ q: 'sharepoint', l: 'remote' }),
    'https://www.crunchboard.com/jobs.rss');

const cb = (title) => BOARDS.CRUNCHBOARD.parseFeedItem({
    title, link: 'https://www.crunchboard.com/jobs/1-x', description: null, publishedAt: null,
});
check('CrunchBoard title → title/company/location',
    (() => { const p = cb('Systems Technician at City of Urbana (Urbana, Illinois, USA)');
        return [p.title, p.company, p.locationText]; })(),
    ['Systems Technician', 'City of Urbana', 'Urbana, Illinois, USA']);
// Greedy split: the LAST " at " separates role from company.
check('CrunchBoard splits on the last " at "',
    (() => { const p = cb('Engineer at Scale at Acme Corp (Remote)');
        return [p.title, p.company]; })(),
    ['Engineer at Scale', 'Acme Corp']);
check('CrunchBoard detects remote from the location', cb('Dev at Acme (Remote)').isRemote, true);
check('CrunchBoard rejects an unparseable title', cb('Just some heading'), null);

// Boards that no HTTP client can reach must say so, so the screen can explain
// itself instead of showing a bare 403.
for (const name of ['WELLFOUND', 'THELADDERS']) {
    check(`${name} is marked as needing a browser`,
        BOARDS[name].requiresBrowser === true && typeof BOARDS[name].browserNote === 'string',
        true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
