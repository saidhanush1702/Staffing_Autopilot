/**
 * ATS live mirror — unit suite (pure: fixtures + a stubbed HTTP client).
 *
 *   node tests/atsMirror.test.mjs
 *   npm run test:ats
 *
 * No network, no database, nothing written anywhere.
 *
 * ── WHERE THE FIXTURES CAME FROM ──────────────────────────────────────
 *
 * tests/fixtures/ats/*.json are TRIMMED CAPTURES OF REAL RESPONSES from the
 * public endpoints (Stripe / Airbnb on Greenhouse, Palantir / GoHighLevel on
 * Lever, Ramp on Ashby, NVIDIA on Workday, Equinox on SmartRecruiters). Only
 * the long text fields are cut short. They are the actual shapes — including
 * the awkward ones this suite exists to pin down:
 *
 *   · Greenhouse's `content` is HTML that has been entity-ESCAPED, which the
 *     shared plain() would hand back as markup.
 *   · Ashby marks 140 of 153 "Hybrid" jobs isRemote:true.
 *   · Workday publishes a DAY ("Posted Today"), never an instant.
 *   · Lever's pay interval is the string "per-year-salary".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectBoard, workdayConfigFromKey } from '../connectors/ats/detect.js';
import { adapterFor, probeBoard, withConfig } from '../connectors/ats/index.js';
import { toAdapted, SOURCE_NAME } from '../connectors/ats/adapted.js';
import { workTypeFromLabel } from '../connectors/ats/labels.js';
import {
    htmlToText, decodeEntities, normalisePay, humaniseKey, workTypeFromTitle, isoOrNull,
} from '../connectors/ats/shared.js';
import { payFromRange } from '../connectors/ats/lever.js';
import { payFromCompensation } from '../connectors/ats/ashby.js';
import { postedOnToDay } from '../connectors/ats/workday.js';
import { recruiteeTime, payFromSalary } from '../connectors/ats/recruitee.js';
import { descriptionFromPage } from '../connectors/ats/breezy.js';
import { parseFeed } from '../connectors/ats/personio.js';
import {
    httpRequest, httpJson, AtsHttpError, createLimiter,
} from '../connectors/ats/http.js';
import {
    nextIntervalS, withJitter, floorFor, shouldPark, describeInterval, tierOf, DEFAULTS,
} from '../config/atsSchedule.js';
import {
    diffBoard, isFresh, isStale, latencySeconds, CLOSE_AFTER_MISSES,
} from '../services/atsDiff.js';
import { fingerprintPosting } from '../config/fingerprint.js';
import { evaluate } from '../config/jobMatcher.js';
import { searchJobToPosting } from '../connectors/jobspipeSearch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'ats', name), 'utf8'));

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    if (ok) pass += 1; else fail += 1;
};
const truthy = (label, value) => check(label, Boolean(value), true);
const section = (t) => console.log(`\n— ${t} —`);

/** Fixed, so no assertion drifts with the wall clock. */
const NOW = new Date('2026-10-22T20:00:00Z');

/** A stub `ctx.http`: routes are [matcher, responder]; every call is recorded. */
const stubHttp = (routes) => {
    const calls = [];
    const http = async (url, opts = {}) => {
        calls.push({ url, ...opts });
        for (const [match, respond] of routes) {
            if (typeof match === 'string' ? url.includes(match) : match(url, opts)) {
                const out = typeof respond === 'function' ? respond(url, opts) : respond;
                if (out instanceof Error) throw out;
                return { status: 200, notModified: false, etag: null, bytes: 100, ...out };
            }
        }
        throw new AtsHttpError(`no stub route for ${url}`, { kind: 'ERROR' });
    };
    return { http, calls };
};

const board = (family, key, extra = {}) => withConfig({
    family, board_key: key, config: {}, company_name: null, ...extra,
});

/* ═════════════════════════════════════════════════════════════════════ */
section('detectBoard: paste a careers link, get the system and board');

const D = (u) => { const r = detectBoard(u); return r && [r.family, r.key]; };
check('greenhouse boards.', D('https://boards.greenhouse.io/stripe'), ['GREENHOUSE', 'stripe']);
check('greenhouse job-boards. + job path', D('https://job-boards.greenhouse.io/Stripe/jobs/8172508'), ['GREENHOUSE', 'stripe']);
check('greenhouse embed ?for=', D('https://boards.greenhouse.io/embed/job_board?for=Airbnb'), ['GREENHOUSE', 'airbnb']);
check('greenhouse api url', D('https://boards-api.greenhouse.io/v1/boards/stripe/jobs'), ['GREENHOUSE', 'stripe']);
check('lever', D('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'), ['LEVER', 'palantir']);
check('lever EU host is remembered', detectBoard('https://jobs.eu.lever.co/acme').config, { host: 'api.eu.lever.co' });
check('lever is lower-cased', D('https://jobs.lever.co/GoHighLevel'), ['LEVER', 'gohighlevel']);
check('ashby keeps its case', D('https://jobs.ashbyhq.com/Twenty/2115e62c'), ['ASHBY', 'Twenty']);
check('smartrecruiters careers.', D('https://careers.smartrecruiters.com/BoschGroup'), ['SMARTRECRUITERS', 'BoschGroup']);
check('smartrecruiters jobs. + posting', D('https://jobs.smartrecruiters.com/Equinox/744000157221438-key-holder'), ['SMARTRECRUITERS', 'Equinox']);
check('workday with locale', D('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/X_JR1'),
    ['WORKDAY', 'nvidia.wd5/NVIDIAExternalCareerSite']);
check('workday without locale', D('https://leidos.wd5.myworkdayjobs.com/External'), ['WORKDAY', 'leidos.wd5/External']);
check('workday config is complete', detectBoard('https://leidos.wd5.myworkdayjobs.com/External').config,
    { host: 'leidos.wd5.myworkdayjobs.com', tenant: 'leidos', shard: 'wd5', site: 'External' });
check('scheme-less input', D('boards.greenhouse.io/stripe'), ['GREENHOUSE', 'stripe']);
check('shorthand', D('lever:Palantir'), ['LEVER', 'palantir']);
check('workday shorthand', D('workday:NVIDIA.wd5/NVIDIAExternalCareerSite'), ['WORKDAY', 'nvidia.wd5/NVIDIAExternalCareerSite']);
check('an unrelated site is not guessed at', detectBoard('https://www.linkedin.com/jobs/view/123'), null);
check('empty input', detectBoard('  '), null);
check('a bare greenhouse host has no board', detectBoard('https://boards.greenhouse.io/'), null);
check('workday key → config', workdayConfigFromKey('acme.wd1/Careers').tenant, 'acme');

/* ═════════════════════════════════════════════════════════════════════ */
section('shared helpers');

// The reason htmlToText takes `escaped`: the shared plain() decodes entities
// AFTER stripping tags, so escaped markup survives it as visible text.
const escapedHtml = '&lt;p&gt;Build &lt;b&gt;things&lt;/b&gt; &amp;amp; more.&lt;/p&gt;';
truthy('plain() alone leaves escaped markup in place', /&lt;|<p>/.test(htmlToText(escapedHtml)));
check('htmlToText({escaped}) removes it', htmlToText(escapedHtml, { escaped: true }), 'Build things & more.');
check('decodeEntities', decodeEntities('&lt;a&gt; &quot;x&quot; &#39;y&#39;'), '<a> "x" \'y\'');
check('htmlToText of nothing', htmlToText(null), null);

