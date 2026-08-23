/**
 * ── WALK A REAL LINKEDIN APPLICATION, WITHOUT SENDING IT ──────────────
 *
 *     npm run try:linkedin                    every link in linkedin-jobs.mjs
 *     npm run try:linkedin -- <url>           just this one
 *
 * A developer's harness for the automation as it stands. It drives the SAME
 * modules the desktop app drives — the board recipe, the filler, the résumé
 * step, the click strategy — against real job pages, and prints the same
 * running commentary the app's Activity tab shows.
 *
 * ── WHY IT STUBS EVERY ANSWER ─────────────────────────────────────────
 *
 * The app is careful about answers: anything it has not been told, it refuses
 * to invent, and the application parks until a person answers it. That is
 * correct, and it means a real run stops on the first screening question and
 * never exercises the four steps behind it.
 *
 * So this fills the leftovers with "1" and ticks whichever option comes first.
 * The values are deliberately meaningless — the question being asked here is
 * "does the automation get through this form", not "is the answer right". What
 * it does with a real answer bank is the app's job and run.mjs's job; what it
 * does with five steps of a real employer's Easy Apply is this file's.
 *
 * The two are kept visibly apart in the output. Every step reports how many
 * fields the REAL filler answered and how many this had to stub — so a step
 * that reads "filler 0 · stubbed 6" is telling you the production path did
 * nothing there, which is usually the bug you came looking for.
 *
 * ── IT CANNOT SUBMIT ──────────────────────────────────────────────────
 *
 * There is no call to `pressSubmit` in this file and no click on any control
 * that reads like a submission — `isSubmit`, the app's own guard, is asked
 * before every button press. Reaching Submit is the finish line, not a step.
 *
 * ── WHAT IT NEEDS ─────────────────────────────────────────────────────
 *
 * A LinkedIn session in the desktop app's own browser profile, and the desktop
 * app CLOSED — one Chromium profile cannot be open twice. If you are not signed
 * in, it opens the login page and waits for you.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const { BOARDS } = require('../src/main/browser/boards.js');
const { BrowserSessions } = require('../src/main/browser/session.js');
const { resolveBrowser } = require('../src/main/browser/engine.js');
const { describeFields, fillForm, checkControl } = require('../src/main/browser/filler.js');
const {
    isSubmit, attachResume, clickSteadily, describeObstruction,
    CLOSED_SELECTOR, EXTERNAL_SELECTOR, STEP_SETTLE_MS,
} = require('../src/main/browser/applyFlow.js');

const BOARD = BOARDS.LINKEDIN;
const RECIPE = BOARD.apply;

/* ── the commentary ───────────────────────────────────────────────────── */

const COLOUR = {
    CONNECTING: '\x1b[36m',
    WORKING: '\x1b[36m',
    FILLING: '\x1b[35m',
    STUBBED: '\x1b[33m',
    READY_TO_SUBMIT: '\x1b[32m',
    HANDED_OVER: '\x1b[90m',
    CLOSED: '\x1b[90m',
    ALREADY_APPLIED: '\x1b[90m',
    PARKED: '\x1b[33m',
    ERROR: '\x1b[31m',
    SIGNED_OUT: '\x1b[33m',
    SIGNED_IN: '\x1b[32m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

/** One line, in the shape the app's Activity tab uses. */
const say = (state, message) => {
    const at = new Date().toLocaleTimeString();
    const tint = COLOUR[state] ?? '';
    console.log(`${DIM}${at}${RESET}  ${tint}${state.padEnd(16)}${RESET}${message}`);
};
const rule = (title) => console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);

/* ── the stub values ──────────────────────────────────────────────────── */

/**
 * What to put in a field nobody answered.
 *
 * Chosen for FORMAT, not for meaning. An email box rejects "1" outright and the
 * step will not advance, which would look like an automation failure when it is
 * only a validation one — so each type gets something shaped the way that type
 * expects, and nothing more thoughtful than that.
 */
const STUB = {
    email: 'test@example.com',
    tel: '1111111111',
    url: 'https://example.com',
    number: '1',
    date: '2026-01-01',
};
const stubFor = (field) => STUB[field.type] ?? '1';

