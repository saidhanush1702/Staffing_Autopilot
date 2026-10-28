/**
 * Phase 1 — a person's "done" releases the app, and a set of checkboxes is one question.
 *
 *   node tests/gates.mjs
 *
 * The two halves of the reported bug: pressing "I've done it" on a question did
 * nothing (the app re-checked a condition that could never come true and kept
 * counting), and the agent put forty checkbox questions in front of the person
 * where the form had asked one.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Attention } = require('../src/main/attention.js');
const { resolveBrowser } = require('../src/main/browser/engine.js');
const { observe } = require('../src/main/agent/observe.js');
const { executeAction } = require('../src/main/agent/actions.js');
const { buildAnswerBook } = require('../src/main/browser/answers.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* ── the button ──────────────────────────────────────────────────────── */

section('a question: "I\'ve done it" goes on at once');
{
    const published = [];
    // A slow poll on purpose: the press must not wait for the next tick.
    const a = new Attention({ pollMs: 5_000, publish: (x) => published.push(x) });
    const started = Date.now();
    const waiting = a.raise({
        kind: 'UNKNOWN_QUESTIONS', message: 'q', waitMs: 60_000,
        holdUntilDeadline: true, releaseOnContinue: true,
        // The check that used to trap it: it can never come true.
        check: async () => false,
    });
    setTimeout(() => a.continueNow(), 50);
    const out = await waiting;
    check('it ends as done', out, 'done');
    check('  within a moment, not at the next poll or the end of the clock', Date.now() - started < 1_500, true);
    check('  and the banner is taken down', published.at(-1), null);
}

section('a sign-in: the app looks once, and says what it sees');
{
    const published = [];
    const a = new Attention({ pollMs: 5_000, publish: (x) => published.push(x) });
    let looks = 0;
    const waiting = a.raise({
        kind: 'SIGN_IN', message: 'sign in', waitMs: 60_000,
        check: async () => { looks += 1; return false; },
        stillMessage: 'The page still looks signed out.',
    });
    // The initial look happens before the wait; then the person presses.
    setTimeout(() => a.continueNow(), 50);
    await sleep(400);
    const notice = published.filter(Boolean).at(-1)?.notice;
    check('pressing it with the gate still up does not end the wait', a.current !== null, true);
    check('  but the banner now says why', notice, 'The page still looks signed out.');
    check('  after looking once more', looks >= 2, true);
    a.forceNow();
    check('"Continue anyway" ends it', await waiting, 'done');
}

section('a sign-in that really is done');
{
    const a = new Attention({ pollMs: 5_000 });
    let signedIn = false;
    const waiting = a.raise({
        kind: 'SIGN_IN', message: 'sign in', waitMs: 60_000, check: async () => signedIn,
    });
    setTimeout(() => { signedIn = true; a.continueNow(); }, 50);
    check('pressing it once the gate is clear ends it', await waiting, 'done');
}

section('"do this one later" is answered at once too');
{
    const a = new Attention({ pollMs: 5_000 });
    const waiting = a.raise({ kind: 'BOT_CHECK', message: 'x', waitMs: 60_000, check: async () => false });
    setTimeout(() => a.skip(), 50);
    const t = Date.now();
    check('it ends as skipped', await waiting, 'skipped');
    check('  without waiting for the next tick', Date.now() - t < 1_500, true);
}

section('the buttons do nothing when nothing is waiting');
{
    const a = new Attention();
    check('continue, force and skip', [a.continueNow(), a.forceNow(), a.skip()], [false, false, false]);
}

/* ── the checkbox set ────────────────────────────────────────────────── */

const { chromium, launchOptions } = resolveBrowser();
const browser = await chromium.launch({ headless: true, ...launchOptions });
const open = async (html) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return page;
};

const lever = (star = '') => `
  <form id="application-form"><ul>
    <li><div class="application-label">Language skill(s) ${star}</div><div class="application-field"><ul>
      ${['English', 'Spanish', 'French', 'German', 'Hindi'].map((l) => `<li><label><input type="checkbox" name="cards[c][field0]" required>${l}</label></li>`).join('')}
    </ul></div></li>
    <li><label>Full name<input type="text" name="name"></label></li>
  </ul></form>`;

