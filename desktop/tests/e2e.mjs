/**
 * ── END TO END, FOR REAL ──────────────────────────────────────────────
 *
 *   node tests/e2e.mjs         (backend must be running)
 *
 * Everything in run.mjs uses fakes. This does not: a real Chromium, the real
 * hub over HTTP, a real device token, the real database. The only thing it
 * substitutes is the JOB BOARD — a small local server serving a login page and
 * an application form — because signing into LinkedIn requires an account this
 * cannot have.
 *
 * ── WHY A FAKE BOARD IS STILL A REAL TEST ─────────────────────────────
 *
 * The parts that break are not the HTML of any particular employer. They are
 * the seams: does the device token authenticate, does leasing hold, does the
 * resume arrive as a file on disk, does the filler put the right value in the
 * right box, does the Q&A list survive to the submission record. A local form
 * exercises every one of those. What it cannot prove is that a given board's
 * selectors are right — which is what `npm run verify:board` is for, and why
 * every real recipe still ships unverified.
 *
 * ── WHAT IT LEAVES BEHIND ─────────────────────────────────────────────
 *
 * The device and the transition rows are removed. The posting, the queue item
 * and the application record are NOT, and cannot be: application_records and
 * application_qa are append-only by design, and the queue item is referenced by
 * the record. So each run leaves one submitted "E2E Test Co" application in the
 * Molina demo organisation. That is the append-only rule working, not a leak —
 * but it does mean the list grows by one every time this is run.
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const HUB = process.env.SMARTAPPLY_HUB ?? 'http://localhost:5001/api';
const ADMIN = { email: 'admin@molina.local', password: 'Admin@123' };
const PORT = 8791;
const BOARD_ORIGIN = `http://localhost:${PORT}`;

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── the board ────────────────────────────────────────────────────────── */

const FORM = `<!doctype html><html><body>
<h1>Apply — Senior React Developer</h1>
<form>
  <label for="fn">First name *</label><input id="fn" required>
  <label for="ln">Last name *</label><input id="ln" required>
  <label for="em">Email address *</label><input id="em" type="email" required>
  <label for="ph">Phone number</label><input id="ph" type="tel">
  <label for="ct">City</label><input id="ct">
  <label for="cv">Resume *</label><input id="cv" type="file" required>
  <button type="submit">Submit application</button>
</form></body></html>`;

const startBoard = () => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        // Signed in from the start: this test is about filling, and the sign-in
        // gate has its own coverage in run.mjs.
        res.end(FORM);
    });
    server.listen(PORT, () => resolve(server));
});

/* ── hub helpers ──────────────────────────────────────────────────────── */

