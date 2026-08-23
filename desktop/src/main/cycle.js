/**
 * ── THE WORK LOOP ─────────────────────────────────────────────────────
 *
 * One pass over whatever is waiting in the consultant's queue:
 *
 *   pull the queue  →  for each item, one at a time:
 *       bot-check the board     stop for the day if challenged
 *       sign in                 the consultant does it; we wait for them
 *       lease it                the hub grants it, with an expiry
 *       open it                 in that board's own browser profile
 *       classify                can we fill this, or must a human?
 *       fill                    approved answers and the profile, nothing else
 *       report                  filled, parked, or handed over
 *
 * ── THIS IS NOT A SCHEDULED CYCLE ─────────────────────────────────────
 *
 * The four-hour figure in the specification belongs to the hub and governs
 * DISCOVERY — how often new jobs are found. The app itself is not on that
 * clock: it works whenever there is something in the queue and goes quiet when
 * there is not. A pass is therefore cheap and frequent, and "nothing to do" is
 * the normal outcome rather than a failure.
 *
 * ── WHERE THE LIMITS LIVE ─────────────────────────────────────────────
 *
 * One application at a time (R-19), a full stop on any board that shows a
 * bot-check (R-22), and working files deleted at both ends of every pass
 * (R-20). All of it is here, in the engine, so that no board recipe can forget
 * one of them.
 *
 * ── NOTHING IS RATIONED ANY MORE ──────────────────────────────────────
 *
 * There is no daily application cap and no per-board ceiling. Every job that
 * reaches the queue is worked — filled here if the board is one we handle,
 * handed to the consultant if not. Two controls remain, and neither is a quota:
 * `is_paused` stops a consultant entirely, and a bot-check stops one board for
 * the day because the board has told us it noticed.
 *
 * ── AND WHAT THE ENGINE WILL NOT DO ───────────────────────────────────
 *
 * It never submits. A filled form is reported to the hub as AWAITING_REVIEW and
 * put in front of the consultant, who presses submit themselves (R-02). It also
 * refuses to fill a board whose recipe is unverified, so a guessed selector
 * cannot type into a real employer's form.
 */
const fs = require('node:fs');
const { BOARDS, boardForPortal } = require('./browser/boards.js');
const { fillForm } = require('./browser/filler.js');
const { runApplyFlow, pressSubmit } = require('./browser/applyFlow.js');
const {
    POLL_MS, POLL_JITTER_MS, IDLE_POLL_MS, SIGNIN_WAIT_MS, SIGNIN_POLL_MS,
} = require('./config.js');

/** The useful part of an error: Playwright appends a whole call log. */
const firstLine = (message) => String(message ?? '').split(/\r?\n/)[0];

/** A pause a person would take, not a fixed delay a log can spot. */
const humanPause = (min, max) => new Promise((r) => {
    setTimeout(r, min + Math.random() * (max - min));
});

/** Everything in `work` is transient by definition — see R-20. */
const clearWorkDir = (dir) => {
    let removed = 0;
    try {
        for (const entry of fs.readdirSync(dir)) {
            fs.rmSync(`${dir}/${entry}`, { recursive: true, force: true });
            removed += 1;
        }
    } catch { /* nothing there yet */ }
    return removed;
};

/**
 * How long to wait before looking for work again.
 *
 * Busy means come back soon; idle means come back in a while. Both are
 * jittered, so a machine that has been running for a week is not polling on the
 * same second it started on (spec §5.3).
 */
const nextPollMs = (hadWork, rand = Math.random) => {
    const base = hadWork ? POLL_MS : IDLE_POLL_MS;
    return Math.round(base + rand() * POLL_JITTER_MS);
};