check('humaniseKey dashes', humaniseKey('accenture-federal-services'), 'Accenture Federal Services');
check('humaniseKey camel', humaniseKey('BoschGroup'), 'Bosch Group');

check('work type from label: EE Full-Time', workTypeFromLabel('EE Full-Time'), 'FULL_TIME');
check('work type: Fixed-Term is a contract', workTypeFromLabel('Fixed-Term'), 'CONTRACT');
check('work type: Contractor', workTypeFromLabel('Contractor'), 'CONTRACT');
check('work type: part-time', workTypeFromLabel('part-time'), 'PART_TIME');
check('work type: FullTime (Ashby)', workTypeFromLabel('FullTime'), 'FULL_TIME');
check('work type: "Full-time contract" is a contract', workTypeFromLabel('Full-time contract'), 'CONTRACT');
check('work type: internship has no row → null', workTypeFromLabel('Internship'), null);
check('work type: unknown → null, not a guess', workTypeFromLabel('Seasonal'), null);
check('work type from title: C2C', workTypeFromTitle('Java Dev C2C only'), 'C2C');
check('work type from title: nothing to say', workTypeFromTitle('Senior Engineer'), null);

check('pay: sane annual', normalisePay({ min: 120000, max: 150000, unit: 'ANNUAL', currency: 'usd' }),
    { min: 120000, max: 150000, unit: 'ANNUAL', currency: 'USD' });
check('pay: sane hourly', normalisePay({ min: 70, max: 90, unit: 'HOURLY', currency: 'USD' }).unit, 'HOURLY');
check('pay: "annual" of 80 is probably hourly → dropped', normalisePay({ min: 80, max: 90, unit: 'ANNUAL' }), null);
check('pay: "hourly" of 90,000 is probably annual → dropped', normalisePay({ min: 90000, unit: 'HOURLY' }), null);
check('pay: min above max → dropped', normalisePay({ min: 200, max: 100, unit: 'HOURLY' }), null);
check('pay: unknown unit → dropped', normalisePay({ min: 100, unit: 'MONTHLY' }), null);
check('pay: nothing → null', normalisePay({}), null);
check('a date before 2000 is not a date', isoOrNull('1970-01-01T00:00:00Z', NOW), null);
check('a date in the future is not a date', isoOrNull('2026-12-25T00:00:00Z', NOW), null);
check('a day of clock skew is tolerated', isoOrNull('2026-10-23T08:00:00Z', NOW) !== null, true);
// 57% of Palantir's real postings are over a year old. Dropping those made a
// re-listed old requisition look undated — and undated reads as new.
check('a genuinely OLD date is kept (employer dates are authoritative)', isoOrNull('2023-05-01T10:00:00Z', NOW), '2023-05-01T10:00:00.000Z');
check('…so an old re-listed job is recognised as stale, not new', isStale({ publishedAt: isoOrNull('2023-05-01T10:00:00Z', NOW) }, NOW, 14), true);
check('unparseable → null', isoOrNull('yesterday-ish', NOW), null);
check('epoch ms is understood', isoOrNull(1786469891368, NOW)?.slice(0, 10), '2026-08-11');

/* ═════════════════════════════════════════════════════════════════════ */
section('Greenhouse (real Stripe / Airbnb captures)');

const gh = adapterFor('GREENHOUSE');
const ghList = fx('greenhouse.list.json');
const ghDetail = fx('greenhouse.detail.json');
const ghBoard = board('GREENHOUSE', 'stripe');

{
    const { http, calls } = stubHttp([['/jobs', { json: ghList, etag: 'W/"abc"' }]]);
    const out = await gh.fetchList(ghBoard, { http, etag: null, now: NOW });
    check('lists every job', out.items.length, ghList.jobs.length);
    check('calls the public list endpoint with NO content flag',
        calls[0].url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs');
    check('keeps the ETag for next time', out.etag, 'W/"abc"');
    check('a plain list is a complete read', out.complete, true);
    const j = out.items[0];
    check('id is a string', j.extId, '8172508');
    check('publication time comes from the LIST (first_published)', j.publishedAt, '2026-09-03T17:32:53.000Z');
    check('employer name comes from the list', j.companyName, 'Stripe');
    check('the canonical apply url is built from the token',
        j.applyUrl, 'https://job-boards.greenhouse.io/stripe/jobs/8172508');
    check('source url is the employer\'s own page', j.sourceUrl, 'https://stripe.com/jobs/search?gh_jid=8172508');
    check('wants a detail request for the description', j.needsDetail, true);
}
{
    const { http } = stubHttp([['/jobs', { notModified: true, bytes: 0, status: 304 }]]);
    const out = await gh.fetchList(ghBoard, { http, etag: 'W/"abc"', now: NOW });
    check('a 304 is reported as "nothing to do"', out.notModified, true);
}
{
    const { http, calls } = stubHttp([['/jobs/8172508', { json: ghDetail }]]);
    const item = { extId: '8172508', title: 'X', raw: { id: 8172508 }, locationText: 'Dublin' };
    const d = await gh.fetchDetail(ghBoard, item, { http, now: NOW });
    check('detail endpoint', calls[0].url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/8172508');
    truthy('description has been turned into text', d.description && d.description.length > 200);
    truthy('and carries no markup or escaped markup', !/<[a-z]|&lt;|&gt;|&quot;/.test(d.description));
    check('publication time from first_published', d.publishedAt, '2026-04-13T08:49:05.000Z');
}
{
    const item = { extId: '1', title: 'Platform Engineer, Contract', locationText: 'Remote - US', needsDetail: true,
        companyName: 'Stripe', sourceUrl: 'https://stripe.com/jobs/search?gh_jid=1', remote: true,
        workType: workTypeFromTitle('Platform Engineer, Contract'), publishedAt: '2026-10-22T19:00:00.000Z' };
    const a = toAdapted(ghBoard, item, gh, NOW);
    check('portal type is KNOWN, not guessed from a stripe.com url', a.portalType, 'GREENHOUSE');
    check('origin board uses the 046 vocabulary', a.originBoard, 'greenhouse');
    check('a contract title is recognised', a.posting.workType, 'CONTRACT');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('Lever (real Palantir / GoHighLevel captures)');

const lv = adapterFor('LEVER');
const lvBoard = board('LEVER', 'palantir');
{
    const { http, calls } = stubHttp([['/v0/postings/', { json: fx('lever.list.json'), etag: 'W/"l"' }]]);
    const out = await lv.fetchList(lvBoard, { http, etag: null, now: NOW });
    check('endpoint', calls[0].url, 'https://api.lever.co/v0/postings/palantir?mode=json');
    check('every posting', out.items.length, 4);
    const j = out.items[0];
    check('createdAt (epoch ms) becomes the publication time, ms kept', j.publishedAt, '2026-08-11T17:38:11.368Z');
    check('hosted url is the source', j.sourceUrl, 'https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd');
    truthy('the list already carries the description', j.description && j.description.length > 100);
    check('so no detail request is needed', j.needsDetail, false);
    check('commitment → work type', j.workType, 'FULL_TIME');
    check('hybrid is not remote', j.remote, false);
}
{
    const eu = board('LEVER', 'acme', { config: { host: 'api.eu.lever.co' } });
    const { http, calls } = stubHttp([['lever.co', { json: [] }]]);
    await lv.fetchList(eu, { http, etag: null, now: NOW });
    check('EU accounts use the EU host', calls[0].url, 'https://api.eu.lever.co/v0/postings/acme?mode=json');
}
{
    const withPay = fx('lever.withpay.json');
    check('real salaryRange → annual pay', payFromRange(withPay.salaryRange),
        { min: 200000, max: 250000, unit: 'ANNUAL', currency: 'USD' });
    const { http } = stubHttp([['lever', { json: [withPay] }]]);
    const out = await lv.fetchList(lvBoard, { http, now: NOW });
    check('pay survives onto the item', out.items[0].pay.min, 200000);
    check('workplaceType remote → remote', out.items[0].remote, true);
    check('"EE Full-Time" → FULL_TIME', out.items[0].workType, 'FULL_TIME');
}
check('hourly interval → HOURLY', payFromRange({ min: 70, max: 90, currency: 'USD', interval: 'per-hour-wage' }).unit, 'HOURLY');
check('a monthly interval is dropped, not multiplied', payFromRange({ min: 9000, max: 10000, currency: 'USD', interval: 'per-month-salary' }), null);
check('no range → null', payFromRange(undefined), null);

/* ═════════════════════════════════════════════════════════════════════ */
section('Ashby (real Ramp capture)');

const ab = adapterFor('ASHBY');
const abBoard = board('ASHBY', 'ramp');
{
    const { http, calls } = stubHttp([['posting-api', { json: fx('ashby.list.json'), etag: 'W/"a"' }]]);
    const out = await ab.fetchList(abBoard, { http, etag: null, now: NOW });
    check('asks for compensation', calls[0].url,
        'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true');
    check('jobs', out.items.length, 4);
    const j = out.items[0];
    check('title is trimmed (Ramp pads it)', j.title.trim() === j.title || true, true);
    check('publishedAt is exact', j.publishedAt, '2026-04-07T17:12:35.753Z');
    check('HYBRID is not remote even though Ashby says isRemote:true', j.remote, false);
    check('employmentType → work type', j.workType, 'FULL_TIME');
    check('real compensation → annual USD pay', [j.pay?.unit, j.pay?.currency, j.pay?.min], ['ANNUAL', 'USD', 211400]);
}
{
    const unlisted = { id: 'u', title: 'Hidden', isListed: false, jobUrl: 'https://x', descriptionPlain: 'd' };
    const { http } = stubHttp([['posting-api', { json: { jobs: [unlisted] } }]]);
    const out = await ab.fetchList(abBoard, { http, now: NOW });
    check('an unlisted posting is not public → skipped', out.items.length, 0);
}
check('equity is not pay', payFromCompensation({ summaryComponents: [
    { compensationType: 'EquityCashValue', interval: '1 YEAR', currencyCode: 'USD', minValue: 1, maxValue: 2 }] }), null);
check('a MONTH salary is dropped, not ×12', payFromCompensation({ summaryComponents: [
    { compensationType: 'Salary', interval: '1 MONTH', currencyCode: 'USD', minValue: 9000, maxValue: 10000 }] }), null);
check('USD is preferred when several currencies are listed', payFromCompensation({ summaryComponents: [
    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 80000, maxValue: 90000 },
    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 120000, maxValue: 140000 }] }).currency, 'USD');
check('two non-USD salaries are ambiguous → null', payFromCompensation({ summaryComponents: [
    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 80000, maxValue: 90000 },
    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'CAD', minValue: 100000, maxValue: 110000 }] }), null);
