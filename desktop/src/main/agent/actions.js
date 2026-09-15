/**
 * ── WHAT THE AGENT'S HANDS WILL AND WILL NOT DO ───────────────────────
 *
 * The hub has already checked that a reply is well-formed and that its source
 * is in the catalogue. That is not trusted here. Every action is checked AGAIN,
 * against the page as it is now and the answers this machine actually holds,
 * and refused with a reason the model reads on its next turn.
 *
 * The rules live in code, not in the prompt. A prompt is advice to a model; an
 * `if` is a wall. Everything below that matters would still hold if the model
 * ignored every instruction it was given.
 *
 * ── THE WALLS ─────────────────────────────────────────────────────────
 *
 *   · Nothing is typed that is not a profile value or an approved answer.
 *   · A field that already holds something is left alone.
 *   · A password field is never filled (R-18).
 *   · A control that submits, withdraws, deletes or signs out is never pressed.
 *     "Apply" is allowed only before anything has been filled — on a job page
 *     it OPENS the form; once answers are in, it is how some forms SEND.
 *   · "ready" is believed only when the page agrees: every visible required
 *     field holds a value, nothing shows an error, and the control named really
 *     reads like a submit button.
 */
const { fillValue } = require('../browser/filler.js');
const {
    SUBMIT_WORDS, clickSteadily, dismissUploadToast, textOf, STEP_SETTLE_MS,
} = require('../browser/applyFlow.js');
const { locate, pageLikeFor } = require('./observe.js');

/** Never pressed, whatever stage the application is at. */
const HARD_SUBMIT = /\b(submit|send( my)? application|confirm and send|finish( application)?|complete (my )?application)\b/i;

/** Never pressed at all. */
const FORBIDDEN = /\b(sign ?out|log ?out|withdraw|delete|remove (my )?(account|application|profile)|unsubscribe|deactivate)\b/i;

/** What the final button of an application says. */
const SUBMIT_LIKE = /\b(submit|send|apply|finish|complete)\b/i;

/** What a page says once an application has landed. */
const SUBMITTED_TEXT = 'text=/thank you for (applying|your application)|application (has been |was )?(submitted|received|sent)|we(\'ve| have) received your application/i';

/**
 * The words behind a source, from THIS machine's answer book.
 *
 * @returns {{ value, source, questionId }|null}
 */
const resolveSource = (source, { book, approvedAnswers }) => {
    const [kind, key] = String(source ?? '').split(/:(.*)/s);
    if (kind === 'profile') {
        const value = book?.values?.[key];
        return value ? { value: String(value), source: 'PROFILE', questionId: null } : null;
    }
    if (kind === 'answer') {
        const a = (approvedAnswers ?? []).find((x) => x.question_id === key);
        return a?.answer_text
            ? { value: String(a.answer_text), source: 'ANSWER', questionId: a.question_id }
            : null;
    }
    return null;
};

const hasValue = (entry) => (entry.kind === 'group'
    ? entry.members.some((m) => m.field.hasValue)
    : Boolean(entry.field?.hasValue));

const labelOf = (entry) => String(
    entry.kind === 'group'
        ? (entry.field.groupLabel || entry.field.label)
        : (entry.field?.label || entry.text || ''),
).replace(/[\s*]+$/, '').trim();