section('the agent sees a set of checkboxes as ONE question');
{
    const page = await open(lever());
    const { observation, registry } = await observe(page, { root: '#application-form' });
    const sets = observation.fields.filter((f) => f.type === 'checkboxes');
    check('one entry, not five', sets.length, 1);
    check('  with the question as its label', sets[0].label, 'Language skill(s)');
    check('  and the options', sets[0].options, ['English', 'Spanish', 'French', 'German', 'Hindi']);
    check('  not required, though every box says so', sets[0].required, undefined);
    check('the ordinary field beside it is untouched', observation.fields.some((f) => f.label === 'Full name'), true);
    check('the registry knows it is a multi-choice set', [...registry.values()].some((e) => e.kind === 'group' && e.multi), true);
}
{
    const page = await open(lever('✱'));
    const { observation } = await observe(page, { root: '#application-form' });
    check('required only when the question itself is marked', observation.fields.find((f) => f.type === 'checkboxes').required, true);
}

section('and can answer it with several options');
{
    const page = await open(lever());
    const { observation, registry } = await observe(page, { root: '#application-form' });
    const ref = observation.fields.find((f) => f.type === 'checkboxes').ref;
    const book = buildAnswerBook({
        profile: {},
        approvedAnswers: [{ question_text: 'Language skill(s)', answer_text: 'English, Hindi', question_id: 'a1' }],
    });
    const done = await executeAction(page, { action: 'fill', ref, source: 'answer:a1' }, {
        registry, errors: [], book, approvedAnswers: [{ question_id: 'a1', answer_text: 'English, Hindi' }],
        resumePath: null, attachedResume: false, filledCount: 0, typing: { minMs: 1, maxMs: 2, betweenFieldsMs: [1, 2] },
    });
    check('both are ticked', done.ok, true);
    const ticked = await page.$$eval('input[type=checkbox]:checked', (els) => els.map((e) => e.closest('label').innerText.trim()));
    check('  the right two', ticked, ['English', 'Hindi']);
    check('  and recorded as one answer', [done.qa?.fieldType, done.qa?.answerText], ['checkbox', 'English, Hindi']);

    const bad = await executeAction(page, { action: 'fill', ref, source: 'answer:a2' }, {
        registry, errors: [], book, approvedAnswers: [{ question_id: 'a2', answer_text: 'English, Klingon' }],
        resumePath: null, attachedResume: false, filledCount: 0, typing: { minMs: 1, maxMs: 2, betweenFieldsMs: [1, 2] },
    });
    check('an option that does not exist ticks nothing more and is refused', bad.ok, false);
}

section('asking the person about it');
{
    const page = await open(lever());
    const { observation, registry } = await observe(page, { root: '#application-form' });
    const ref = observation.fields.find((f) => f.type === 'checkboxes').ref;
    const asked = await executeAction(page, { action: 'ask_human', refs: [ref] }, {
        registry, errors: [], book: buildAnswerBook({ profile: {} }), approvedAnswers: [],
        resumePath: null, attachedResume: false, filledCount: 0, typing: {},
    });
    const u = asked.terminal.unknown;
    check('it is one question, with its options', [u.length, u[0].fieldType, u[0].options.length], [1, 'checkbox', 5]);
    check('  and does not block the form unless it is marked required', u[0].required, false);
}

section('a newsletter box is not the application');
{
    const { classifyPage } = require('../src/main/agent/pageKind.js');
    const stripe = `<main><h1>Head of Marketing, Japan</h1><a href="#apply" class="btn">Apply now</a></main>
      <footer><h3>Get industry insights and updates from Stripe</h3>
        <form><input type="email" aria-label="Enter work email" value="x@y.com"><button>Continue</button></form>
        <p>Receive marketing communication from Stripe. You can unsubscribe at any time.</p></footer>`;
    const page = await open(stripe);
    const { observation } = await observe(page);
    check('the footer sign-up box is not read as a field', observation.fields.length, 0);
    check('  so the page is a posting with an Apply control', classifyPage(observation), 'JOB_PAGE');

    const real = await open(`<main><h1>Apply</h1><form id="f">
      <label>Full name<input type="text" name="name"></label>
      <label>Email<input type="email" name="email"></label>
      <label>Phone<input type="text" name="phone"></label>
      <label>City<input type="text" name="city"></label>
      <p>You may unsubscribe from job alerts at any time.</p></form></main>`);
    const r = await observe(real);
    check('a real application that mentions unsubscribing keeps its fields', r.observation.fields.length, 4);

    const inline = await open('<main><h2>Quick apply</h2><label>Email<input type="email" name="email"></label><label>Name<input name="n"></label><button>Apply</button></main>');
    const i = await observe(inline);
    check('a small apply form in the main content is kept', i.observation.fields.length, 2);
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