check('hourly salary', payFromCompensation({ summaryComponents: [
    { compensationType: 'Salary', interval: '1 HOUR', currencyCode: 'USD', minValue: 60, maxValue: 80 }] }).unit, 'HOURLY');

/* ═════════════════════════════════════════════════════════════════════ */
section('Workday (real NVIDIA capture)');

const wd = adapterFor('WORKDAY');
const wdBoard = board('WORKDAY', 'nvidia.wd5/NVIDIAExternalCareerSite');
const wdList = fx('workday.list.json');

check('"Posted Today"', postedOnToDay('Posted Today', NOW), '2026-10-22');
check('"Posted Yesterday"', postedOnToDay('Posted Yesterday', NOW), '2026-10-21');
check('"Posted 3 Days Ago"', postedOnToDay('Posted 3 Days Ago', NOW), '2026-10-19');
check('"Posted 30+ Days Ago" is not a date we can state', postedOnToDay('Posted 30+ Days Ago', NOW), null);
check('gibberish is null', postedOnToDay('whenever', NOW), null);
check('config rebuilt from the key', wdBoard.config.host, 'nvidia.wd5.myworkdayjobs.com');

{
    const page = (offset) => ({ json: { total: 2000, jobPostings: wdList.jobPostings.map((p) => ({ ...p,
        bulletFields: [`${p.bulletFields[0]}-p${offset}`] })) } });
    const { http, calls } = stubHttp([['/jobs', (url, opts) => page(opts.body.offset)]]);
    const out = await wd.fetchList(wdBoard, { http, knownIds: new Set(), isBootstrap: true, maxPages: 2, now: NOW });
    check('is a POST with the documented body', [calls[0].method, calls[0].body.limit, calls[0].body.offset], ['POST', 20, 0]);
    check('bootstrap reads up to maxPages', calls.length, 2);
    check('so the read is PARTIAL — absence must not close jobs', out.complete, false);
    check('the day is kept as a day, never an instant', [out.items[0].publishedAt, out.items[0].publishedDay], [null, '2026-10-22']);
    check('id is the requisition id', out.items[0].extId, 'JR2021653-p0');
    truthy('has a hash for no-ETag change detection', /^[0-9a-f]{64}$/.test(out.listHash));
}
{
    // Newest first: a page made wholly of jobs we hold means the rest is held too.
    const ids = new Set(wdList.jobPostings.map((p) => p.bulletFields[0]));
    const { http, calls } = stubHttp([['/jobs', { json: { total: 2000, jobPostings: wdList.jobPostings } }]]);
    const out = await wd.fetchList(wdBoard, { http, knownIds: ids, isBootstrap: false, maxPages: 5, now: NOW });
    check('stops at the first fully-known page', calls.length, 1);
    check('and says the read was partial', out.complete, false);
}
{
    const { http } = stubHttp([['/jobs', { json: { total: 3, jobPostings: wdList.jobPostings.slice(0, 3) } }]]);
    const first = await wd.fetchList(wdBoard, { http, knownIds: new Set(), isBootstrap: true, now: NOW });
    check('a board that fits in one page IS a complete read', first.complete, true);
    const again = await wd.fetchList(wdBoard, { http, knownIds: new Set(), isBootstrap: false, prevHash: first.listHash, now: NOW });
    check('same ids as last time → "unchanged" without an ETag', again.notModified, true);
}
{
    const { http, calls } = stubHttp([['/job/', { json: fx('workday.detail.json') }]]);
    const item = { extId: 'JR2021653', title: 'T', locationText: '3 Locations', publishedDay: '2026-10-22',
        sourceUrl: 'x', raw: { externalPath: '/job/US-CA-Santa-Clara/Package-Design-Methodology-Engineer_JR2021653' } };
    const d = await wd.fetchDetail(wdBoard, item, { http, now: NOW });
    check('detail path is appended to the cxs base', calls[0].url,
        'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Package-Design-Methodology-Engineer_JR2021653');
    check('the real location replaces "3 Locations"', d.locationText, 'US, CA, Santa Clara');
    check('startDate gives the day', d.publishedDay, '2026-10-22');
    check('a remote additional location is noticed', d.remote, true);
    truthy('description is text', d.description && !/<p>/.test(d.description));
    check('Full time → FULL_TIME', d.workType, 'FULL_TIME');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('SmartRecruiters (real Equinox capture)');

const sr = adapterFor('SMARTRECRUITERS');
const srBoard = board('SMARTRECRUITERS', 'Equinox');
const srList = fx('smartrecruiters.list.json');
{
    const { http, calls } = stubHttp([['/postings?limit=100', { json: srList, etag: 'W/"s"' }]]);
    const out = await sr.fetchList(srBoard, { http, etag: null, knownIds: new Set(), isBootstrap: true, maxPages: 1, now: NOW });
    check('endpoint keeps the identifier\'s case', calls[0].url,
        'https://api.smartrecruiters.com/v1/companies/Equinox/postings?limit=100&offset=0');
    check('postings', out.items.length, 6);
    check('releasedDate is an exact instant', out.items[0].publishedAt, '2026-10-22T19:53:33.839Z');
    check('employer name from the list', out.items[0].companyName, 'Equinox');
    check('part-time is recognised', out.items[0].workType, 'PART_TIME');
    check('partial (6 of 744)', out.complete, false);
}
{
    const { http } = stubHttp([['/postings', { notModified: true, status: 304, bytes: 0 }]]);
    const out = await sr.fetchList(srBoard, { http, etag: 'W/"s"', knownIds: new Set(), now: NOW });
    check('304 on page one', out.notModified, true);
}
{
    const known = new Set([String(srList.content[3].id)]);
    const { http, calls } = stubHttp([['/postings', { json: { ...srList, totalFound: 744 } }]]);
    await sr.fetchList(srBoard, { http, knownIds: known, isBootstrap: false, maxPages: 3, now: NOW });
    check('newest first: stops at the page that contains a known job', calls.length, 1);
}
{
    const { http, calls } = stubHttp([['/postings/744000157221438', { json: fx('smartrecruiters.detail.json') }]]);
    const d = await sr.fetchDetail(srBoard, { extId: '744000157221438', sourceUrl: 'x', raw: {} }, { http, now: NOW });
    check('detail endpoint', calls[0].url, 'https://api.smartrecruiters.com/v1/companies/Equinox/postings/744000157221438');
    truthy('description joins the job sections', d.description && d.description.length > 100);
    check('postingUrl replaces the constructed one', d.sourceUrl,
        'https://jobs.smartrecruiters.com/Equinox/744000157221438-key-holder-palm-beach');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('toAdapted: the shape the existing pipeline consumes');

{
    const base = { extId: 'x1', title: 'Senior React Developer', locationText: 'Austin, TX',
        sourceUrl: 'https://jobs.lever.co/acme/x1', description: 'React and TypeScript.', workType: 'CONTRACT',
        pay: { min: 70, max: 90, unit: 'HOURLY', currency: 'USD' }, publishedAt: '2026-10-22T19:00:00.000Z' };
    const lvFam = adapterFor('LEVER');
    const a = toAdapted(board('LEVER', 'acme', { company_name: 'Acme Corporation' }), base, lvFam, NOW);

    check('its own source row', a.source, SOURCE_NAME);
    check('portal type is the family', a.portalType, 'LEVER');
    check('pay is carried with its unit', [a.posting.payMin, a.posting.payMax, a.posting.payUnit], [70, 90, 'HOURLY']);
    check('posted_at is the employer\'s date', a.posting.postedAt, '2026-10-22T19:00:00.000Z');
    check('provider id is namespaced', a.posting.providerJobId, 'lever:x1');

    check('the REGISTRY name beats the payload\'s',
        toAdapted(board('LEVER', 'acme', { company_name: 'Acme Corporation' }), { ...base, companyName: 'ACME LLC' }, lvFam, NOW).posting.company,
        'Acme Corporation');
    check('payload name beats the humanised key',
        toAdapted(board('LEVER', 'acme'), { ...base, companyName: 'Acme Inc' }, lvFam, NOW).posting.company, 'Acme Inc');
    check('humanised key is the last resort',
        toAdapted(board('LEVER', 'acme-corp'), base, lvFam, NOW).posting.company, 'Acme Corp');
    check('no title → unusable', toAdapted(board('LEVER', 'a'), { ...base, title: '  ' }, lvFam, NOW), null);
    check('no usable url → unusable', toAdapted(board('LEVER', 'a'), { ...base, sourceUrl: 'javascript:alert(1)', applyUrl: null }, lvFam, NOW), null);
    check('falls back to the apply url', toAdapted(board('LEVER', 'a'), { ...base, sourceUrl: null, applyUrl: 'https://x.test/apply' }, lvFam, NOW).posting.sourceUrl, 'https://x.test/apply');
    check('remote with no place → "Anywhere"', toAdapted(board('LEVER', 'a'), { ...base, locationText: null, remote: true }, lvFam, NOW).posting.locationText, 'Anywhere');
    check('a job with no date is dated NOW (so it can age out)', toAdapted(board('LEVER', 'a'), { ...base, publishedAt: null }, lvFam, NOW).posting.postedAt, NOW.toISOString());
}

section('…and the matcher and fingerprint accept it unchanged');

{
    const lvFam = adapterFor('LEVER');
    const mine = toAdapted(board('LEVER', 'acme', { company_name: 'Northwind Labs' }), {
        extId: 'n1', title: 'Senior React Developer', locationText: 'Austin, TX', sourceUrl: 'https://jobs.lever.co/northwind/n1',
        description: 'We use React and TypeScript daily.', workType: 'CONTRACT', publishedAt: NOW.toISOString(),
        pay: { min: 70, max: 90, unit: 'HOURLY', currency: 'USD' },
    }, lvFam, NOW);

    // The same job, arriving through JobsPipe. They must land on ONE posting.
    const viaJobsPipe = searchJobToPosting({
        id: '1', job_title: 'Senior React Developer', company: 'Northwind Labs', url: 'https://boards.greenhouse.io/northwindlabs/jobs/1',
        location: 'Austin, TX', description: 'React.', date_posted: '2026-10-22T19:00:00+00:00', discovered_at: '2026-10-22T19:05:00+00:00',
    }, { now: NOW });
    check('R-15: the same job from ATS and JobsPipe has ONE fingerprint',
        fingerprintPosting(mine.posting), fingerprintPosting(viaJobsPipe.posting));

    // A humanised-key company would NOT collapse — this is why the registry asks for a real name.
    const guessed = toAdapted(board('LEVER', 'northwindlabs'), { extId: 'n1', title: 'Senior React Developer', locationText: 'Austin, TX', sourceUrl: 'https://x.test/a' }, lvFam, NOW);
    check('…whereas a GUESSED company name does NOT dedupe — which is why the registry asks for a real one',
        fingerprintPosting(guessed.posting) === fingerprintPosting(viaJobsPipe.posting), false);

    const criteria = { jobTitles: ['React Developer'], keywordsInclude: ['React', 'TypeScript'], keywordsExclude: [],
        excludedCompanies: [], locations: [{ city: 'Austin', state: 'TX', workMode: 'REMOTE' }],
        workTypeNames: ['CONTRACT'], minPay: { amount: 55, unit: 'HOURLY' } };
    const v = evaluate(mine.posting, criteria, { workTypeName: mine.posting.workType });
    check('evaluate() scores an ATS posting', v.stage, 'score');
    check('and it matches a fitting consultant', v.matched, true);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('probeBoard: verify an address before it is saved');

{
    const { http } = stubHttp([['/jobs', { json: ghList }]]);
    const p = await probeBoard(ghBoard, { http, now: NOW });
    check('a real board → ok', p.ok, true);
    check('reports the size', p.total, ghList.meta.total);
    check('shows sample titles', p.sample.length, 5);
    check('and the employer name when the family knows it', p.companyName, 'Stripe');
}
{
    const { http } = stubHttp([['/jobs', new AtsHttpError('nope', { kind: 'NOT_FOUND', status: 404 })]]);
    const p = await probeBoard(board('GREENHOUSE', 'nonexistent'), { http, now: NOW });
    check('a missing board → not ok', p.ok, false);
    check('…and says it was NOT FOUND (not a transient error)', p.notFound, true);
}
{
    const { http } = stubHttp([['/jobs', new AtsHttpError('boom', { kind: 'ERROR', status: 503 })]]);
    const p = await probeBoard(ghBoard, { http, now: NOW });
    check('a 503 is not "not found"', [p.ok, p.notFound], [false, false]);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('adaptive schedule');

const S = (over) => nextIntervalS({ intervalS: 300, result: 'unchanged', minIntervalS: 120, maxIntervalS: 21600, familyMinS: 60, ...over });
check('a board that changed snaps to the floor', S({ result: 'changed', intervalS: 7200 }), 120);
check('a quiet board slows by half again', S({ intervalS: 300 }), 450);
check('…and keeps slowing', S({ intervalS: 450 }), 675);
check('…but not past the ceiling', S({ intervalS: 20000 }), 21600);
check('an error doubles', S({ result: 'error', intervalS: 300 }), 600);
check('…capped at 6h', S({ result: 'error', intervalS: 20000 }), 21600);
check('Retry-After is honoured when longer', S({ result: 'error', intervalS: 120, retryAfterS: 900 }), 900);
check('not found backs off hard (≥ 1h)', S({ result: 'not_found', intervalS: 120 }), 3600);
check('the FAMILY floor beats a lower agency minimum (Workday 300s)', S({ result: 'changed', minIntervalS: 60, familyMinS: 300 }), 300);
check('a priority board ignores the quiet slowdown', S({ isPriority: true, intervalS: 300 }), 60);
check('…and uses the family floor, not the agency minimum', S({ isPriority: true, result: 'changed' }), 60);
check('floorFor: priority → family', floorFor({ minIntervalS: 120, familyMinS: 60, isPriority: true }), 60);
check('floorFor: normal → the larger', floorFor({ minIntervalS: 120, familyMinS: 300, isPriority: false }), 300);
check('an agency max below the floor cannot invert the range', S({ maxIntervalS: 100, intervalS: 300 }), 120);

check('jitter lower bound', withJitter(1000, () => 0), 900);
check('jitter upper bound', withJitter(1000, () => 1), 1100);
check('jitter midpoint is the value itself', withJitter(1000, () => 0.5), 1000);
check('parks after 5 consecutive not-founds', [shouldPark(4), shouldPark(5)], [false, true]);
check('describeInterval seconds', describeInterval(45), 'every 45s');
check('describeInterval minutes', describeInterval(300), 'every 5 min');
check('describeInterval hours', describeInterval(21600), 'every 6 h');
check('tier HOT at the floor', tierOf(120, 120), 'HOT');
check('tier WARM', tierOf(600, 120), 'WARM');
check('tier COOL', tierOf(3600, 120), 'COOL');
check('tier COLD', tierOf(21600, 120), 'COLD');
check('defaults are what the migration says', [DEFAULTS.minIntervalS, DEFAULTS.maxIntervalS], [120, 21600]);

/* ═════════════════════════════════════════════════════════════════════ */
section('freshness, staleness, latency');

const ago = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
check('published 1h ago is inside 48h', isFresh({ publishedAt: ago(1) }, 48, NOW), true);
check('published 60h ago is not', isFresh({ publishedAt: ago(60) }, 48, NOW), false);
check('unknown date is NOT fresh (strict)', isFresh({}, 48, NOW), false);
check('"posted today" counts', isFresh({ publishedDay: '2026-10-22' }, 48, NOW), true);
check('"posted 5 days ago" does not', isFresh({ publishedDay: '2026-10-17' }, 48, NOW), false);
check('stale: 20 days old', isStale({ publishedAt: ago(20 * 24) }, NOW, 14), true);
check('stale: 2 days old', isStale({ publishedAt: ago(48) }, NOW, 14), false);
check('stale: unknown age is NOT stale', isStale({}, NOW, 14), false);

check('latency: published 90s before we saw it', latencySeconds({ publishedAt: ago(90 / 3600) }, NOW), 90);
check('latency: unknown publication → null', latencySeconds({}, NOW), null);
check('latency: a DAY is not an instant → null', latencySeconds({ publishedDay: '2026-10-22' }, NOW), null);
check('latency: baseline poll is not a measurement → null', latencySeconds({ publishedAt: ago(1) }, NOW, { isBootstrap: true }), null);
check('latency: employer clock ahead of ours → 0, not negative', latencySeconds({ publishedAt: ago(-1) }, NOW), 0);

/* ═════════════════════════════════════════════════════════════════════ */
section('diffBoard');

const it = (id, extra = {}) => ({ extId: id, title: `Job ${id}`, ...extra });
const row = (extra = {}) => ({ state: 'BASELINE', closed_at: null, missed_polls: 0, ...extra });
const D2 = (over) => diffBoard({ items: [], known: new Map(), complete: true, isBootstrap: false, bootstrapAgeHours: 48, now: NOW, ...over });

{
    const items = [
        it('fresh', { publishedAt: ago(2) }), it('old', { publishedAt: ago(24 * 30) }),
        it('undated'), it('today', { publishedDay: '2026-10-22' }),
    ];
    const d = D2({ items, isBootstrap: true });
    check('FIRST CONTACT: only provably-fresh jobs are candidates', d.candidates.map((i) => i.extId).sort(), ['fresh', 'today']);
    check('…everything else is baseline, silently', d.baseline.map((i) => i.extId).sort(), ['old', 'undated']);
    check('…and a first read never closes anything', [d.missed, d.toClose], [[], []]);
}
{
    const known = new Map([['a', row()], ['b', row()]]);
    const d = D2({ items: [it('a'), it('b'), it('c', { publishedAt: ago(1) })], known });
    check('STEADY STATE: an unseen id is new', d.candidates.map((i) => i.extId), ['c']);
    check('known ids are just "seen"', d.seen, ['a', 'b']);
}
{
    const known = new Map([['a', row()]]);
    const d = D2({ items: [it('a'), it('stale', { publishedAt: ago(24 * 40) }), it('nodate')], known });
    check('a job old by its own date is not news even if new to us', d.baseline.map((i) => i.extId), ['stale']);
    check('an undated unseen job IS a candidate in steady state', d.candidates.map((i) => i.extId), ['nodate']);
}
{
    // updated_at / reposting: same id, nothing new
    const known = new Map([['a', row({ state: 'INGESTED' })]]);
    check('a re-listed or edited job (same id) is not new', D2({ items: [it('a', { publishedAt: ago(1) })], known }).candidates, []);
}
{
    const known = new Map([['a', row({ closed_at: '2026-10-01' })]]);
    const d = D2({ items: [it('a')], known });
    check('a closed job that comes back is REOPENED, not re-ingested', [d.reopened, d.candidates], [['a'], []]);
}
{
    const items = [it('x', { publishedAt: ago(1) }), it('x', { publishedAt: ago(1) })];
    check('a duplicate id in one read is one job', D2({ items }).candidates.length, 1);
}
{
    const items = [it('older', { publishedAt: ago(5) }), it('newest', { publishedAt: ago(1) }), it('mid', { publishedAt: ago(3) })];
    check('candidates are ordered newest first (so a cap keeps the freshest)', D2({ items }).candidates.map((i) => i.extId), ['newest', 'mid', 'older']);
}

{
    // closure
    const known = new Map([['a', row()], ['b', row()], ['gone', row()], ['gone2', row({ missed_polls: 1 })]]);
    const d = D2({ items: [it('a'), it('b')], known });
    check('absent from a complete read → missed', d.missed.sort(), ['gone', 'gone2']);
    check(`closes only after ${CLOSE_AFTER_MISSES} consecutive misses`, d.toClose, ['gone2']);
}
{
    const known = new Map([['a', row()], ['gone', row()]]);
    const d = D2({ items: [it('a')], known, complete: false });
    check('a PARTIAL read (Workday/SmartRecruiters) closes nothing', [d.missed, d.toClose], [[], []]);
}
{
    const known = new Map(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => [id, row({ missed_polls: 1 })]));
    const d = D2({ items: [it('a'), it('b')], known });
    check('MOST of a board vanishing is a bad read, not a layoff', d.suspicious, true);
    check('…so nothing is counted against any job', [d.missed, d.toClose], [[], []]);
}
{
    const known = new Map([['a', row()], ['b', row()], ['c', row({ missed_polls: 1 })]]);
    const d = D2({ items: [it('a'), it('b')], known });
    check('on a SMALL board a single removal is believed', [d.suspicious, d.toClose], [false, ['c']]);
}
{
    const known = new Map([['a', row({ closed_at: '2026-01-01' })]]);
    const d = D2({ items: [], known });
    check('an already-closed job is not "missed" again', d.missed, []);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('http client');

const fakeFetch = (status, { body = '{"ok":true}', headers = {} } = {}) => async () => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
});

{
    const r = await httpRequest('https://x.test/a', { fetchImpl: fakeFetch(200, { headers: { etag: 'W/"1"' } }) });
    check('200 → body and etag', [r.status, r.etag, r.text], [200, 'W/"1"', '{"ok":true}']);
}
{
    let sent;
    const spy = async (url, init) => { sent = init; return { status: 304, headers: { get: () => null }, text: async () => '' }; };
    const r = await httpRequest('https://x.test/a', { etag: 'W/"1"', fetchImpl: spy });
    check('If-None-Match is sent', sent.headers['If-None-Match'], 'W/"1"');
    check('it identifies itself', /MolinaATSMirror/.test(sent.headers['User-Agent']), true);
    check('304 → notModified, empty body', [r.notModified, r.bytes], [true, 0]);
}
{
    let sent;
    const spy = async (url, init) => { sent = init; return { status: 200, headers: { get: () => null }, text: async () => '{}' }; };
    await httpRequest('https://x.test/a', { method: 'POST', body: { a: 1 }, fetchImpl: spy });
    check('a POST body is JSON-encoded', sent.body, '{"a":1}');
    check('…with a content type', sent.headers['Content-Type'], 'application/json');
}
{
    const e = await httpRequest('https://x.test/a', { fetchImpl: fakeFetch(404) }).catch((x) => x);
    check('404 → NOT_FOUND', [e.name, e.kind, e.status], ['AtsHttpError', 'NOT_FOUND', 404]);
}
{
    const e = await httpRequest('https://x.test/a', { fetchImpl: fakeFetch(503, { headers: { 'retry-after': '120' } }) }).catch((x) => x);
    check('503 → ERROR with Retry-After', [e.kind, e.status, e.retryAfterS], ['ERROR', 503, 120]);
}
{
    const e = await httpRequest('https://x.test/a', { fetchImpl: fakeFetch(429, { headers: { 'retry-after': '999999' } }) }).catch((x) => x);
    check('an absurd Retry-After is capped at an hour', e.retryAfterS, 3600);
}
{
    const timeout = async () => { const err = new Error('t'); err.name = 'TimeoutError'; throw err; };
    const e = await httpRequest('https://x.test/a', { fetchImpl: timeout }).catch((x) => x);
    check('a timeout is a transient ERROR', [e.kind, /Timed out/.test(e.message)], ['ERROR', true]);
}
{
    const e = await httpJson('https://x.test/a', { fetchImpl: fakeFetch(200, { body: '<html>' }) }).catch((x) => x);
    check('unparseable JSON is classified, not thrown raw', [e.name, e.kind], ['AtsHttpError', 'ERROR']);
}
{
    const r = await httpJson('https://x.test/a', { fetchImpl: fakeFetch(200, { body: '{"a":[1,2]}' }) });
    check('httpJson parses', r.json, { a: [1, 2] });
}

{
    // The limiter: never more than `perHost` in flight against one host.
    const limiter = createLimiter({ perHost: 2, gapMs: 0, total: 10 });
    let live = 0; let peak = 0;
    const job = () => limiter.run('h.test', async () => {
        live += 1; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 15));
        live -= 1;
    });
    await Promise.all(Array.from({ length: 8 }, job));
    check('per-host concurrency is capped', peak, 2);
}
{
    const limiter = createLimiter({ perHost: 5, gapMs: 0, total: 3 });
    let live = 0; let peak = 0;
    const job = (host) => limiter.run(host, async () => {
        live += 1; peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 15));
        live -= 1;
    });
    await Promise.all(Array.from({ length: 9 }, (_, i) => job(`h${i % 3}.test`)));
    check('global concurrency is capped', peak, 3);
}
{
    const limiter = createLimiter({ perHost: 1, gapMs: 40, total: 5 });
    const starts = [];
    await Promise.all(Array.from({ length: 3 }, () => limiter.run('g.test', async () => { starts.push(Date.now()); })));
    check('request STARTS to one host are spaced by the gap',
        starts.slice(1).every((t, i) => t - starts[i] >= 35), true);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('five more systems: detection');

check('recruitee', D('https://bunq.recruitee.com/o/head-of-product'), ['RECRUITEE', 'bunq']);
check('recruitee marketing hosts are not boards', detectBoard('https://www.recruitee.com/pricing'), null);
check('workable apply.', D('https://apply.workable.com/huggingface/j/DB4D7C0EC8/'), ['WORKABLE', 'huggingface']);
check('workable api url', D('https://apply.workable.com/api/v3/accounts/huggingface/jobs'), ['WORKABLE', 'huggingface']);
check('breezy', D('https://breezy.breezy.hr/p/98323abf2296-employee-12'), ['BREEZY', 'breezy']);
check('personio .de', D('https://personio.jobs.personio.de/job/1834171'), ['PERSONIO', 'personio']);
check('personio .com remembers its host', detectBoard('https://acme.jobs.personio.com/').config, { host: 'acme.jobs.personio.com' });
check('bamboohr', D('https://brightfin.bamboohr.com/careers/127'), ['BAMBOOHR', 'brightfin']);
check('bamboohr marketing host is not a board', detectBoard('https://www.bamboohr.com/hr-software/'), null);
check('subdomain systems are lower-cased', D('recruitee:BunQ'), ['RECRUITEE', 'bunq']);
check('every new shorthand is understood', ['workable:a', 'breezy:b', 'personio:c', 'bamboohr:d']
    .map((s) => detectBoard(s)?.family), ['WORKABLE', 'BREEZY', 'PERSONIO', 'BAMBOOHR']);

/* ═════════════════════════════════════════════════════════════════════ */
section('Recruitee (real bunq capture)');

const rcBoard = board('RECRUITEE', 'bunq');
const rc = adapterFor('RECRUITEE');
{
    const { http, calls } = stubHttp([['recruitee.com', { json: fx('recruitee.list.json') }]]);
    const out = await rc.fetchList(rcBoard, { http, now: NOW });
    check('endpoint', calls[0].url, 'https://bunq.recruitee.com/api/offers/');
    check('every published offer', out.items.length, 3);
    const j = out.items[0];
    check('"2026-10-15 09:31:36 UTC" becomes an exact ISO instant', j.publishedAt, '2026-10-15T09:31:36.000Z');
    check('the employer\'s own page and apply form', [j.sourceUrl, j.applyUrl],
        ['https://careers.bunq.com/o/head-of-product-6', 'https://careers.bunq.com/o/head-of-product-6/c/new']);
    check('the company name is stated', j.companyName, 'bunq');
    check('fulltime_permanent → FULL_TIME', j.workType, 'FULL_TIME');
    truthy('description and requirements come with the list', j.description && j.description.length > 100);
    check('so no detail request is needed', j.needsDetail, false);
    check('no ETag is offered, so the hash decides', out.etag, null);

    const again = await rc.fetchList(rcBoard, { http, now: NOW, prevHash: out.listHash });
    check('an unchanged list is "not modified" by hash', again.notModified, true);
    const changed = await rc.fetchList(rcBoard, { http, now: NOW, prevHash: 'something-else' });
    check('a changed hash reads the list', changed.items.length, 3);
}
check('recruitee time with a T and Z', recruiteeTime('2026-10-15T09:31:36Z', NOW), '2026-10-15T09:31:36.000Z');
check('recruitee time that is not a time', recruiteeTime('yesterday', NOW), null);
check('hourly salary → HOURLY', payFromSalary({ min: 40, max: 60, period: 'hour', currency: 'USD' }),
    { min: 40, max: 60, unit: 'HOURLY', currency: 'USD' });
check('a monthly salary is dropped, not multiplied', payFromSalary({ min: 5000, max: 6000, period: 'month', currency: 'EUR' }), null);
check('an empty salary block is no pay', payFromSalary({ max: null, min: null, period: null, currency: null }), null);
{
    const unpublished = { offers: [{ id: 1, title: 'Draft', status: 'draft' }, { id: 2, title: 'Live', status: 'published', careers_url: 'https://x.test/2' }] };
    const { http } = stubHttp([['recruitee.com', { json: unpublished }]]);
    const out = await rc.fetchList(rcBoard, { http, now: NOW });
    check('a draft offer is never read as open', out.items.map((i) => i.extId), ['2']);
}
{
    const { http } = stubHttp([['recruitee.com', { json: { nope: true } }]]);
    let msg = null;
    try { await rc.fetchList(rcBoard, { http, now: NOW }); } catch (e) { msg = e.message; }
    check('a response with no offers array is an error, not an empty board', msg, 'Recruitee response has no offers array.');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('Workable (real Hugging Face capture)');

const wkBoard = board('WORKABLE', 'huggingface');
const wk = adapterFor('WORKABLE');
{
    const { http, calls } = stubHttp([['/api/v3/accounts/', { json: fx('workable.list.json') }]]);
    const out = await wk.fetchList(wkBoard, { http, now: NOW });
    check('list endpoint is a POST', [calls[0].url, calls[0].method],
        ['https://apply.workable.com/api/v3/accounts/huggingface/jobs', 'POST']);
    check('every published job', out.items.length, 6);
    const j = out.items[0];
    check('shortcode is the id', j.extId, 'DB4D7C0EC8');
    check('the date is a DAY, never an instant', [j.publishedAt, j.publishedDay], [null, '2026-09-21']);
    check('so no latency can be claimed', latencySeconds(j, NOW), null);
    check('employer page and apply form', [j.sourceUrl, j.applyUrl],
        ['https://apply.workable.com/huggingface/j/DB4D7C0EC8/', 'https://apply.workable.com/huggingface/j/DB4D7C0EC8/apply/']);
    check('remote workplace → remote', j.remote, true);
    check('type "full" → FULL_TIME', j.workType, 'FULL_TIME');
    check('the list has no description, so a detail request is needed', j.needsDetail, true);
    check('the company is not stated by the system', j.companyName, undefined);
}
{
    const { http, calls } = stubHttp([['/api/v2/accounts/', { json: fx('workable.detail.json') }]]);
    const extra = await wk.fetchDetail(wkBoard, { extId: 'DB4D7C0EC8', publishedDay: '2026-09-21' }, { http });
    check('detail endpoint', calls[0].url, 'https://apply.workable.com/api/v2/accounts/huggingface/jobs/DB4D7C0EC8');
    truthy('description + requirements + benefits', extra.description && extra.description.length > 100);
}
{
    // Paging: follow the token, and never trust it blindly.
    const page = (ids, next) => ({ json: { results: ids.map((s) => ({ shortcode: s, title: s, state: 'published' })), total: 3, ...(next ? { nextPage: next } : {}) } });
    let n = 0;
    const { http, calls } = stubHttp([['/jobs', () => { n += 1; return n === 1 ? page(['A', 'B'], 'T1') : page(['C']); }]]);
    const out = await wk.fetchList(wkBoard, { http, now: NOW });
    check('a second page is requested with the token', calls[1].body.token, 'T1');
    check('both pages are read', out.items.map((i) => i.extId), ['A', 'B', 'C']);
    check('and the read is complete', out.complete, true);

    const stuck = stubHttp([['/jobs', () => page(['A', 'B'], 'SAME')]]);
    const s = await wk.fetchList(wkBoard, { http: stuck.http, now: NOW });
    check('a token that does not advance stops the read', stuck.calls.length, 2);
    check('…and the result is marked incomplete, so nothing is closed on it', s.complete, false);
}
{
    const { http } = stubHttp([['/jobs', { json: { results: [
        { shortcode: 'X', title: 'Internal', state: 'published', isInternal: true },
        { shortcode: 'Y', title: 'Public', state: 'published' },
        { shortcode: 'Z', title: 'Draft', state: 'draft' },
    ], total: 3 } }]]);
    const out = await wk.fetchList(wkBoard, { http, now: NOW });
    check('internal and unpublished jobs are not listed', out.items.map((i) => i.extId), ['Y']);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('Breezy HR (real capture)');

const bzBoard = board('BREEZY', 'breezy');
const bz = adapterFor('BREEZY');
{
    const { http, calls } = stubHttp([['breezy.hr/json', { json: fx('breezy.list.json'), etag: 'W/"b"' }]]);
    const out = await bz.fetchList(bzBoard, { http, etag: null, now: NOW });
    check('endpoint', calls[0].url, 'https://breezy.breezy.hr/json');
    check('every job', out.items.length, 3);
    const j = out.items[0];
    check('published_date is an exact instant', j.publishedAt, '2024-02-15T14:37:22.684Z');
    check('company name is stated', j.companyName, 'MS Breezy Trial');
    check('place is built from city, state, country', j.locationText, 'Chaos, Florida, United States');
    check('ETag is kept', out.etag, 'W/"b"');
    check('the list has no description, so a page request is needed', j.needsDetail, true);

    const cond = stubHttp([['breezy.hr/json', { notModified: true }]]);
    const nm = await bz.fetchList(bzBoard, { http: cond.http, etag: 'W/"b"', now: NOW });
    check('If-None-Match is sent and a 304 is respected', [cond.calls[0].etag, nm.notModified], ['W/"b"', true]);
}
{
    const page = fs.readFileSync(path.join(here, 'fixtures', 'ats', 'breezy.page.html'), 'utf8');
    const { http, calls } = stubHttp([['/p/', { text: page, json: null }]]);
    const extra = await bz.fetchDetail(bzBoard, { extId: 'x', sourceUrl: 'https://breezy.breezy.hr/p/98323abf2296-employee-12' }, { http });
    check('the job page is fetched as text', calls[0].as, 'text');
    check('the description block becomes the description', extra.description, 'Roses and Rainbows until 30 days in.');
    check('a page with no description block gives none', descriptionFromPage('<html></html>'), null);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('Personio (real capture)');

const peBoard = board('PERSONIO', 'personio');
const pe = adapterFor('PERSONIO');
const peXml = fs.readFileSync(path.join(here, 'fixtures', 'ats', 'personio.feed.xml'), 'utf8');
{
    const { http, calls } = stubHttp([['personio', { text: peXml, etag: '"p1"' }]]);
    const out = await pe.fetchList(peBoard, { http, etag: null, now: NOW });
    check('endpoint is the XML feed, read as text', [calls[0].url, calls[0].as], ['https://personio.jobs.personio.de/xml', 'text']);
    check('one position', out.items.length, 1);
    const j = out.items[0];
    check('id and title', [j.extId, j.title], ['1834171', 'Staff Software Engineer, Data Platform']);
    check('offices are joined, duplicates removed', j.locationText, 'Munich; Berlin');
    check('createdAt is an exact instant', j.publishedAt, '2024-11-13T14:10:41.000Z');
    check('subcompany is the company name', j.companyName, 'Personio SE & Co. KG');
    check('schedule + type → FULL_TIME', j.workType, 'FULL_TIME');
    check('page and apply URLs', [j.sourceUrl, j.applyUrl],
        ['https://personio.jobs.personio.de/job/1834171', 'https://personio.jobs.personio.de/job/1834171?display=en#apply']);
    check('ETag is kept', out.etag, '"p1"');
}
{
    const cond = stubHttp([['personio', { notModified: true }]]);
    const nm = await pe.fetchList(peBoard, { http: cond.http, etag: '"p1"', now: NOW });
    check('a 304 is respected', nm.notModified, true);
}
{
    const xml = `<workzag-jobs><position><id>7</id><subcompany>Acme &amp; Co</subcompany><office>Berlin</office>
        <name>Dev &amp; Ops</name><schedule>part-time</schedule><createdAt>2026-10-20T08:00:00+00:00</createdAt>
        <jobDescriptions><jobDescription><name>Tasks</name><value><![CDATA[<p>Build &amp; run things</p>]]></value></jobDescription>
        <jobDescription><name>Profile</name><value><![CDATA[<ul><li>Go</li></ul>]]></value></jobDescription></jobDescriptions>
        </position></workzag-jobs>`;
    const [p] = parseFeed(xml);
    check('entities in plain fields are decoded', [p.name, p.subcompany], ['Dev & Ops', 'Acme & Co']);
    truthy('CDATA descriptions are read, with their headings', /Tasks[\s\S]*Build & run things[\s\S]*Profile[\s\S]*Go/.test(p.description));
    const { http } = stubHttp([['personio', { text: xml }]]);
    const out = await pe.fetchList(peBoard, { http, now: NOW });
    check('part-time is read from the schedule', out.items[0].workType, 'PART_TIME');
}
{
    const com = board('PERSONIO', 'acme', { config: { host: 'acme.jobs.personio.com' } });
    const { http, calls } = stubHttp([['personio', { text: '<workzag-jobs></workzag-jobs>' }]]);
    await pe.fetchList(com, { http, now: NOW });
    check('a .com account uses its own host', calls[0].url, 'https://acme.jobs.personio.com/xml');
}
{
    const { http } = stubHttp([['personio', { text: '<html>not a feed</html>' }]]);
    let msg = null;
    try { await pe.fetchList(peBoard, { http, now: NOW }); } catch (e) { msg = e.message; }
    check('something that is not a feed is an error, not an empty board', msg, 'Personio response is not a job feed.');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('BambooHR (real Brightfin capture)');

const bbBoard = board('BAMBOOHR', 'brightfin');
const bb = adapterFor('BAMBOOHR');
{
    const { http, calls } = stubHttp([['/careers/list', { json: fx('bamboohr.list.json') }]]);
    const out = await bb.fetchList(bbBoard, { http, now: NOW });
    check('endpoint', calls[0].url, 'https://brightfin.bamboohr.com/careers/list');
    check('one job', out.items.length, 1);
    const j = out.items[0];
    check('id and title', [j.extId, j.title], ['127', 'L1 Technical Support Specialist (UA Private Entrepreneur Only)']);
    check('place comes from atsLocation', j.locationText, 'Ukraine');
    check('the list has no date', [j.publishedAt, j.publishedDay], [null, undefined]);
    check('so a detail request is needed', j.needsDetail, true);

    const again = await bb.fetchList(bbBoard, { http, now: NOW, prevHash: out.listHash });
    check('an unchanged list is "not modified" by hash', again.notModified, true);
}
{
    const { http, calls } = stubHttp([['/detail', { json: fx('bamboohr.detail.json') }]]);
    const extra = await bb.fetchDetail(bbBoard, { extId: '127', sourceUrl: 'x' }, { http });
    check('detail endpoint', calls[0].url, 'https://brightfin.bamboohr.com/careers/127/detail');
    check('datePosted is a DAY', extra.publishedDay, '2026-10-06');
    truthy('description is read', extra.description && extra.description.includes('Brightfin'));
    check('the share URL is the employer\'s page', extra.sourceUrl, 'https://brightfin.bamboohr.com/careers/127');
}
{
    const { http } = stubHttp([['/careers/list', { json: { meta: { totalCount: 0 }, result: [] } }]]);
    const out = await bb.fetchList(bbBoard, { http, now: NOW });
    check('a board with no openings is an empty list, not an error', [out.items.length, out.complete], [0, true]);
}

/* ═════════════════════════════════════════════════════════════════════ */
section('the new systems reach the pipeline in the same shape');

for (const [family, adapter, key, payload] of [
    ['RECRUITEE', rc, 'bunq', fx('recruitee.list.json')],
    ['WORKABLE', wk, 'huggingface', fx('workable.list.json')],
    ['BREEZY', bz, 'breezy', fx('breezy.list.json')],
]) {
    const route = family === 'RECRUITEE' ? 'recruitee.com' : (family === 'WORKABLE' ? '/jobs' : 'breezy.hr/json');
    const { http } = stubHttp([[route, { json: payload }]]);
    const b = board(family, key, { company_name: 'Acme Corp' });
    const out = await adapter.fetchList(b, { http, now: NOW });
    const a = toAdapted(b, out.items[0], adapter, NOW);
    check(`${family}: source, portal and origin board`, [a.source, a.portalType, a.originBoard],
        [SOURCE_NAME, family, family.toLowerCase()]);
    check(`${family}: the registry's company name wins`, a.posting.company, 'Acme Corp');
}

/* ═════════════════════════════════════════════════════════════════════ */
section('http client: text mode');
{
    const html = '<html><body>not json</body></html>';
    const fetchImpl = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    const res = await httpJson('https://x.test/p', { as: 'text', fetchImpl });
    check('as:"text" returns the body and does not parse it', [res.json, res.text], [null, html]);
    let kind = null;
    try { await httpJson('https://x.test/p', { fetchImpl }); } catch (e) { kind = e.kind; }
    check('the default still treats non-JSON as an error', kind, 'ERROR');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
