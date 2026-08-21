/**
 * ── APPLY FLOWS THAT ARE NOT A SINGLE FORM ────────────────────────────
 *
 * Some boards put the whole application on the job page. Others — LinkedIn's
 * Easy Apply is the one that forced this module — hide it behind a button and
 * then walk you through several steps:
 *
 *     [Easy Apply]  →  contact details  →  resume  →  screening questions
 *                   →  review  →  [Submit application]
 *
 * `fillForm` fills ONE form that is already on screen. This drives the parts
 * around it: press the button that reveals the form, fill each step, press Next,
 * and stop when the Submit button appears.
 *
 * ── THE SUBMIT BUTTON IS THE WALL ─────────────────────────────────────
 *
 * This module knows exactly where the Submit button is, and never clicks it.
 * Finding it is the signal to STOP — the application is complete and a person
 * takes it from here (R-02).
 *
 * Two independent guards, because one line of code is not enough to stand
 * between a machine and sending a job application in somebody's name:
 *
 *   1. `#isSubmit` refuses to click any control whose text or aria-label reads
 *      like a submission, whatever the recipe's `next` selector matched.
 *   2. The loop stops the moment the submit control is visible, before it can
 *      look for a Next button at all.
 *
 * A separate function, `pressSubmit`, does click it. It is not called from here
 * and never from the work loop — only from the consultant pressing the button
 * in the app, having read what was filled in.
 */
const { fillForm } = require('./filler.js');

/** Words that mean "this sends the application". Never clicked while filling. */
const SUBMIT_WORDS = /\b(submit|send application|apply now|finish|confirm and send)\b/i;

/** How long to let a step render before reading it. */
const STEP_SETTLE_MS = 1_800;

/** A wizard longer than this is not a wizard, it is a loop we misread. */
const MAX_STEPS = 12;

const textOf = async (locator) => {
    const [inner, aria] = await Promise.all([
        locator.innerText().catch(() => ''),
        locator.getAttribute('aria-label').catch(() => null),
    ]);
    return `${inner ?? ''} ${aria ?? ''}`.replace(/\s+/g, ' ').trim();
};

/** Would clicking this send the application? */
const isSubmit = async (locator) => SUBMIT_WORDS.test(await textOf(locator));

const visible = async (page, selector) => {
    if (!selector) return false;
    const l = page.locator(selector).first();
    if (await l.count() === 0) return false;
    return l.isVisible().catch(() => false);
};

/**
 * Work a board's apply flow as far as it can go without submitting.
 *
 * @returns {{
 *   outcome: 'READY_TO_SUBMIT'|'ALREADY_APPLIED'|'NO_APPLY_FLOW'|'LEFT_THE_BOARD'|'INCOMPLETE',
 *   qa, unknown, attachedResume, steps, detail
 * }}
 */
