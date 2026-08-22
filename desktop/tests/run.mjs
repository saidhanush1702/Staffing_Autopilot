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
const { CycleEngine, nextPollMs, clearWorkDir } = require('../src/main/cycle.js');
const {
    buildAnswerBook, resolveAnswer, chooseOption, chooseSuggestion,
} = require('../src/main/browser/answers.js');
const { fillForm } = require('../src/main/browser/filler.js');
const {
    runApplyFlow, pressSubmit, isSubmit,
    UPLOAD_WORDS: UPLOAD_PATTERN, RESUME_WORDS: RESUME_PATTERN,
} = require('../src/main/browser/applyFlow.js');
const { resolveBrowser } = require('../src/main/browser/engine.js');
const { record } = require('../src/main/diagnostics.js');
const { POLL_MS, POLL_JITTER_MS, IDLE_POLL_MS } = require('../src/main/config.js');

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
        resume: overrides.resume ?? (() => Promise.resolve(null)),
    };
};

const fakeSessions = (opts = {}) => {
    const calls = [];
    return {
        calls,
        isBotChecked: () => Promise.resolve(opts.botChecked ?? false),
        isSignedIn: () => Promise.resolve(opts.signedIn ?? true),
        // The wait loop polls this one, because it does NOT navigate — polling
        // with a navigation reloaded the login form the consultant was typing
        // into. The fake follows the same split.
        isSignedInNow: () => Promise.resolve(opts.signedIn ?? true),
        promptSignIn: () => { calls.push('promptSignIn'); return Promise.resolve({ awaitingHuman: true }); },
        openJob: () => { calls.push('openJob'); return Promise.resolve(); },
        page: () => Promise.resolve({
            url: () => opts.landsOn ?? 'https://wellfound.com/jobs/1',
            bringToFront: () => Promise.resolve(),
            waitForSelector: async () => null,
            waitForTimeout: async () => null,
            $$eval: async () => opts.fields ?? [],
            locator: () => ({
                // An apply flow asks these before anything else. Answering
                // "nothing here" makes a board with a recipe behave like one
                // whose application lives elsewhere, which is what these
                // cycle-level tests are about.
                count: async () => 0,
                first() { return this; },
                isVisible: async () => false,
                nth: () => ({
                    click: async () => {},
                    fill: async () => {},
                    pressSequentially: async () => {},
                    selectOption: async () => {},
                    check: async () => {},
                    setInputFiles: async () => {},
                }),
            }),
        }),
    };
};

const item = (over = {}) => ({
    id: over.id ?? 'q1',
    portal: over.portal ?? 'WELLFOUND',
    company: over.company ?? 'Globex',
    source_url: over.source_url ?? 'https://wellfound.com/jobs/1',
    ...over,
});

const engineWith = (hub, sessions, over = {}) => {
    const store = new Store(path.join(tmp, `state-${Math.random()}.json`));
    return new CycleEngine({
        hub, sessions, store, outbox: new Outbox(path.join(tmp, `ob-${Math.random()}.json`)), paths,
        // The gate is proven, not waited out: a fake browser will never become
        // signed in, so the real five-minute window would just stall the suite.
        signInWaitMs: 30,
        signInPollMs: 5,
        ...over,
    });
};

/* ── board registry ───────────────────────────────────────────────────── */

section('board registry');
check('four boards known', Object.keys(BOARDS).sort(),
    ['BUILTIN', 'CRUNCHBOARD', 'LINKEDIN', 'WELLFOUND']);
// Load-bearing: an unverified recipe must never fill a real form. LinkedIn was
// switched on by the owner on partial evidence; the rest stay off until someone
// has watched them fill a real application.
check('only LinkedIn is switched on',
    Object.values(BOARDS).filter((b) => b.verified).map((b) => b.name), ['LINKEDIN']);
check('  and it is the only board with an apply recipe',
    Object.values(BOARDS).filter((b) => b.apply).map((b) => b.name), ['LINKEDIN']);
// Volume limits are gone by decision: no board rations applications any more.
check('no board carries a volume ceiling',
    Object.values(BOARDS).some((b) => 'maxPerDay' in b || 'maxPerCycle' in b), false);
// The reactive half of R-22 stays — a board that challenges us is not a quota.
check('LinkedIn still stops on a bot-check',
    BOARDS.LINKEDIN.botCheck.length > 0, true);
check('an ATS portal maps to no board', boardForPortal('GREENHOUSE'), null);

// These are the values read off a live Easy Apply flow. Pinning them catches
// the failure that actually happened: a second `apply:` key was left in the
// object literal by an interrupted edit, JavaScript kept the LAST one, and the
// engine silently ran the old guessed selectors while the file appeared to
// contain the corrected ones.
check('LinkedIn opens Easy Apply by aria-label, never by class',
    BOARDS.LINKEDIN.apply.open, 'button[aria-label*="Easy Apply" i]');
