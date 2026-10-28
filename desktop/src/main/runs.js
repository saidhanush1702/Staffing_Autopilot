/**
 * ── THE RUN LEDGER ────────────────────────────────────────────────────
 *
 * A written record of every application that is waiting on a person.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────
 *
 * A gate (sign-in, account wall, terms) used to be a countdown inside one call
 * stack. When it ran out the job was handed over for good, and while it ran the
 * whole queue stood still. Nothing was written down, so nothing could be shown,
 * reminded about, or picked up again after a restart.
 *
 * A waiting run is now a row here instead:
 *
 *   status   WAITING_USER  while a person has something to do
 *            RUNNING       a retry is under way
 *   gate     what is needed, in words, and which kind
 *   lane     the browser session the person is working in. A held lane stops
 *            OTHER jobs on that session from running into the same wall, and
 *            never touches any other lane.
 *   since    when the wait began. Kept across retries, so the time limit is
 *            measured from the first ask, not from the latest attempt.
 *
 * ── RESUME IS RE-READING, NEVER REPLAYING ─────────────────────────────
 *
 * A run stores no step to replay. Coming back means opening the job again and
 * reading the page as it is now: a page changes while a person works, and a
 * replay would act on a page that no longer exists.
 */
const {
    GATE_TTL_MS, GATE_RETRY_MS, GATE_COOLDOWN_MS, GATE_REMINDER_MS, GATE_REMINDER_REPEAT_MS,
} = require('./config.js');

class RunLedger {
    /**
     * @param store   the app's Store; rows live under its `runs` key
     * @param now     injectable clock, so the suite can move time forward
     */
    constructor({
        store, now = () => Date.now(),
        ttlMs = GATE_TTL_MS, retryMs = GATE_RETRY_MS, cooldowns = GATE_COOLDOWN_MS,
        reminderMs = GATE_REMINDER_MS, repeatMs = GATE_REMINDER_REPEAT_MS,
    }) {
        this.store = store;
        this.now = now;
        this.ttlMs = ttlMs;
        this.retryMs = retryMs;
        this.cooldowns = cooldowns;
        this.reminderMs = reminderMs;
        this.repeatMs = repeatMs;
    }

    #rows() { return this.store.get('runs') ?? []; }

    #save(rows) { this.store.set({ runs: rows }); }