const runApplyFlow = async (page, board, fillOptions, { log = () => {} } = {}) => {
    const recipe = board.apply;
    if (!recipe) return { outcome: 'NO_APPLY_FLOW', detail: 'this board has no apply flow defined' };

    const empty = { qa: [], unknown: [], attachedResume: false, steps: 0 };

    // Applying twice under someone's name is worse than not applying. If the
    // board says it already has an application from this person, believe it.
    if (await visible(page, recipe.alreadyApplied)) {
        return { ...empty, outcome: 'ALREADY_APPLIED', detail: 'the board says you already applied' };
    }

    const opener = page.locator(recipe.open).first();
    if (await opener.count() === 0 || !(await opener.isVisible().catch(() => false))) {
        return {
            ...empty,
            outcome: 'NO_APPLY_FLOW',
            detail: 'no apply button on this page — applying happens elsewhere',
        };
    }

    // Refuse even here. A board that labels its opener "Apply now" and submits
    // immediately would otherwise be a one-click disaster.
    if (await isSubmit(opener)) {
        return {
            ...empty,
            outcome: 'NO_APPLY_FLOW',
            detail: 'the apply control looks like it submits directly — left for you',
        };
    }

    const before = new URL(page.url()).host;
    await opener.click();

    await page.waitForSelector(recipe.dialog, { timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(STEP_SETTLE_MS);

    // Some "apply" buttons are a redirect to the employer's own site.
    if (new URL(page.url()).host !== before) {
        return {
            ...empty,
            outcome: 'LEFT_THE_BOARD',
            detail: `applying continues on ${new URL(page.url()).host}`,
        };
    }

    if (await page.locator(recipe.dialog).count() === 0) {
        return { ...empty, outcome: 'NO_APPLY_FLOW', detail: 'the apply form never opened' };
    }

    const qa = [];
    const unknown = [];
    let attachedResume = false;
    let steps = 0;

    for (; steps < (recipe.maxSteps ?? MAX_STEPS); steps += 1) {
        const filled = await fillForm(page, { ...fillOptions, root: recipe.dialog });
        qa.push(...filled.qa);
        unknown.push(...filled.unknown);
        attachedResume = attachedResume || filled.attachedResume;

        // Guard 1: reaching the submit control means the form is complete.
        // Checked BEFORE looking for Next, so there is no step of the loop in
        // which both are candidates.
        if (await visible(page, recipe.submit)) {
            log(`${board.label}: reached the review step after ${steps + 1} step(s)`);
            return {
                outcome: 'READY_TO_SUBMIT',
                qa,
                unknown,
                attachedResume,
                steps: steps + 1,
                detail: 'filled and waiting for you to submit',
            };
        }

        // A required question with no approved answer stops the wizard: pressing
        // Next would either fail validation or, worse, silently skip it.
        const blocking = unknown.filter((u) => u.required);
        if (blocking.length > 0) {
            return {
                outcome: 'INCOMPLETE',
                qa,
                unknown,
                attachedResume,
                steps: steps + 1,
                detail: `${blocking.length} question(s) need an approved answer`,
            };
        }

        const next = page.locator(recipe.next).first();
        if (await next.count() === 0 || !(await next.isVisible().catch(() => false))) {
            return {
                outcome: 'INCOMPLETE',
                qa,
                unknown,
                attachedResume,
                steps: steps + 1,
                detail: 'no next step and no submit button — the flow is not what the recipe expects',
            };
        }

        // Guard 2: whatever the selector matched, do not click it if it reads
        // like a submission.
        if (await isSubmit(next)) {
            log(`${board.label}: the next control looks like submit — stopping`);
            return {
                outcome: 'READY_TO_SUBMIT',
                qa,
                unknown,
                attachedResume,
                steps: steps + 1,
                detail: 'filled and waiting for you to submit',
            };
        }

        await next.click();
        await page.waitForTimeout(STEP_SETTLE_MS);
    }

    return {
        outcome: 'INCOMPLETE',
        qa,
        unknown,
        attachedResume,
        steps,
        detail: `gave up after ${steps} steps`,
    };
};

/**
 * Press the board's submit button.
 *
 * ── THE ONE PLACE THIS IS ALLOWED ─────────────────────────────────────
 *
 * Called only when the consultant has read what was filled in and pressed
 * Submit in the app. Nothing in the work loop calls it; it is deliberately in
 * this file, next to the guards, so that anyone reading how submission is
 * prevented also sees the single door that is left open, and who opens it.
 *
 * It verifies the button is really there rather than assuming, because a flow
 * that has moved on underneath us must fail loudly instead of clicking whatever
 * now occupies that position.
 */
const pressSubmit = async (page, board) => {
    const recipe = board.apply;
    if (!recipe?.submit) {
        return { ok: false, error: 'This board has no submit control defined.' };
    }

    const button = page.locator(recipe.submit).first();
    if (await button.count() === 0 || !(await button.isVisible().catch(() => false))) {
        return {
            ok: false,
            error: 'The submit button is no longer on screen. The application may have '
                + 'timed out — open it and check before trying again.',
        };
    }

    await button.click();
    await page.waitForTimeout(2_500);

    const confirmed = recipe.submitted
        ? await visible(page, recipe.submitted)
        : await page.locator(recipe.submit).count() === 0;

    return {
        ok: true,
        confirmed,
        // Not the same claim. `ok` means the click happened; `confirmed` means
        // the board showed us something that says it landed. Reporting the
        // second when we only know the first is how a record starts lying.
        detail: confirmed
            ? 'the board confirmed the application'
            : 'submitted, but the board showed no confirmation — please check',
    };
};

module.exports = {
    runApplyFlow, pressSubmit, isSubmit, SUBMIT_WORDS, MAX_STEPS, STEP_SETTLE_MS,
};
