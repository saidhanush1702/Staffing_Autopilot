/**
 * Held runs — the ledger, and what the engine does with it.
 *
 *   node tests/runs.mjs
 *
 * Same rules as run.mjs: no Electron, no Playwright, no hub. The engine takes
 * its browser and hub as arguments, so a gate that needs a person can be proven
 * without one — and without waiting a real day for the time limit.
 */
process.env.SMARTAPPLY_BOT_FLOWS = '*';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Store } = require('../src/main/store.js');
const { Outbox } = require('../src/main/outbox.js');
const { BOARDS } = require('../src/main/browser/boards.js');
const { CycleEngine } = require('../src/main/cycle.js');
const { RunLedger } = require('../src/main/runs.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-runs-'));
const paths = { work: path.join(tmp, 'work'), profiles: path.join(tmp, 'profiles') };
fs.mkdirSync(paths.work, { recursive: true });

const MIN = 60_000;
const HOUR = 60 * MIN;

const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
};

const newStore = () => new Store(path.join(tmp, `state-${Math.random()}.json`));

const gate = { kind: 'SIGN_IN', message: 'Sign in to Wellfound' };
const base = { itemId: 'q1', lane: 'WELLFOUND', company: 'Globex', title: 'Dev', gate };

/* ── the ledger on its own ───────────────────────────────────────────── */

section('the ledger records who is waiting on a person');
{
    const c = clock();
    const store = newStore();
    const ledger = new RunLedger({ store, now: c.now });

    ledger.defer(base);
    check('a deferred run is waiting', ledger.waiting().map((r) => r.itemId), ['q1']);
    check('  and it holds its lane', ledger.holdsLane('WELLFOUND'), true);
    check('  but no other lane', ledger.holdsLane('LINKEDIN'), false);
    check('  and it is not due for a retry straight away', ledger.due(ledger.get('q1')), false);

    c.advance(31 * MIN);
    check('  it is due once the cool-down has passed', ledger.due(ledger.get('q1')), true);

    const since = ledger.get('q1').since;
    ledger.defer({ ...base, gate: { kind: 'SIGN_IN', message: 'again' } });
    check('deferring again keeps the original start time', ledger.get('q1').since, since);
    check('  but takes the latest wording', ledger.get('q1').gate.message, 'again');

    ledger.resume('q1');
    check('a run being retried no longer holds its lane', ledger.holdsLane('WELLFOUND'), false);
    check('  and counts the attempt', ledger.get('q1').attempts, 1);
    ledger.resolve('q1');
    check('a finished run leaves no trace', ledger.all(), []);

    const again = new RunLedger({ store: newStore(), now: c.now });
    again.defer(base);
    const reread = new RunLedger({ store: again.store, now: c.now });
    check('it survives being read back from the store', reread.waiting().length, 1);
}

section('reminders come at 5 min, 30 min and 2 h, then every 2 h');
{
    const c = clock();
    const ledger = new RunLedger({ store: newStore(), now: c.now });
    ledger.defer(base);

    check('nothing before five minutes', ledger.takeReminders().length, 0);
    c.advance(5 * MIN);
    check('first nudge at five minutes', ledger.takeReminders().length, 1);
    check('  not repeated by a second poll', ledger.takeReminders().length, 0);
    c.advance(25 * MIN);
    check('second at thirty', ledger.takeReminders().length, 1);
    c.advance(90 * MIN);
    check('third at two hours', ledger.takeReminders().length, 1);
    c.advance(1 * HOUR);
    check('then quiet until another two hours', ledger.takeReminders().length, 0);
    c.advance(1 * HOUR);
    check('  and nudged again', ledger.takeReminders().length, 1);
}

section('a run waits a day, then gives up');
{
    const c = clock();
    const ledger = new RunLedger({ store: newStore(), now: c.now });
    ledger.defer(base);

    c.advance(23 * HOUR);
    check('still held after 23 hours', ledger.takeExpired().length, 0);
    c.advance(2 * HOUR);
    check('  expired after 25', ledger.holdsLane('WELLFOUND'), false);
    check('  and handed back exactly once', ledger.takeExpired().map((r) => r.itemId), ['q1']);
    check('  then gone', ledger.takeExpired().length, 0);
}

section('"I\'ve done it" and a crash');
{
    const c = clock();
    const ledger = new RunLedger({ store: newStore(), now: c.now });
    ledger.defer(base);
    check('before pressing it the run is not due', ledger.due(ledger.get('q1')), false);
    ledger.requestResume('q1');
    check('pressing it makes the run due at once', ledger.due(ledger.get('q1')), true);
    check('  and asking about a job that is not held does nothing', ledger.requestResume('nope'), false);

    ledger.resume('q1');
    const recovered = ledger.recover();
    check('a run left mid-retry by a crash is waiting again', recovered, 1);
    check('  and is due straight away', ledger.due(ledger.get('q1')), true);
}

/* ── the engine ──────────────────────────────────────────────────────── */

BOARDS.WELLFOUND.verified = true;

const fakeHub = (items) => {
    const calls = [];
    const rec = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve({}); };
    return {
        calls,
        heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
        queue: () => Promise.resolve({ items: items.list, approvedAnswers: [], profile: {} }),
        lease: rec('lease'),
        filled: rec('filled'),
        parked: rec('parked'),
        skipped: rec('skipped'),
        reclassify: rec('reclassify'),
        submitted: rec('submitted'),
        boardStatus: rec('boardStatus'),
        resume: () => Promise.resolve(null),
    };
};

