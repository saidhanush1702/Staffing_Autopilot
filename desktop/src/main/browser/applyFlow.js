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

/**
 * Words on a control that offers to take a file.
 *
 * Deliberately a pattern rather than a selector. One employer's Easy Apply says
 * "Upload resume"; the next says "Attach CV" or "Add resume". Pinning the exact
 * string of the flow that happened to be tested would make every other flow
 * look like it had no upload at all.
 */
const UPLOAD_WORDS = /\b(upload|attach|choose file|select file|add (a )?(resume|cv))\b/i;

/** A step that is asking for a CV, whatever it calls one. */
const RESUME_WORDS = /\b(resume|résumé|cv)\b/i;

/**
 * A posting that is shut.
 *
 * ── WHY THIS IS A SKIP AND NOT A HAND-OVER ────────────────────────────
 *
 * A closed job has no apply button, which used to make it indistinguishable
 * from a job that applies on the employer's site — so the app handed it to the
 * consultant, who opened it and found a red notice saying nobody can apply.
 * Doing that across a run fills somebody's list with work that cannot be done.
 *
 * The phrases are the boards' own, matched case-insensitively as whole
 * sentences, and only where the page shows them as its own status rather than
 * inside a description.
 */
const CLOSED_SELECTOR = 'text=/no longer accepting applications'
    + '|this job is no longer available'
    + '|applications are closed'
    + '|this position has been filled/i';

/**
 * An apply control that hands over to somebody else's site.
 *
 * Matched only AFTER the board's own in-page flow has failed to appear, so on a
 * job that offers both, Easy Apply always wins.
 */
const EXTERNAL_SELECTOR = 'button:has-text("Apply"), a:has-text("Apply")';

/** How long to let a step render before reading it. */
const STEP_SETTLE_MS = 1_800;

/** A wizard longer than this is not a wizard, it is a loop we misread. */
const MAX_STEPS = 12;

/**
 * How long to give a board to draw its apply button.
 *
 * Generous on purpose. The cost of waiting too long is one slow item; the cost
 * of not waiting long enough is declaring a job unapplyable when it was merely
 * still rendering, which is what happened across a whole run.
 */
const OPENER_TIMEOUT_MS = 15_000;

const textOf = async (locator) => {
    const [inner, aria] = await Promise.all([
        locator.innerText().catch(() => ''),
        locator.getAttribute('aria-label').catch(() => null),
    ]);
    return `${inner ?? ''} ${aria ?? ''}`.replace(/\s+/g, ' ').trim();
};

/**
 * Click something on a page that will not hold still.
 *
 * LinkedIn re-renders continuously — its UI is server-driven, and pieces of it
 * are replaced while you look at them. Playwright will not click an element it
 * cannot see stay put for two consecutive frames, so a button that is present,
 * visible and enabled still times out. It happened on the same button, on the
 * same job, that had clicked cleanly minutes earlier.
 *
 * ── WHY NOTHING HERE AIMS AT A POSITION ───────────────────────────────
 *
 * The first version of this measured the element's position and clicked that
 * point. It is an obvious idea and it is wrong: the only reason the fallback
 * runs is that things are MOVING, so the coordinates are stale the moment they
 * are read. In a live run it clicked twice into empty space and shut the
 * application flow — the "Dismiss" control sits a few pixels from the buttons
 * this needs to press.
 *
 * So every step below resolves the LOCATOR and acts on that element or on
 * nothing. Whatever else happens, none of them can press a different control
 * than the one they were asked for.
 */
const clickSteadily = async (locator, log = () => {}) => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});

    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await locator.click({ timeout: 8_000 });
            return;
        } catch {
            await locator.page().waitForTimeout(1_200);
        }
    }

    // ── SOMETHING IS SITTING ON TOP OF IT ─────────────────────────────
    //
    // LinkedIn raises a "Resume uploaded successfully" bar at the bottom of the
    // flow. In a small window it lands squarely over Next and Review, and
    // Playwright will not click a control another element would receive the
    // click for — so the run stopped there until somebody closed the bar by
    // hand.
    //
    // This only NAMES the obstruction; it does not touch it. Closing a message
    // means clicking an X, and on this flow there is another X a few pixels
    // away that abandons the whole application. Reading is safe, reaching is
    // not.
    const covering = await describeObstruction(locator);
    if (covering) log(`the "${covering}" message is covering this button`);

    // ── PRESS IT THE WAY A KEYBOARD USER WOULD ────────────────────────
    //
    // Focus then Enter activates the focused control and nothing else. Unlike a
    // click it does not travel through the page's layers, so an overlay cannot
    // intercept it — and unlike `force: true` it cannot land on whatever
    // happens to be in that spot. When the earlier fallback used coordinates it
    // pressed Dismiss twice and shut the application flow; this cannot, because
    // it never aims at a position at all.
    try {
        await locator.focus({ timeout: 4_000 });
        await locator.press('Enter', { timeout: 4_000 });
        return;
    } catch { /* not focusable — one option left */ }

    log('the page will not settle — clicking the control directly');
    // Last resort, and still aimed at the element itself.
    await locator.click({ force: true, timeout: 8_000 });
};