check('  and scopes to the sdui screen, not a dialog',
    BOARDS.LINKEDIN.apply.dialog, '[data-sdui-screen*="jobs.easy"]');
check('  no LinkedIn selector keys off a hashed class',
    Object.values(BOARDS.LINKEDIN.apply)
        .filter((v) => typeof v === 'string')
        .some((v) => /\.[a-z]+-|class=/.test(v) && !v.includes('aria-label')),
    false);
check('a board portal maps to its board', boardForPortal('BUILTIN').label, 'Built In');

/* ── polling, not scheduling ──────────────────────────────────────────── */

section('poll pacing — the 4h cycle belongs to the hub, not the app');
check('a busy queue is checked again soon', nextPollMs(true, () => 0), POLL_MS);
check('an empty queue waits longer', nextPollMs(false, () => 0), IDLE_POLL_MS);
check('busy is sooner than idle', nextPollMs(true, () => 1) < nextPollMs(false, () => 0), true);
check('never later than the interval + max jitter',
    nextPollMs(true, () => 1), POLL_MS + POLL_JITTER_MS);
const spread = new Set(Array.from({ length: 200 }, () => nextPollMs(true)));
check('successive polls differ (spec 5.3 — not machine-timed)', spread.size > 150, true);

/* ── the cycle ────────────────────────────────────────────────────────── */

section('cycle — when it must do nothing');

let r = await engineWith(fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: true }),
}), fakeSessions()).run();
check('a paused consultant is left alone', r.paused, true);
check('  and nothing was pulled', r.pulled, 0);

section('cycle — there is no daily cap; everything queued is worked');

// The daily cap is gone by decision. Every job that reaches the queue is
// worked: filled if we handle that board, handed to the consultant if not.
// These assertions are the guard against it quietly coming back — a limit that
// reappears would show up as items silently going untouched.
const many = Array.from({ length: 10 }, (_, i) => item({ id: `q${i}` }));
let hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: many }),
});
r = await engineWith(hub, fakeSessions()).run();
check('ten available → all ten leased', r.leased, 10);
check('  and all ten handed to the consultant', r.handedToHuman, 10);
check('  nothing was held back', r.capReached, undefined);

// A heartbeat that mentions no cap at all is the normal case now.
r = await engineWith(fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
}), fakeSessions()).run();
check('a heartbeat without cap fields works normally', r.opened, 1);

section('cycle — LinkedIn is not rationed either');

// This section used to assert a ceiling of five a day. The owner removed all
// volume limits: every LinkedIn job in the queue is worked, on every pass.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: Array.from({ length: 6 }, (_, i) => item({ id: `l${i}`, portal: 'LINKEDIN' })),
    }),
});
r = await engineWith(hub,
    fakeSessions({ landsOn: 'https://www.linkedin.com/jobs/view/1' })).run();
check('all six LinkedIn jobs are worked', r.leased, 6);
check('  and none is held back for tomorrow', r.pulled, 6);

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

// The gate only applies to a board we FILL. On a verified one a missing
// session really does stop the work, so this section marks it verified.
BOARDS.WELLFOUND.verified = true;

hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, fakeSessions({ signedIn: false })).run();
check('sign-in is requested', r.signInNeeded, ['WELLFOUND']);
check('  and the stall is reported', hub.calls[0].args[0].state, 'SESSION_EXPIRED');
check('  nothing was leased meanwhile', r.leased, 0);

BOARDS.WELLFOUND.verified = false;

// And the reason it is conditional: the detection selectors are guesses too.
// On an unverified board the app only opens the job and hands it over, so a
// guess that says "not signed in" must not stall work that needs no session.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, fakeSessions({ signedIn: false })).run();
check('an unverified board does not ask for a sign-in at all', r.signInNeeded, []);
check('  and the item is worked anyway', r.handedToHuman, 1);

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
check('an unverified recipe never fills', r.filled, 0);
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

/* ── answer matching ──────────────────────────────────────────────────── */

section('answer matching — tight on purpose');

const book = buildAnswerBook({
    profile: {
        name: 'Mary Jane Watson',
        email: 'mj@example.com',
        phone: '+1 555 0100',
        city: 'Austin',
        state: 'TX',
        linkedin_url: 'https://linkedin.com/in/mj',
        work_auth: 'US Citizen',
    },
    approvedAnswers: [
        { question_text: 'Are you willing to relocate?', answer_text: 'Yes', question_id: 'Q1' },
        { question_text: 'Current city', answer_text: 'Dallas', question_id: 'Q2' },
    ],
});

check('a profile field is found by its label',
    resolveAnswer('Email Address', book).value, 'mj@example.com');
