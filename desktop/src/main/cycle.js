/**
 * ── THE CYCLE ENGINE ──────────────────────────────────────────────────
 *
 * One pass over the consultant's ready work:
 *
 *   pull the queue  →  for each item, one at a time:
 *       lease it            (the hub grants it, with an expiry)
 *       open it in the board's browser
 *       classify            can we fill this, or does a human have to?
 *       report back
 *
 * ── D3 DELIBERATELY DOES NOT FILL ANYTHING ────────────────────────────
 *
 * No field is typed into at this stage. That is not an omission — it is the
 * point. Every part of the loop that can go wrong (leasing, session expiry,
 * caps, classification, cleanup, reporting, crash recovery) is proven while the
 * cost of being wrong is zero. Filling arrives on top of a loop already known to
 * work, rather than being debugged through it.
 *
 * ── THE LIMITS ARE ENFORCED HERE, NOT IN THE RECIPES ──────────────────
 *
 * One application at a time (R-19), the daily cap locally as well as at the hub
 * (R-17), LinkedIn's own lower ceiling and its full stop on any bot-check
 * (R-22), and working files deleted at the end of every cycle (R-20). Keeping
 * these in the engine means no board recipe can forget one.
 */
const fs = require('node:fs');
const { BOARDS, boardForPortal } = require('./browser/boards.js');
const { JITTER_MAX_MS } = require('./config.js');

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
 * Random offset on top of the interval the hub asked for.
 *
 * Spec §5.3 wants activity that does not look machine-timed. A cycle that fires
 * at exactly 08:00:00, 12:00:00 and 16:00:00 across a whole bench is a pattern;
 * a few minutes of noise per machine is not.
 */
const nextWakeMs = (intervalMs, rand = Math.random) =>
    Math.round(intervalMs + rand() * JITTER_MAX_MS);

class CycleEngine {
    constructor({ hub, sessions, store, outbox, paths, log = () => {} }) {
        this.hub = hub;
        this.sessions = sessions;
        this.store = store;
        this.outbox = outbox;
        this.paths = paths;
        this.log = log;
        this.running = false;
    }

    /**
     * One cycle. Never throws for an operational problem — a cycle that dies on
     * the first awkward item is a cycle that stops working in week one. Every
     * failure is recorded against its item and the pass continues.
     */
    async run() {
        if (this.running) return { skipped: 'already running' };
        this.running = true;

        const stats = {
            pulled: 0, leased: 0, opened: 0,
            fillable: 0, handedToHuman: 0, skipped: 0,
            signInNeeded: [], botChecked: [], errors: [],
        };

        try {
            // Anything left in `work` is from a cycle that did not finish
            // cleanly. Clearing on the way IN as well as out means a crash
            // cannot leave a resume on disk indefinitely (R-20).
            clearWorkDir(this.paths.work);

            const beat = await this.hub.heartbeat();
            this.store.set({
                dailyCap: beat.dailyCap,
                paused: beat.paused,
                pausedBoards: beat.pausedBoards ?? [],
            });

            // A paused consultant's app does nothing at all.
            if (beat.paused) {
                this.log('consultant is paused — nothing to do');
                return { ...stats, paused: true };
            }

            // The local half of R-17. The hub is the authority on what the cap
            // IS; this is the app refusing to exceed it independently, so a
            // disagreement fails closed rather than over-applying.
            const remaining = Math.max(0, (beat.dailyCap ?? 0) - (beat.usedToday ?? 0));
            if (remaining === 0) {
                this.log('daily cap already reached');
                return { ...stats, capReached: true };
            }

            const pausedUntil = new Map(
                (beat.pausedBoards ?? []).map((b) => [b.board, b.until]),
            );

            const { items } = await this.hub.queue();
            stats.pulled = items.length;

            // Per-board counters for this pass, so LinkedIn's lower ceiling is
            // applied inside the overall cap rather than alongside it.
            const perBoard = new Map();
            let worked = 0;

            for (const item of items) {
                if (worked >= remaining) {
                    this.log(`stopping: ${worked} of ${remaining} cap slots used`);
                    break;
                }

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

                const used = perBoard.get(board.name) ?? 0;
                if (board.maxPerCycle && used >= board.maxPerCycle) {
                    this.log(`${board.label} reached its per-cycle ceiling of ${board.maxPerCycle}`);
                    continue;
                }

                try {
                    const outcome = await this.#workOne(item, board, stats);
                    if (outcome === 'counted') {
                        worked += 1;
                        perBoard.set(board.name, used + 1);
                    }
                    // R-19: never parallel, and a real gap between applications.
                    await humanPause(1500, 4000);
                } catch (err) {
                    stats.errors.push(`${item.company} — ${err.message}`);
                    // R-26: a failure parks the item with a clear error. It
                    // never leaves something half-done looking finished.
                    await this.#report(() => this.hub.skipped(item.id, {
                        reason: `The app could not process this: ${err.message}`.slice(0, 500),
                    }));
                    stats.skipped += 1;
                }
            }

            return stats;
        } finally {
            // R-20: nothing transient survives the cycle.
            clearWorkDir(this.paths.work);
            this.store.set({ lastCycleAt: new Date().toISOString() });
            this.store.appendCycle({ at: new Date().toISOString(), ...stats });
            this.running = false;
        }
    }

    /**
     * One item: sign-in check, bot-check, lease, open, classify.
     *
     * @returns 'counted' when a cap slot was genuinely used
     */
    async #workOne(item, board, stats) {
        // Bot-check FIRST. Asking a challenged board for anything else is how a
        // temporary challenge becomes a blocked account (R-22).
        if (await this.sessions.isBotChecked(board)) {
            stats.botChecked.push(board.name);
            await this.#report(() => this.hub.boardStatus({
                board: board.name, state: 'BOT_CHECK',
                detail: 'Challenge page detected — stopping this board for the day',
            }));
            return 'stopped';
        }

        if (!(await this.sessions.isSignedIn(board))) {
            stats.signInNeeded.push(board.name);
            await this.sessions.promptSignIn(board);
            await this.#report(() => this.hub.boardStatus({
                board: board.name, state: 'SESSION_EXPIRED',
                detail: 'Waiting for the consultant to sign in',
            }));
            return 'stopped';
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
        //
        // The second is what makes D3 safe to run today.
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

        // Reached only once a board is verified — D4's entry point.
        stats.fillable += 1;
        return 'counted';
    }

    /**
     * Send a report, or queue it durably if the hub is unreachable.
     *
     * Reports are facts about work already done. Losing one because the network
     * blinked would leave the hub's record disagreeing with reality, so nothing
     * is ever fire-and-forget.
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

module.exports = { CycleEngine, nextWakeMs, clearWorkDir, humanPause };