/**
 * What is covering this control, in its own words.
 *
 * Read-only on purpose: it hit-tests the button's centre and walks up from
 * whatever answers, so the log can say "the Resume uploaded successfully
 * message is covering this button" instead of "click timed out".
 *
 * @returns the obstruction's text, or null when nothing is in the way
 */
const describeObstruction = async (locator) => {
    if (typeof locator.evaluate !== 'function') return null;
    return locator.evaluate((target) => {
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const hit = document.elementFromPoint(
            rect.left + rect.width / 2, rect.top + rect.height / 2,
        );
        // An ancestor or a child of the button is not an obstruction.
        if (!hit || hit === target || target.contains(hit) || hit.contains(target)) return null;
        return (hit.closest('[role="alert"], [role="status"]') ?? hit)
            .innerText.replace(/\s+/g, ' ').trim().slice(0, 80) || 'something';
    }).catch(() => null);
};

/**
 * Attach the resume on a step that demands one.
 *
 * ── WHY THIS IS NOT JUST A FILE INPUT ─────────────────────────────────
 *
 * `fillForm` handles `input[type=file]`, which is enough for an ordinary form.
 * LinkedIn's resume step has no file input in the document at all — only a
 * button that opens the operating system's file chooser. So the filler found
 * nothing to attach, attached nothing, and the step correctly refused to
 * advance. From outside it looked like the form was broken.
 *
 * Two ways in, tried in that order:
 *
 *   1. A file input that exists but is hidden, ANYWHERE on the page. Some
 *      boards keep one outside the step's own container. Setting files on it
 *      directly is the least disruptive thing we can do.
 *   2. The upload button, with the file chooser intercepted. Playwright hands
 *      us the chooser instead of the OS showing a dialog nobody is there to
 *      answer.
 *
 * @returns true when a file was attached
 */
const attachResume = async (page, recipe, resumePath, log = () => {}) => {
    if (!resumePath) return false;

    const hidden = page.locator('input[type="file"]').first();
    if (await hidden.count() > 0) {
        await hidden.setInputFiles(resumePath);
        log('attached the resume to the form');
        return true;
    }

    // An explicit selector wins if a board needed one; otherwise find the
    // control by what it says, so an unfamiliar wording still works.
    const trigger = recipe.resumeUpload
        ? page.locator(recipe.resumeUpload).first()
        : await findByWords(page, recipe.dialog, UPLOAD_WORDS);
    if (!trigger || await trigger.count() === 0) return false;

    // The chooser has to be awaited alongside the click: it opens as a
    // consequence of the click, so listening afterwards is already too late.
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null),
        clickSteadily(trigger, log),
    ]);
    if (!chooser) {
        log('the upload button did not open a file chooser');
        return false;
    }

    await chooser.setFiles(resumePath);
    log('uploaded the resume');
    return true;
};

/** Would clicking this send the application? */
const isSubmit = async (locator) => SUBMIT_WORDS.test(await textOf(locator));

/**
 * A fingerprint of the step currently on screen.
 *
 * Progress text plus the fields being asked for. If this is unchanged after
 * pressing Next, the form did not advance — whatever the button appeared to do.
 */
const stepSignature = async (page, root) => {
    try {
        return await page.$$eval(`${root} input, ${root} select, ${root} textarea`,
            (nodes, container) => {
                const progress = (document.body.innerText.match(/\d+\s*\/\s*\d+\s*pages?/i) || [''])[0];
                const names = nodes
                    .map((n) => `${n.getAttribute('name') || n.id || n.type}`)
                    .join(',');
                return `${progress}|${names}|${container}`;
            }, root);
    } catch {
        return null;
    }
};

/** Anything the form is complaining about, in its own words. */
const validationText = async (page, root) => {
    try {
        return await page.$$eval(
            `${root} [role="alert"], ${root} [aria-invalid="true"], ${root} .artdeco-inline-feedback--error`,
            (nodes) => nodes.map((n) => (n.innerText || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean).slice(0, 3).join('; '),
        );
    } catch {
        return '';
    }
};

/**
 * The first button in `root` whose text or aria-label matches `words`.
 *
 * Reading the buttons and choosing one is what a person does; matching a CSS
 * class is what breaks the moment a different employer renders the same step.
 */
const findByWords = async (page, root, words) => {
    const buttons = page.locator(`${root} button`);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
        const b = buttons.nth(i);
        if (words.test(await textOf(b))) return b;
    }
    return null;
};

