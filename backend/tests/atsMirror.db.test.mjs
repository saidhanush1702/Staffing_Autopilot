/**
 * ATS live mirror — database integration suite.
 *
 *   ATS_TEST_DB=staffing_autopilot_test node tests/atsMirror.db.test.mjs
 *   npm run test:ats-db
 *
 * Runs the REAL poller, the REAL diff, the REAL ingest pipeline (fingerprint →
 * matcher → job_matches → queue_items) and the REAL schema. Only the network is
 * faked: a scripted employer board stands in for Greenhouse.
 *
 * ── IT REFUSES TO RUN AGAINST DEV DATA ────────────────────────────────
 *
 * This suite inserts postings, matches and queue items, and `promoteToReady`
 * enqueues AI preparation jobs. Against a database with real consultants and
 * `WORKER_ENABLED=true` that would spend money on fiction. So it will only run
 * against a database whose name contains "test", and never through
 * DATABASE_URL. Everything it creates is tagged "AtsTest" and removed at start
 * and end.
 *
 * Needs the migrations AND seeds applied to that database (the seeded Molina
 * bench is what the test jobs match against).
 */
const TEST_DB = process.env.ATS_TEST_DB ?? 'staffing_autopilot_test';

if (process.env.DATABASE_URL || process.env.MIGRATION_DATABASE_URL) {
    console.error('Refusing to run: DATABASE_URL is set. This suite only talks to a local database by name.');
    process.exit(2);
}
if (!/test/i.test(TEST_DB)) {
    console.error(`Refusing to run against "${TEST_DB}": the database name must contain "test".`);
    process.exit(2);
}
// BEFORE db.js is imported — dotenv never overrides a variable already set.
process.env.DB_NAME = TEST_DB;

const { query, pool } = await import('../db.js');
const { pollBoard, getOrCreateSettings } = await import('../services/atsPoller.js');
const { createIngestor, clearBenchCache } = await import('../services/atsIngest.js');
const { claimDue, claimOne } = await import('../jobs/atsMirror.js');
const { ingestAdapted } = await import('../controllers/jobspipeListener.js');
const { searchJobToPosting } = await import('../connectors/jobspipeSearch.js');
const { AtsHttpError } = await import('../connectors/ats/http.js');
const { v4: uuidv4 } = await import('uuid');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    if (ok) pass += 1; else fail += 1;
};
const truthy = (label, v) => check(label, Boolean(v), true);
const section = (t) => console.log(`\n— ${t} —`);

const COMPANY = 'AtsTest Employer';
const KEY = 'atstest';

/* ── a scripted employer ─────────────────────────────────────────────── */

const world = { jobs: [], version: 1, fail: null, hits: [] };

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const job = (id, title, { location = 'Remote - US', ago = 5, content = '<p>React TypeScript Next.js.</p>' } = {}) => ({
    id, title, location: { name: location }, updated_at: minutesAgo(ago), first_published: minutesAgo(ago),
    company_name: COMPANY, absolute_url: `https://careers.atstest.example/jobs/${id}`, metadata: null,
    internal_job_id: id, requisition_id: String(id), _content: content,
});

const strip = ({ _content, ...rest }) => rest;
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

world.http = async (url, opts = {}) => {
    world.hits.push(url);
    if (world.fail) throw world.fail;
    const detail = /\/jobs\/(\d+)$/.exec(url);
    if (detail) {
        const j = world.jobs.find((x) => String(x.id) === detail[1]);
        if (!j) throw new AtsHttpError('gone', { kind: 'NOT_FOUND', status: 404 });
        return { status: 200, notModified: false, bytes: 500, json: { ...strip(j), content: escapeHtml(j._content) } };
    }
    const etag = `W/"v${world.version}"`;
    if (opts.etag === etag) return { status: 304, notModified: true, bytes: 0, etag };
    return {
        status: 200, notModified: false, bytes: 2000, etag,
        json: { jobs: world.jobs.map(strip), meta: { total: world.jobs.length } },
    };
};
const publish = () => { world.version += 1; };

/* ── fixtures in the database ────────────────────────────────────────── */