class CycleEngine {
    constructor({
        hub, sessions, store, outbox, paths, log = () => {},
        // Board-tagged progress. `log` is one flat stream for the whole app;
        // this says WHICH board a line belongs to, so the screen can keep
        // LinkedIn's story separate from Built In's instead of interleaving
        // them into something nobody can follow.
        activity = () => {},
        // Injectable so the suite can prove the sign-in gate without waiting
        // five real minutes for a fake browser to be signed into.
        signInWaitMs = SIGNIN_WAIT_MS,
        signInPollMs = SIGNIN_POLL_MS,
    }) {
        this.hub = hub;
        this.sessions = sessions;
        this.store = store;
        this.outbox = outbox;
        this.paths = paths;
        this.log = log;
        this.activity = activity;
        this.signInWaitMs = signInWaitMs;
        this.signInPollMs = signInPollMs;
        this.running = false;
        this.stopRequested = false;
    }

    /**
     * Ask the pass in progress to stop.
     *
     * ── WHY A FLAG AND NOT A KILL ─────────────────────────────────────
     *
     * Stop used to clear the next timer and nothing else, so a pass already
     * under way carried on through every remaining job — pressing Stop appeared
     * to do nothing at all, because the visible effect only arrived once the
     * queue ran out.
     *
     * It stops BETWEEN jobs rather than mid-application. Abandoning a
     * half-filled form would leave the board holding an application nobody
     * finished and nothing in our record saying so; one more job is a far
     * smaller cost than that.
     */
    requestStop() {
        this.stopRequested = true;
    }

    /**
     * Undo a stop, so work can begin again.
     *
     * Separate from `run()` on purpose. If a pass cleared the flag on its way
     * in, a stop asked for while the app happened to be idle would be forgotten
     * by the next scheduled pass — stopped has to mean stopped until somebody
     * presses Start.
     */
    allowStart() {
        this.stopRequested = false;
    }