/** Is this step asking for a resume? */
const stepWantsResume = async (page, root) => {
    const text = await page.locator(root).innerText().catch(() => '');
    return RESUME_WORDS.test(text);
};

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
 *   outcome: 'READY_TO_SUBMIT'|'ALREADY_APPLIED'|'CLOSED'|'EXTERNAL_APPLY'
 *          |'NO_APPLY_FLOW'|'LEFT_THE_BOARD'|'INCOMPLETE',
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

    // Checked BEFORE the apply button, and deliberately so: a closed posting
    // has no button to wait for, and waiting fifteen seconds to discover that
    // is fifteen seconds spent per dead job.
    if (await visible(page, recipe.closed ?? CLOSED_SELECTOR)) {
        return {
            ...empty,
            outcome: 'CLOSED',
            detail: 'this posting is no longer accepting applications',
        };
    }

    // ── WAIT FOR THE BUTTON, DO NOT GLANCE FOR IT ─────────────────────
    //
    // LinkedIn draws its job page in stages: the description arrives first and
    // the apply button a few seconds later. Asking `count()` the moment the
    // page loads is asking before the answer exists, and it always answers
    // zero.
    //
    // That is not hypothetical — it declared "no apply button on this page" on
    // a run of real jobs, one second after opening each of them, including
    // several that plainly had Easy Apply. Every hand-run probe that saw the
    // button had waited five seconds or more first.
    //
    // So this waits for the control to appear and only calls it absent when it
    // has not shown up in time. A job that really has no apply button costs
    // this wait once; a job that has one no longer gets skipped for being slow.
    const opener = page.locator(recipe.open).first();
    const appeared = await page
        .waitForSelector(recipe.open, { state: 'visible', timeout: OPENER_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);

    if (!appeared) {
        // The board's own flow is not on offer. Is there an apply button that
        // simply leads somewhere else? Saying so is worth the extra look: the
        // consultant then knows this is a job to do by hand rather than one
        // the app failed at.
        const away = page.locator(recipe.externalApply ?? EXTERNAL_SELECTOR).first();
        if (await away.count() > 0 && await away.isVisible().catch(() => false)) {
            return {
                ...empty,
                outcome: 'EXTERNAL_APPLY',
                detail: 'this job applies on the employer’s own site, so it needs you',
            };
        }
        return {
            ...empty,
            outcome: 'NO_APPLY_FLOW',
            detail: 'no apply button appeared on this page — applying happens elsewhere',
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
    await clickSteadily(opener, log);

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

        // A step that asks for a resume and offers no file input to put it in.
        if (!attachedResume && await stepWantsResume(page, recipe.dialog)) {
            attachedResume = await attachResume(
                page, recipe, fillOptions.resumePath, log,
            );
            if (attachedResume) {
                qa.push({
                    questionText: 'Resume',
                    answerText: '[resume uploaded]',
                    fieldType: 'file',
                    source: 'RESUME',
                    questionId: null,
                });
                await page.waitForTimeout(STEP_SETTLE_MS);
            } else {
                // Required, and we have nothing to give it.
                return {
                    outcome: 'INCOMPLETE',
                    qa,
                    unknown,
                    attachedResume,
                    steps: steps + 1,
                    detail: 'this application needs a resume and none could be attached',
                };
            }
        }

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

        // ── DID IT ACTUALLY MOVE? ─────────────────────────────────
        //
        // A form that rejects something usually refuses to advance and says so
        // quietly, next to the offending field. The button still looks pressed.
        //
        // Without this check the loop pressed Next eight times on the same page
        // and reported "gave up after 8 steps", which describes the symptom and
        // hides the cause. Worse, hammering one button is exactly the behaviour
        // a board watches for.
        const before = await stepSignature(page, recipe.dialog);
        await clickSteadily(next, log);
        await page.waitForTimeout(STEP_SETTLE_MS);
        const after = await stepSignature(page, recipe.dialog);

        if (before && after && before === after) {
            const complaint = await validationText(page, recipe.dialog);
            return {
                outcome: 'INCOMPLETE',
                qa,
                unknown,
                attachedResume,
                steps: steps + 1,
                detail: complaint
                    ? `the form would not accept this page: ${complaint}`
                    : 'the form would not move past this page — something on it was '
                      + 'rejected, so it needs a person',
            };
        }
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

    await clickSteadily(button);
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
    runApplyFlow, pressSubmit, isSubmit, attachResume,
    SUBMIT_WORDS, UPLOAD_WORDS, RESUME_WORDS, MAX_STEPS, STEP_SETTLE_MS,
    clickSteadily, describeObstruction,
    CLOSED_SELECTOR, EXTERNAL_SELECTOR,
};