const settle = async (page) => {
    await page.waitForLoadState?.('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(STEP_SETTLE_MS);
};

/**
 * Press a control, following it if it opens a new tab.
 *
 * Career sites open "Apply" in a new window as often as not. The agent drives
 * one page per session, so the new window's address is brought back into this
 * one and the stray window closed.
 */
const pressAndFollow = async (page, locator, log) => {
    const context = typeof page.context === 'function' ? page.context() : null;
    // A new window opens as the click lands, so a short listen is enough —
    // and this wait is paid on every press, new window or not.
    const popup = context
        ? context.waitForEvent('page', { timeout: 1_500 }).catch(() => null)
        : Promise.resolve(null);

    await clickSteadily(locator, log);
    const opened = await popup;
    if (opened) {
        await opened.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        const url = opened.url();
        await opened.close().catch(() => {});
        if (/^https?:/i.test(url)) {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
        }
    }
    await settle(page);
};

/**
 * Is this page really ready for someone to press submit?
 *
 * @returns null when it is, or the reason it is not
 */
const notReadyBecause = async (page, action, ctx) => {
    const target = ctx.registry.get(action.ref);
    if (!target || target.kind !== 'control') {
        return `${action.ref} is not a button on this page`;
    }
    const locator = await locate(page, target.frameIndex, action.ref);
    if (!locator || !(await locator.isVisible().catch(() => false))) {
        return 'that button is no longer on screen';
    }
    const text = await textOf(locator);
    if (!SUBMIT_LIKE.test(text)) {
        return `"${text.slice(0, 60)}" does not look like the button that sends the application`;
    }

    const missing = [];
    for (const entry of ctx.registry.values()) {
        if (entry.kind !== 'field' && entry.kind !== 'group') continue;
        const f = entry.field;
        const required = entry.kind === 'group'
            ? entry.members.some((m) => m.field.required)
            : f.required;
        if (!required) continue;
        if (f.type === 'file') {
            if (!ctx.attachedResume && !f.hasValue) missing.push(labelOf(entry) || 'resume');
            continue;
        }
        if (!hasValue(entry)) missing.push(labelOf(entry) || entry.ref);
    }
    if (missing.length > 0) {
        return `required fields are still empty: ${missing.slice(0, 6).join('; ')}`;
    }
    if ((ctx.errors ?? []).length > 0) {
        return `the page is showing errors: ${ctx.errors.slice(0, 3).join('; ')}`;
    }
    return null;
};

/**
 * Carry out one action.
 *
 * @param ctx {
 *   registry, errors, book, approvedAnswers, resumePath, attachedResume,
 *   filledCount, typing, log, waitForHuman(page, message) → boolean
 * }
 * @returns
 *   { ok: true, result, qa?, attachedResume? }   done; carry on
 *   { ok: false, error }                         refused; tell the model why
 *   { terminal: {...} }                          the run ends here
 */
const executeAction = async (page, action, ctx) => {
    const log = ctx.log ?? (() => {});
    const refuse = (error) => ({ ok: false, error });
    const target = action.ref ? ctx.registry.get(action.ref) : null;

    switch (action.action) {
    case 'fill': {
        if (!target) return refuse(`there is no field ${action.ref} on this page — read the page again`);
        if (target.kind === 'control') return refuse(`${action.ref} is a button, not a field; use press`);

        const f = target.field;
        if (f.type === 'password') return refuse('password fields are never filled');
        if (f.type === 'file') return refuse('that field takes a file; use upload_resume');
        if (hasValue(target)) return refuse(`"${labelOf(target)}" already has a value, so it is left alone`);

        const resolved = resolveSource(action.source, ctx);
        if (!resolved) return refuse(`${action.source} is not something this consultant has`);

        let filled;
        if (target.kind === 'group') {
            const members = [];
            for (const m of target.members) {
                const l = await locate(page, target.frameIndex, m.ref);
                if (l) members.push({ locator: l, field: m.field });
            }
            if (members.length === 0) return refuse('those options are no longer on the page');
            filled = await fillValue(pageLikeFor(page, target.frameIndex), { members }, resolved.value, {
                typing: ctx.typing,
            });
        } else {
            const locator = await locate(page, target.frameIndex, action.ref);
            if (!locator) return refuse('that field is no longer on the page');
            filled = await fillValue(pageLikeFor(page, target.frameIndex), { locator, field: f }, resolved.value, {
                typing: ctx.typing, stateHint: ctx.book?.values?.state ?? null,
            });
        }
        if (!filled.ok) return refuse(filled.error);

        return {
            ok: true,
            result: `filled "${labelOf(target).slice(0, 60)}"`,
            qa: {
                questionText: labelOf(target),
                answerText: filled.answerText,
                fieldType: target.kind === 'group' ? 'radio' : f.type,
                source: resolved.source,
                questionId: resolved.questionId,
                // The recipe matched this question to its answer word for
                // word; the agent matched it by meaning. The review screen
                // says which, so a consultant knows what to read closely.
                matchedBy: 'AGENT',
            },
        };
    }

    case 'upload_resume': {
        if (!ctx.resumePath) return refuse('there is no resume to upload for this job');
        if (!target) return refuse(`there is no element ${action.ref} on this page`);
        const locator = await locate(page, target.frameIndex, action.ref);
        if (!locator) return refuse('that element is no longer on the page');

        if (target.kind === 'field' && target.field.type === 'file') {
            await locator.setInputFiles(ctx.resumePath);
        } else if (target.kind === 'control') {
            const [chooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 15_000 }).catch(() => null),
                clickSteadily(locator, log),
            ]);
            if (!chooser) return refuse('that button did not open a file chooser');
            await chooser.setFiles(ctx.resumePath);
        } else {
            return refuse('that is not a file field or an upload button');
        }

        await page.waitForTimeout(1_200);
        await dismissUploadToast(page, log);
        return {
            ok: true,
            result: 'uploaded the resume',
            attachedResume: true,
            qa: {
                questionText: labelOf(target) || 'Resume',
                answerText: '[resume attached]',
                fieldType: 'file',
                source: 'RESUME',
                questionId: null,
                matchedBy: 'AGENT',
            },
        };
    }

    case 'press': {
        if (!target) return refuse(`there is no control ${action.ref} on this page — read the page again`);
        if (target.kind !== 'control') return refuse(`${action.ref} is a field; use fill`);

        const locator = await locate(page, target.frameIndex, action.ref);
        if (!locator) return refuse('that control is no longer on the page');
        if (await locator.isDisabled().catch(() => false)) return refuse('that control is disabled');

        const text = await textOf(locator);
        if (FORBIDDEN.test(text)) return refuse(`"${text.slice(0, 50)}" is never pressed`);
        if (HARD_SUBMIT.test(text)) {
            return refuse(`"${text.slice(0, 50)}" sends the application — answer ready instead once the form is complete`);
        }
        // "Apply now" opens a form on a job page and SENDS one on some
        // application pages. Which one it is depends on whether anything has
        // been filled in yet.
        if (SUBMIT_WORDS.test(text) && ctx.filledCount > 0) {
            return refuse(`"${text.slice(0, 50)}" could send the application now that answers are filled — answer ready if the form is complete`);
        }

        const href = await locator.getAttribute('href').catch(() => null);
        if (href && /^\s*(javascript|mailto|tel|data):/i.test(href)) {
            return refuse('that link does not lead to a page');
        }

        const before = page.url();
        await pressAndFollow(page, locator, log);
        const moved = page.url() !== before;
        return { ok: true, result: `pressed "${text.slice(0, 60)}"${moved ? ' — a new page opened' : ''}` };
    }

    case 'ask_human': {
        const unknown = [];
        for (const ref of action.refs ?? []) {
            const entry = ctx.registry.get(ref);
            if (!entry || entry.kind === 'control') continue;
            const f = entry.field;
            unknown.push({
                questionText: labelOf(entry),
                fieldType: entry.kind === 'group' ? 'radio' : f.type,
                required: entry.kind === 'group' ? entry.members.some((m) => m.field.required) || true : true,
                options: entry.kind === 'group'
                    ? entry.members.map((m) => m.field.label).filter(Boolean)
                    : (f.options ?? []),
            });
        }
        if (unknown.length === 0) return refuse('none of those refs is a field on this page');
        return {
            terminal: {
                outcome: 'INCOMPLETE',
                unknown,
                detail: `${unknown.length} question(s) need your answer`,
            },
        };
    }

    case 'needs_sign_in': {
        const signedIn = ctx.waitForHuman
            ? await ctx.waitForHuman(page, 'This site wants you to sign in or create an account. '
                + 'Do that in the browser window and the AI agent carries on.')
            : false;
        if (signedIn) {
            await settle(page);
            return { ok: true, result: 'the consultant signed in — carry on with the application' };
        }
        return {
            terminal: {
                outcome: 'ACCOUNT_WALL',
                detail: 'this site needs you to sign in or create an account first',
            },
        };
    }

    case 'ready': {
        const why = await notReadyBecause(page, action, ctx);
        if (why) return refuse(`not ready: ${why}`);
        const text = await textOf(await locate(page, target.frameIndex, action.ref));
        return {
            terminal: {
                outcome: 'READY_TO_SUBMIT',
                detail: 'filled by the AI agent and waiting for you to submit',
                submit: { ref: action.ref, frameIndex: target.frameIndex, text: text.slice(0, 80) },
            },
        };
    }

    case 'stop': {
        const map = {
            closed: ['CLOSED', 'the posting says it is no longer accepting applications'],
            already_applied: ['ALREADY_APPLIED', 'the site says you have already applied'],
            not_a_job_form: ['NO_APPLY_FLOW', 'the AI agent could not find an application to fill on this site'],
            blocked: ['BLOCKED', 'the AI agent could not get past this page'],
        };
        const [outcome, detail] = map[action.kind] ?? map.blocked;
        return {
            terminal: {
                outcome,
                detail: action.reason ? `${detail} (${action.reason.slice(0, 160)})` : detail,
            },
        };
    }

    default:
        return refuse(`"${action.action}" is not something the app can do`);
    }
};

