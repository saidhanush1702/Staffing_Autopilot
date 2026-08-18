/**
 * Desktop app — unit suite.
 *
 *   npm test
 *
 * Everything here runs without Electron, without Playwright and without a hub.
 * The engine takes its browser and its hub client as constructor arguments
 * precisely so both can be replaced with fakes, which is what makes the rules
 * testable at all: a suite that needed a real browser and a real job board could
 * not assert "we did NOT type into that form".
 *
 * What is NOT covered here, and cannot be: that the tray appears, that windows
 * render, that Playwright launches a browser. Those need a desktop session.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Store } = require('../src/main/store.js');
const { Outbox } = require('../src/main/outbox.js');
const { fingerprint } = require('../src/main/fingerprint.js');
const { BOARDS, boardForPortal } = require('../src/main/browser/boards.js');
const { CycleEngine, nextWakeMs, clearWorkDir } = require('../src/main/cycle.js');
const { JITTER_MAX_MS } = require('../src/main/config.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-desktop-'));
const paths = { work: path.join(tmp, 'work'), profiles: path.join(tmp, 'profiles') };
fs.mkdirSync(paths.work, { recursive: true });

/* ── fakes ────────────────────────────────────────────────────────────── */

const fakeHub = (overrides = {}) => {
    const calls = [];
    const rec = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve({}); };
    return {
        calls,
        heartbeat: overrides.heartbeat
            ?? (() => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] })),
        queue: overrides.queue ?? (() => Promise.resolve({ items: [] })),
        lease: rec('lease'),
        filled: rec('filled'),
        parked: rec('parked'),
        skipped: rec('skipped'),
        reclassify: rec('reclassify'),
        submitted: rec('submitted'),
        boardStatus: rec('boardStatus'),
    };
};

const fakeSessions = (opts = {}) => ({
    isBotChecked: () => Promise.resolve(opts.botChecked ?? false),
    isSignedIn: () => Promise.resolve(opts.signedIn ?? true),
    promptSignIn: () => Promise.resolve({ awaitingHuman: true }),
    openJob: () => Promise.resolve(),
    page: () => Promise.resolve({ url: () => opts.landsOn ?? 'https://wellfound.com/jobs/1' }),
});

const item = (over = {}) => ({
    id: over.id ?? 'q1',
    portal: over.portal ?? 'WELLFOUND',
    company: over.company ?? 'Globex',
    source_url: over.source_url ?? 'https://wellfound.com/jobs/1',
    ...over,
});

const engineWith = (hub, sessions) => {
    const store = new Store(path.join(tmp, `state-${Math.random()}.json`));
    return new CycleEngine({
        hub, sessions, store, outbox: new Outbox(path.join(tmp, `ob-${Math.random()}.json`)), paths,
    });
};

/* ── board registry ───────────────────────────────────────────────────── */

section('board registry');
check('four boards known', Object.keys(BOARDS).sort(),
    ['BUILTIN', 'CRUNCHBOARD', 'LINKEDIN', 'WELLFOUND']);
// Load-bearing: an unverified recipe must never fill a real form.
check('every recipe is still unverified',
    Object.values(BOARDS).every((b) => b.verified === false), true);
check('LinkedIn has its own lower ceiling (R-22)', BOARDS.LINKEDIN.maxPerCycle, 2);
check('an ATS portal maps to no board', boardForPortal('GREENHOUSE'), null);
check('a board portal maps to its board', boardForPortal('BUILTIN').label, 'Built In');

/* ── wake jitter ──────────────────────────────────────────────────────── */

section('wake jitter (spec 5.3 — not machine-timed)');
check('never earlier than the interval', nextWakeMs(1000, () => 0), 1000);
check('never later than interval + max jitter',
    nextWakeMs(1000, () => 1), 1000 + JITTER_MAX_MS);
const spread = new Set(Array.from({ length: 200 }, () => nextWakeMs(3600_000)));
check('successive wakes differ', spread.size > 150, true);

/* ── the cycle ────────────────────────────────────────────────────────── */

section('cycle — when it must do nothing');

let r = await engineWith(fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: true }),
}), fakeSessions()).run();
check('a paused consultant is left alone', r.paused, true);
check('  and nothing was pulled', r.pulled, 0);

r = await engineWith(fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 5, paused: false }),
}), fakeSessions()).run();
check('cap already reached — stops before pulling', r.capReached, true);

section('cycle — the daily cap is enforced locally too (R-17)');

const many = Array.from({ length: 10 }, (_, i) => item({ id: `q${i}` }));
let hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 3, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: many }),
});
r = await engineWith(hub, fakeSessions()).run();
check('ten available, cap of three → three leased', r.leased, 3);
check('  and exactly three handed to the consultant', r.handedToHuman, 3);

