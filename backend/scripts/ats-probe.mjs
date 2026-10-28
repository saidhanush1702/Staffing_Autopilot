/**
 * See what the ATS mirror would see on one employer's board — no database, no
 * writes, nothing queued. The quickest way to check a careers link works.
 *
 *   npm run ats:probe -- https://boards.greenhouse.io/stripe
 *   npm run ats:probe -- lever:palantir
 *   npm run ats:probe -- https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
 *   npm run ats:probe -- https://boards.greenhouse.io/stripe --jobs 5
 *
 * It does exactly what the "Verify" button does, then prints the first few jobs
 * the way the pipeline would receive them (company, title, place, pay, posted).
 */
import { httpJson, createLimiter, hostOf } from '../connectors/ats/http.js';
import { adapterFor, probeBoard, withConfig } from '../connectors/ats/index.js';
import { detectBoard } from '../connectors/ats/detect.js';
import { toAdapted } from '../connectors/ats/adapted.js';

const args = process.argv.slice(2);
const jobsFlag = args.indexOf('--jobs');
const showJobs = jobsFlag >= 0 ? Number(args.splice(jobsFlag, 2)[1]) || 3 : 3;
const input = args.join(' ').trim();

if (!input) {
    console.error('Usage: npm run ats:probe -- <careers URL | family:key> [--jobs N]');
    process.exit(2);
}

const detected = detectBoard(input);
if (!detected) {
    console.error(`Not recognised as a Greenhouse, Lever, Ashby, Workday or SmartRecruiters link: ${input}`);
    process.exit(2);
}

const limiter = createLimiter({ perHost: 2, gapMs: 150, total: 4 });
const ctx = { http: (url, o) => limiter.run(hostOf(url), () => httpJson(url, o)), now: new Date() };
const board = withConfig({
    family: detected.family, board_key: detected.key, config: detected.config, company_name: null,
});

console.log(`\n${detected.family}  ·  board "${detected.key}"`);

const started = Date.now();
const p = await probeBoard(board, ctx);
if (!p.ok) {
    console.error(`✗ ${p.notFound ? 'No such board' : 'Could not read it'}: ${p.error}`);
    process.exit(1);
}

console.log(`✓ readable in ${Date.now() - started}ms · ${p.total} open job(s)`);
console.log(`  company name from the system: ${p.companyName ?? '(not stated — you will need to enter it)'}`);

const adapter = adapterFor(detected.family);
const list = await adapter.fetchList(board, {
    ...ctx, etag: null, prevHash: null, knownIds: new Set(), isBootstrap: true, maxPages: 1,
});

for (const raw of list.items.slice(0, showJobs)) {
    let item = raw;
    if (item.needsDetail) {
        try { item = { ...item, ...(await adapter.fetchDetail(board, item, ctx)) }; } catch (e) {
            console.log(`  (detail failed for ${item.extId}: ${e.message})`);
        }
    }
    const a = toAdapted({ ...board, company_name: p.companyName ?? null }, item, adapter);
    if (!a) { console.log(`\n  ✗ ${item.title ?? item.extId} — unusable (no title or link)`); continue; }
    const j = a.posting;
    const pay = j.payMin != null || j.payMax != null
        ? `${j.payMin ?? '?'}–${j.payMax ?? '?'} ${j.payUnit} ${j.payCurrency ?? ''}`.trim() : 'not stated';
    console.log(`\n  ● ${j.title}`);
    console.log(`    ${j.company} · ${j.locationText ?? 'no location'}${j.isRemote ? ' · remote' : ''} · ${j.workType ?? 'type unknown'}`);
    console.log(`    pay: ${pay} · published: ${item.publishedAt ?? item.publishedDay ?? 'unknown'}`);
    console.log(`    ${j.sourceUrl}`);
    console.log(`    portal: ${a.portalType} · description: ${j.description ? `${j.description.length} chars` : 'none'}`);
}
console.log('');
process.exit(0);
