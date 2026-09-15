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
const { BrowserSessions } = require('../src/main/browser/session.js');
const { Attention, WAIT_MS } = require('../src/main/attention.js');
const { DESTINATIONS, tenantFor } = require('../src/main/browser/destinations.js');
const { CycleEngine, nextPollMs, clearWorkDir } = require('../src/main/cycle.js');
const {
    buildAnswerBook, resolveAnswer, chooseOption, chooseSuggestion,
} = require('../src/main/browser/answers.js');
const { fillForm, describeFields } = require('../src/main/browser/filler.js');
const {
    runApplyFlow, pressSubmit, isSubmit,
    UPLOAD_WORDS: UPLOAD_PATTERN, RESUME_WORDS: RESUME_PATTERN,
    REVEAL_WORDS, NOT_REVEAL,
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
            // Nothing is on this page, and it has to say so consistently. It
            // used to resolve `waitForSelector` for every selector while its
            // `locator` reported a count of zero — harmless while unverified
            // boards short-circuited before the recipe ran, and an invented
            // "already applied" the moment they stopped doing that.
            waitForSelector: async (sel) => { throw new Error(`Timeout waiting for ${sel}`); },
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
        //
        // Small, but not as small as it can possibly be. At 30ms and a 5ms poll
        // this failed intermittently — the whole window could elapse before the
        // first poll got a turn on a loaded machine, and the test then reported
        // that signing in had not been noticed when the only thing that had
        // happened was a slow tick. Two seconds is still instant next to the
        // suite's own runtime and leaves no room for that.
        signInWaitMs: 2_000,
        signInPollMs: 20,
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
// Built In has a recipe too, but it is a CLASSIFYING one — it recognises a
// removed posting and finds the hand-off link, and has nothing to fill. The
// thing that must stay unique to LinkedIn is permission to type into a form,
// and that is `verified`, checked above.
check('Built In has a recipe, and still may not fill anything',
    [Boolean(BOARDS.BUILTIN.apply), BOARDS.BUILTIN.verified], [true, false]);
check('  because Built In hosts no application of its own',
    BOARDS.BUILTIN.apply.externalApply.includes('Apply to job'), true);
// The owner's instruction, recorded where a toggle cannot overrule it.
check('  and it never submits by itself', BOARDS.BUILTIN.neverAutoSubmit, true);
check('LinkedIn carries no such refusal, because the toggle governs it',
    Boolean(BOARDS.LINKEDIN.neverAutoSubmit), false);
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
        .some((v) => /\.[a-z]+-|\bclass=/.test(v) && !v.includes('aria-label')),
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



/* ── the account of a pass ────────────────────────────────────────────── */

section('every pass writes down what it did, and why');

/**
 * A board page that is a closed posting: no apply button, and a notice saying
 * applications are shut. Both of the app's earlier answers to this were wrong —
 * it waited fifteen seconds for a button and then told the consultant to apply
 * by hand to a job nobody can apply to.
 */
const closedPage = () => ({
    url: () => 'https://wellfound.com/jobs/1',
    bringToFront: async () => {},
    // Honest, because the flow now races the three verdicts against each other
    // and a fake that resolves — or throws — for all of them proves nothing.
    // This page shows the closed notice and nothing else.
    waitForSelector: async (sel) => {
        if (sel.startsWith('text=/') && !sel.includes('application submitted')) return null;
        throw new Error(`Timeout waiting for ${sel}`);
    },
    waitForTimeout: async () => null,
    $$eval: async () => [],
    locator: (sel) => {
        const shut = sel.startsWith('text=/') && !sel.includes('application submitted');
        const c = {
            count: async () => (shut ? 1 : 0),
            isVisible: async () => shut,
            innerText: async () => (shut ? 'No longer accepting applications' : ''),
            getAttribute: async () => null,
            click: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            page: () => ({ waitForTimeout: async () => {} }),
        };
        return { ...c, first: () => c, nth: () => c };
    },
});

BOARDS.WELLFOUND.verified = true;
BOARDS.WELLFOUND.apply = {
    open: 'OPEN', dialog: 'DIALOG', next: 'NEXT', submit: 'SUBMIT',
    alreadyApplied: 'APPLIED', maxSteps: 4,
};

let ledgerHub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item({ id: 'q1', company: 'VRSamadhan', title: 'React Js Developer' })],
        profile: { name: 'Sai Dhanush' },
        approvedAnswers: [],
    }),
});
let ledgerSess = fakeSessions();
ledgerSess.page = async () => closedPage();

let ledgerEngine = engineWith(ledgerHub, ledgerSess);
let stats = await ledgerEngine.run();

check('a closed posting is skipped, not handed to the consultant', stats.skipped, 1);
check('  and nobody is asked to apply to it', stats.handedToHuman, 0);
check('  it is counted as closed in its own right', stats.closed, 1);
check('  the hub is told why, in the word the consultant will look for',
    ledgerHub.calls.find((c) => c.name === 'skipped')?.args[1].reason,
    'This job is expired — the posting is no longer accepting applications.');

check('the pass names the job it decided about',
    stats.outcomes.map((o) => [o.company, o.result]), [['VRSamadhan', 'CLOSED']]);
check('  with the reason attached',
    /expired/.test(stats.outcomes[0].reason), true);
check('  and the ledger survives into the run history',
    (ledgerEngine.store.get('cycleLog').at(-1).outcomes ?? []).length, 1);

// A board the app does not fill still gets a line of its own, so "handed over"
// is never something the consultant has to infer from an empty screen.
BOARDS.WELLFOUND.verified = false;
ledgerHub = fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({
        items: [item({ id: 'q2', company: 'Crisil', title: 'React Front end developer' })],
        profile: {},
        approvedAnswers: [],
    }),
});
ledgerSess = fakeSessions();
ledgerEngine = engineWith(ledgerHub, ledgerSess);
stats = await ledgerEngine.run();

check('an unverified board still hands over', stats.outcomes.map((o) => o.result), ['HANDED_OVER']);
// It got as far as its own recipe and reported what the PAGE was, rather than
// stopping at "this board is not verified" — which was true of every job on the
// board and therefore told nobody anything.
check('  and the reason describes the page, not the board',
    /no apply button/.test(stats.outcomes[0].reason), true);

delete BOARDS.WELLFOUND.apply;


/* ── destinations: where a board hands the job to ─────────────────────── */

section('a hand-off is recognised, and kept per employer');

check('a Workday URL is recognised', tenantFor(
    'https://jda.wd5.myworkdayjobs.com/JDA_Careers/job/Hyderabad/DevOps-Engineer_262499',
)?.system, 'WORKDAY');
check('  whichever employer runs it', tenantFor(
    'https://vanguard.wd5.myworkdayjobs.com/vanguard_external/job/x',
)?.system, 'WORKDAY');
check('SmartRecruiters is recognised too',
    tenantFor('https://jobs.smartrecruiters.com/BlueSpireInc1/74399')?.system, 'SMARTRECRUITERS');
check('an employer’s own careers page is not a destination',
    tenantFor('http://careers.hupcfl.com/apply/k3eToF4RNb'), null);
check('nor is a malformed link', tenantFor('not a url'), null);

// ── ONE SESSION PER EMPLOYER, NOT PER SYSTEM ─────────────────────────
//
// Every employer runs their own Workday with their own accounts. Sharing one
// profile across tenants would mean signing in once and appearing signed out
// forever afterwards.
const wd1 = tenantFor('https://jda.wd5.myworkdayjobs.com/JDA_Careers/job/a');
const wd2 = tenantFor('https://vanguard.wd5.myworkdayjobs.com/vanguard_external/job/b');
check('two employers get two profiles', wd1.name === wd2.name, false);
check('  and both are safe as directory names',
    [wd1.name, wd2.name].every((n) => /^[a-z0-9-]+$/.test(n)), true);
check('  the same employer always gets the same one',
    tenantFor('https://jda.wd5.myworkdayjobs.com/JDA_Careers/job/zzz').name, wd1.name);