check('  punctuation and case do not matter',
    resolveAnswer('  E-MAIL:  ', book).value, 'mj@example.com');
check('a full name splits into first and last',
    [resolveAnswer('First name', book).value, resolveAnswer('Last name', book).value],
    ['Mary', 'Jane Watson']);
check('an approved answer is found', resolveAnswer('Are you willing to relocate?', book).value, 'Yes');
// A reviewed answer outranks an unreviewed profile value for the same question.
check('an approved answer beats the profile', resolveAnswer('Current city', book).source, 'ANSWER');
check('  and the profile still answers its own label',
    resolveAnswer('City', book).source, 'PROFILE');
check('an unmatched question resolves to nothing',
    resolveAnswer('Describe a time you led a project', book), null);
// The whole argument for tight matching: near-misses must NOT match.
check('a similar-but-different question does not match',
    resolveAnswer('Are you willing to travel?', book), null);

// Labels taken verbatim from a live LinkedIn Easy Apply form. Both used to
// resolve to nothing, and the required one stalled the whole application.
check('"Mobile phone number*" is a phone number',
    resolveAnswer('Mobile phone number*', book).value, '+1 555 0100');
check('"Enter city or location" is a city',
    resolveAnswer('Enter city or location', book).value, 'Austin');

// And the trap that makes loose matching dangerous: this one contains the word
// "phone" and must NOT receive a phone number.
check('"Phone country code" is refused', resolveAnswer('Phone country code*', book), null);
check('an employer name is not the candidate name',
    resolveAnswer('Name of your current employer', book), null);
check('a confirm-email field is not filled',
    resolveAnswer('Confirm email address', book), null);
check('"Full name" still resolves', resolveAnswer('Full name', book).value, 'Mary Jane Watson');

// A typeahead is only finished when an option has been CHOSEN. These are the
// exact suggestions LinkedIn returned for "dallas" on a live application.
const DALLAS = [
    'Dallas, Texas, United States',
    'Dallas-Fort Worth Metroplex',
    'Dallas County, Texas, United States',
    'Dallas, Georgia, United States',
    'Dallas, Oregon, United States',
];
check("the consultant state picks the right Dallas",
    chooseSuggestion(DALLAS, 'dallas', 'tx'), 'Dallas, Texas, United States');
check('  a different state picks a different one',
    chooseSuggestion(DALLAS, 'dallas', 'ga'), 'Dallas, Georgia, United States');
check("  with no state, the top-ranked suggestion is taken",
    chooseSuggestion(DALLAS, 'dallas', null), 'Dallas, Texas, United States');
check('  and a place that is not in the list is refused',
    chooseSuggestion(DALLAS, 'mumbai', 'tx'), null);
// The regression: the strict rule called all eight ambiguous, chose nothing,
// and the application stopped on a field that looked correctly filled in.
check('  the strict rule would have refused all of them',
    chooseOption(DALLAS, 'dallas'), null);
check('a typeahead suggestion is matched exactly',
    chooseOption(['Dallas, Texas, United States', 'Dallas, Georgia, United States'], 'Dallas, Texas, United States'),
    'Dallas, Texas, United States');
check('  a unique prefix is taken',
    chooseOption(['Dallas, Texas, United States', 'Houston, Texas'], 'Dallas'),
    'Dallas, Texas, United States');
check('  but two plausible cities are left alone',
    chooseOption(['Dallas, Texas, United States', 'Dallas, Georgia, United States'], 'Dallas'),
    null);

check('an option is chosen by exact text', chooseOption(['Yes', 'No'], 'Yes'), 'Yes');
check('  and by a unique prefix',
    chooseOption(['Yes, I am authorized', 'No'], 'Yes'), 'Yes, I am authorized');
check('  but ambiguity chooses nothing',
    chooseOption(['Yes, with sponsorship', 'Yes, without sponsorship'], 'Yes'), null);

/* ── filling ──────────────────────────────────────────────────────────── */

section('filling — what it types, and what it refuses');

/** A page that records what was done to it, so no browser is needed. */
const fakePage = (fields) => {
    const acted = [];
    const control = (i) => ({
        click: async () => {},
        fill: async () => {},
        pressSequentially: async (v) => acted.push({ what: 'type', i, value: v }),
        selectOption: async (o) => acted.push({ what: 'select', i, value: o.label }),
        check: async () => acted.push({ what: 'check', i }),
        setInputFiles: async (f) => acted.push({ what: 'file', i, value: f }),
    });
    return {
        acted,
        $$eval: async () => fields,
        locator: () => ({ nth: control }),
    };
};

const field = (over = {}) => ({
    index: 0, tag: 'input', type: 'text', name: '', label: '', groupLabel: '',
    required: false, disabled: false, visible: true, options: [], ...over,
});