const { rows: orgs } = await query("SELECT id FROM organizations WHERE name = 'Molina Staffing'");
if (!orgs[0]) {
    console.error(`No "Molina Staffing" organisation in ${TEST_DB}. Apply migrations AND seeds first.`);
    process.exit(2);
}
const ORG = orgs[0].id;
const { rows: tbl } = await query("SELECT to_regclass('ats_boards') AS t");
if (!tbl[0].t) { console.error('Migration 058 has not been applied to this database.'); process.exit(2); }

const cleanup = async () => {
    await query('DELETE FROM ats_boards WHERE organization_id = $1 AND board_key LIKE $2', [ORG, `${KEY}%`]);
    const { rows } = await query(
        'SELECT id FROM job_postings WHERE organization_id = $1 AND company ILIKE $2', [ORG, 'atstest%'],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
        await query('DELETE FROM queue_item_transitions WHERE queue_item_id IN (SELECT id FROM queue_items WHERE posting_id = ANY($1))', [ids]).catch(() => {});
        await query('DELETE FROM background_jobs WHERE payload::text LIKE ANY (SELECT \'%\' || id || \'%\' FROM queue_items WHERE posting_id = ANY($1))', [ids]).catch(() => {});
        await query('DELETE FROM queue_items WHERE posting_id = ANY($1)', [ids]);
        await query('DELETE FROM job_matches WHERE posting_id = ANY($1)', [ids]);
        await query('DELETE FROM job_posting_sightings WHERE posting_id = ANY($1)', [ids]);
        await query('DELETE FROM job_postings WHERE id = ANY($1)', [ids]);
    }
};

const familyId = (await query("SELECT id FROM lkp_ats_families WHERE name = 'GREENHOUSE'")).rows[0].id;

const setSettings = (patch) => query(
    `UPDATE ats_org_settings SET is_enabled = COALESCE($2, is_enabled), mode = COALESCE($3, mode),
            bootstrap_age_hours = COALESCE($4, bootstrap_age_hours),
            max_ingest_per_poll = COALESCE($5, max_ingest_per_poll),
            detail_cap_per_poll = COALESCE($6, detail_cap_per_poll),
            close_on_removal = COALESCE($7, close_on_removal)
      WHERE organization_id = $1`,
    [ORG, patch.enabled ?? null, patch.mode ?? null, patch.bootstrap ?? null,
        patch.maxIngest ?? null, patch.detailCap ?? null, patch.closeOnRemoval ?? null],
);

const addBoard = async (key, name = COMPANY) => {
    const id = uuidv4();
    await query(
        `INSERT INTO ats_boards (id, organization_id, family_id, board_key, config, company_name, status)
         VALUES ($1,$2,$3,$4,'{}',$5,'PENDING')`,
        [id, ORG, familyId, key, name],
    );
    return id;
};

const loadRow = async (id) => (await query(
    `SELECT b.*, f.name AS family, f.min_interval_s AS family_min_interval_s
       FROM ats_boards b JOIN lkp_ats_families f ON f.id = b.family_id WHERE b.id = $1`, [id],
)).rows[0];

const poll = async (id, { mode } = {}) => {
    const settings = { ...(await getOrCreateSettings(ORG)), ...(mode ? { mode } : {}) };
    return pollBoard(await loadRow(id), {
        settings, http: world.http, ingest: createIngestor(ORG), trigger: 'MANUAL', now: new Date(), rand: () => 0.5,
    });
};

const jobRows = async (id) => (await query(
    'SELECT ext_id, state, latency_s, posting_id, matches, queued, closed_at, missed_polls FROM ats_board_jobs WHERE board_id = $1 ORDER BY ext_id',
    [id],
)).rows;
const state = (rows, ext) => rows.find((r) => r.ext_id === String(ext))?.state;
const postingsFor = async (like) => (await query(
    'SELECT * FROM job_postings WHERE organization_id = $1 AND company ILIKE $2', [ORG, like],
)).rows;