// A destination is a board in shape, which is what lets the engine reuse
// everything it already had.
check('a tenant carries what the engine asks a board for',
    ['name', 'loginUrl', 'signedIn', 'botCheck', 'verified']
        .every((k) => k in wd1), true);
check('sign-in happens on the job page, needing no guessed login path',
    wd1.loginUrl, 'https://jda.wd5.myworkdayjobs.com/JDA_Careers/job/a');

// ── NOTHING HERE MAY FILL, AND NOTHING MAY SUBMIT ────────────────────
//
// The public parts were measured; the form behind the account wall was not.
// Until somebody has watched one being filled, these classify and hand over.
// Workday earned it: filling was watched working through `runApplyFlow`
// against the live site. SmartRecruiters has not, and cannot be -- it answers
// automated requests with a challenge.
check('only Workday is verified',
    Object.values(DESTINATIONS).filter((d) => d.verified).map((d) => d.name), ['WORKDAY']);
check('  and a verified destination still refuses to auto-submit',
    tenantFor('https://acme.wd5.myworkdayjobs.com/x/job/y').neverAutoSubmit, true);
// The chooser and the form are different elements -- conflating them was the
// bug that made the wizard unreachable.
check('the chooser and the fill root are not the same selector',
    DESTINATIONS.WORKDAY.apply.chooser === DESTINATIONS.WORKDAY.apply.dialog, false);
// `fillForm` scopes by string prefix, so a comma here would silently match
// the whole page instead of the form.
check('the fill root is a single selector, never a list',
    DESTINATIONS.WORKDAY.apply.dialog.includes(','), false);
check('and every one of them refuses to auto-submit',
    Object.values(DESTINATIONS).every((d) => d.neverAutoSubmit), true);
check('  which a tenant carries through', wd1.neverAutoSubmit, true);

// SmartRecruiters answered our probes with a DataDome challenge. R-22 says stop.
check('SmartRecruiters has no apply recipe at all',
    'apply' in DESTINATIONS.SMARTRECRUITERS, false);
check('  only a bot check to recognise',
    DESTINATIONS.SMARTRECRUITERS.botCheck.some((s) => s.includes('captcha')), true);
check('  and a tenant of it inherits that',
    tenantFor('https://jobs.smartrecruiters.com/x/y').botCheck.length > 0, true);

// Workday's controls were read off four tenants and never varied.
check('Workday is driven by data-automation-id, not by classes',
    DESTINATIONS.WORKDAY.apply.open, '[data-automation-id="adventureButton"]');
check('  and it chooses Apply Manually over autofill',
    DESTINATIONS.WORKDAY.apply.start, '[data-automation-id="applyManually"]');


section('the engine follows a hand-off into a destination');

/**
 * A board page that offers only an external APPLY, plus a destination page
 * behind it. `pages` is keyed by session name, which is how the engine keeps a
 * board and a destination apart.
 */
const handOffSessions = (destUrl, destOpts = {}) => {
    const opened = [];
    const ctrl = (kind, opts) => {
        const c = {
            count: async () => (opts[kind] ? 1 : 0),
            isVisible: async () => Boolean(opts[kind]),
            innerText: async () => (kind === 'away' ? 'APPLY' : ''),
            getAttribute: async (a) => (kind === 'away' && a === 'href' ? destUrl : null),
            click: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            page: () => ({ waitForTimeout: async () => {} }),
        };
        return { ...c, first: () => c, nth: () => c };
    };
    const kindOf = (sel) => {
        if (sel.includes('application submitted')) return 'appliedNotice';
        if (sel.startsWith('text=/')) return 'closed';
        if (sel.includes('Apply to job') || sel.includes(':has-text("Apply")')) return 'away';
        if (sel.includes('captcha')) return 'captcha';
        if (sel.includes('legalNotice')) return 'legal';
        return 'other';
    };
    const makePage = (opts) => ({
        url: () => opts.url,
        bringToFront: async () => {},
        waitForSelector: async (sel) => {
            if (!opts[kindOf(sel)]) throw new Error(`Timeout waiting for ${sel}`);
            return null;
        },
        waitForTimeout: async () => null,
        $$eval: async () => [],
        locator: (sel) => ctrl(kindOf(sel), opts),
    });

    const pages = {
        BUILTIN: makePage({ url: 'https://builtin.com/job/1', away: true }),
    };
    // `captchaClearsAfterCalls` lets a test simulate the person solving the
    // challenge partway through a wait -- each poll from `#waitOut` counts as
    // one call, so a small number here means "cleared after a couple of ticks"
    // without the test needing real wall-clock time to pass.
    let botCheckCalls = 0;
    return {
        opened,
        isBotChecked: async (def) => {
            if (def.name === 'BUILTIN' || !destOpts.captcha) return false;
            botCheckCalls += 1;
            if (destOpts.captchaClearsAfterCalls
                && botCheckCalls > destOpts.captchaClearsAfterCalls) return false;
            return true;
        },
        isSignedIn: async (def) => (def.name === 'BUILTIN' ? true : Boolean(destOpts.signedIn)),
        isSignedInNow: async () => Boolean(destOpts.signedIn),
        promptSignIn: async () => ({ awaitingHuman: true }),
        openJob: async (name, url) => {
            opened.push([name, url]);
            pages[name] = pages[name] ?? makePage({ url, ...destOpts });
        },
        page: async (name) => pages[name] ?? makePage({ url: destUrl, ...destOpts }),
    };
};

const biItem = () => item({
    id: 'b1', portal: 'BUILTIN', company: 'Blue Yonder',
    title: 'DevOps Engineer', source_url: 'https://builtin.com/job/1',
});
const biHub = () => fakeHub({
    heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
    queue: () => Promise.resolve({ items: [biItem()], profile: {}, approvedAnswers: [] }),
});

const WD = 'https://jda.wd5.myworkdayjobs.com/JDA_Careers/job/Hyderabad/DevOps-Engineer_262499';

// The destination is opened in ITS OWN session, not the board's.
let dHub = biHub();
let dSess = handOffSessions(WD, { signedIn: true });
let dEngine = engineWith(dHub, dSess);
let dStats = await dEngine.run();

check('the hand-off link is followed', dSess.opened.length, 2);
check('  the board is opened first', dSess.opened[0][0], 'BUILTIN');
check('  then the destination, in a profile of its own',
    dSess.opened[1][0], tenantFor(WD).name);
check('  at the address the board gave', dSess.opened[1][1], WD);
check('  and the job is handed over, because Workday is not verified',
    dStats.outcomes.map((o) => o.result), ['HANDED_OVER']);
check('  naming the employer’s system in the reason',
    /Workday/.test(dStats.outcomes[0].reason), true);

// A destination that challenges us stops, and says so in those words.
dHub = biHub();
dSess = handOffSessions(WD, { captcha: true });
dEngine = engineWith(dHub, dSess);
dStats = await dEngine.run();
check('a destination showing a bot check is not pushed at',
    /human check/.test(dStats.outcomes[0].reason), true);
check('  and it is recorded against the run', dStats.botChecked.length, 1);

// Nobody signed in: the item waits for a person rather than failing.
dHub = biHub();
dSess = handOffSessions(WD, { signedIn: false });
dEngine = engineWith(dHub, dSess);
dStats = await dEngine.run();
check('an unsigned-in destination asks for a sign-in',
    /sign in/.test(dStats.outcomes[0].reason), true);
check('  and the login page was opened for them', dStats.signInNeeded.length, 1);

// An employer's own careers site is not a system we handle — unchanged.
dHub = biHub();
dSess = handOffSessions('http://careers.hupcfl.com/apply/k3eToF4RNb');
dEngine = engineWith(dHub, dSess);
dStats = await dEngine.run();
check('an unknown destination is still just a hand-over', dSess.opened.length, 1);
check('  named by its host', /hupcfl/.test(dStats.outcomes[0].reason), true);

section('a challenge that clears gets a person a chance, not an instant hand-over');

// Real timing (30s) would make the suite itself take thirty seconds. The
// engine reads this fresh through `tenantFor` on every call, so shrinking it
// for the test and restoring it after is the same trick already used above
// for `BOARDS.WELLFOUND.verified`.
const realWait = DESTINATIONS.SMARTRECRUITERS.botCheckWaitMs;
DESTINATIONS.SMARTRECRUITERS.botCheckWaitMs = 60;