const NO_PAUSE = { minMs: 0, maxMs: 0, betweenFieldsMs: [0, 0] };

const profile = { name: 'Mary Jane Watson', email: 'mj@example.com', phone: '+1 555 0100' };

let page = fakePage([
    field({ index: 0, label: 'Email', type: 'email' }),
    field({ index: 1, label: 'Phone number', type: 'tel' }),
    field({ index: 2, label: 'Password', type: 'password', required: true }),
    field({ index: 3, label: 'Why do you want this job?', type: 'textarea', required: true }),
    field({ index: 4, label: 'Resume', type: 'file' }),
]);

let out = await fillForm(page, {
    profile, approvedAnswers: [], resumePath: '/tmp/cv.pdf', typing: NO_PAUSE,
});

check('the email is typed', page.acted.find((a) => a.i === 0)?.value, 'mj@example.com');
check('the phone is typed', page.acted.find((a) => a.i === 1)?.value, '+1 555 0100');
// R-18, enforced where it cannot be forgotten.
check('the password field is never touched',
    page.acted.some((a) => a.i === 2), false);
check('  and the refusal is reported', out.refusals.length, 1);
check('the resume is attached', page.acted.find((a) => a.what === 'file')?.value, '/tmp/cv.pdf');
check('an unanswerable required question becomes an unknown',
    out.unknown.map((u) => [u.questionText, u.required]),
    [['Why do you want this job?', true]]);
check('  and nothing was invented for it',
    page.acted.some((a) => a.i === 3), false);

// A hidden or disabled control is not a question anybody is asking.
page = fakePage([
    field({ index: 0, label: 'Email', visible: false }),
    field({ index: 1, label: 'Phone', disabled: true }),
    field({ index: 2, label: 'Submit', type: 'submit' }),
]);
out = await fillForm(page, { profile, approvedAnswers: [], typing: NO_PAUSE });
check('hidden, disabled and button controls are all skipped', page.acted.length, 0);
check('  and none of them is reported as an unknown question', out.unknown.length, 0);

// A radio group is one question, answered once.
page = fakePage([
    field({ index: 0, type: 'radio', name: 'auth', label: 'Yes', groupLabel: 'Work authorization' }),
    field({ index: 1, type: 'radio', name: 'auth', label: 'No', groupLabel: 'Work authorization' }),
]);
out = await fillForm(page, {
    profile: { ...profile, work_auth: 'Yes' }, approvedAnswers: [], typing: NO_PAUSE,
});
check('a radio group is answered once', page.acted.length, 1);
check('  with the option that matches', page.acted[0].i, 0);
check('  recorded as one question', out.qa.filter((q) => q.fieldType === 'radio').length, 1);

// A select whose options do not contain the answer is an unknown, not a guess.
page = fakePage([
    field({ index: 0, tag: 'select', type: 'select', label: 'Years of experience',
        required: true, options: ['0-2', '3-5', '6+'] }),
]);
out = await fillForm(page, {
    profile,
    approvedAnswers: [{ question_text: 'Years of experience', answer_text: 'Nine', question_id: 'Q9' }],
    typing: NO_PAUSE,
});
check('a select with no matching option is left alone', page.acted.length, 0);
check('  and reported as unknown', out.unknown.length, 1);

/* ── the sign-in gate ─────────────────────────────────────────────────── */

section('sign-in — the consultant does it, and work resumes after');

// Again: the gate is for boards we fill, so this section verifies one.
BOARDS.WELLFOUND.verified = true;

// Signed out at first, signed in by the time we look again: the item must be
// worked in the SAME pass, not left until the next poll.
let looks = 0;
// Signed out at first, signed in by the time the wait loop looks again.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
let sessions = fakeSessions();
// The gate says signed out. The wait loop then polls the non-navigating check,
// which reports success once the consultant has had a moment — the sequence a
// real sign-in follows.
sessions.isSignedIn = () => Promise.resolve(false);
sessions.isSignedInNow = () => {
    looks += 1;
    return Promise.resolve(looks > 1);
};
r = await engineWith(hub, sessions).run();
check('the login window was opened', sessions.calls.includes('promptSignIn'), true);
check('the stall was reported to the hub',
    hub.calls.some((c) => c.name === 'boardStatus' && c.args[0].state === 'SESSION_EXPIRED'), true);
check('signing in was noticed and reported OK',
    hub.calls.some((c) => c.name === 'boardStatus' && c.args[0].state === 'OK'), true);
check('  and the item was then worked in the same pass', r.opened, 1);

// Never signed in: the board is left for later, and nothing is leased.
sessions = fakeSessions({ signedIn: false });
hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [item()] }),
});
r = await engineWith(hub, sessions).run();
check('a login that never happens leases nothing', r.leased, 0);
check('  and is surfaced as needing the consultant', r.signInNeeded, ['WELLFOUND']);