try {
    await cleanup();
    await getOrCreateSettings(ORG);
    await setSettings({ enabled: true, mode: 'OBSERVE', bootstrap: 48, maxIngest: 50, detailCap: 25, closeOnRemoval: false });
    clearBenchCache();

    const bench = await (await import('../controllers/discoveryController.js')).loadMatchableConsultants(ORG);
    console.log(`(bench for Molina Staffing in ${TEST_DB}: ${bench.length} matchable consultant(s))`);

    /* ════════════════════════════════════════════════════════════════ */
    section('FIRST CONTACT is a baseline, not news (OBSERVE mode)');

    world.jobs = [
        job(1001, 'Staff Engineer', { ago: 60 * 24 * 90 }),       // 90 days
        job(1002, 'Data Engineer', { ago: 60 * 24 * 40 }),
        job(1003, 'Designer', { ago: 60 * 24 * 10 }),
        job(1004, 'Fresh Frontend Engineer', { ago: 120 }),        // 2 h
    ];
    const boardId = await addBoard(KEY);
    const r1 = await poll(boardId);
    let rows = await jobRows(boardId);
    let board = await loadRow(boardId);

    check('outcome is BASELINED', r1.outcome, 'BASELINED');
    check('every listed job is remembered', rows.length, 4);
    check('old jobs are BASELINE — never ingested', [state(rows, 1001), state(rows, 1002), state(rows, 1003)], ['BASELINE', 'BASELINE', 'BASELINE']);
    check('a provably fresh one is a candidate, only OBSERVED here', state(rows, 1004), 'OBSERVED');
    check('baseline detections carry NO latency (we were not watching)', rows.find((r) => r.ext_id === '1004').latency_s, null);
    check('OBSERVE created no postings', (await postingsFor('AtsTest%')).length, 0);
    check('board is now ACTIVE and baselined', [board.status, Boolean(board.baselined_at)], ['ACTIVE', true]);
    check('the ETag is remembered', board.etag, `W/"v${world.version}"`);
    check('jobs_open reflects the board', board.jobs_open, 4);

    /* ════════════════════════════════════════════════════════════════ */
    section('an unchanged board costs a header exchange');

    const hitsBefore = world.hits.length;
    const r2 = await poll(boardId);
    check('304 → NOT_MODIFIED', r2.outcome, 'NOT_MODIFIED');
    check('exactly one request, no detail calls', world.hits.length - hitsBefore, 1);
    check('nothing new was recorded', (await jobRows(boardId)).length, 4);
    const afterQuiet = await loadRow(boardId);
    truthy('a quiet board slows down (interval grew)', afterQuiet.interval_s > board.interval_s || afterQuiet.interval_s >= 450);

    /* ════════════════════════════════════════════════════════════════ */
    section('a new job is detected, with how long it took (OBSERVE)');

    world.jobs.push(job(1005, 'Platform Engineer', { ago: 1.5 }));          // 90 s ago
    publish();
    const r3 = await poll(boardId);
    rows = await jobRows(boardId);
    check('outcome OK, one new', [r3.outcome, r3.new_found], ['OK', 1]);
    check('recorded as OBSERVED', state(rows, 1005), 'OBSERVED');
    const lat = rows.find((r) => r.ext_id === '1005').latency_s;
    truthy(`latency measured from the employer's timestamp (${lat}s ≈ 90s)`, lat >= 85 && lat <= 130);
    check('still no postings — nothing reaches a queue in OBSERVE', (await postingsFor('AtsTest%')).length, 0);
    board = await loadRow(boardId);
    check('a board that just changed snaps to its floor (120s ±jitter)', board.interval_s, 120);
    truthy('next poll is scheduled ~2 min out', (new Date(board.next_poll_at) - Date.now()) / 1000 <= 135);

    /* ════════════════════════════════════════════════════════════════ */
    section('LIVE: a matching job flows through the REAL pipeline');

    await setSettings({ mode: 'LIVE' });
    clearBenchCache();
    world.jobs.push(job(1006, 'React Developer', { location: 'Remote - US', ago: 2, content: '<p>Contract role. React, TypeScript and Next.js.</p>' }));
    publish();
    const r4 = await poll(boardId);
    rows = await jobRows(boardId);
    check('ingested one new posting', [r4.outcome, r4.ingested], ['OK', 1]);
    check('the detail request supplied the description', r4.detail_fetches, 1);
    check('state INGESTED', state(rows, 1006), 'INGESTED');

    const posts = await postingsFor(COMPANY);
    check('exactly one posting exists', posts.length, 1);
    const p = posts[0];
    check('stored under the ATS source', (await query('SELECT name FROM lkp_job_sources WHERE id = $1', [p.first_source_id])).rows[0].name, 'ATS_DIRECT');
    check('origin board uses the 046 vocabulary', p.origin_board, 'greenhouse');
    check('portal type is GREENHOUSE (known, not guessed from the url)',
        (await query('SELECT name FROM lkp_portal_types WHERE id = $1', [p.portal_type_id])).rows[0].name, 'GREENHOUSE');
    truthy('description was decoded from escaped HTML', p.description && !/&lt;|<p>/.test(p.description) && /React/.test(p.description));
    check('posted_at is the employer\'s timestamp, not ours', Math.abs(new Date(p.posted_at) - (Date.now() - 2 * 60_000)) < 20_000, true);
    check('provider id is namespaced', p.provider_job_id, 'greenhouse:1006');

    const jr = rows.find((r) => r.ext_id === '1006');
    check('the board row links to the posting', jr.posting_id, p.id);
    if (bench.length > 0) {
        truthy('a fitting consultant was matched', jr.matches >= 1);
        const { rows: qi } = await query(
            `SELECT q.id, st.name AS status, q.channel, m.reason
               FROM queue_items q JOIN lkp_queue_statuses st ON st.id = q.status_id
               JOIN job_matches m ON m.id = q.match_id WHERE q.posting_id = $1`, [p.id]);
        truthy('…and queued', qi.length >= 1);
        truthy('provenance says ATS mirror, NOT JobsPipe', qi.length && /\[via ATS mirror\]/.test(qi[0].reason) && !/JobsPipe/.test(qi[0].reason));
        const { rows: tr } = await query(
            'SELECT reason FROM queue_item_transitions WHERE queue_item_id = $1', [qi[0]?.id]);
        truthy('the transition log names the employer board', tr.length && /employer's board \(via greenhouse\)/.test(tr[0].reason));
    } else {
        console.log('  (skipped match assertions: no matchable consultants in this database)');
    }

    /* ════════════════════════════════════════════════════════════════ */
    section('R-15 across doors: a job another door already holds is a DUPLICATE');

    // Put a job in through JobsPipe's own pipeline first...
    const viaJobsPipe = searchJobToPosting({
        id: 'jp-1', job_title: 'Senior React Engineer', company: COMPANY, url: 'https://boards.greenhouse.io/atstest/jobs/jp-1',
        location: 'Remote - US', description: 'React TypeScript.', date_posted: minutesAgo(30), discovered_at: minutesAgo(25),
    });
    const jp = await ingestAdapted(ORG, viaJobsPipe);
    check('JobsPipe stored it', jp.isNew, true);
    const countBefore = (await postingsFor(COMPANY)).length;
    const queuedBefore = (await query('SELECT count(*)::int n FROM queue_items WHERE posting_id = $1', [jp.postingId])).rows[0].n;

    // ...then the employer's board lists the same job.
    world.jobs.push(job(1007, 'Senior React Engineer', { location: 'Remote - US', ago: 1 }));
    publish();
    const r5 = await poll(boardId);
    rows = await jobRows(boardId);
    check('the mirror recognised it', [r5.ingested, r5.duplicates], [0, 1]);
    check('state DUPLICATE', state(rows, 1007), 'DUPLICATE');
    check('no second posting was created', (await postingsFor(COMPANY)).length, countBefore);
    check('and the row points at the existing posting', rows.find((r) => r.ext_id === '1007').posting_id, jp.postingId);
    const queuedAfter = (await query('SELECT count(*)::int n FROM queue_items WHERE posting_id = $1', [jp.postingId])).rows[0].n;
    check('nobody was queued for it twice', queuedAfter, queuedBefore);

    /* ════════════════════════════════════════════════════════════════ */
    section('bounds: a burst cannot flood the queue');

    await setSettings({ maxIngest: 1, detailCap: 25 });
    world.jobs.push(
        job(1008, 'Cap Test One', { ago: 3 }),
        job(1009, 'Cap Test Two', { ago: 2 }),
        job(1010, 'Cap Test Three', { ago: 1 }),
    );
    publish();
    const r6 = await poll(boardId);
    rows = await jobRows(boardId);
    check('only max_ingest_per_poll were ingested', r6.ingested + r6.duplicates, 1);
    check('the rest are kept as DETECTED, not lost',
        [state(rows, 1008), state(rows, 1009), state(rows, 1010)].filter((s) => s === 'DETECTED').length, 2);
    check('the freshest was taken first', state(rows, 1010) !== 'DETECTED', true);

    await setSettings({ maxIngest: 50 });
    const r7 = await poll(boardId);       // a 304 — the backlog must still drain
    check('the next poll is a 304…', r7.outcome, 'NOT_MODIFIED');
    check('…and STILL drains the backlog', r7.ingested + r7.duplicates, 2);
    rows = await jobRows(boardId);
    check('nothing left pending', rows.filter((r) => r.state === 'DETECTED').length, 0);

    /* ════════════════════════════════════════════════════════════════ */
    section('a job that vanishes closes only after two complete reads');

    world.jobs = world.jobs.filter((j) => j.id !== 1008);
    publish();
    await poll(boardId);
    rows = await jobRows(boardId);
    check('first miss: still open', [rows.find((r) => r.ext_id === '1008').closed_at, rows.find((r) => r.ext_id === '1008').missed_polls], [null, 1]);
    publish();
    const r9 = await poll(boardId);
    rows = await jobRows(boardId);
    check('second miss: closed', Boolean(rows.find((r) => r.ext_id === '1008').closed_at), true);
    check('the poll reports it', r9.closed, 1);
    const pid = rows.find((r) => r.ext_id === '1008').posting_id;
    check('the posting stays active by default (close_on_removal is off)',
        pid ? (await query('SELECT is_active FROM job_postings WHERE id = $1', [pid])).rows[0].is_active : true, true);

    world.jobs.push(job(1008, 'Cap Test One', { ago: 3 }));
    publish();
    const r10 = await poll(boardId);
    rows = await jobRows(boardId);
    check('a job that comes BACK is reopened, not re-ingested', [rows.find((r) => r.ext_id === '1008').closed_at, r10.new_found], [null, 0]);

    /* close_on_removal reaches the posting */
    await setSettings({ closeOnRemoval: true });
    world.jobs = world.jobs.filter((j) => j.id !== 1009);
    publish(); await poll(boardId); publish(); await poll(boardId);
    rows = await jobRows(boardId);
    const pid9 = rows.find((r) => r.ext_id === '1009').posting_id;
    if (pid9) {
        check('with close_on_removal ON, the posting is deactivated',
            (await query('SELECT is_active FROM job_postings WHERE id = $1', [pid9])).rows[0].is_active, false);
    }
    await setSettings({ closeOnRemoval: false });

    /* ════════════════════════════════════════════════════════════════ */
    section('a mass disappearance is a bad read, not a layoff');

    // Two earlier misses would already close a job, so first give every open job
    // one miss on record: if the guard failed, ONE more bad read would close them all.
    await query('UPDATE ats_board_jobs SET missed_polls = 1 WHERE board_id = $1 AND closed_at IS NULL', [boardId]);
    const openBefore = (await jobRows(boardId)).filter((r) => !r.closed_at);
    const keep = world.jobs.slice(0, 1);
    world.jobs = keep;
    publish();
    const r11 = await poll(boardId);
    rows = await jobRows(boardId);
    const openAfter = rows.filter((r) => !r.closed_at);
    truthy(`setup is meaningful: ${openBefore.length} open jobs, 1 listed`, openBefore.length >= 6);
    check('the poll closed nothing', r11.closed, 0);
    check('every job that was open is STILL open', openAfter.length, openBefore.length);
    check('and no job was counted against (missed_polls untouched)',
        rows.filter((r) => !r.closed_at).every((r) => r.missed_polls === 1 || r.ext_id === String(keep[0].id)), true);

    /* ════════════════════════════════════════════════════════════════ */
    section('failure handling');

    world.fail = new AtsHttpError('HTTP 503 from boards-api.greenhouse.io', { kind: 'ERROR', status: 503, retryAfterS: 300 });
    const before = await loadRow(boardId);
    const r12 = await poll(boardId);
    const afterErr = await loadRow(boardId);
    check('outcome ERROR', r12.outcome, 'ERROR');
    check('consecutive failures counted', afterErr.consecutive_failures, before.consecutive_failures + 1);
    truthy('backed off (Retry-After honoured)', afterErr.interval_s >= 300);
    truthy('the error is recorded on the board', /503/.test(afterErr.last_error));
    check('the claim was released', afterErr.claimed_until, null);

    world.fail = null; publish();
    const r13 = await poll(boardId);
    const healed = await loadRow(boardId);
    check('recovers on the next good read', [r13.outcome !== 'ERROR', healed.consecutive_failures, healed.last_error], [true, 0, null]);

    /* a vanished board is parked after 5 NOT_FOUNDs, not hammered */
    const ghostId = await addBoard(`${KEY}-ghost`);
    world.fail = new AtsHttpError('Not found (HTTP 404)', { kind: 'NOT_FOUND', status: 404 });
    for (let i = 0; i < 5; i += 1) await poll(ghostId);
    const ghost = await loadRow(ghostId);
    check('5 NOT_FOUND polls park the board', [ghost.status, ghost.consecutive_not_found], ['NOT_FOUND', 5]);
    truthy('and it backs off to at least an hour', ghost.interval_s >= 3600);
    world.fail = null;

    /* ════════════════════════════════════════════════════════════════ */
    section('a board with no real company name only OBSERVES');

    const nameless = await addBoard(`${KEY}-nameless`, null);
    await query("UPDATE ats_boards SET baselined_at = now() WHERE id = $1", [nameless]);   // skip bootstrap
    const stripCompany = (j) => ({ ...j, company_name: undefined });
    const savedHttp = world.http;
    world.http = async (url, opts) => {
        const out = await savedHttp(url, opts);
        if (out.json?.jobs) out.json = { ...out.json, jobs: out.json.jobs.map(stripCompany) };
        else if (out.json) out.json = stripCompany(out.json);
        return out;
    };
    world.jobs = [job(2001, 'React Developer', { ago: 1 })];
    publish();
    const r14 = await poll(nameless);
    const nrows = await jobRows(nameless);
    check('detected…', r14.new_found, 1);
    check('…but only OBSERVED (a guessed name would not dedupe against other doors)', state(nrows, 2001), 'OBSERVED');
    check('and no posting was created for it (no guessed-name company in the pool)',
        (await postingsFor('atstest%')).filter((p) => p.company !== COMPANY).length, 0);
    world.http = savedHttp;

    /* ════════════════════════════════════════════════════════════════ */
    section('turning the feature OFF leaves no back door');

    await setSettings({ enabled: false, mode: 'LIVE' });
    // pollClaimed (what manual/on-add polls use) holds an OFF agency in OBSERVE
    const { pollClaimed } = await import('../jobs/atsMirror.js');
    const offBoard = await addBoard(`${KEY}-off`);
    await query("UPDATE ats_boards SET baselined_at = now() WHERE id = $1", [offBoard]);
    world.jobs = [job(3001, 'React Developer', { ago: 1, content: '<p>React, TypeScript and Next.js contract.</p>' })];
    publish();
    const claimed = await claimOne(offBoard, ORG);
    truthy('a manual claim works while OFF', claimed);
    const effective = await getOrCreateSettings(ORG);
    check('settings say OFF + LIVE', [effective.is_enabled, effective.mode], [false, 'LIVE']);

    // The REAL entry point manual/on-add polls use — only the network is faked.
    // If the guard were missing, this React job matches the seeded consultant and
    // would be ingested and queued, exactly as in the LIVE section above.
    const ingestCalls = [];
    const offRun = await pollClaimed(claimed, effective, {
        trigger: 'MANUAL', httpClient: world.http,
        ingest: async (a) => { ingestCalls.push(a); throw new Error('ingest must not be called while OFF'); },
    });
    const offRows = await jobRows(offBoard);
    check('it detected the job…', offRun.new_found, 1);
    check('…recorded it as OBSERVED only', state(offRows, 3001), 'OBSERVED');
    check('the ingest pipeline was never invoked', ingestCalls.length, 0);
    check('no posting was created for it', (await postingsFor(COMPANY)).filter((p) => p.provider_job_id === 'greenhouse:3001').length, 0);
    await setSettings({ enabled: true, mode: 'OBSERVE' });

    /* ════════════════════════════════════════════════════════════════ */
    section('claiming: one worker per board, and a lapsed lease is recoverable');

    await query('UPDATE ats_boards SET is_enabled = FALSE WHERE organization_id = $1 AND board_key LIKE $2', [ORG, `${KEY}%`]);
    const dueBoard = await addBoard(`${KEY}-due`);
    await query("UPDATE ats_boards SET next_poll_at = now() - interval '1 minute', baselined_at = now() WHERE id = $1", [dueBoard]);
    const c1 = (await claimDue(50)).filter((b) => b.id === dueBoard);
    check('a due board is claimed', c1.length, 1);
    check('…with its family attached', [c1[0].family, c1[0].family_min_interval_s], ['GREENHOUSE', 60]);
    const c2 = (await claimDue(50)).filter((b) => b.id === dueBoard);
    check('a second claim while leased gets nothing', c2.length, 0);
    check('a manual claim of a leased board is refused', await claimOne(dueBoard, ORG), null);
    await query("UPDATE ats_boards SET claimed_until = now() - interval '1 second' WHERE id = $1", [dueBoard]);
    check('once the lease lapses it is claimable again', (await claimDue(50)).filter((b) => b.id === dueBoard).length, 1);

    // A disabled AGENCY is never claimed, however due its boards are.
    await query("UPDATE ats_boards SET claimed_until = NULL WHERE id = $1", [dueBoard]);
    await setSettings({ enabled: false });
    check('a switched-off agency\'s boards are never claimed', (await claimDue(50)).filter((b) => b.id === dueBoard).length, 0);
    await setSettings({ enabled: true });

    // Two workers racing for the same board: exactly one wins.
    await query("UPDATE ats_boards SET claimed_until = NULL, next_poll_at = now() - interval '1 minute' WHERE id = $1", [dueBoard]);
    const race = await Promise.all([claimDue(50), claimDue(50), claimDue(50)]);
    check('three racing workers: the board is taken exactly once',
        race.flat().filter((b) => b.id === dueBoard).length, 1);

    /* ════════════════════════════════════════════════════════════════ */
    section('tenant isolation');

    const { rows: other } = await query("SELECT id FROM organizations WHERE name = 'Apex Staffing'");
    if (other[0]) {
        const seen = await query('SELECT count(*)::int n FROM ats_boards WHERE organization_id = $1 AND board_key LIKE $2', [other[0].id, `${KEY}%`]);
        check('another agency sees none of these boards', seen.rows[0].n, 0);
    }

    /* ════════════════════════════════════════════════════════════════ */
    section('the other doors are untouched');

    const { rows: srcs } = await query("SELECT name, fetch_mode FROM lkp_job_sources WHERE name IN ('JOBSPIPE','GOOGLE_JOBS','ATS_DIRECT') ORDER BY name");
    check('source rows intact; ATS_DIRECT is its own mode',
        srcs.map((s) => `${s.name}:${s.fetch_mode}`), ['ATS_DIRECT:ATS', 'GOOGLE_JOBS:PROVIDER', 'JOBSPIPE:WEBHOOK']);
    const { rows: prov } = await query("SELECT count(*)::int n FROM lkp_job_sources WHERE fetch_mode = 'PROVIDER' AND name = 'ATS_DIRECT'");
    check('the discovery cycle can never select ATS_DIRECT as a search provider', prov[0].n, 0);
} finally {
    await cleanup().catch((e) => console.error('cleanup failed:', e.message));
    await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