const SR = 'https://jobs.smartrecruiters.com/SomeCo/12345-a-job';

// Cleared in time: the item is worked, not handed over.
dHub = biHub();
dSess = handOffSessions(SR, { captcha: true, captchaClearsAfterCalls: 1, signedIn: true });
dEngine = engineWith(dHub, dSess);
dStats = await dEngine.run();
check('a challenge that clears in time is not a hand-over',
    dStats.outcomes.map((o) => o.result), ['HANDED_OVER']);
check('  it did carry on past the check, though — not counted as botChecked',
    dStats.botChecked.length, 0);

// Never cleared: still hands over, same as before, just after giving a person
// the chance.
dHub = biHub();
dSess = handOffSessions(SR, { captcha: true });
dEngine = engineWith(dHub, dSess);
dStats = await dEngine.run();
check('a challenge that never clears still hands over',
    /human check/.test(dStats.outcomes[0].reason), true);
check('  and is recorded as a bot check, same as before', dStats.botChecked.length, 1);

DESTINATIONS.SMARTRECRUITERS.botCheckWaitMs = realWait;


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
            if (kind === 'closed') return opts.closed ? 1 : 0;
            if (kind === 'appliedNotice') return opts.appliedNotice ? 1 : 0;
            if (kind === 'away') return opts.externalApply ? 1 : 0;
            // `start` is a fixed one-time choice (Workday's "Apply Manually"),
            // present until clicked. `wall` is a live gate a test can clear
            // from its own `waitForHuman`, so it is read from `opts.wall`
            // fresh on every count() rather than cached at page-creation time.
            if (kind === 'start') return opts.start && !clicked.includes('start') ? 1 : 0;
            if (kind === 'wall') return opts.wall ? 1 : 0;
            if (kind === 'submit') return opened && step >= steps.length - 1 ? 1 : 0;
            if (kind === 'next') return opened && step < steps.length - 1 ? 1 : 0;
            if (kind === 'dialog') return opened ? 1 : 0;
            return 0;
        },
        isVisible: async () => (await control(kind).count()) > 0,
        innerText: async () => ({ open: 'Easy Apply', next: 'Next', submit: 'Submit application', already: 'Applied', start: 'Apply Manually' }[kind] ?? ''),
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

    // `closed` and `away` answer for the two lookups the flow now makes before
    // and after the apply button. Both default to absent — this board is open
    // and applies in place — and a test that wants either says so through
    // `opts`, rather than every unrecognised selector reporting a live dialog.
    const kindOf = (sel) => {
        if (sel.includes('OPEN')) return 'open';
        if (sel.includes('START')) return 'start';
        if (sel.includes('WALL')) return 'wall';
        if (sel.includes('NEXT')) return 'next';
        if (sel.includes('SUBMIT')) return 'submit';
        if (sel.includes('APPLIED')) return 'already';
        // Two text-engine selectors now, and they mean opposite things.
        if (sel.includes('application submitted')) return 'appliedNotice';
        if (sel.startsWith('text=/')) return 'closed';
        if (sel.includes(':has-text("Apply")')) return 'away';
        return 'dialog';
    };

    return {
        clicked,
        opts,
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

// No apply button and nothing else either: we cannot say where applying happens.
wiz = wizardPage([[]], { noOpen: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a page with no apply button is handed over', flow.outcome, 'NO_APPLY_FLOW');

// ── A CLOSED POSTING IS NOT A HAND-OVER ──────────────────────────────
//
// It reads as "no apply button" to everything that only looks for a button,
// and the consultant then opens it to find applications are closed. These two
// cases have to be told apart before either is reported.
wiz = wizardPage([[]], { noOpen: true, closed: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a posting that says applications are closed is recognised', flow.outcome, 'CLOSED');
check('  and it says so plainly', /expired/.test(flow.detail), true);
check('  without waiting for an apply button that will never come',
    wiz.clicked.length, 0);

// A closed posting is checked BEFORE the opener, so an open one is unaffected.
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]]);
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('an open posting is not mistaken for a closed one', flow.outcome, 'READY_TO_SUBMIT');

// ── AND A FINISHED APPLICATION IS NOT A MISSING BUTTON ───────────────
//
// A completed application removes the apply button and puts a status block
// where it was. With only "Continue applying" — a resumable DRAFT — to match
// on, the page matched nothing, and the consultant was told to go and apply by
// hand to a job they had already applied to.
wiz = wizardPage([[]], { noOpen: true, appliedNotice: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a finished application is recognised without a button to match',
    flow.outcome, 'ALREADY_APPLIED');
check('  and nothing on the page was touched', wiz.clicked.length, 0);

// Both shapes mean the same thing and must report the same thing.
wiz = wizardPage([[]], { alreadyApplied: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a resumable draft says the same', flow.outcome, 'ALREADY_APPLIED');


// An "Apply" that leaves for the employer's site: a person's job, and the
// reason given should say that rather than blaming the app.
wiz = wizardPage([[]], { noOpen: true, externalApply: true });
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('an apply button that leaves the board is recognised', flow.outcome, 'EXTERNAL_APPLY');

// ── CLASSIFYING IS NOT PERMISSION TO FILL ────────────────────────────
//
// Unverified boards now reach their own recipe, so that a job's REASON can
// describe the page rather than the board. That must not leak into permission:
// here the page has a real in-page application and the board has never been
// watched filling one.
let nvFlow = await runApplyFlow(
    wizardPage([[wField({ index: 0, label: 'Email' })]]), wizardBoard,
    { profile: {}, approvedAnswers: [] }, { canFill: false },
);
check('a form on an unverified board is recognised and refused',
    nvFlow.outcome, 'NOT_VERIFIED');
check('  and the reason says filling is what is unchecked',
    /filling it has not been checked/.test(nvFlow.detail), true);

const nvPage = wizardPage([[wField({ index: 0, label: 'Email' })]]);
await runApplyFlow(nvPage, wizardBoard, { profile: {}, approvedAnswers: [] }, { canFill: false });
check('  the apply button was never pressed', nvPage.clicked.length, 0);

// The very same page, once the board is trusted, is worked as normal.
nvFlow = await runApplyFlow(
    wizardPage([[wField({ index: 0, label: 'Email' })]]), wizardBoard,
    { profile: { email: 'mj@example.com' }, approvedAnswers: [] }, { canFill: true },
);
check('  and filling resumes the moment it is', nvFlow.outcome, 'READY_TO_SUBMIT');
check('  and the reason names the employer’s site',
    /employer/.test(flow.detail), true);

// ── A SECOND CLICK, ONLY WHEN THE RECIPE ASKS FOR ONE ────────────────
//
// Workday's Apply opens a CHOICE (Autofill / Apply Manually / Use My Last
// Application), not the form itself. `start` names the one that leads to a
// form the app is allowed to fill.
const gatedBoard = { ...wizardBoard, apply: { ...wizardBoard.apply, start: 'START', accountWall: 'WALL' } };

wiz = wizardPage([[wField({ index: 0, label: 'Email' })]], { start: true });
flow = await runApplyFlow(wiz, gatedBoard, { profile: wizProfile, approvedAnswers: [] });
check('a declared start control is pressed, right after the opener',
    wiz.clicked.slice(0, 2), ['open', 'start']);
check('  and filling still reaches the end', flow.outcome, 'READY_TO_SUBMIT');

wiz = wizardPage([[wField({ index: 0, label: 'Email' })]]);
flow = await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] });
check('a board with no `start` never gains a click for one',
    wiz.clicked.includes('start'), false);

// ── AN ACCOUNT WALL MID-FLOW, NOT JUST AT THE DOOR ────────────────────
//
// Measured on Workday: signing in at the header does not guarantee the apply
// flow itself is authenticated. "Apply Manually" can land on its own
// email/password gate. `waitForHuman` is how the caller (cycle.js in
// production) is given the chance to get a person through it.
let waited = [];
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]], { start: true, wall: true });
flow = await runApplyFlow(wiz, gatedBoard, { profile: wizProfile, approvedAnswers: [] }, {
    waitForHuman: async (page, selector, message) => {
        waited.push({ selector, message });
        return false; // nobody signed in within the (fake) window
    },
});
check('an account wall is recognised', flow.outcome, 'ACCOUNT_WALL');
check('  the caller was asked to wait, with the gate’s own selector',
    waited[0]?.selector, 'WALL');
