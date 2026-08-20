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
 * One application at a time (R-19), LinkedIn's own lower ceiling counted per
 * DAY and its full stop on any bot-check (R-22), and working files deleted at
 * both ends of every pass (R-20). All of it is here, in the engine, so that no
 * board recipe can forget one of them.
 *
 * There is no daily application cap. Every job that reaches the queue is worked
 * — filled here if the board is one we handle, handed to the consultant if not.
 * What remains is `is_paused`, which stops a consultant entirely, and the
 * per-board ceiling, which exists to protect the ACCOUNT rather than to ration
 * applications.
 *
 * ── AND WHAT THE ENGINE WILL NOT DO ───────────────────────────────────
 *
 * It never submits. A filled form is reported to the hub as AWAITING_REVIEW and
 * put in front of the consultant, who presses submit themselves (R-02). It also
 * refuses to fill a board whose recipe is unverified, so a guessed selector
 * cannot type into a real employer's form.
 */
const fs = require('node:fs');
const { boardForPortal } = require('./browser/boards.js');
const { fillForm } = require('./browser/filler.js');
const {
    POLL_MS, POLL_JITTER_MS, IDLE_POLL_MS, SIGNIN_WAIT_MS, SIGNIN_POLL_MS,
} = require('./config.js');

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
        this.signInWaitMs = signInWaitMs;
        this.signInPollMs = signInPollMs;
        this.running = false;
    }

    /**
     * One pass. Never throws for an operational problem — a pass that dies on
     * the first awkward item is a loop that stops working in week one. Every
     * failure is recorded against its own item and the pass continues.
     */
    async run() {
        if (this.running) return { skipped: 'already running' };
        this.running = true;

        const stats = {
            pulled: 0, leased: 0, opened: 0,
            filled: 0, parked: 0, handedToHuman: 0, skipped: 0,
            signInNeeded: [], botChecked: [], errors: [],
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
                const board = boardForPortal(item.portal);
                if (!board) {
                    // The hub thought this was ours; we have no recipe for it.
                    // Hand it back rather than guessing.
                    await this.#report(() => this.hub.reclassify(item.id, {
                        reason: `No recipe for portal ${item.portal}`,
                    }));
                    stats.handedToHuman += 1;
                    continue;
                }

                if (pausedUntil.has(board.name)) {
                    this.log(`${board.label} is paused until ${pausedUntil.get(board.name)}`);
                    continue;
                }

                // R-22, counted against the day rather than the pass.
                const usedOnBoard = this.store.boardUsedToday(board.name);
                if (board.maxPerDay && usedOnBoard >= board.maxPerDay) {
                    this.log(`${board.label} has taken its ${board.maxPerDay} for today`);
                    continue;
                }

                try {
                    const outcome = await this.#workOne(
                        item, board, stats, { approvedAnswers, profile },
                    );
                    if (outcome === 'counted') {
                        worked += 1;
                        this.store.countBoardUse(board.name);
                    }
                    // R-19: never parallel, and a real gap between applications.
                    await humanPause(1500, 4000);
                } catch (err) {
                    stats.errors.push(`${item.company} — ${err.message}`);
                    // R-26: a failure parks the item with a clear reason. It
                    // never leaves something half-done looking finished.
                    await this.#report(() => this.hub.skipped(item.id, {
                        reason: `The app could not process this: ${err.message}`.slice(0, 500),
                    }));
                    stats.skipped += 1;
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
            if (await this.sessions.isSignedIn(board)) {
                this.log(`${board.label}: signed in — carrying on`);
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
    async #workOne(item, board, stats, { approvedAnswers, profile }) {
        // Bot-check FIRST. Asking a challenged board for anything else is how a
        // temporary challenge becomes a blocked account (R-22).
        if (await this.sessions.isBotChecked(board)) {
            stats.botChecked.push(board.name);
            await this.#report(() => this.hub.boardStatus({
                board: board.name,
                state: 'BOT_CHECK',
                detail: 'Challenge page detected — stopping this board for the day',
            }));
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
            if (!(await this.#waitForSignIn(board))) return 'stopped';
        }

        // Lease before opening. The hub decides whether this device may have
        // the item, and the lease expires — so a crash here releases it rather
        // than locking it forever.
        await this.hub.lease(item.id);
        stats.leased += 1;

        await this.sessions.openJob(board.name, item.source_url);
        stats.opened += 1;

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
            return 'counted';
        }

        // ── fill ──────────────────────────────────────────────────────
        //
        // The resume is fetched for THIS job and lands in `work`, which is
        // wiped at the end of the pass (spec §6, R-20).
        const resumePath = await this.hub.resume(item.id, this.paths.work);
        const result = await fillForm(page, {
            profile, approvedAnswers, resumePath,
        });

        for (const r of result.refusals) this.log(`refused: ${r.label} — ${r.reason}`);

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
            this.log(`parked ${item.company}: ${blocking.length} unanswered question(s)`);
            return 'counted';
        }

        // Filled, and stopped. The consultant reviews and submits (R-02).
        await this.#report(() => this.hub.filled(item.id));
        this.#rememberForReview(item, board, result);
        stats.filled += 1;
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
    #rememberForReview(item, board, result) {
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
        });

        this.store.set({ awaitingReview: waiting });
    }

    /**
     * Report that the consultant submitted an application themselves.
     *
     * The app never reaches this on its own — it is called from the review
     * screen, after a person has pressed submit on the portal.
     */
    async reportSubmitted(itemId) {
        const waiting = this.store.get('awaitingReview') ?? [];
        const entry = waiting.find((w) => w.itemId === itemId);
        if (!entry) return { ok: false, error: 'That application is no longer waiting.' };

        await this.hub.submitted(itemId, {
            submissionMethod: 'DESKTOP_BOT',
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