/* ── walking one job ──────────────────────────────────────────────────── */

const visible = async (page, selector) => {
    if (!selector) return false;
    const l = page.locator(selector).first();
    if (await l.count() === 0) return false;
    return l.isVisible().catch(() => false);
};

/**
 * Fill whatever the real filler left behind.
 *
 * Runs AFTER `fillForm`, over the same descriptors, and touches only what is
 * still empty. Uses the app's own `checkControl`, so a LinkedIn radio — a 0×0
 * transparent input behind a styled proxy — is ticked through exactly the code
 * path the app uses, and a regression there shows up here.
 *
 * @returns the questions it had to make something up for
 */
const stubTheRest = async (page, root) => {
    const fields = await describeFields(page, root);
    const locators = page.locator(
        `${root} input, ${root} textarea, ${root} select`,
    );
    const stubbed = [];
    const done = new Set();

    for (const f of fields) {
        if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password'].includes(f.type)) {
            continue;
        }
        if (f.disabled || !f.visible) continue;

        const label = f.groupLabel || f.label || `(unnamed ${f.type})`;

        if (f.type === 'radio' || f.type === 'checkbox') {
            const key = f.groupKey || f.name || `solo-${f.index}`;
            if (done.has(key)) continue;
            done.add(key);

            const group = fields.filter(
                (s) => s.type === f.type && (s.groupKey || s.name || `solo-${s.index}`) === key,
            );
            if (group.some((s) => s.hasValue)) continue;

            // "Select any" — the first one. Which option is picked is not what
            // this harness is testing.
            const pick = group[0];
            await checkControl(locators.nth(pick.index), pick);
            stubbed.push(`${label} → ${pick.label || 'first option'}`);
            continue;
        }

        if (f.hasValue) continue;

        if (f.tag === 'select') {
            const choice = f.options.find((o) => o && !/^(select|choose|--)/i.test(o));
            if (!choice) continue;
            await locators.nth(f.index).selectOption({ label: choice }).catch(() => {});
            stubbed.push(`${label} → ${choice}`);
            continue;
        }

        const value = stubFor(f);
        const control = locators.nth(f.index);
        await control.fill(value).catch(() => {});

        // A combobox holds nothing until an option is CHOSEN, so a typed value
        // alone leaves the step unable to advance. Take whatever it offers.
        const listed = page.locator('[role="listbox"] [role="option"]').first();
        if (await listed.count().catch(() => 0) > 0) {
            await listed.click().catch(() => {});
            await page.waitForTimeout(500);
        }
        stubbed.push(`${label} → ${value}`);
    }

    return stubbed;
};

/** The step's own words, so the terminal shows what is on screen. */
const stepHeading = async (page, root) => {
    const text = await page.locator(root).innerText().catch(() => '');
    const progress = (text.match(/\d+\s*\/\s*\d+\s*pages?/i) ?? [''])[0];
    const heading = text.split('\n').map((l) => l.trim())
        .filter((l) => l && !/\d+\s*\/\s*\d+\s*pages?/i.test(l))[0] ?? '';
    return [progress, heading].filter(Boolean).join(' · ');
};