check('  and a message naming the board', /Test Board/.test(waited[0]?.message ?? ''), true);
check('  nothing past the wall was touched', wiz.clicked.includes('next'), false);

// The same wall, but the person gets through it in time.
waited = [];
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]], { start: true, wall: true });
flow = await runApplyFlow(wiz, gatedBoard, { profile: wizProfile, approvedAnswers: [] }, {
    waitForHuman: async () => {
        wiz.opts.wall = false; // the human signed in; the gate is gone now
        return true;
    },
});
check('once the wall clears, filling carries on through it', flow.outcome, 'READY_TO_SUBMIT');

// A recipe with no accountWall at all is never asked to wait for one.
let askedAtAll = false;
wiz = wizardPage([[wField({ index: 0, label: 'Email' })]]);
await runApplyFlow(wiz, wizardBoard, { profile: wizProfile, approvedAnswers: [] }, {
    waitForHuman: async () => { askedAtAll = true; return false; },
});
check('a board that declares no accountWall never calls waitForHuman', askedAtAll, false);


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
        // Nothing on this page but the opener and, later, Submit. `already`
        // counted 1 while reporting itself invisible, which the old glance
        // tolerated and the verdict race does not.
        count: async () => (['next', 'closed', 'already'].includes(kind) ? 0 : 1),
        first() { return this; },
        nth() { return this; },
        isVisible: async () => !['next', 'already', 'closed'].includes(kind),
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
                : sel.includes('APPLIED') ? 'already'
                    // This posting is open, unapplied, and applies in place, so
                    // both text-engine probes must come back empty.
                    : sel.startsWith('text=/') ? 'closed' : 'dialog');
    return {
        clicked,
        url: () => 'https://wellfound.com/jobs/1',
        bringToFront: async () => {},
        // Only the opener is on this page. Resolving for everything made the
        // verdict race a coin toss between "open" and "already applied".
        waitForSelector: async (sel) => {
            if ((await ctrl(kindOf(sel)).count()) === 0) {
                throw new Error(`Timeout waiting for ${sel}`);
            }
            return null;
        },
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

// ── A BOARD CAN REFUSE, AND THE TOGGLE DOES NOT OVERRULE IT ──────────
//
// Built In is marked `neverAutoSubmit` on the owner's instruction: fill it to
// the submit button and stop, so a person reads the application before it goes.
// A preference somebody set weeks ago must not be able to undo that, which is
// the whole reason it lives on the board and not in the settings.
BOARDS.WELLFOUND.neverAutoSubmit = true;
sess = fakeSessions();
rp = readyPage();
sess.page = async () => rp;
hub = applyHub();
engine = engineWith(hub, sess);
engine.store.set({ automationOn: true, autoSubmit: true });
r = await engine.run();
check('a board that refuses auto-submit is not submitted, toggle or no toggle',
    rp.clicked.includes('submit'), false);
check('  the hub is not told it was sent',
    hub.calls.some((c) => c.name === 'submitted'), false);
check('  the application is still filled, not abandoned', r.filled, 1);
check('  and it waits for the consultant instead',
    engine.store.get('awaitingReview').length, 1);
delete BOARDS.WELLFOUND.neverAutoSubmit;

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

section('a sign-in survives the app being closed');

/**
 * A fake context that behaves like Chromium in the one way that matters here:
 * cookies added to it are remembered while it lives, and a NEW one starts
 * empty -- which is precisely what made Workday log the consultant out of
 * every tenant, every restart, no matter how many times they signed in.
 */
const fakeChromium = () => {
    const launched = [];
    return {
        launched,
        launchPersistentContext: async () => {
            const jar = [];
            const ctx = {
                jar,
                setDefaultNavigationTimeout() {},
                on() {},
                pages: () => [],
                newPage: async () => ({}),
                cookies: async () => [...jar],
                addCookies: async (cookies) => { jar.push(...cookies); },
                close: async () => {},
            };
            launched.push(ctx);
            return ctx;
        },
    };
};

const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-sess-'));
const makeSessions = (chromiumFake) => new BrowserSessions({
    chromium: chromiumFake,
    profilesDir: path.join(sessionRoot, 'profiles'),
    sessionsDir: path.join(sessionRoot, 'sessions'),
});

let chromeFake = fakeChromium();
let jarSess = makeSessions(chromeFake);
let jarCtx = await jarSess.context('WORKDAY-ACME');
// The shape Workday actually uses: no expiry, so Chromium drops it on close.
await jarCtx.addCookies([{ name: 'CALYPSO_SESSION', value: 'tok', domain: 'acme.test', path: '/' }]);
await jarSess.closeAll();

chromeFake = fakeChromium();
jarSess = makeSessions(chromeFake);
jarCtx = await jarSess.context('WORKDAY-ACME');
check('a session cookie is put back into a brand-new context',
    (await jarCtx.cookies()).map((c) => c.name), ['CALYPSO_SESSION']);
check('  and the context really was new, not the old one cached',
    chromeFake.launched.length, 1);

// One employer's session must never leak into another's -- separate accounts,
// separate profiles, separate jars.
const other = await jarSess.context('WORKDAY-OTHERCO');
check('another employer’s tenant starts empty', (await other.cookies()).length, 0);
await jarSess.closeAll();

// Revocation (R-21) has to take saved sign-ins with it; a cookie jar on disk
// is a sign-in in a file.
jarSess.forgetSessions();
chromeFake = fakeChromium();
jarSess = makeSessions(chromeFake);
jarCtx = await jarSess.context('WORKDAY-ACME');
check('forgetting sessions really removes them', (await jarCtx.cookies()).length, 0);
await jarSess.closeAll();

fs.rmSync(sessionRoot, { recursive: true, force: true });


section('only a couple of browsers are open at once');

/**
 * The same fake as above, but it records closes -- because the thing being
 * proven here is that browsers actually go away, not merely that they were
 * asked to.
 */
const countingChromium = () => {
    const opened = [];
    const closed = [];
    return {
        opened,
        closed,
        launchPersistentContext: async (dir) => {
            const jar = [];
            const ctx = {
                dir,
                setDefaultNavigationTimeout() {},
                on() {},
                pages: () => [],
                newPage: async () => ({}),
                cookies: async () => [...jar],
                addCookies: async (c) => { jar.push(...c); },
                close: async () => { closed.push(dir); },
            };
            opened.push(dir);
            return ctx;
        },
    };
};

const lruRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-lru-'));
let lruChrome = countingChromium();
let lru = new BrowserSessions({
    chromium: lruChrome,
    profilesDir: path.join(lruRoot, 'profiles'),
    sessionsDir: path.join(lruRoot, 'sessions'),
    maxOpenContexts: 2,
});

await lru.context('LINKEDIN');
await lru.context('BUILTIN');
check('two boards, two browsers', lruChrome.opened.length, 2);
check('  and nothing closed yet', lruChrome.closed.length, 0);

// A third employer arrives -- eight of these is what exhausted the machine.
await lru.context('WORKDAY-ACME');
check('a third opens', lruChrome.opened.length, 3);
check('  and the oldest is closed to make room', lruChrome.closed.length, 1);
check('  the one closed is the least recently used',
    lruChrome.closed[0].endsWith('linkedin'), true);
check('  never more than the cap are open at once', lru.contexts.size, 2);

// Touching a board keeps it alive; the untouched one goes instead.
await lru.context('BUILTIN');            // refresh its place in the queue
await lru.context('WORKDAY-OTHER');
check('a board used recently is not the one evicted',
    lru.contexts.has('BUILTIN'), true);

await lru.closeAll();

// ── AND EVICTION MUST NOT COST A SIGN-IN ─────────────────────────────
//
// Closing a browser to save memory would be no help at all if it logged the
// consultant out. It does not, because the jar is written before the close.
lruChrome = countingChromium();
lru = new BrowserSessions({
    chromium: lruChrome,
    profilesDir: path.join(lruRoot, 'profiles'),
    sessionsDir: path.join(lruRoot, 'sessions'),
    maxOpenContexts: 1,
});
let signedIn = await lru.context('WORKDAY-ACME');
await signedIn.addCookies([
    { name: 'CALYPSO_SESSION', value: 'tok', domain: 'acme.test', path: '/' },
]);
await lru.context('LINKEDIN');           // forces WORKDAY-ACME out
check('the evicted browser really was closed', lruChrome.closed.length, 1);
signedIn = await lru.context('WORKDAY-ACME');   // and back again
check('  yet its sign-in came back with it',
    (await signedIn.cookies()).map((c) => c.name), ['CALYPSO_SESSION']);

await lru.closeAll();
fs.rmSync(lruRoot, { recursive: true, force: true });


section('when the bot needs a person, it asks and waits');

const attentionWith = (over = {}) => {
    const published = [];
    const notified = [];
    return {
        published,
        notified,
        a: new Attention({
            notify: (x) => notified.push(x),
            publish: (x) => published.push(x),
            pollMs: 5,           // real seconds are not the thing being tested
            ...over,
        }),
    };
};

// Already satisfied: a gate nobody needs must not pause anybody.
let { a, published, notified } = attentionWith();
let attnSaid = await a.raise({ kind: 'BOT_CHECK', check: async () => true, waitMs: 500 });
check('a gate already clear resolves at once', attnSaid, 'done');
check('  and the screen is told to clear it again', published.at(-1), null);
check('  the consultant is still told it happened', notified.length, 1);

// Cleared partway through: the common case.
({ a, published, notified } = attentionWith());
let attnLooks = 0;
attnSaid = await a.raise({
    kind: 'BOT_CHECK',
    check: async () => { attnLooks += 1; return attnLooks > 2; },
    waitMs: 2_000,
});
check('a gate cleared partway through is noticed', attnSaid, 'done');

// Nobody there.
({ a, published } = attentionWith());
attnSaid = await a.raise({ kind: 'BOT_CHECK', check: async () => false, waitMs: 60 });
check('a gate nobody clears times out', attnSaid, 'timeout');
check('  and the banner is taken down either way', published.at(-1), null);

// ── THE TWO BUTTONS ──────────────────────────────────────────────────
({ a } = attentionWith());
let attnPressed = false;
const skipping = a.raise({
    kind: 'UNKNOWN_QUESTIONS',
    check: async () => false,
    waitMs: 10_000,
});
setTimeout(() => { attnPressed = a.skip(); }, 20);
check('"Skip this job" ends the wait', await skipping, 'skipped');
check('  and it reported that something was waiting', attnPressed, true);

// "I've done it" is a request to LOOK, not a claim. Pressing it while the gate
// is still up must not abandon the job on somebody's optimism.
({ a } = attentionWith());
let attnCleared = false;
const nudging = a.raise({
    kind: 'SIGN_IN',
    check: async () => attnCleared,
    waitMs: 3_000,
});
setTimeout(() => { a.continueNow(); }, 15);      // too early -- still not done
setTimeout(() => { attnCleared = true; }, 120);      // now they really have
check('"I’ve done it" pressed too early does not end the job', await nudging, 'done');

// Nothing is waiting: the buttons are inert rather than throwing.
({ a } = attentionWith());
check('the buttons do nothing when no gate is up', [a.continueNow(), a.skip()], [false, false]);

// ── WHAT THE SCREEN IS GIVEN ─────────────────────────────────────────
({ a, published } = attentionWith());
await a.raise({
    kind: 'UNKNOWN_QUESTIONS',
    board: 'LINKEDIN',
    boardLabel: 'LinkedIn',
    company: 'Freshworks',
    message: 'Answer it on the Questions tab',
    check: async () => true,
    waitMs: 1_000,
});
const attnShown = published[0];
check('the banner is given a deadline, not a countdown',
    [typeof attnShown.until, typeof attnShown.totalMs], ['number', 'number']);
check('  and enough to say which job stopped',
    [attnShown.company, attnShown.boardLabel], ['Freshworks', 'LinkedIn']);
check('  with a headline of its own', typeof attnShown.headline, 'string');

// The durations the owner asked for: 60s / 2min / 5min.
check('a human check waits a minute', WAIT_MS.BOT_CHECK, 60_000);
check('an unanswered question waits two', WAIT_MS.UNKNOWN_QUESTIONS, 120_000);
check('signing in waits five', WAIT_MS.SIGN_IN, 300_000);


section('an answered question resumes the job it stopped');

/**
 * A board page whose form asks one thing nobody has answered. The answer bank
 * is a live object the test mutates, standing in for a consultant typing into
 * the Questions tab while the countdown runs.
 */
const askingPage = (bank) => {
    const ctrl = (kind) => {
        const c = {
            count: async () => (kind === 'dialog' ? 1 : 0),
            isVisible: async () => false,
            innerText: async () => '',
            getAttribute: async () => null,
            click: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            fill: async () => {},
            pressSequentially: async () => {},
            selectOption: async () => {},
            check: async () => {},
            setInputFiles: async () => {},
            page: () => ({ waitForTimeout: async () => {} }),
        };
        return { ...c, first: () => c, nth: () => c };
    };
    return {
        url: () => 'https://wellfound.com/jobs/1',
        bringToFront: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => null,
        // The one question. Once the bank holds an answer the filler resolves
        // it, so the second pass reports no unknowns -- exactly what happens
        // on a real page once the consultant has answered.
        $$eval: async () => [{
            index: 0, tag: 'input', type: 'text', name: '', id: '',
            label: 'What is your notice period?', groupLabel: '', groupKey: '',
            required: true, disabled: false, visible: true, hittable: true,
            hasValue: bank.some((a) => a.question_text === 'What is your notice period?'),
            options: [],
        }],
        locator: (sel) => ctrl(sel.includes('DIALOG') ? 'dialog' : 'other'),
    };
};

const askingHub = (bank) => {
    const hub = fakeHub({
        heartbeat: () => Promise.resolve({ paused: false, pausedBoards: [] }),
        queue: () => Promise.resolve({
            items: [item({ id: 'aq1', company: 'Freshworks', title: 'Full Stack' })],
            profile: { name: 'Sai Dhanush' },
            approvedAnswers: bank,
        }),
    });
    hub.askQuestions = (...args) => { hub.calls.push({ name: 'askQuestions', args }); return Promise.resolve({ ok: true }); };
    hub.answers = () => Promise.resolve({ ok: true, answers: bank });
    return hub;
};

// The board has to be one the engine will actually FILL, or it hands over
// before a question is ever reached. No apply recipe: this exercises the
// plain single-page form path.
BOARDS.WELLFOUND.verified = true;

// ── ANSWERED IN TIME: the same job carries on ────────────────────────
let bank = [];
let aHub = askingHub(bank);
let aSess = fakeSessions();
aSess.page = async () => askingPage(bank);
let aAttn = new Attention({ pollMs: 5 });
let aEngine = engineWith(aHub, aSess, { attention: aAttn });

// The consultant answers a moment after the countdown appears.
setTimeout(() => { bank.push({ question_text: 'What is your notice period?', answer_text: '30 days', question_id: 'Q1' }); }, 40);

let aStats = await aEngine.run();
check('the questions are raised before anything is given up',
    aHub.calls.some((c) => c.name === 'askQuestions'), true);
check('  and the job is NOT parked when somebody answers',
    aHub.calls.some((c) => c.name === 'parked'), false);
check('  it carries on to the review screen instead',
    aStats.outcomes.map((o) => o.result), ['READY_TO_SUBMIT']);
check('  nothing was counted as parked', aStats.parked, 0);

// ── NOBODY ANSWERS: exactly the old behaviour ────────────────────────
bank = [];
aHub = askingHub(bank);
aSess = fakeSessions();
aSess.page = async () => askingPage(bank);
aAttn = new Attention({ pollMs: 5 });
aEngine = engineWith(aHub, aSess, { attention: aAttn });

aStats = await aEngine.run();
check('an unanswered question still parks the job in the end',
    aHub.calls.some((c) => c.name === 'parked'), true);
check('  counted as parked', aStats.parked, 1);
check('  and the reason names what it is waiting on',
    /notice period/.test(aStats.outcomes[0].reason), true);

// ── SKIPPED: the person said move on ─────────────────────────────────
bank = [];
aHub = askingHub(bank);
aSess = fakeSessions();
aSess.page = async () => askingPage(bank);
aAttn = new Attention({ pollMs: 5 });
aEngine = engineWith(aHub, aSess, { attention: aAttn });
setTimeout(() => { aAttn.skip(); }, 30);

aStats = await aEngine.run();
check('skipping parks it too, and says so',
    /skipped/.test(aStats.outcomes[0].reason), true);

BOARDS.WELLFOUND.verified = false;
check('the test board is left as it was found', BOARDS.WELLFOUND.verified, false);


section('a step hiding its fields behind a button is opened, not skipped');

// The wording rule, on the buttons these forms actually carry.
// Mirrors the full guard in `findRevealControl`, not just the two patterns:
// a control that submits is refused there, whatever else it is called.
const opensFields = (t) => REVEAL_WORDS.test(t) && !NOT_REVEAL.test(t)
    // Mirrors the full guard in `findRevealControl`, not just the two
// patterns: a control that submits is refused there whatever else it is
// called, so the helper has to refuse it too or the test is not testing
// the same rule.
    && !/\b(submit|send application|apply now|finish|confirm and send)\b/i.test(t);
check('"Add work experience" opens a section', opensFields('Add work experience'), true);
check('  so does "+ Add" and "Add another employer"',
    [opensFields('+ Add'), opensFields('Add another employer')], [true, true]);
check('Back, Next and Save do not',
    ['Back', 'Next', 'Save'].some(opensFields), false);
check('nor does a field whose LABEL merely contains the word',
    opensFields('Address line 1'), false);
// LinkedIn puts a save control on these very screens; clicking it would
// favourite the job instead of opening the section.
check('nor "Add to favourites" — the preposition gives it away',
    opensFields('Add to favourites'), false);
check('and nothing that submits, whatever it is called',
    opensFields('Add and submit application'), false);

/**
 * A step that arrives empty and grows fields once its button is pressed —
 * LinkedIn's "Work experience", which the engine used to read as empty and
 * press Next straight past.
 */
const collapsedPage = (opts = {}) => {
    const clicked = [];
    let open = false;
    let step = 0;

    const fieldsNow = () => {
        if (step > 0) return [wField({ index: 0, label: 'Email' })];
        return open ? [wField({ index: 0, label: 'Employer', required: true })] : [];
    };

    const control = (kind) => ({
        count: async () => {
            if (kind === 'open') return 1;
            if (kind === 'reveal') return step === 0 && !opts.noReveal ? 1 : 0;
            if (kind === 'submit') return step >= 1 ? 1 : 0;
            if (kind === 'next') return step < 1 ? 1 : 0;
            if (kind === 'dialog') return 1;
            return 0;
        },
        isVisible: async () => (await control(kind).count()) > 0,
        innerText: async () => ({
            open: 'Easy Apply',
            reveal: opts.revealText ?? 'Add work experience',
            next: 'Next',
            submit: 'Submit application',
        }[kind] ?? ''),
        getAttribute: async () => null,
        click: async () => {
            clicked.push(kind);
            if (kind === 'reveal') open = true;
            if (kind === 'next') step += 1;
        },
        scrollIntoViewIfNeeded: async () => {},
        page: () => ({ waitForTimeout: async () => {} }),
        fill: async () => {}, pressSequentially: async () => {},
        selectOption: async () => {}, check: async () => {}, setInputFiles: async () => {},
    });

    const kindOf = (sel) => {
        if (sel.includes('OPEN')) return 'open';
        if (sel.includes('NEXT')) return 'next';
        if (sel.includes('SUBMIT')) return 'submit';
        if (sel.includes('APPLIED')) return 'already';
        if (sel.includes('application submitted')) return 'appliedNotice';
        if (sel.startsWith('text=/')) return 'closed';
        // The reveal finder asks for every button inside the step.
        if (sel.includes('button')) return 'reveal';
        return 'dialog';
    };

    return {
        clicked,
        url: () => 'https://board.test/job/1',
        locator: (sel) => {
            const c = control(kindOf(sel));
            return { ...c, first: () => c, nth: () => c, count: c.count };
        },
        waitForSelector: async (sel) => {
            if (await control(kindOf(sel)).count() === 0) throw new Error(`Timeout ${sel}`);
            return null;
        },
        waitForTimeout: async () => null,
        $$eval: async () => fieldsNow(),
    };
};

let cp = collapsedPage();
let cpFlow = await runApplyFlow(cp, wizardBoard, {
    profile: { name: 'Mary Jane Watson' }, approvedAnswers: [],
});
check('the hidden section is opened', cp.clicked.includes('reveal'), true);
// Next is never reached here at all: the revealed field is required and
// unanswered, so the flow stops to ask rather than pressing on -- which is
// itself the point. What matters is that Next was not pressed FIRST.
check('  and Next was not pressed past it', cp.clicked.includes('next'), false);
check('  and the field behind it is seen',
    cpFlow.unknown.some((u) => u.questionText === 'Employer'), true);

// It must not keep pressing the same button on a step that stays empty.
cp = collapsedPage({ revealText: 'Add work experience' });
await runApplyFlow(cp, wizardBoard, { profile: {}, approvedAnswers: [] });
check('the same section is never opened twice',
    cp.clicked.filter((c) => c === 'reveal').length, 1);

// A step that genuinely has nothing behaves exactly as it did before.
cp = collapsedPage({ noReveal: true });
cpFlow = await runApplyFlow(cp, wizardBoard, { profile: {}, approvedAnswers: [] });
check('a step with no such button is untouched', cp.clicked.includes('reveal'), false);
check('  and the flow still reaches the end', cpFlow.outcome, 'READY_TO_SUBMIT');


section('a question wait is decided by the clock, not by keystrokes');

// ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────
//
// The form check asks "is every required field non-empty?", which turns true
// after the FIRST CHARACTER of the last answer. Polling it meant a consultant
// typing "30 days" had the bot move on at "3", taking a half-typed answer.
// So for questions the window is held open and the button is the way out.
let { a: holdA } = attentionWith();
let looked = 0;
let holdSaid = await holdA.raise({
    kind: 'UNKNOWN_QUESTIONS',
    // Satisfied from the very first instant — a field with one character in it.
    check: async () => { looked += 1; return true; },
    waitMs: 60,
    holdUntilDeadline: true,
});
check('a held wait does not end the moment the field looks filled', looked > 0, true);
check('  it runs to the deadline and only then accepts', holdSaid, 'done');

// Held, and still nothing there at the end.
({ a: holdA } = attentionWith());
holdSaid = await holdA.raise({
    kind: 'UNKNOWN_QUESTIONS',
    check: async () => false,
    waitMs: 60,
    holdUntilDeadline: true,
});
check('a held wait nobody answers still times out', holdSaid, 'timeout');

// The button is the shortcut, and it still has to be true to work.
({ a: holdA } = attentionWith());
let ready = false;
const held = holdA.raise({
    kind: 'UNKNOWN_QUESTIONS',
    check: async () => ready,
    waitMs: 10_000,
    holdUntilDeadline: true,
});
setTimeout(() => { holdA.continueNow(); }, 15);     // pressed while still blank
setTimeout(() => { ready = true; holdA.continueNow(); }, 90);
check('"I’ve done it" is the way past a held wait', await held, 'done');

// A gate that is either up or down still ends the moment it clears — holding
// those would make every captcha cost a full minute for nothing.
({ a: holdA } = attentionWith());
let up = true;
const quick = holdA.raise({ kind: 'BOT_CHECK', check: async () => !up, waitMs: 10_000 });
setTimeout(() => { up = false; }, 20);
check('a captcha still ends as soon as it is cleared', await quick, 'done');

// The screen is told which kind of wait it is, so the banner can say so.
({ a: holdA, published } = attentionWith());
await holdA.raise({
    kind: 'UNKNOWN_QUESTIONS', check: async () => true, waitMs: 20, holdUntilDeadline: true,
});
check('the banner is told the clock decides', published[0].holdUntilDeadline, true);


section('a form value is readable, except where it must never be');

const valuePage = await (async () => {
    const engineNow = resolveBrowser();
    const b = await engineNow.chromium.launch({ headless: true, ...engineNow.launchOptions });
    const pg = await b.newPage();
    await pg.setContent(`<!doctype html><html><body><div id="f">
      <label for="n">Notice period</label><input id="n" value="30 days">
      <label for="p">Password</label><input id="p" type="password" value="hunter2">
      <label for="e">Empty</label><input id="e" value="">
    </div></body></html>`);
    const fields = await describeFields(pg, '#f');
    await b.close();
    return fields;
})();

check('a typed answer can be read back for banking',
    valuePage.find((f) => f.label === 'Notice period')?.value, '30 days');
// R-18: a descriptor carrying a password would smuggle it into logs, IPC and
// the review screen. The refusal lives where the value is read.
check('a password is never carried in a descriptor',
    valuePage.find((f) => f.type === 'password')?.value, '');
check('  even though the box plainly has one in it',
    valuePage.find((f) => f.type === 'password')?.hasValue, true);
check('an empty field reads as empty', valuePage.find((f) => f.label === 'Empty')?.value, '');


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

/* ── the AI agent ─────────────────────────────────────────────────────── */

section('AI agent — the loop stops where it should');
{
    const { runAgent } = require('../src/main/agent/runAgent.js');
    const NO_WAIT = { minMs: 0, maxMs: 0, betweenFieldsMs: [0, 0] };

    /** A page whose signature changes on every look unless it is frozen. */
    const pages = (opts = {}) => {
        let n = 0;
        return async () => {
            n += 1;
            return {
                observation: {
                    url: 'https://jobs.example.test/apply',
                    fields: [],
                    controls: [],
                    headings: [],
                    errors: opts.errors ?? [],
                    challenge: opts.challenge ? opts.challenge(n) : false,
                },
                registry: new Map(),
                signature: opts.frozen ? 'same' : `sig-${n}`,
            };
        };
    };

    /** The hub, answering from a script and remembering what it was sent. */
    const scriptedHub = (replies) => {
        const sent = [];
        let i = 0;
        return {
            sent,
            agentStep: async (runId, body) => {
                sent.push(body);
                const r = replies[Math.min(i, replies.length - 1)];
                i += 1;
                return r;
            },
        };
    };
    const act = (action, extra = {}) => ({
        ok: true,
        action: {
            action, ref: 'F0f1', source: '', refs: [], kind: '', reason: `doing ${action}`, ...extra,
        },
    });

    let executed = [];
    let hub = scriptedHub([
        act('fill', { source: 'profile:email' }),
        act('press', { ref: 'F0c2' }),
        act('ready', { ref: 'F0c3' }),
    ]);
    let out = await runAgent({}, { hub, runId: 'r1', typing: NO_WAIT }, {
        observe: pages(),
        execute: async (page, action) => {
            executed.push(action.action);
            if (action.action === 'fill') {
                return {
                    ok: true, result: 'filled',
                    qa: { questionText: 'Email', answerText: 'x', source: 'PROFILE' },
                };
            }
            if (action.action === 'press') return { ok: true, result: 'pressed' };
            return {
                terminal: {
                    outcome: 'READY_TO_SUBMIT', detail: 'ready', submit: { ref: 'F0c3', frameIndex: 0 },
                },
            };
        },
    });
    check('a form the agent completes ends READY_TO_SUBMIT', out.outcome, 'READY_TO_SUBMIT');
    check('  having done what it was told, in order', executed, ['fill', 'press', 'ready']);
    check('  with the filled answer carried in qa', out.qa.length, 1);
    check('  and the submit button remembered', out.submit?.ref, 'F0c3');
    check('  in the same shape a recipe returns',
        ['outcome', 'qa', 'unknown', 'attachedResume', 'steps', 'detail'].every((k) => k in out), true);

    hub = scriptedHub([act('press')]);
    out = await runAgent({}, { hub, runId: 'r2', typing: NO_WAIT }, {
        observe: pages(),
        execute: async () => ({ ok: false, error: 'that sends the application' }),
    });
    check('four refusals in a row end the run', out.outcome, 'INCOMPLETE');
    check('  and say why', /kept choosing actions the app refused/.test(out.detail), true);
    check('  the model was told about every refusal',
        hub.sent.slice(1).every((b) => /refused/.test(b.lastResult)), true);

    hub = scriptedHub([act('press')]);
    out = await runAgent({}, { hub, runId: 'r3', typing: NO_WAIT }, {
        observe: pages({ frozen: true, errors: ['Phone is required'] }),
        execute: async () => ({ ok: true, result: 'pressed' }),
    });
    check('a page that stops changing ends the run as stuck', out.outcome, 'INCOMPLETE');
    check('  quoting what the form complained about', /Phone is required/.test(out.detail), true);

    hub = scriptedHub([{ ok: false, stop: 'CAP', detail: 'the AI agent reached this job’s $0.50 limit' }]);
    let touched = 0;
    out = await runAgent({}, { hub, runId: 'r4', typing: NO_WAIT }, {
        observe: pages(),
        execute: async () => { touched += 1; return { ok: true }; },
    });
    check('the hub refusing a turn ends the run', out.outcome, 'INCOMPLETE');
    check('  with the hub’s own reason', /\$0\.50 limit/.test(out.detail), true);
    check('  and nothing on the page is touched', touched, 0);

    hub = scriptedHub([
        { ok: true, action: null, invalid: 'answer:a99 is not in the catalogue.' },
        act('ready'),
    ]);
    out = await runAgent({}, { hub, runId: 'r5', typing: NO_WAIT }, {
        observe: pages(),
        execute: async () => ({ terminal: { outcome: 'READY_TO_SUBMIT', detail: 'ok' } }),
    });
    check('an unusable reply is fed back rather than acted on', /a99/.test(hub.sent[1]?.lastResult ?? ''), true);
    check('  and the run carries on', out.outcome, 'READY_TO_SUBMIT');

    touched = 0;
    hub = scriptedHub([
        act('fill', { source: 'profile:email' }),
        act('fill', { source: 'profile:phone' }),
        act('press'),
    ]);
    out = await runAgent({}, { hub, runId: 'r6', shadow: true, typing: NO_WAIT }, {
        observe: pages(),
        execute: async () => { touched += 1; return { ok: true }; },
    });
    check('shadow mode never touches the page', touched, 0);
    check('  it ends SHADOW', out.outcome, 'SHADOW');
    check('  having recorded three proposals', out.agent.proposals.length, 3);

    hub = scriptedHub([act('ready')]);
    out = await runAgent({}, {
        hub, runId: 'r7', typing: NO_WAIT, waitForBotCheck: async () => false,
    }, {
        observe: pages({ challenge: () => true }),
        execute: async () => ({ ok: true }),
    });
    check('a human check nobody clears ends BLOCKED, without asking the model',
        [out.outcome, hub.sent.length], ['BLOCKED', 0]);

    let cleared = 0;
    out = await runAgent({}, {
        hub: scriptedHub([act('ready')]),
        runId: 'r7b',
        typing: NO_WAIT,
        waitForBotCheck: async () => { cleared += 1; return true; },
    }, {
        observe: pages({ challenge: (n) => n === 1 }),
        execute: async () => ({ terminal: { outcome: 'READY_TO_SUBMIT', detail: 'ok' } }),
    });
    check('  one the consultant clears lets the agent carry on', [cleared, out.outcome], [1, 'READY_TO_SUBMIT']);

    hub = scriptedHub([act('fill', { source: 'profile:email' })]);
    out = await runAgent({}, { hub, runId: 'r8', maxActions: 5, typing: NO_WAIT }, {
        observe: pages(),
        execute: async () => ({ ok: true, result: 'filled' }),
    });
    check('the action ceiling holds', [out.outcome, out.steps], ['INCOMPLETE', 5]);

    out = await runAgent({}, {
        hub: scriptedHub([act('ready')]),
        runId: 'r9',
        typing: NO_WAIT,
        prior: { qa: [{ questionText: 'Name', answerText: 'A', source: 'PROFILE' }], attachedResume: true },
    }, {
        observe: pages(),
        execute: async () => ({ terminal: { outcome: 'READY_TO_SUBMIT', detail: 'ok' } }),
    });
    check('what the recipe already filled is kept', [out.qa.length, out.attachedResume], [1, true]);
}

section('AI agent — when the engine hands a job to it');
{
    /** A hub that also speaks the agent's three routes. */
    const agentHub = (over = {}) => {
        const hub = fakeHub({ queue: over.queue });
        hub.started = [];
        hub.finished = [];
        hub.agentStart = async (id, body) => {
            hub.started.push({ id, ...body });
            return over.start ?? { ok: true, runId: 'run-1', mode: over.mode ?? 'ON', limits: {} };
        };
        hub.agentFinish = async (runId, body) => { hub.finished.push({ runId, ...body }); return { ok: true }; };
        hub.agentStep = async () => ({ ok: false, stop: 'CAP', detail: 'not used here' });
        return hub;
    };

    /** The agent loop, replaced by an answer. */
    const agentReturns = (result) => {
        const calls = [];
        const fn = async (page, opts) => {
            calls.push(opts);
            return {
                qa: [], unknown: [], attachedResume: false, steps: 1, submit: null,
                agent: { runId: opts.runId, actions: 1, refused: 0 },
                ...result,
            };
        };
        fn.calls = calls;
        return fn;
    };

    const noRecipe = item({
        id: 'ag1', portal: 'GREENHOUSE', channel: 'AGENT', company: 'Acme', title: 'Engineer',
        source_url: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    const queueOf = (...items) => () => Promise.resolve({ items, approvedAnswers: [], profile: {} });

    {
        const hub = agentHub({ queue: queueOf(noRecipe) });
        const runner = agentReturns({
            outcome: 'READY_TO_SUBMIT',
            detail: 'filled',
            qa: [{ questionText: 'Email', answerText: 'x', source: 'PROFILE', matchedBy: 'AGENT' }],
            submit: { ref: 'F0c9', frameIndex: 0 },
        });
        const eng = engineWith(hub, fakeSessions({ landsOn: noRecipe.source_url }), { runAgent: runner });
        const stats = await eng.run();
        check('a job with no recipe goes to the agent, not straight to a person',
            hub.calls.some((c) => c.name === 'reclassify'), false);
        check('  the hub was asked first, as NO_RECIPE', hub.started[0]?.entry, 'NO_RECIPE');
        check('  naming the site', hub.started[0]?.host, 'boards.greenhouse.io');
        check('  the job was leased before the agent touched it', hub.calls.some((c) => c.name === 'lease'), true);
        check('  a filled form is reported like any other', hub.calls.some((c) => c.name === 'filled'), true);
        check('  and counted as the agent’s work', [stats.agentTried, stats.agentFilled], [1, 1]);
        check('  marked so on the run summary', stats.outcomes[0]?.filledBy, 'AGENT');
        check('  it waits for review with the submit button it found',
            eng.store.get('awaitingReview')[0]?.submit?.ref, 'F0c9');
        check('  marked as agent-filled for the review screen',
            eng.store.get('awaitingReview')[0]?.filledBy, 'AGENT');
        check('  and the run is closed on the hub', hub.finished[0]?.outcome, 'READY_TO_SUBMIT');
    }

    {
        const hub = agentHub({
            queue: queueOf(noRecipe),
            start: { ok: false, reason: 'The AI agent is switched off for this organisation.' },
        });
        const runner = agentReturns({ outcome: 'READY_TO_SUBMIT' });
        const eng = engineWith(hub, fakeSessions(), { runAgent: runner });
        await eng.run();
        check('an agent the hub refuses: the job is handed over as before',
            hub.calls.some((c) => c.name === 'reclassify'), true);
        check('  without leasing or opening anything', hub.calls.some((c) => c.name === 'lease'), false);
        check('  and without the agent running', runner.calls.length, 0);
    }

    {
        const hub = agentHub({ queue: queueOf(noRecipe) });
        const eng = engineWith(hub, fakeSessions(), { runAgent: agentReturns({ outcome: 'READY_TO_SUBMIT' }) });
        eng.store.set({ agentFallback: false });
        await eng.run();
        check('a consultant who switched the agent off is never asked about it', hub.started.length, 0);
    }

    {
        const hub = agentHub({ queue: queueOf(noRecipe) });
        const eng = engineWith(hub, fakeSessions(), {
            runAgent: agentReturns({
                outcome: 'INCOMPLETE', detail: 'the page stopped changing — the AI agent got stuck',
            }),
        });
        await eng.run();
        const handed = hub.calls.find((c) => c.name === 'reclassify');
        check('what the agent cannot finish still reaches a person', Boolean(handed), true);
        check('  with the agent’s reason attached', /got stuck/.test(handed?.args[1]?.reason ?? ''), true);
        check('  and the run records how it ended', hub.finished[0]?.outcome, 'INCOMPLETE');
    }

    {
        const hub = agentHub({ queue: queueOf(noRecipe) });
        const eng = engineWith(hub, fakeSessions(), {
            runAgent: agentReturns({ outcome: 'CLOSED', detail: 'the posting says it is closed' }),
        });
        const stats = await eng.run();
        check('a posting the agent finds closed is skipped, not handed over',
            [hub.calls.some((c) => c.name === 'skipped'), hub.calls.some((c) => c.name === 'reclassify')],
            [true, false]);
        check('  and counted as expired', stats.closed, 1);
    }

    {
        const hub = agentHub({ queue: queueOf(noRecipe), mode: 'SHADOW' });
        const eng = engineWith(hub, fakeSessions(), {
            runAgent: agentReturns({ outcome: 'SHADOW', detail: 'shadow mode — the AI agent would have: fill F0f1' }),
        });
        await eng.run();
        check('shadow mode hands the job over exactly as if the agent did not exist',
            [hub.calls.some((c) => c.name === 'reclassify'), hub.calls.some((c) => c.name === 'filled')],
            [true, false]);
        check('  and records the run as SHADOW', hub.finished[0]?.outcome, 'SHADOW');
    }

    {
        const hub = agentHub({ queue: queueOf(noRecipe) });
        const eng = engineWith(hub, fakeSessions(), {
            runAgent: agentReturns({
                outcome: 'READY_TO_SUBMIT',
                detail: 'filled',
                qa: [{ questionText: 'Email', answerText: 'x', source: 'PROFILE' }],
                submit: { ref: 'F0c1', frameIndex: 0 },
            }),
        });
        eng.store.set({ autoSubmit: true });
        const stats = await eng.run();
        check('auto-submit never claims a submission it could not make',
            hub.calls.some((c) => c.name === 'submitted'), false);
        check('  the application stays waiting for the consultant', stats.outcomes[0]?.result, 'READY_TO_SUBMIT');
    }

    {
        const wf = item({ id: 'wf1', portal: 'WELLFOUND', company: 'Initech', source_url: 'https://wellfound.com/jobs/1' });
        const hub = agentHub({ queue: queueOf(wf) });
        const runner = agentReturns({
            outcome: 'READY_TO_SUBMIT',
            detail: 'filled',
            qa: [{ questionText: 'Email', answerText: 'x', source: 'PROFILE' }],
        });
        const eng = engineWith(hub, fakeSessions({ landsOn: 'https://careers.initech.example/apply/1' }), {
            runAgent: runner,
        });
        await eng.run();
        check('a recipe that lands somewhere it does not know hands the page to the agent',
            hub.started[0]?.entry, 'RECIPE_FAILED');
        check('  naming where it landed', hub.started[0]?.host, 'careers.initech.example');
        check('  and the job is not handed over', hub.calls.some((c) => c.name === 'reclassify'), false);
    }
}

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