    get(itemId) { return this.#rows().find((r) => r.itemId === itemId) ?? null; }

    /** Every run, newest first. For the screen. */
    all() { return [...this.#rows()].sort((a, b) => b.since - a.since); }

    /** Runs a person has something to do for. */
    waiting() { return this.all().filter((r) => r.status === 'WAITING_USER'); }

    /**
     * Put a run on hold for a person.
     *
     * Calling it again for the same item keeps `since` and the reminder
     * history: a retry that hits the same wall must not restart the clock, or a
     * job could wait forever by being retried.
     */
    defer({
        itemId, lane, board = null, boardLabel = null, company = null, title = null,
        url = null, gate, holdsLane = true,
    }) {
        const rows = this.#rows().filter((r) => r.itemId !== itemId);
        const before = this.get(itemId);
        const at = this.now();
        rows.push({
            itemId,
            lane,
            board,
            boardLabel,
            company,
            title,
            url,
            status: 'WAITING_USER',
            gate: { kind: gate.kind, message: String(gate.message ?? '').slice(0, 300) },
            holdsLane,
            since: before?.since ?? at,
            attempts: before?.attempts ?? 0,
            // Times a person did not come back in time. Counted across
            // retries, so a job cannot go round the back of the queue forever.
            gateAttempts: (before?.gateAttempts ?? 0) + 1,
            reminders: before?.reminders ?? 0,
            lastRemindedAt: before?.lastRemindedAt ?? null,
            // The site is left alone until then, and so is this job.
            nextTryAt: at + (this.cooldowns[gate.kind] ?? this.retryMs),
            resumeRequested: false,
        });
        this.#save(rows);
        return this.get(itemId);
    }

    /** A retry is starting. The row stays, so a second wall keeps its clock. */
    resume(itemId) {
        const rows = this.#rows().map((r) => (r.itemId === itemId
            ? {
                ...r, status: 'RUNNING', attempts: r.attempts + 1, resumeRequested: false,
            }
            : r));
        this.#save(rows);
    }

    /** The run is over, one way or another. */
    resolve(itemId) {
        const rows = this.#rows();
        if (!rows.some((r) => r.itemId === itemId)) return false;
        this.#save(rows.filter((r) => r.itemId !== itemId));
        return true;
    }

    /** "I've done it" — try this one now rather than at the next interval. */
    requestResume(itemId) {
        let found = false;
        const rows = this.#rows().map((r) => {
            if (r.itemId !== itemId) return r;
            found = true;
            return { ...r, resumeRequested: true };
        });
        if (found) this.#save(rows);
        return found;
    }

    /** Was this lane left alone recently, because a person did not come back? */
    holdsLane(lane) {
        return this.#rows().some((r) => r.lane === lane && r.holdsLane
            && r.status === 'WAITING_USER' && !this.isExpired(r)
            && this.now() < r.nextTryAt);
    }

    /**
     * The thing a lane was left alone for has been seen to clear (the board is
     * signed in now), so the jobs behind it need not wait out the cool-down.
     */
    releaseLane(lane, kind) {
        let changed = false;
        const rows = this.#rows().map((r) => {
            if (r.lane !== lane || r.gate.kind !== kind || !r.holdsLane) return r;
            changed = true;
            return { ...r, holdsLane: false };
        });
        if (changed) this.#save(rows);
        return changed;
    }

    /** How many times has a person failed to come back for this job? */
    gateAttempts(itemId) {
        return this.get(itemId)?.gateAttempts ?? 0;
    }

    isExpired(run) { return this.now() - run.since >= this.ttlMs; }

    /** Is it time to try this run again? */
    due(run) {
        return run.resumeRequested || this.now() >= run.nextTryAt;
    }

    /**
     * Runs that waited too long. Removed here, so the caller reports each once.
     */
    takeExpired() {
        const rows = this.#rows();
        const gone = rows.filter((r) => r.status === 'WAITING_USER' && this.isExpired(r));
        if (gone.length === 0) return [];
        this.#save(rows.filter((r) => !gone.includes(r)));
        return gone;
    }

    /**
     * Runs a reminder is owed for.
     *
     * 5 minutes, 30 minutes, 2 hours after the wait began, then every couple of
     * hours. Marked as reminded here, so a poll that runs twice in a minute
     * cannot send the same nudge twice.
     */
    takeReminders() {
        const at = this.now();
        const due = [];
        const rows = this.#rows().map((r) => {
            if (r.status !== 'WAITING_USER') return r;
            const waited = at - r.since;
            const nextAt = r.reminders < this.reminderMs.length
                ? this.reminderMs[r.reminders]
                : this.reminderMs[this.reminderMs.length - 1]
                    + (r.reminders - this.reminderMs.length + 1) * this.repeatMs;
            if (waited < nextAt) return r;
            const updated = { ...r, reminders: r.reminders + 1, lastRemindedAt: at };
            due.push(updated);
            return updated;
        });
        if (due.length > 0) this.#save(rows);
        return due;
    }

    /** After a crash: a run left RUNNING is waiting again, not lost. */
    recover() {
        const rows = this.#rows();
        if (!rows.some((r) => r.status === 'RUNNING')) return 0;
        let n = 0;
        this.#save(rows.map((r) => {
            if (r.status !== 'RUNNING') return r;
            n += 1;
            return { ...r, status: 'WAITING_USER', nextTryAt: this.now() };
        }));
        return n;
    }
}

module.exports = { RunLedger };