const fakeSessions = (signedIn) => {
    const calls = [];
    return {
        calls,
        signedIn,
        isBotChecked: () => Promise.resolve(false),
        isSignedIn: (b) => Promise.resolve(signedIn[b.name] ?? true),
        isSignedInNow: (b) => Promise.resolve(signedIn[b.name] ?? true),
        promptSignIn: (b) => { calls.push(`promptSignIn:${b.name}`); return Promise.resolve({}); },
        openJob: () => Promise.resolve(),
        page: () => Promise.resolve({
            url: () => 'https://wellfound.com/jobs/1',
            bringToFront: () => Promise.resolve(),
            waitForSelector: async (sel) => { throw new Error(`Timeout waiting for ${sel}`); },
            waitForTimeout: async () => null,
            $$eval: async () => [],
            locator: () => ({
                count: async () => 0,
                first() { return this; },
                isVisible: async () => false,
                nth: () => ({}),
            }),
        }),
    };
};

const job = (id, portal, company) => ({
    id, portal, company, title: 'Dev', source_url: `https://example.com/${id}`,
});

const engineWith = (hub, sessions) => new CycleEngine({
    hub,
    sessions,
    store: newStore(),
    outbox: new Outbox(path.join(tmp, `ob-${Math.random()}.json`)),
    paths,
    // A fake browser never becomes signed in on its own, so the short window is
    // a fraction of a second rather than five minutes.
    signInWaitMs: 150,
    signInPollMs: 20,
});

section('a sign-in nobody does holds its lane, not the queue');
{
    const items = { list: [
        job('q1', 'WELLFOUND', 'Globex'),
        job('q2', 'WELLFOUND', 'Initech'),
        job('q3', 'LINKEDIN', 'Hooli'),
    ] };
    const hub = fakeHub(items);
    const sess = fakeSessions({ WELLFOUND: false, LINKEDIN: true });
    const engine = engineWith(hub, sess);

    await engine.run();

    check('the first job went on hold for the sign-in',
        engine.ledger.get('q1')?.gate.kind, 'SIGN_IN');
    check('  the sign-in window was opened once, not once per job',
        sess.calls.filter((x) => x === 'promptSignIn:WELLFOUND').length, 1);
    check('  the second job on that board was left alone',
        engine.ledger.get('q2'), null);
    check('  while another board carried on',
        hub.calls.filter((x) => x.name === 'lease').map((x) => x.args[0]), ['q3']);

    // ── nobody has signed in yet: the next pass must not nag ─────────────
    await engine.run();
    check('a second pass does not open the window again',
        sess.calls.filter((x) => x === 'promptSignIn:WELLFOUND').length, 1);
    check('  and the job is still waiting', engine.ledger.get('q1')?.status, 'WAITING_USER');

    // ── they sign in ─────────────────────────────────────────────────────
    sess.signedIn.WELLFOUND = true;
    hub.calls.length = 0;
    await engine.run();
    const leased = hub.calls.filter((x) => x.name === 'lease').map((x) => x.args[0]);
    check('once signed in the held job is picked up', leased.includes('q1'), true);
    check('  and the job behind it too', leased.includes('q2'), true);
    check('  the hold is cleared', engine.ledger.waiting(), []);
}

section('"I\'ve done it" retries at once, and keeps the clock');
{
    const items = { list: [job('q1', 'WELLFOUND', 'Globex')] };
    const hub = fakeHub(items);
    const sess = fakeSessions({ WELLFOUND: false });
    const engine = engineWith(hub, sess);

    await engine.run();
    const since = engine.ledger.get('q1').since;

    engine.ledger.requestResume('q1');
    await engine.run();
    const row = engine.ledger.get('q1');
    check('still not signed in, so it goes back on hold', row?.status, 'WAITING_USER');
    check('  the attempt was counted', row?.attempts, 1);
    check('  and the wait is measured from the first ask', row?.since, since);
}

section('a job that leaves the queue stops holding a lane');
{
    const items = { list: [job('q1', 'WELLFOUND', 'Globex')] };
    const hub = fakeHub(items);
    const engine = engineWith(hub, fakeSessions({ WELLFOUND: false }));
    await engine.run();
    check('held', engine.ledger.holdsLane('WELLFOUND'), true);

    items.list = [];
    await engine.run();
    check('the job left the queue; the hold is forgotten',
        engine.ledger.holdsLane('WELLFOUND'), false);
}

section('after a day it is given up on, once');
{
    const c = clock(Date.now());
    const items = { list: [job('q1', 'WELLFOUND', 'Globex')] };
    const hub = fakeHub(items);
    const store = newStore();
    const engine = new CycleEngine({
        hub,
        sessions: fakeSessions({ WELLFOUND: false }),
        store,
        outbox: new Outbox(path.join(tmp, `ob-${Math.random()}.json`)),
        paths,
        signInWaitMs: 150,
        signInPollMs: 20,
        ledger: new RunLedger({ store, now: c.now }),
    });

    await engine.run();
    c.advance(25 * HOUR);
    hub.calls.length = 0;
    await engine.run();

    const handed = hub.calls.filter((x) => x.name === 'skipped');
    check('the hub is told the job was skipped, once', handed.length, 1);
    check('  with the reason', /Waited more than a day/.test(handed[0]?.args[1]?.reason ?? ''), true);
    check('  and nothing is held any more', engine.ledger.all(), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