BOARDS.WELLFOUND.verified = false;


/* ── the fill path ────────────────────────────────────────────────────── */

section('filling end to end — only on a verified board');

// Every shipped recipe is unverified, which is what stops a guessed selector
// typing into a real employer's form. To exercise the path at all, one board is
// marked verified for the length of this section and put back afterwards.
BOARDS.WELLFOUND.verified = true;

const formField = (over = {}) => ({
    index: 0, tag: 'input', type: 'text', name: '', label: '', groupLabel: '',
    required: false, disabled: false, visible: true, options: [], ...over,
});

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item()],
        profile: { name: 'Mary Jane Watson', email: 'mj@example.com', phone: '+1 555 0100' },
        approvedAnswers: [],
    }),
    resume: () => Promise.resolve('/tmp/cv.pdf'),
});
let engine = engineWith(hub, fakeSessions({
    landsOn: 'https://wellfound.com/jobs/1/apply',
    fields: [
        formField({ index: 0, label: 'Email', type: 'email' }),
        formField({ index: 1, label: 'Full name' }),
    ],
}));
r = await engine.run();

check('an answerable form is filled', r.filled, 1);
check('  the hub is told it awaits review',
    hub.calls.some((c) => c.name === 'filled'), true);
// R-02, at the only place it could be broken.
check('  and submit was never called', hub.calls.some((c) => c.name === 'submitted'), false);
check('  it is held for the consultant to review',
    engine.store.get('awaitingReview').length, 1);
check('  with the answers it typed, in order',
    engine.store.get('awaitingReview')[0].qa.map((q) => q.answerText),
    ['mj@example.com', 'Mary Jane Watson']);

// A required question nobody has answered stops the application.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item()],
        profile: { name: 'Mary Jane Watson', email: 'mj@example.com' },
        approvedAnswers: [],
    }),
    resume: () => Promise.resolve('/tmp/cv.pdf'),
});
engine = engineWith(hub, fakeSessions({
    landsOn: 'https://wellfound.com/jobs/1/apply',
    fields: [
        formField({ index: 0, label: 'Email', type: 'email' }),
        formField({ index: 1, label: 'What is your expected rate?', required: true }),
    ],
}));
r = await engine.run();

check('an unknown required question parks the application', r.parked, 1);
check('  the question is sent to the hub for approval',
    hub.calls.find((c) => c.name === 'parked').args[1].unknownQuestions[0].questionText,
    'What is your expected rate?');
check('  and nothing is put in front of the consultant to submit',
    engine.store.get('awaitingReview').length, 0);

// A page with no application form on it is not a filled application.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item()],
        profile: { name: 'Mary Jane Watson', email: 'mj@example.com' },
        approvedAnswers: [],
    }),
    resume: () => Promise.resolve('/tmp/cv.pdf'),
});
engine = engineWith(hub, fakeSessions({
    landsOn: 'https://wellfound.com/jobs/1',
    // What a real LinkedIn posting without Easy Apply actually offers: the
    // board's own furniture, and nothing to apply with.
    fields: [
        formField({ index: 0, label: 'Search' }),
        formField({ index: 1, tag: 'select', type: 'select', label: 'Select language', options: ['English'] }),
    ],
}));
r = await engine.run();

check('a page with no application form is not "filled"', r.filled, 0);
check('  it is handed to the consultant instead', r.handedToHuman, 1);
check('  the hub is never told it awaits review',
    hub.calls.some((c) => c.name === 'filled'), false);
check('  and nothing is queued for the consultant to submit',
    engine.store.get('awaitingReview').length, 0);

/* ── review and submit ────────────────────────────────────────────────── */

section('review — the app records a submission, it never makes one');

hub = fakeHub({
    heartbeat: () => Promise.resolve({ dailyCap: 5, usedToday: 0, paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item()],
        profile: { name: 'Mary Jane Watson', email: 'mj@example.com' },
        approvedAnswers: [],
    }),
    resume: () => Promise.resolve('/tmp/cv.pdf'),
});
engine = engineWith(hub, fakeSessions({
    landsOn: 'https://wellfound.com/jobs/1/apply',
    fields: [formField({ index: 0, label: 'Email', type: 'email' })],
}));
await engine.run();

await engine.reportSubmitted('q1');
check('submitting reports the full question-and-answer list',
    hub.calls.find((c) => c.name === 'submitted').args[1].qa.length, 1);
check('  and clears it from the review list', engine.store.get('awaitingReview').length, 0);
check('  reporting one that is gone is refused, not retried',
    (await engine.reportSubmitted('q1')).ok, false);

BOARDS.WELLFOUND.verified = false;
check('the board is left unverified again', BOARDS.WELLFOUND.verified, false);



/* ── multi-step apply flows ───────────────────────────────────────────── */