const tryOne = async (sessions, url, { resumePath }) => {
    rule(url);

    const page = await sessions.openJob(BOARD.name, url);
    say('CONNECTING', 'opened the job page');
    await page.waitForTimeout(2_000);

    // The same three questions the app asks, in the same order, before it
    // decides this job is workable at all.
    if (await visible(page, RECIPE.alreadyApplied)) {
        say('ALREADY_APPLIED', 'the board says this account already applied');
        return 'ALREADY_APPLIED';
    }
    if (await visible(page, CLOSED_SELECTOR)) {
        say('CLOSED', 'this posting is no longer accepting applications');
        return 'CLOSED';
    }

    const appeared = await page
        .waitForSelector(RECIPE.open, { state: 'visible', timeout: 15_000 })
        .then(() => true).catch(() => false);

    if (!appeared) {
        const away = page.locator(EXTERNAL_SELECTOR).first();
        if (await away.count() > 0 && await away.isVisible().catch(() => false)) {
            say('HANDED_OVER', 'applies on the employer’s own site — a person’s job');
            return 'EXTERNAL_APPLY';
        }
        say('HANDED_OVER', 'no apply button on this page');
        return 'NO_APPLY_FLOW';
    }

    say('WORKING', 'pressing Easy Apply');
    await clickSteadily(page.locator(RECIPE.open).first(), (m) => say('WORKING', m));
    await page.waitForSelector(RECIPE.dialog, { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(STEP_SETTLE_MS);

    if (await page.locator(RECIPE.dialog).count() === 0) {
        say('ERROR', 'the apply form never opened');
        return 'NO_APPLY_FLOW';
    }

    let realAnswers = 0;
    let stubbedTotal = 0;
    let attached = false;

    for (let step = 1; step <= (RECIPE.maxSteps ?? 8); step += 1) {
        const heading = await stepHeading(page, RECIPE.dialog);
        say('FILLING', `step ${step}${heading ? ` — ${heading}` : ''}`);

        // ── THE PRODUCTION FILLER GOES FIRST ──────────────────────────
        //
        // With an empty answer bank, so whatever it fills came from the
        // profile-field rules or from the portal's own pre-filled values. What
        // it leaves is exactly what a real consultant would be asked.
        const filled = await fillForm(page, {
            profile: {}, approvedAnswers: [], resumePath: null, root: RECIPE.dialog,
        });
        realAnswers += filled.qa.length;
        for (const q of filled.qa) {
            console.log(`${DIM}                    filler │ ${q.questionText} → ${q.answerText}${RESET}`);
        }
        for (const r of filled.refusals) {
            say('ERROR', `refused: ${r.label} — ${r.reason}`);
        }

        // The résumé step, through the app's own upload path.
        if (!attached && /\b(resume|résumé|cv)\b/i.test(
            await page.locator(RECIPE.dialog).innerText().catch(() => ''),
        )) {
            attached = await attachResume(page, RECIPE, resumePath, (m) => say('FILLING', m));
            if (attached) await page.waitForTimeout(STEP_SETTLE_MS);
        }

        const stubbed = await stubTheRest(page, RECIPE.dialog);
        stubbedTotal += stubbed.length;
        for (const s of stubbed) {
            console.log(`${COLOUR.STUBBED}                    stub   │ ${s}${RESET}`);
        }
        say('FILLING', `filler ${filled.qa.length} · stubbed ${stubbed.length}`);

        // ── THE FINISH LINE ───────────────────────────────────────────
        if (await visible(page, RECIPE.submit)) {
            say('READY_TO_SUBMIT', `reached Submit after ${step} step(s) — NOT pressing it`);
            return 'READY_TO_SUBMIT';
        }

        const next = page.locator(RECIPE.next).first();
        if (await next.count() === 0 || !(await next.isVisible().catch(() => false))) {
            say('ERROR', 'no Next and no Submit — the flow is not what the recipe expects');
            return 'STUCK';
        }

        // The app's own guard, asked again here. Nothing that reads like a
        // submission is ever clicked by this file.
        if (await isSubmit(next)) {
            say('READY_TO_SUBMIT', `the next control is Submit — stopping after ${step} step(s)`);
            return 'READY_TO_SUBMIT';
        }

        const before = await page.locator(RECIPE.dialog).innerText().catch(() => '');
        const covering = await describeObstruction(next);
        if (covering) say('STUBBED', `"${covering}" is covering the button`);

        await clickSteadily(next, (m) => say('WORKING', m));
        await page.waitForTimeout(STEP_SETTLE_MS);
        const after = await page.locator(RECIPE.dialog).innerText().catch(() => '');

        if (before === after) {
            const complaint = after.split('\n').map((l) => l.trim())
                .filter((l) => /required|invalid|must|please/i.test(l)).slice(0, 3).join('; ');
            say('PARKED', complaint
                ? `the form would not move on: ${complaint}`
                : 'the form would not move past this step');
            return 'STUCK';
        }
    }

    say('ERROR', `gave up after ${RECIPE.maxSteps} steps · filler ${realAnswers} · stubbed ${stubbedTotal}`);
    return 'STUCK';
};

/* ── signing in ───────────────────────────────────────────────────────── */

const ensureSignedIn = async (sessions) => {
    if (await sessions.isSignedIn(BOARD)) {
        say('SIGNED_IN', 'LinkedIn session is live');
        return true;
    }

    say('SIGNED_OUT', 'not signed in — opening the login page, sign in and leave it open');
    await sessions.promptSignIn(BOARD);

    for (let waited = 0; waited < 300; waited += 5) {
        await new Promise((r) => { setTimeout(r, 5_000); });
        if (await sessions.isSignedInNow(BOARD)) {
            say('SIGNED_IN', 'signed in — carrying on');
            return true;
        }
    }
    say('ERROR', 'still not signed in after five minutes');
    return false;
};

/* ── the run ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? true);
};
const keepOpen = argv.includes('--keep-open');
const resumePath = flag('--resume');

const fromFile = (await import('./linkedin-jobs.mjs')).default ?? [];
const fromArgs = argv.filter((a) => a.startsWith('http'));
const links = (fromArgs.length > 0 ? fromArgs : fromFile)
    .map((l) => String(l).trim())
    .filter((l) => l && !l.startsWith('//'));

if (links.length === 0) {
    console.log('No job links. Add some to tools/linkedin-jobs.mjs, or pass one:\n'
        + '  npm run try:linkedin -- https://www.linkedin.com/jobs/view/1234567890');
    process.exit(1);
}

// `--any-host` points the same walk at a local page instead of LinkedIn, which
// is how the harness itself gets tested without filling a real employer's form.
// Off by default: pasting a Wellfound link in by mistake should say so now
// rather than fail eight steps later against a recipe meant for another board.
const anyHost = argv.includes('--any-host');
const notLinkedIn = anyHost
    ? []
    : links.filter((l) => !/(^|[.])linkedin[.]com$/i.test(new URL(l).host));
if (notLinkedIn.length > 0) {
    console.log('This harness drives the LinkedIn recipe. These are not LinkedIn links:');
    for (const l of notLinkedIn) console.log(`  ${l}`);
    console.log('Pass --any-host to run them anyway (for local test pages).');
    process.exit(1);
}

// The desktop app's own profile, so its LinkedIn sign-in is the one used. Two
// processes cannot share a Chromium profile, which is why the app has to be
// closed — the failure otherwise is a lock error with no explanation in it.
const userData = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), '.config'),
    'smartapply-desktop',
);
const engine = resolveBrowser();
const sessions = new BrowserSessions({
    chromium: engine.chromium,
    profilesDir: path.join(userData, 'profiles'),
    launchOptions: engine.launchOptions,
});

console.log(`\nSmartApply · LinkedIn apply-flow harness`);
console.log(`${DIM}browser: ${engine.source} · profile: ${path.join(userData, 'profiles', 'linkedin')}${RESET}`);
console.log(`${DIM}${links.length} job(s) · nothing will be submitted${RESET}`);
if (resumePath) console.log(`${DIM}résumé: ${resumePath}${RESET}`);

const results = [];
try {
    // A local page has no session to check, and asking LinkedIn about one
    // would be a live request this does not need.
    if (!anyHost && !(await ensureSignedIn(sessions))) process.exit(1);

    for (const url of links) {
        try {
            results.push([url, await tryOne(sessions, url, { resumePath })]);
        } catch (err) {
            say('ERROR', String(err.message).split('\n')[0]);
            results.push([url, 'ERROR']);
        }
    }
} catch (err) {
    if (/ProcessSingleton|SingletonLock|profile.*in use/i.test(err.message)) {
        console.log('\nThat profile is already open. Close the SmartApply desktop app and try again.');
    } else {
        console.log(`\n${err.message}`);
    }
    process.exit(1);
} finally {
    rule('summary');
    for (const [url, outcome] of results) {
        const tint = COLOUR[outcome] ?? '';
        console.log(`  ${tint}${String(outcome).padEnd(18)}${RESET}${url}`);
    }
    console.log(`\n${DIM}Nothing was submitted.${RESET}`);

    if (keepOpen) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await new Promise((r) => rl.question('\nBrowser left open. Press Enter to close… ', r));
        rl.close();
    }
    await sessions.closeAll();
}