const login = async () => {
    const res = await fetch(`${HUB}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ADMIN),
    });
    if (!res.ok) throw new Error(`admin login failed: ${res.status}`);
    return {
        'content-type': 'application/json',
        cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
    };
};

const main = async () => {
    const board = await startBoard();
    // pg and dotenv belong to the backend, not to this app — this harness
    // reaches across to them rather than adding a database driver to a desktop
    // application that must never hold one.
    const backend = path.resolve('..', 'backend');
    const pg = require(path.join(backend, 'node_modules', 'pg'));
    require(path.join(backend, 'node_modules', 'dotenv'))
        .config({ path: path.join(backend, '.env') });

    const db = new pg.Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
    });
    await db.connect();

    const made = { postingId: null, itemId: null, deviceId: null };
    let sessions = null;

    try {
        const H = await login();

        /* ── a job on our own board ──────────────────────────────── */

        const { rows: [consultant] } = await db.query(
            `SELECT u.id, u.organization_id FROM users u
               JOIN consultant_profiles p ON p.user_id = u.id
              WHERE u.email = 'consultant1@molina.local'`,
        );
        const orgId = consultant.organization_id;

        const { rows: [portal] } = await db.query(
            "SELECT id FROM lkp_portal_types WHERE name = 'BUILTIN'",
        );
        const { rows: [ready] } = await db.query(
            "SELECT id FROM lkp_queue_statuses WHERE name = 'READY'",
        );

        made.postingId = crypto.randomUUID();
        await db.query(
            `INSERT INTO job_postings
                (id, organization_id, company, title, location_text, source_url,
                 fingerprint, portal_type_id, first_seen_at, last_seen_at)
             VALUES ($1,$2,'E2E Test Co','Senior React Developer','Austin, TX',$3,$4,$5,now(),now())`,
            [made.postingId, orgId, `${BOARD_ORIGIN}/job/1`, `e2e-${Date.now()}`, portal.id],
        );

        made.itemId = crypto.randomUUID();
        await db.query(
            `INSERT INTO queue_items
                (id, organization_id, consultant_id, posting_id, status_id,
                 channel, queued_at, became_ready_at, prepared_at)
             VALUES ($1,$2,$3,$4,$5,'BOT',now(),now(),now())`,
            [made.itemId, orgId, consultant.id, made.postingId, ready.id],
        );

        /* ── a real device ───────────────────────────────────────── */

        const issued = await (await fetch(`${HUB}/management/devices`, {
            method: 'POST', headers: H, body: JSON.stringify({ consultantId: consultant.id }),
        })).json();

        const fingerprintHex = `e2e${Date.now()}`;
        const activated = await (await fetch(`${HUB}/device/activate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                activationCode: issued.activationCode,
                machineFingerprint: fingerprintHex,
                machineLabel: 'e2e harness',
            }),
        })).json();

        section('the device is admitted');
        check('a token was issued', typeof activated.deviceToken, 'string');

        const { rows: [dev] } = await db.query(
            'SELECT id FROM devices WHERE machine_fingerprint = $1', [fingerprintHex],
        );
        made.deviceId = dev.id;

        /* ── the real engine ─────────────────────────────────────── */

        const { HubClient } = require('../src/main/hubClient.js');
        const { BrowserSessions } = require('../src/main/browser/session.js');
        const { CycleEngine } = require('../src/main/cycle.js');
        const { BOARDS } = require('../src/main/browser/boards.js');
        const { Store } = require('../src/main/store.js');
        const { Outbox } = require('../src/main/outbox.js');
        const { resolveBrowser } = require('../src/main/browser/engine.js');

        // Point the BuiltIn recipe at our own server for the length of this
        // run, and mark it verified — the engine refuses to fill otherwise,
        // which is the behaviour the rest of the suite already covers.
        const original = { ...BOARDS.BUILTIN };
        BOARDS.BUILTIN.loginUrl = `${BOARD_ORIGIN}/login`;
        BOARDS.BUILTIN.signedIn = { present: [], absent: [] };
        BOARDS.BUILTIN.botCheck = [];
        BOARDS.BUILTIN.verified = true;

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smartapply-e2e-'));
        const paths = {
            state: path.join(tmp, 'state.json'),
            outbox: path.join(tmp, 'outbox.json'),
            profiles: path.join(tmp, 'profiles'),
            work: path.join(tmp, 'work'),
            logs: path.join(tmp, 'logs'),
        };
        for (const d of [paths.profiles, paths.work, paths.logs]) {
            fs.mkdirSync(d, { recursive: true });
        }

        const hub = new HubClient({
            getToken: () => activated.deviceToken,
            fingerprint: fingerprintHex,
            onRevoked: (why) => { throw new Error(`revoked mid-test: ${why}`); },
            baseURL: HUB,
        });

        const { chromium, launchOptions } = resolveBrowser();
        sessions = new BrowserSessions({ chromium, profilesDir: paths.profiles, launchOptions });

        const store = new Store(paths.state);
        const engine = new CycleEngine({
            hub, sessions, store, outbox: new Outbox(paths.outbox), paths,
            log: (m) => console.log(`      · ${m}`),
        });

        section('one real pass, against a real browser');
        const result = await engine.run();

        check('the item was pulled', result.pulled >= 1, true);
        check('it was leased', result.leased, 1);
        check('the page was opened', result.opened, 1);
        check('the form was filled', result.filled, 1);
        check('nothing was parked', result.parked, 0);
        // Scoped to OUR item: this runs against a shared queue, and a demo
        // posting pointing at an unreachable host failing is not this test's
        // business.
        check('our item did not error',
            result.errors.filter((e) => e.includes('E2E Test Co')), []);

        section('what the hub now believes');
        const { rows: [state] } = await db.query(
            `SELECT st.name FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
              WHERE q.id = $1`, [made.itemId],
        );
        check('the item awaits the consultant', state.name, 'AWAITING_REVIEW');

        section('what was actually typed');
        const waiting = store.get('awaitingReview');
        check('one application is waiting for review', waiting.length, 1);
        const answers = Object.fromEntries(
            waiting[0].qa.map((q) => [q.questionText.replace(/\s*\*$/, ''), q.answerText]),
        );
        check('first name', answers['First name'], 'Consultant');
        check('last name', answers['Last name'], '1');
        check('email address', answers['Email address'], 'consultant1@molina.local');
        check('the resume was attached', waiting[0].attachedResume, true);

        // The resume is NOT still on disk, and that is the guarantee (R-20):
        // `work` is wiped at the end of every pass. That it was attached at all
        // is already proven above — the browser will not accept a file input it
        // cannot read, so `attachedResume` could not be true without a real
        // file having existed here a moment ago.
        check('and nothing was left behind on disk (R-20)',
            fs.readdirSync(paths.work).length, 0);

        section('the consultant submits');
        const submitted = await engine.reportSubmitted(made.itemId);
        check('the report was accepted', submitted.ok, true);
        check('and it left the review list', store.get('awaitingReview').length, 0);

        const { rows: [record] } = await db.query(
            `SELECT a.id, a.company, a.job_title, s.name AS status
               FROM application_records a
               JOIN lkp_application_statuses s ON s.id = a.status_id
              WHERE a.queue_item_id = $1`, [made.itemId],
        );
        check('a permanent application record exists', record?.company, 'E2E Test Co');
        check('  marked submitted', record?.status, 'SUBMITTED');

        const { rows: qa } = await db.query(
            'SELECT question_text, answer_text FROM application_qa WHERE application_id = $1 ORDER BY position',
            [record.id],
        );
        check('the full question-and-answer list was stored', qa.length, waiting[0].qa.length);

        const { rows: [after] } = await db.query(
            `SELECT st.name FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
              WHERE q.id = $1`, [made.itemId],
        );
        check('the queue item is finished', after.name, 'SUBMITTED');

        Object.assign(BOARDS.BUILTIN, original);
        fs.rmSync(tmp, { recursive: true, force: true });
    } finally {
        try { await sessions?.closeAll(); } catch { /* nothing open */ }
        board.close();

        // application_records and application_qa are append-only by design, so
        // the record this test creates is left where it is. Everything the test
        // invented that CAN be removed, is.
        if (made.itemId) {
            await db.query('DELETE FROM queue_item_transitions WHERE queue_item_id = $1', [made.itemId]);
        }
        if (made.deviceId) await db.query('DELETE FROM devices WHERE id = $1', [made.deviceId]);
        await db.end();

        console.log(`\n${pass} passed, ${fail} failed\n`);
        process.exit(fail ? 1 : 0);
    }
};

main().catch((err) => {
    console.error(`\ne2e failed to run: ${err.stack}\n`);
    process.exit(1);
});