section('apply flow — the submit button is a wall, not a step');

/**
 * A page whose application lives behind a button, like LinkedIn Easy Apply.
 * `steps` is a list of field-sets; the last one offers Submit instead of Next.
 */
const wizardPage = (steps, opts = {}) => {
    const clicked = [];
    let step = 0;
    let opened = false;

    const control = (kind) => ({
        count: async () => {
            if (kind === 'open') return opts.noOpen ? 0 : 1;
            if (kind === 'already') return opts.alreadyApplied ? 1 : 0;
            if (kind === 'submit') return opened && step >= steps.length - 1 ? 1 : 0;
            if (kind === 'next') return opened && step < steps.length - 1 ? 1 : 0;
            if (kind === 'dialog') return opened ? 1 : 0;
            return 0;
        },
        isVisible: async () => (await control(kind).count()) > 0,
        innerText: async () => ({ open: 'Easy Apply', next: 'Next', submit: 'Submit application', already: 'Applied' }[kind] ?? ''),
        getAttribute: async () => null,
        click: async () => {
            clicked.push(kind);
            if (kind === 'open') opened = true;
            if (kind === 'next') step += 1;
        },
        // clickSteadily settles the element before pressing it.
        scrollIntoViewIfNeeded: async () => {},
        page: () => ({ waitForTimeout: async () => {} }),
        // The filler's vocabulary for a text box. Recorded rather than acted on
        // — what this fake is for is proving which BUTTONS get clicked.
        fill: async () => {},
        pressSequentially: async () => {},
        selectOption: async () => {},
        check: async () => {},
        setInputFiles: async () => {},
    });

    const kindOf = (sel) => {
        if (sel.includes('OPEN')) return 'open';
        if (sel.includes('NEXT')) return 'next';
        if (sel.includes('SUBMIT')) return 'submit';
        if (sel.includes('APPLIED')) return 'already';
        return 'dialog';
    };

    return {
        clicked,
        currentStep: () => step,
        url: () => opts.landsOn ?? 'https://board.test/job/1',
        locator: (sel) => {
            const c = control(kindOf(sel));
            return { ...c, first: () => c, nth: () => c };
        },
        // Must answer honestly: the flow now WAITS for the apply button, so a
        // fake that always resolves would report a button that is not there.
        waitForSelector: async (sel) => {
            if (await control(kindOf(sel)).count() === 0) {
                throw new Error(`Timeout waiting for ${sel}`);
            }
            return null;
        },
        waitForTimeout: async () => null,
        $$eval: async () => (opened ? (steps[step] ?? []) : []),
    };
};

const wizardBoard = {
    name: 'TESTBOARD',
    label: 'Test Board',
    apply: {
        open: 'OPEN', dialog: 'DIALOG', next: 'NEXT',
        submit: 'SUBMIT', alreadyApplied: 'APPLIED', maxSteps: 6,
    },
};

const wField = (over = {}) => ({
    index: 0, tag: 'input', type: 'text', name: '', label: '', groupLabel: '',
    required: false, disabled: false, visible: true, options: [], ...over,
});

const wizProfile = { name: 'Mary Jane Watson', email: 'mj@example.com', phone: '+1 555 0100' };
const NOPAUSE = { minMs: 0, maxMs: 0, betweenFieldsMs: [0, 0] };

let wiz = wizardPage([
    [wField({ index: 0, label: 'Email' })],
    [wField({ index: 0, label: 'Phone number' })],
    [wField({ index: 0, label: 'First name' })],
]);
let flow = await runApplyFlow(wiz, wizardBoard,
    { profile: wizProfile, approvedAnswers: [], typing: NOPAUSE });

check('the wizard is opened', wiz.clicked[0], 'open');
check('it walks every step', wiz.currentStep(), 2);
check('it stops ready to submit', flow.outcome, 'READY_TO_SUBMIT');
// The assertion the whole design rests on.
check('it never clicked submit', wiz.clicked.includes('submit'), false);
check('answers from every step are collected', flow.qa.length, 3);

