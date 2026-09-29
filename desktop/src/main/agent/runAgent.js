/**
 * ── THE AGENT LOOP ────────────────────────────────────────────────────
 *
 *   observe the page → ask the hub for one action → check it → do it → again
 *
 * until the form is ready, a person is needed, or a limit is reached.
 *
 * ── IT ENDS THE WAY A RECIPE ENDS ─────────────────────────────────────
 *
 * The result has exactly the shape `runApplyFlow` returns — outcome, qa,
 * unknown, attachedResume, steps, detail — so everything the work loop already
 * does with a recipe's result it does with the agent's, unchanged: questions go
 * to the consultant, a filled form goes to review, and the autoSubmit choice
 * applies. Nothing downstream needs to know which of the two filled the form.
 *
 * ── THE LIMITS THAT LIVE HERE ─────────────────────────────────────────
 *
 * The hub owns the money limits. This owns the behavioural ones:
 *
 *   actions        a hard ceiling on things done, refusals included
 *   stuck          the page has not changed across three successful actions
 *   refused        four refusals in a row means the model is not converging
 *
 * ── SHADOW MODE ───────────────────────────────────────────────────────
 *
 * Observe and ask, never act. Three proposals are recorded against the run and
 * the job is handed over exactly as it would have been without the agent. That
 * is how an organisation watches the agent decide before letting it type.
 */
const { buildAnswerBook } = require('../browser/answers.js');
const { TYPING } = require('../config.js');
const { observe: realObserve } = require('./observe.js');
const { executeAction: realExecute } = require('./actions.js');

const MAX_ACTIONS = 40;
const STUCK_AFTER = 3;
const REFUSED_IN_A_ROW = 4;
const SHADOW_PROPOSALS = 3;

/** A pause a person would take between two things on a form. */
const humanPause = (typing) => new Promise((r) => {
    const [min, max] = typing?.betweenFieldsMs ?? [300, 900];
    setTimeout(r, min + Math.random() * (max - min));
});

/**
 * @param page       the Playwright page the application is on
 * @param opts {
 *   hub, runId, fillOptions: { profile, approvedAnswers, resumePath },
 *   root, log, activity(message), waitForHuman(page, message), waitForBotCheck(page),
 *   shadow, prior: { qa, attachedResume }, maxActions, typing
 * }
 * @param deps       { observe, execute } — replaceable so the loop's own rules
 *                   can be tested without a browser
 */