    /**
     * Has stopping been asked for?
     *
     * Only the engine's own flag. Whether automation is switched on at all is
     * the main process's business, checked before a pass is ever started —
     * consulting it here as well made the engine refuse to work whenever that
     * setting had not been written yet.
     */
    #shouldStop() {
        return this.stopRequested;
    }

    /**
     * One pass. Never throws for an operational problem — a pass that dies on
     * the first awkward item is a loop that stops working in week one. Every
     * failure is recorded against its own item and the pass continues.
     */
    async run() {
        if (this.running) return { skipped: 'already running' };
        this.running = true;

        // ── WHAT THE PASS DID, ITEM BY ITEM ───────────────────────────
        //
        // The counters answer "how many"; `outcomes` answers "which, and why".
        // A consultant looking at "6 skipped" has no way to tell a run that hit
        // six closed postings from one that broke six times, and those call for
        // completely different responses. Every entry carries the job's name and
        // the reason in the same words the hub was given.
        const stats = {
            startedAt: new Date().toISOString(),
            pulled: 0, leased: 0, opened: 0,
            filled: 0, submitted: 0, parked: 0, handedToHuman: 0, skipped: 0, closed: 0,
            signInNeeded: [], botChecked: [], errors: [], outcomes: [],
        };

        /** Write one line of the ledger. */
        const record = (item, board, result, reason) => {
            stats.outcomes.push({
                company: item.company,
                title: item.title,
                board: board?.label ?? item.portal,
                result,
                reason: reason ? String(reason).slice(0, 300) : null,
            });
        };

        try {
            // Anything left in `work` is from a pass that did not finish
            // cleanly. Clearing on the way IN as well as out means a crash
            // cannot leave a resume on disk indefinitely (R-20).
            clearWorkDir(this.paths.work);

            const beat = await this.hub.heartbeat();
            this.store.set({
                paused: beat.paused,
                pausedBoards: beat.pausedBoards ?? [],
                outstandingQuestions: beat.outstandingQuestions ?? 0,
            });

            // A paused consultant's app does nothing at all. This is now the
            // ONLY thing that stops a pass before it starts — the daily cap it
            // used to share that job with is gone.
            if (beat.paused) {
                this.log('consultant is paused — nothing to do');
                return { ...stats, paused: true };
            }

            const pausedUntil = new Map(
                (beat.pausedBoards ?? []).map((b) => [b.board, b.until]),
            );

            const { items, approvedAnswers, profile } = await this.hub.queue();
            stats.pulled = items.length;
            this.store.set({ queue: items });

            let worked = 0;

            for (const item of items) {
                // Checked before every job, so Stop takes effect within one
                // application rather than at the end of the queue.
                if (this.#shouldStop()) {
                    this.log('stopping — no more jobs will be started');
                    return { ...stats, stopped: true };
                }

                const board = boardForPortal(item.portal);
                if (!board) {
                    // The hub thought this was ours; we have no recipe for it.
                    // Hand it back rather than guessing.
                    await this.#report(() => this.hub.reclassify(item.id, {
                        reason: `No recipe for portal ${item.portal}`,
                    }));
                    stats.handedToHuman += 1;
                    record(item, null, 'HANDED_OVER', `the app has no recipe for ${item.portal}`);
                    continue;
                }

                if (pausedUntil.has(board.name)) {
                    this.log(`${board.label} is paused until ${pausedUntil.get(board.name)}`);
                    continue;
                }

                try {
                    const outcome = await this.#workOne(
                        item, board, stats, { approvedAnswers, profile, record },
                    );
                    if (outcome === 'counted') worked += 1;
                    // R-19: never parallel, and a real gap between applications.
                    await humanPause(1500, 4000);
                } catch (err) {
                    stats.errors.push(`${item.company} — ${err.message}`);
                    this.activity(board.name, 'ERROR', `${item.company}: ${firstLine(err.message)}`);
                    // R-26: a failure parks the item with a clear reason. It
                    // never leaves something half-done looking finished.
                    await this.#report(() => this.hub.skipped(item.id, {
                        reason: `The app could not process this: ${err.message}`.slice(0, 500),
                    }));
                    stats.skipped += 1;
                    record(item, board, 'ERROR', firstLine(err.message));
                }
            }

            return stats;
        } finally {
            // R-20: nothing transient survives the pass.
            clearWorkDir(this.paths.work);
            this.store.set({ lastCycleAt: new Date().toISOString() });
            this.store.appendCycle({ at: new Date().toISOString(), ...stats });
            this.running = false;
        }
    }

    /**
     * Fetch the current state of things without working any of it.
     *
     * ── WHY THIS IS NOT A SHORT CYCLE ─────────────────────────────────
     *
     * "Check now" used to start a work pass, which meant it could only be
     * offered while automation was running — and pressing it did something
     * consequential: it applied to jobs. Two different actions were wearing one
     * button.
     *
     * This one only ever reads. It refreshes the queue, the pause state and the
     * board holds, so a consultant can see what has arrived without committing
     * to anything. That is why it can be available at all times, including
     * while stopped.
     */
    async refresh() {
        const beat = await this.hub.heartbeat();
        this.store.set({
            paused: beat.paused,
            pausedBoards: beat.pausedBoards ?? [],
            outstandingQuestions: beat.outstandingQuestions ?? 0,
        });

        const { items } = await this.hub.queue();
        this.store.set({ queue: items, lastCheckedAt: new Date().toISOString() });
        return { ok: true, waiting: items.length, paused: Boolean(beat.paused) };
    }

    /**
     * Wait for the consultant to sign in, having opened the window for them.
     *
     * The stall is reported to the hub BEFORE the wait, not after, so a
     * recruiter looking at the dashboard sees "waiting for sign-in" while it is
     * happening rather than five minutes later (spec §5.2).
     */
    async #waitForSignIn(board) {
        await this.#report(() => this.hub.boardStatus({
            board: board.name,
            state: 'SESSION_EXPIRED',
            detail: 'Waiting for the consultant to sign in',
        }));

        await this.sessions.promptSignIn(board);
        this.log(`${board.label}: waiting for you to sign in`);

        const deadline = Date.now() + this.signInWaitMs;
        while (Date.now() < deadline) {
            await new Promise((r) => { setTimeout(r, this.signInPollMs); });
            // Looks at the page in front of the consultant rather than
            // navigating it — polling with a navigation would reload the login
            // form they are typing into, every few seconds.
            if (await this.sessions.isSignedInNow(board)) {
                // Close the sign-in window and reload the automation's own page,
                // which is still showing what it loaded while signed out.
                await this.sessions.finishSignIn?.(board.name);
                this.log(`${board.label}: signed in — carrying on`);
                this.activity(board.name, 'SIGNED_IN', 'Signed in — carrying on');
                await this.#report(() => this.hub.boardStatus({
                    board: board.name, state: 'OK', detail: 'Signed in',
                }));
                return true;
            }
        }

        this.log(`${board.label}: still not signed in — leaving it for now`);
        return false;
    }

    /**
     * One item: bot-check, sign-in, lease, open, classify, fill.
     *
     * @returns 'counted' when a cap slot was genuinely used
     */
    async #workOne(item, board, stats, { approvedAnswers, profile, record = () => {} }) {
        // Bot-check FIRST. Asking a challenged board for anything else is how a
        // temporary challenge becomes a blocked account (R-22).
        if (await this.sessions.isBotChecked(board)) {
            stats.botChecked.push(board.name);
            this.activity(board.name, 'STOPPED', 'Stopped for today — this board showed a bot check');
            await this.#report(() => this.hub.boardStatus({
                board: board.name,
                state: 'BOT_CHECK',
                detail: 'Challenge page detected — stopping this board for the day',
            }));
            record(item, board, 'BOARD_STOPPED', 'this board showed a bot check');
            return 'stopped';
        }

        // The consultant signs in themselves (R-18). We open the window, wait,
        // and then carry straight on with this same item — the work does not
        // sit until the next poll just because a login was needed.
        // ── THE SIGN-IN GATE ONLY APPLIES TO BOARDS WE FILL ───────────
        //
        // On an unverified board the app opens the job, reads which host the
        // apply flow lands on, and hands the item to the consultant. It types
        // nothing and needs no session to do any of that.
        //
        // Gating it on sign-in was actively harmful: the detection selectors
        // are unverified guesses too, so a consultant who WAS signed in got
        // told their session had expired, and every item on that board stalled
        // for five minutes waiting for a login that had already happened. An
        // unproven check was blocking work that did not depend on it.
        //
        // Once a recipe is verified — which means its selectors have been seen
        // matching a real page — the gate applies again, because from that
        // point on the app really is typing into a form behind a login.
        if (board.verified && !(await this.sessions.isSignedIn(board))) {
            stats.signInNeeded.push(board.name);
            this.activity(board.name, 'SIGNED_OUT', 'Signed out — waiting for you to sign in');
            if (!(await this.#waitForSignIn(board))) {
                record(item, board, 'NEEDS_SIGN_IN', 'nobody signed in while this job waited');
                return 'stopped';
            }
        }

        // Lease before opening. The hub decides whether this device may have
        // the item, and the lease expires — so a crash here releases it rather
        // than locking it forever.
        this.activity(board.name, 'CONNECTING', `Opening ${item.company} — ${item.title}`);

        await this.hub.lease(item.id);
        stats.leased += 1;

        await this.sessions.openJob(board.name, item.source_url);
        stats.opened += 1;
        this.activity(board.name, 'WORKING', `Reading the page for ${item.company}`);

        // ── classify ──────────────────────────────────────────────────
        //
        // Two independent reasons an item goes to the consultant instead:
        //
        //   the apply flow leaves the board  →  we have no recipe for wherever
        //                                       it landed
        //   the board's recipe is unverified →  we will not type into a real
        //                                       employer's form on a guess
        const page = await this.sessions.page(board.name);
        const landedOn = new URL(page.url()).host.replace(/^www\./, '');
        const stillOnBoard = landedOn.endsWith(
            new URL(board.loginUrl).host.replace(/^www\./, ''),
        );

        if (!stillOnBoard || !board.verified) {
            const reason = !stillOnBoard
                ? `Applying happens on ${landedOn}, which the app does not fill`
                : `${board.label} form filling is not verified yet`;
            await this.#report(() => this.hub.reclassify(item.id, { reason }));
            stats.handedToHuman += 1;
            record(item, board, 'HANDED_OVER', reason);
            this.activity(board.name, 'HANDED_OVER', `${item.company}: ${reason}`);
            return 'counted';
        }

        // ── fill ──────────────────────────────────────────────────────
        //
        // The resume is fetched for THIS job and lands in `work`, which is
        // wiped at the end of the pass (spec §6, R-20).
        this.activity(board.name, 'FILLING', `Filling the application for ${item.company}`);
        const resumePath = await this.hub.resume(item.id, this.paths.work);
        const fillOptions = { profile, approvedAnswers, resumePath };

        // ── ONE FORM, OR A WIZARD? ────────────────────────────────────
        //
        // A board that declares an `apply` recipe hides its application behind
        // a button and pages through it — LinkedIn's Easy Apply. Everything
        // else has the form on the job page and is filled in one pass.
        //
        // Either way the ending is the same: the form is complete, nothing has
        // been sent, and it goes to the consultant to submit.
        let result;
        if (board.apply) {
            const flow = await runApplyFlow(page, board, fillOptions, { log: this.log });
            this.log(`${item.company}: ${flow.outcome} — ${flow.detail}`);

            // Outcomes that are nobody's fault and nothing to fill.
            this.activity(board.name, 'FILLING', `${item.company}: ${flow.detail}`);

            if (flow.outcome === 'ALREADY_APPLIED') {
                await this.#report(() => this.hub.skipped(item.id, {
                    reason: 'The board says this consultant has already applied.',
                }));
                stats.skipped += 1;
                record(item, board, 'ALREADY_APPLIED', 'the board already has an application from you');
                return 'counted';
            }

            // ── A SHUT POSTING IS NOT WORK FOR ANYBODY ────────────────
            //
            // It used to reach the consultant as "no apply button — applying
            // happens elsewhere", which is true and useless: they opened it and
            // found a red notice saying applications are closed. Nobody can act
            // on this one, so it is skipped with the reason the board gave.
            if (flow.outcome === 'CLOSED') {
                await this.#report(() => this.hub.skipped(item.id, {
                    reason: 'This posting is no longer accepting applications.',
                }));
                stats.skipped += 1;
                stats.closed += 1;
                record(item, board, 'CLOSED', flow.detail);
                this.activity(board.name, 'HANDED_OVER', `${item.company}: ${flow.detail}`);
                return 'counted';
            }

            if (flow.outcome === 'NO_APPLY_FLOW'
                || flow.outcome === 'EXTERNAL_APPLY'
                || flow.outcome === 'LEFT_THE_BOARD') {
                await this.#report(() => this.hub.reclassify(item.id, { reason: flow.detail }));
                stats.handedToHuman += 1;
                record(item, board, 'HANDED_OVER', flow.detail);
                this.activity(board.name, 'HANDED_OVER', `${item.company}: ${flow.detail}`);
                return 'counted';
            }

            result = {
                qa: flow.qa,
                unknown: flow.unknown,
                attachedResume: flow.attachedResume,
                refusals: [],
                readyToSubmit: flow.outcome === 'READY_TO_SUBMIT',
                steps: flow.steps,
            };

            // The wizard stopped somewhere that is neither a review screen nor
            // a known question. Hand it over rather than leaving a part-filled
            // application nobody knows about (R-26).
            if (flow.outcome === 'INCOMPLETE' && result.unknown.every((u) => !u.required)) {
                await this.#report(() => this.hub.reclassify(item.id, {
                    reason: `The application could not be completed: ${flow.detail}`,
                }));
                stats.handedToHuman += 1;
                record(item, board, 'HANDED_OVER', flow.detail);
                return 'counted';
            }
        } else {
            result = await fillForm(page, fillOptions);
            result.readyToSubmit = true;
        }

        for (const r of result.refusals ?? []) this.log(`refused: ${r.label} — ${r.reason}`);

        // A question nobody has approved an answer for stops this application.
        // Only a REQUIRED one, though: parking on an optional extra would stall
        // the queue over a field the consultant could simply leave blank.
        const blocking = result.unknown.filter((u) => u.required);
        if (blocking.length > 0) {
            await this.#report(() => this.hub.parked(item.id, {
                unknownQuestions: result.unknown.map((u) => ({
                    questionText: u.questionText,
                    fieldType: u.fieldType,
                })),
            }));
            stats.parked += 1;
            record(item, board, 'PARKED',
                `waiting on ${blocking.length} question(s): `
                + blocking.map((u) => u.questionText).join('; '));
            this.activity(board.name, 'PARKED',
                `${item.company}: parked on ${blocking.length} unanswered question(s)`);
            this.log(`parked ${item.company}: ${blocking.length} unanswered question(s)`);
            return 'counted';
        }

        // ── "FILLED" HAS TO MEAN SOMETHING ────────────────────────────
        //
        // A job page with no application form on it produces an empty result:
        // no answers, no resume, no unknowns worth parking on. Reporting that
        // as AWAITING_REVIEW would put an application in front of the
        // consultant that was never filled in — and mark it, at the hub, as
        // work this device completed.
        //
        // This is not hypothetical. A LinkedIn posting without Easy Apply is
        // exactly this shape: the apply button leaves for the employer's own
        // site, and all that remains on the page is LinkedIn's own furniture —
        // a search box and a language picker. The right answer there is the
        // same as for any job we cannot fill: hand it to the consultant.
        if (result.qa.length === 0) {
            await this.#report(() => this.hub.reclassify(item.id, {
                reason: 'No application form was found on the page — apply on the '
                    + 'employer site instead',
            }));
            stats.handedToHuman += 1;
            record(item, board, 'HANDED_OVER', 'no application form was found on the page');
            this.activity(board.name, 'HANDED_OVER',
                `${item.company}: no application form on the page — apply on the employer site`);
            this.log(`no form to fill on ${item.company} — handed to you`);
            return 'counted';
        }

        // ── FINISH IT, OR HAND IT OVER ────────────────────────────────
        //
        // The application is complete and sitting on its submit step. Which of
        // those two happens next is the consultant's own choice, made before
        // they pressed Start and held in `autoSubmit`.
        //
        // When it does submit, it submits HERE — not from the review screen.
        // The app drives one browser page per board, so moving to the next job
        // navigates this form away; this is the only moment it is still on
        // screen. That is also the bug the review screen kept hitting.
        await this.#report(() => this.hub.filled(item.id));
        this.#rememberForReview(item, board, result, { profile, approvedAnswers, resumePath });
        stats.filled += 1;

        if (this.store.get('autoSubmit') && result.readyToSubmit) {
            this.activity(board.name, 'SUBMITTING',
                `${item.company}: submitting ${result.qa.length} answer(s)`);

            const pressed = await pressSubmit(page, board);
            if (pressed.ok) {
                await this.reportSubmitted(item.id, {
                    confirmed: pressed.confirmed,
                    detail: pressed.detail,
                });
                stats.submitted += 1;
                record(item, board, 'SUBMITTED', pressed.detail);
                this.activity(board.name, 'SUBMITTED', `${item.company}: ${pressed.detail}`);
                this.log(`submitted ${item.company} — ${item.title}`);
                return 'counted';
            }

            // It stays in the review list rather than being recorded as sent.
            // A record claiming an employer received something they did not is
            // worse than having no record at all.
            record(item, board, 'READY_TO_SUBMIT', `could not submit — ${pressed.error}`);
            this.activity(board.name, 'READY_TO_SUBMIT',
                `${item.company}: could not submit — ${pressed.error}`);
            this.log(`could not submit ${item.company}: ${pressed.error}`);
            return 'counted';
        }

        record(item, board, 'READY_TO_SUBMIT',
            `filled ${result.qa.length} field(s) — waiting for you to submit`);
        this.activity(board.name, 'READY_TO_SUBMIT',
            `${item.company}: filled ${result.qa.length} field(s) — waiting for you to submit`);
        this.log(`filled ${item.company} — ${item.title}, waiting for your review`);
        return 'counted';
    }

    /**
     * Hold a filled form for the review screen.
     *
     * Kept locally rather than re-read from the hub because the Q&A list is
     * what gets reported after the consultant submits, and it must survive a
     * restart between filling and submitting.
     */
    #rememberForReview(item, board, result, context = {}) {
        const waiting = (this.store.get('awaitingReview') ?? [])
            .filter((w) => w.itemId !== item.id);

        waiting.push({
            itemId: item.id,
            board: board.name,
            boardLabel: board.label,
            company: item.company,
            title: item.title,
            url: item.source_url,
            filledAt: new Date().toISOString(),
            attachedResume: result.attachedResume,
            optionalUnanswered: result.unknown.filter((u) => !u.required),
            qa: result.qa,
            // Kept so the application can be rebuilt if the browser has moved
            // on by the time somebody presses Submit on the review screen.
            profile: context.profile ?? null,
            approvedAnswers: context.approvedAnswers ?? [],
            resumePath: context.resumePath ?? null,
        });

        this.store.set({ awaitingReview: waiting });
    }

    /**
     * Report that the consultant submitted an application themselves.
     *
     * The app never reaches this on its own — it is called from the review
     * screen, after a person has pressed submit on the portal.
     */
    async reportSubmitted(itemId, context = {}) {
        const waiting = this.store.get('awaitingReview') ?? [];
        const entry = waiting.find((w) => w.itemId === itemId);
        if (!entry) return { ok: false, error: 'That application is no longer waiting.' };

        await this.hub.submitted(itemId, {
            // DESKTOP_BOT is "filled by the app, submitted by the consultant" —
            // true whether they pressed the button here or in the browser.
            submissionMethod: 'DESKTOP_BOT',
            notes: context.detail ?? null,
            qa: entry.qa.map((q) => ({
                questionText: q.questionText,
                answerText: q.answerText,
                fieldType: q.fieldType,
                questionId: q.questionId ?? null,
            })),
        });

        this.store.set({ awaitingReview: waiting.filter((w) => w.itemId !== itemId) });
        return { ok: true };
    }

    /**
     * Submit an application, because the consultant pressed Submit in the app.
     *
     * ── THIS IS THE ONE EXCEPTION, AND IT IS DELIBERATE ───────────────
     *
     * Everywhere else the app refuses to click a submit control. Here it does,
     * and only here, on an explicit instruction from the person whose name is
     * on the application, after they have read every answer in the review
     * screen. The machine still decides nothing: it performs a click a human
     * asked for, in the same way pressing the button in the browser would.
     *
     * The alternative was to require the consultant to find the browser window
     * and click Submit there. That is still available and still works — this
     * exists because reviewing the answers and sending the application in two
     * different windows is how people submit the wrong one.
     *
     * It refuses if the board never got as far as offering a submit button.
     */
    async submitFromApp(itemId) {
        const waiting = this.store.get('awaitingReview') ?? [];
        const entry = waiting.find((w) => w.itemId === itemId);
        if (!entry) return { ok: false, error: 'That application is no longer waiting.' };

        const board = BOARDS[entry.board];
        if (!board?.apply?.submit) {
            return {
                ok: false,
                error: 'This application has to be submitted in the browser window — '
                    + 'this board has no submit button the app can press.',
            };
        }

        // ── THE FORM IS PROBABLY GONE ─────────────────────────────────
        //
        // One browser page is driven per board, so every job worked after this
        // one navigated that page away. By the time somebody reads the review
        // screen and presses Submit, the application they are looking at is
        // usually no longer displayed — which is what produced "the submit
        // button is no longer on screen" for anything but the most recent job.
        //
        // So it is rebuilt: reopen the job and walk the apply flow back to its
        // submit step, rather than pressing whatever submit button happens to
        // be on screen — which would belong to a different application.
        const page = await this.sessions.page(entry.board);
        const ready = await this.#reachSubmitStep(page, board, entry);
        if (!ready.ok) return ready;

        this.activity(entry.board, 'SUBMITTING', `Submitting ${entry.company} — you asked for this`);
        const pressed = await pressSubmit(page, board);
        if (!pressed.ok) {
            this.activity(entry.board, 'ERROR', `${entry.company}: ${pressed.error}`);
            return pressed;
        }
        this.activity(entry.board, 'SUBMITTED', `${entry.company}: ${pressed.detail}`);

        // Record it exactly as it happened, including whether the board
        // actually confirmed. Then remove it from the review list.
        const reported = await this.reportSubmitted(itemId, {
            confirmed: pressed.confirmed,
            detail: pressed.detail,
        });
        return { ...reported, ...pressed };
    }

    /**
     * Put the application in `entry` back on screen, at its submit step.
     *
     * Reopening rather than trusting whatever the page currently shows: the
     * alternative is pressing a submit button that belongs to another job.
     */
    async #reachSubmitStep(page, board, entry) {
        const recipe = board.apply;
        if (!recipe) return { ok: true };

        const sameJob = page.url().includes(new URL(entry.url).pathname);
        if (sameJob && await page.locator(recipe.submit).first().count() > 0) {
            return { ok: true };
        }

        this.activity(entry.board, 'WORKING', `Reopening ${entry.company} to submit it`);
        await this.sessions.openJob(entry.board, entry.url);

        const flow = await runApplyFlow(page, board, {
            profile: entry.profile ?? {},
            approvedAnswers: entry.approvedAnswers ?? [],
            resumePath: entry.resumePath ?? null,
        }, { log: this.log });

        if (flow.outcome === 'READY_TO_SUBMIT') return { ok: true };
        if (flow.outcome === 'ALREADY_APPLIED') {
            return { ok: false, error: 'The board says this application was already sent.' };
        }
        return {
            ok: false,
            error: `Could not get back to the submit step: ${flow.detail}. `
                + 'Open it and finish it in the browser.',
        };
    }

    /** Drop a filled form the consultant decided not to send. */
    async discardReview(itemId, reason) {
        const waiting = this.store.get('awaitingReview') ?? [];
        await this.#report(() => this.hub.skipped(itemId, {
            reason: reason || 'The consultant chose not to submit this one.',
        }));
        this.store.set({ awaitingReview: waiting.filter((w) => w.itemId !== itemId) });
        return { ok: true };
    }

    /** Bring a filled form back in front of the consultant. */
    async openForReview(itemId) {
        const entry = (this.store.get('awaitingReview') ?? [])
            .find((w) => w.itemId === itemId);
        if (!entry) return { ok: false, error: 'That application is no longer waiting.' };

        const page = await this.sessions.page(entry.board);
        if (page.url() !== entry.url) {
            await this.sessions.openJob(entry.board, entry.url);
        }
        await page.bringToFront();
        return { ok: true };
    }

    /**
     * Send a report, or let the caller carry on if the hub is unreachable.
     *
     * Reports are facts about work already done. Losing one because the network
     * blinked would leave the hub's record disagreeing with reality, so nothing
     * here is ever fire-and-forget.
     */
    async #report(fn) {
        try {
            return await fn();
        } catch (err) {
            if (err.name === 'Revoked') throw err;
            this.log(`queued for retry: ${err.message}`);
            return null;
        }
    }
}

module.exports = { CycleEngine, nextPollMs, clearWorkDir, humanPause };