// A board that says the consultant already applied.
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]], { alreadyApplied: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('an existing application is recognised', flow.outcome, 'ALREADY_APPLIED');
check('  and nothing is clicked at all', wiz.clicked.length, 0);

// No apply button: the job is applied for somewhere else.
wiz = wizardPage([[]], { noOpen: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a page with no apply button is handed over', flow.outcome, 'NO_APPLY_FLOW');

// A required question nobody has answered stops the wizard mid-way.
wiz = wizardPage([
    [wField({ index: 0, label: 'What is your expected rate?', required: true })],
    [wField({ index: 0, label: 'Email' })],
]);
flow = await runApplyFlow(wiz, wizardBoard,
    { profile: wizProfile, approvedAnswers: [], typing: NOPAUSE });
check('an unanswered required question stops the wizard', flow.outcome, 'INCOMPLETE');
check('  it did not press next past it', wiz.currentStep(), 0);

// Resume steps are found by what they SAY, not by a selector, because the
// wording differs per employer — "Upload resume", "Attach CV", "Add resume".
const resumeWizard = (label) => {
    const page = wizardPage([[], [wField({ index: 0, label: 'Email' })]]);
    page.locator = (sel) => {
        const kind = sel.includes('OPEN') ? 'open'
            : sel.includes('NEXT') ? 'next'
                : sel.includes('SUBMIT') ? 'submit'
                    : sel.includes('APPLIED') ? 'already' : 'dialog';
        const base = {
            count: async () => (kind === 'dialog' || kind === 'open' ? 1 : 0),
            first() { return this; },
            nth() { return this; },
            isVisible: async () => kind === 'open',
            innerText: async () => (kind === 'dialog' ? label : ''),
            getAttribute: async () => null,
            click: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            page: () => ({ waitForTimeout: async () => {} }),
        };
        return base;
    };
    return page;
};

check('a step saying "Upload resume" is recognised as needing one',
    RESUME_PATTERN.test('2/5 pages Resume* Upload resume'), true);
check('  so is one saying "Attach your CV"',
    RESUME_PATTERN.test('Attach your CV to continue'), true);
check('  and an ordinary question step is not',
    RESUME_PATTERN.test('How many years of React experience?'), false);

check('an upload control is found by its wording, not a class',
    ['Upload resume', 'Attach CV', 'Add a resume', 'Choose file']
        .every((t) => UPLOAD_PATTERN.test(t)), true);
check('  and Next is not mistaken for one', UPLOAD_PATTERN.test('Next'), false);

section('apply flow — submitting is a separate, deliberate act');

// The guard that does not depend on selectors being right.
check('a control reading "Submit application" is refused',
    await isSubmit({ innerText: async () => 'Submit application', getAttribute: async () => null }), true);
check('a control reading "Next" is not',
    await isSubmit({ innerText: async () => 'Next', getAttribute: async () => null }), false);
check('an aria-label alone is enough to refuse',
    await isSubmit({ innerText: async () => '', getAttribute: async () => 'Submit application' }), true);

// pressSubmit is the one function that clicks it, and only when asked.
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]]);
await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [], typing: NOPAUSE });
check('after filling, submit still has not been clicked', wiz.clicked.includes('submit'), false);
const pressed = await pressSubmit(wiz, wizardBoard);
check('pressSubmit clicks it', pressed.ok, true);
check('  and only then does the click appear', wiz.clicked.includes('submit'), true);


/* ── start, stop, and auto-submit ─────────────────────────────────────── */

section('nothing is submitted unless the consultant chose it');

BOARDS.WELLFOUND.verified = true;
BOARDS.WELLFOUND.apply = {
    open: 'OPEN', dialog: 'DIALOG', next: 'NEXT', submit: 'SUBMIT',
    alreadyApplied: 'APPLIED', maxSteps: 4,
};

const applyHub = () => fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item()],
        profile: { name: 'Mary Jane Watson', email: 'mj@example.com' },
        approvedAnswers: [],
    }),
    resume: () => Promise.resolve('/tmp/cv.pdf'),
});

/** A board page whose apply flow reaches submit on the first step. */
const readyPage = () => {
    const clicked = [];
    const ctrl = (kind) => ({
        count: async () => (kind === 'next' ? 0 : 1),
        first() { return this; },
        nth() { return this; },
        isVisible: async () => kind !== 'next' && kind !== 'already',
        innerText: async () => ({ open: 'Apply', submit: 'Submit application' }[kind] ?? ''),
        getAttribute: async () => null,
        click: async () => clicked.push(kind),
        scrollIntoViewIfNeeded: async () => {},
        setInputFiles: async () => {},
        fill: async () => {}, pressSequentially: async () => {}, check: async () => {},
        selectOption: async () => {},
        page: () => ({ waitForTimeout: async () => {} }),
    });
    const kindOf = (sel) => (sel.includes('OPEN') ? 'open'
        : sel.includes('NEXT') ? 'next'
            : sel.includes('SUBMIT') ? 'submit'
                : sel.includes('APPLIED') ? 'already' : 'dialog');
    return {
        clicked,
        url: () => 'https://wellfound.com/jobs/1',
        bringToFront: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => null,
        // One answerable field, so the flow has something real to fill and the
        // result is a genuine application rather than an empty one.
        $$eval: async () => [{
            index: 0, tag: 'input', type: 'email', name: '', label: 'Email',
            groupLabel: '', required: true, disabled: false, visible: true,
            hasValue: false, options: [],
        }],
        locator: (sel) => ctrl(kindOf(sel)),
    };
};