const runAgent = async (page, {
    hub, runId, fillOptions = {}, root = null,
    log = () => {}, activity = () => {},
    waitForHuman = null, waitForBotCheck = null,
    shadow = false, prior = null, maxActions = MAX_ACTIONS, typing = TYPING,
} = {}, deps = {}) => {
    const observe = deps.observe ?? realObserve;
    const execute = deps.execute ?? realExecute;

    const book = buildAnswerBook({
        profile: fillOptions.profile, approvedAnswers: fillOptions.approvedAnswers ?? [],
    });
    const qa = [...(prior?.qa ?? [])];
    let attachedResume = Boolean(prior?.attachedResume);

    const history = [];
    let lastResult = '';
    let actions = 0;
    let refused = 0;
    let refusedInARow = 0;
    let unchanged = 0;
    let lastSignature = null;
    let lastActed = false;
    let proposals = 0;
    let turns = 0;

    const end = (r) => ({
        outcome: r.outcome,
        detail: r.detail,
        qa,
        unknown: r.unknown ?? [],
        attachedResume,
        steps: actions,
        submit: r.submit ?? null,
        agent: { runId, actions, refused, turns, proposals: shadow ? history : undefined },
    });

    while (actions < maxActions) {
        let seen;
        try {
            seen = await observe(page, { root });
        } catch (err) {
            return end({ outcome: 'INCOMPLETE', detail: `the page could not be read: ${String(err.message).split('\n')[0]}` });
        }

        // A challenge is the consultant's to clear, never the model's.
        if (seen.observation.challenge) {
            const cleared = waitForBotCheck ? await waitForBotCheck(page) : false;
            if (!cleared) {
                return end({ outcome: 'BLOCKED', detail: 'the site is asking for a human check' });
            }
            lastResult = 'a human check was cleared by the consultant';
            lastSignature = null;
            continue;
        }

        if (lastActed && lastSignature !== null && seen.signature === lastSignature) {
            unchanged += 1;
            if (unchanged >= STUCK_AFTER) {
                return end({
                    outcome: 'INCOMPLETE',
                    detail: seen.observation.errors.length
                        ? `the form would not move on: ${seen.observation.errors.slice(0, 2).join('; ')}`
                        : 'the page stopped changing — the AI agent got stuck',
                });
            }
        } else {
            unchanged = 0;
        }
        lastSignature = seen.signature;

        let step;
        try {
            step = await hub.agentStep(runId, {
                observation: seen.observation,
                // Clipped to what the hub's schema accepts. A refusal quoting a
                // long label must not turn into a 400 that ends the run as
                // "the hub could not be reached".
                history: history.slice(-20).map((h) => ({
                    ...h,
                    ref: String(h.ref ?? '').slice(0, 60),
                    source: String(h.source ?? '').slice(0, 80),
                    result: String(h.result ?? '').slice(0, 380),
                })),
                lastResult: String(lastResult ?? '').slice(0, 480),
            });
        } catch (err) {
            return end({ outcome: 'INCOMPLETE', detail: `the hub could not be reached: ${String(err.message).slice(0, 160)}` });
        }
        turns += 1;

        if (!step?.ok) {
            return end({ outcome: 'INCOMPLETE', detail: step?.detail ?? 'the AI agent stopped' });
        }

        if (!step.action) {
            refused += 1;
            refusedInARow += 1;
            actions += 1;
            lastActed = false;
            lastResult = `your reply was refused: ${step.invalid}`;
            history.push({ n: actions, action: 'invalid', ref: '', source: '', result: lastResult });
            if (refusedInARow >= REFUSED_IN_A_ROW) {
                return end({ outcome: 'INCOMPLETE', detail: 'the AI agent kept giving answers the app could not use' });
            }
            continue;
        }

        const { action } = step;
        if (action.reason) activity(action.reason);
        log(`agent: ${action.action}${action.ref ? ` ${action.ref}` : ''}${action.source ? ` ${action.source}` : ''} — ${action.reason}`);

        if (shadow) {
            proposals += 1;
            actions += 1;
            history.push({
                n: actions, action: action.action, ref: action.ref, source: action.source,
                result: 'not carried out (shadow mode)',
            });
            const terminal = ['ready', 'stop', 'ask_human', 'needs_sign_in'].includes(action.action);
            if (terminal || proposals >= SHADOW_PROPOSALS) {
                return end({
                    outcome: 'SHADOW',
                    detail: `shadow mode — the AI agent would have: ${history
                        .map((h) => `${h.action}${h.ref ? ` ${h.ref}` : ''}`).join(', ')}`,
                });
            }
            lastResult = 'shadow mode: nothing was carried out. Say what you would do next, as if the last action had worked.';
            lastActed = false;
            continue;
        }

        const done = await execute(page, action, {
            registry: seen.registry,
            errors: seen.observation.errors,
            book,
            approvedAnswers: fillOptions.approvedAnswers ?? [],
            resumePath: fillOptions.resumePath ?? null,
            attachedResume,
            filledCount: qa.filter((q) => q.source !== 'PORTAL').length,
            typing,
            log,
            waitForHuman,
        });
        actions += 1;

        if (done.terminal) {
            history.push({ n: actions, action: action.action, ref: action.ref, source: action.source, result: done.terminal.outcome });
            return end(done.terminal);
        }

        if (done.ok) {
            refusedInARow = 0;
            lastActed = true;
            if (done.qa) qa.push(done.qa);
            if (done.attachedResume) attachedResume = true;
            lastResult = done.result;
            await humanPause(typing);
        } else {
            refused += 1;
            refusedInARow += 1;
            lastActed = false;
            lastResult = `refused: ${done.error}`;
            log(`agent: refused — ${done.error}`);
            if (refusedInARow >= REFUSED_IN_A_ROW) {
                return end({ outcome: 'INCOMPLETE', detail: `the AI agent kept choosing actions the app refused (last: ${done.error})` });
            }
        }

        history.push({
            n: actions, action: action.action, ref: action.ref, source: action.source, result: lastResult,
        });
    }

    return end({ outcome: 'INCOMPLETE', detail: `the AI agent used all ${maxActions} of its actions` });
};

module.exports = {
    runAgent, MAX_ACTIONS, STUCK_AFTER, REFUSED_IN_A_ROW, SHADOW_PROPOSALS,
};