section('cycle — LinkedIn is capped tighter than the rest (R-22)');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 10, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: Array.from({ length: 6 }, (_, i) => item({ id: `l${i}`, portal: 'LINKEDIN' })),
    }),
});
r = await engineWith(hub, fakeSessions({ landsOn: 'https://www.linkedin.com/jobs/view/1' })).run();
check('cap of 10 but LinkedIn allows 2 per cycle', r.leased, 2);

section('cycle — a bot-check stops that board immediately (R-22)');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item({ portal: 'LINKEDIN' })] }),
});
r = await engineWith(hub, fakeSessions({ botChecked: true })).run();
check('the board is reported as challenged', r.botChecked, ['LINKEDIN']);
// The critical assertion: we did not even lease it, let alone open it.
check('  nothing was leased', r.leased, 0);
check('  nothing was opened', r.opened, 0);
check('  the hub was told', hub.calls.filter((c) => c.name === 'boardStatus').length, 1);
check('  with state BOT_CHECK', hub.calls[0].args[0].state, 'BOT_CHECK');

section('cycle — an expired session pauses the board, not the app');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, fakeSessions({ signedIn: false })).run();
check('sign-in is requested', r.signInNeeded, ['WELLFOUND']);
check('  and the stall is reported', hub.calls[0].args[0].state, 'SESSION_EXPIRED');
check('  nothing was leased meanwhile', r.leased, 0);

section('cycle — a board the hub already paused is skipped');

hub = fakeHub({
    heartbeat: () => Promise.resolve({
        dailyCap: 5, usedToday: 0, paused: false,
        pausedBoards: [{ board: 'WELLFOUND', until: '2099-01-01T00:00:00Z' }],
    }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, fakeSessions()).run();
check('the paused board is not touched', r.leased, 0);

section('cycle — classification');

// Off-board redirect: the apply flow left the board, so a human takes it.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item({ portal: 'BUILTIN' })] }),
});
r = await engineWith(hub, fakeSessions({ landsOn: 'https://boards.greenhouse.io/acme/jobs/1' })).run();
check('a redirect off-board is handed to the consultant', r.handedToHuman, 1);
check('  and reclassified at the hub',
    hub.calls.some((c) => c.name === 'reclassify'), true);
check('  with the destination named',
    /greenhouse\.io/.test(hub.calls.find((c) => c.name === 'reclassify').args[1].reason), true);

// On-board, but the recipe is unverified — the safety that makes D3 shippable.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, fakeSessions({ landsOn: 'https://wellfound.com/jobs/1/apply' })).run();
check('an unverified recipe never fills', r.fillable, 0);
check('  it is handed over instead', r.handedToHuman, 1);

section('cycle — an unknown portal is handed back, not guessed at');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item({ portal: 'WORKDAY' })] }),
});
r = await engineWith(hub, fakeSessions()).run();
check('no recipe → reclassified', r.handedToHuman, 1);
check('  never leased', r.leased, 0);

section('cycle — one failing item does not kill the pass (R-26)');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item({ id: 'bad' }), item({ id: 'good' })] }),
});
let first = true;
const flaky = {
    ...fakeSessions(),
    openJob: () => {
        if (first) { first = false; return Promise.reject(new Error('navigation timeout')); }
        return Promise.resolve();
    },
};
r = await engineWith(hub, flaky).run();
check('the bad item is skipped with a reason', r.skipped, 1);
check('  and the next item is still worked', r.opened, 1);
check('  the skip reason reaches the hub',
    /could not process/.test(hub.calls.find((c) => c.name === 'skipped').args[1].reason), true);

/* ── working files ────────────────────────────────────────────────────── */

section('working files are deleted every cycle (R-20)');

fs.writeFileSync(path.join(paths.work, 'resume.pdf'), 'x');
fs.writeFileSync(path.join(paths.work, 'scratch.tmp'), 'y');
check('two files planted', fs.readdirSync(paths.work).length, 2);
await engineWith(fakeHub(), fakeSessions()).run();
check('gone after a cycle', fs.readdirSync(paths.work).length, 0);

fs.writeFileSync(path.join(paths.work, 'left-by-a-crash.pdf'), 'z');
clearWorkDir(paths.work);
check('and cleared on the way in, so a crash leaves nothing',
    fs.readdirSync(paths.work).length, 0);

/* ── identity ─────────────────────────────────────────────────────────── */

section('machine fingerprint (R-21)');
check('64 hex characters', /^[0-9a-f]{64}$/.test(fingerprint()), true);
check('stable across calls', fingerprint() === fingerprint(), true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