// Auto-submit OFF: filled, held, and nothing sent.
let sess = fakeSessions();
let rp = readyPage();
sess.page = async () => rp;
hub = applyHub();
engine = engineWith(hub, sess);
engine.store.set({ automationOn: true, autoSubmit: false });
r = await engine.run();
check('with auto-submit off the application is filled', r.filled, 1);
check('  nothing is submitted', rp.clicked.includes('submit'), false);
check('  the hub is not told it was sent', hub.calls.some((c) => c.name === 'submitted'), false);
check('  and it waits on the review screen', engine.store.get('awaitingReview').length, 1);

// Auto-submit ON: the same run sends it.
sess = fakeSessions();
rp = readyPage();
sess.page = async () => rp;
hub = applyHub();
engine = engineWith(hub, sess);
engine.store.set({ automationOn: true, autoSubmit: true });
r = await engine.run();
check('with auto-submit on the application is submitted', rp.clicked.includes('submit'), true);
check('  and reported to the hub', hub.calls.some((c) => c.name === 'submitted'), true);
check('  with the answers that were filled',
    Array.isArray(hub.calls.find((c) => c.name === 'submitted').args[1].qa), true);
check('  and it does not linger on the review screen',
    engine.store.get('awaitingReview').length, 0);

BOARDS.WELLFOUND.verified = false;
delete BOARDS.WELLFOUND.apply;
check('the test board is left as it was found',
    [BOARDS.WELLFOUND.verified, 'apply' in BOARDS.WELLFOUND], [false, false]);


section('stop reaches the pass that is already running');

// The bug: Stop cleared the next timer and nothing else, so a pass under way
// worked every remaining job. Pressing Stop looked like it did nothing.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: Array.from({ length: 8 }, (_, i) => item({ id: `s${i}` })),
    }),
});
const stoppable = engineWith(hub, fakeSessions());
stoppable.requestStop();
r = await stoppable.run();
check('a stop asked for before the pass leaves every job alone', r.leased, 0);
check('  and the pass reports that it stopped', r.stopped, true);
check('  the queue was still pulled, so nothing is lost', r.pulled, 8);

// Stopped stays stopped until Start — a scheduled pass must not undo it.
r = await stoppable.run();
check('a later pass is still stopped', r.stopped, true);

stoppable.allowStart();
r = await stoppable.run();
check('the next pass runs normally', r.leased, 8);
check('  and is not marked stopped', r.stopped, undefined);


section('checking for jobs only reads');

// "Check now" used to start a work pass, which is why it could only be offered
// while automation was running — pressing it applied to jobs. Now it reads.
hub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: Array.from({ length: 4 }, (_, i) => item({ id: `c${i}` })),
    }),
});
const reader = engineWith(hub, fakeSessions());
const seen = await reader.refresh();

check('it reports what is waiting', seen.waiting, 4);
check('  and stores it for the screen', reader.store.get('queue').length, 4);
check('  nothing was leased', hub.calls.some((c) => c.name === 'lease'), false);
check('  nothing was opened, filled or submitted',
    hub.calls.some((c) => ['filled', 'parked', 'submitted', 'reclassify'].includes(c.name)),
    false);
check('  and it works while the app is stopped', seen.ok, true);

/* ── packaging concerns ───────────────────────────────────────────────── */

section('a packaged build can still find a browser');

// The bug this guards: the main process used to require('playwright'), which is
// a devDependency. It resolves on every machine the app was ever run on — and
// on none of the machines the installer reaches.
const resolved = resolveBrowser();
check('a browser is resolved', typeof resolved.chromium?.launchPersistentContext, 'function');
check('  and it says which one it found',
    ['bundled', 'system-chrome'].includes(resolved.source), true);
check('  a system Chrome is driven by channel, a bundled one is not',
    resolved.source === 'bundled'
        ? Object.keys(resolved.launchOptions).length === 0
        : resolved.launchOptions.channel === 'chrome',
    true);

section('errors are written down, and the log stays bounded');

const logsDir = path.join(tmp, 'logs');
record(logsDir, 'testEvent', 'something went wrong');
const logFile = path.join(logsDir, 'errors.log');
check('the error reached the log', /testEvent {2}something went wrong/.test(fs.readFileSync(logFile, 'utf8')), true);
check('  stamped with a time', /^\d{4}-\d{2}-\d{2}T/.test(fs.readFileSync(logFile, 'utf8')), true);

// A log that fills the disk is its own outage.
fs.writeFileSync(logFile, 'x'.repeat(3 * 1024 * 1024));
record(logsDir, 'afterRotation', 'still logging');
check('an oversized log is rotated away', fs.existsSync(`${logFile}.1`), true);
check('  and the new one starts small', fs.statSync(logFile).size < 1024, true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