/**
 * Press the submit button the agent identified.
 *
 * Called only by the work loop when the consultant chose to submit
 * automatically, or by the review screen when they pressed Submit. Checks the
 * button is still there and still reads like a submit button, because a page
 * that has moved on underneath us must fail loudly rather than click whatever
 * now occupies that spot.
 */
const pressAgentSubmit = async (page, submit, log = () => {}) => {
    if (!submit?.ref) {
        return { ok: false, error: 'The AI agent did not record which button submits this application.' };
    }
    const locator = await locate(page, submit.frameIndex ?? 0, submit.ref);
    if (!locator || !(await locator.isVisible().catch(() => false))) {
        return {
            ok: false,
            error: 'The submit button is no longer on screen. Open the application in the browser and check it before submitting.',
        };
    }
    const text = await textOf(locator);
    if (!SUBMIT_LIKE.test(text)) {
        return { ok: false, error: `"${text.slice(0, 60)}" no longer looks like a submit button — check the application in the browser.` };
    }

    await clickSteadily(locator, log);
    await page.waitForTimeout(3_000);

    const thanked = await page.locator(SUBMITTED_TEXT).count().catch(() => 0) > 0;
    const gone = !(await locate(page, submit.frameIndex ?? 0, submit.ref));
    const confirmed = thanked || gone;
    return {
        ok: true,
        confirmed,
        detail: confirmed
            ? 'the site confirmed the application'
            : 'submitted, but the site showed no confirmation — please check',
    };
};

module.exports = {
    executeAction, pressAgentSubmit, resolveSource,
    HARD_SUBMIT, FORBIDDEN, SUBMIT_LIKE,
};
