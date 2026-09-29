/**
 * ── THE OUTBOX ────────────────────────────────────────────────────────
 *
 * Every report to the hub is written here BEFORE it is sent, and only removed
 * once the hub confirms it.
 *
 * ── THE FAILURE THIS EXISTS FOR ───────────────────────────────────────
 *
 * A consultant submits an application. The employer has it. Then the laptop
 * drops Wi-Fi before `POST /submitted` lands. Without an outbox that record is
 * gone — and R-08 says every application is kept indefinitely, so an
 * application the employer received and the hub never heard about is a hole in
 * the one table that exists to be trustworthy.
 *
 * It survives a restart because it is on disk, and it cannot double-report
 * because each entry carries the queue item it belongs to and the hub treats a
 * repeat as the same submission.
 */
const { readJson, writeJson } = require('./store.js');

const MAX_ATTEMPTS = 8;

class Outbox {
    constructor(file) {
        this.file = file;
        this.entries = readJson(file, []);
    }

    #flush() { writeJson(this.file, this.entries); }

    /** Queue a report. Returns its local id. */
    add(path, body) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            path,
            body,
            attempts: 0,
            lastError: null,
            queuedAt: new Date().toISOString(),
        };
        this.entries.push(entry);
        this.#flush();
        return entry.id;
    }

    get pending() { return this.entries.length; }

    /**
     * Drain in order, stopping at the first entry that is not yet due.
     *
     * Order matters: `filled` before `submitted` for the same item, or the hub
     * sees a submission for an item it thinks is still being worked on and the
     * state machine refuses it.
     *
     * @param send async (path, body) => void — throws to signal failure
     */
    async drain(send, now = Date.now()) {
        let sent = 0;
        let failed = 0;

        while (this.entries.length > 0) {
            const entry = this.entries[0];
            if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now) break;

            try {
                await send(entry.path, entry.body);
                this.entries.shift();
                sent += 1;
            } catch (err) {
                entry.attempts += 1;
                entry.lastError = String(err.message ?? err).slice(0, 300);
                failed += 1;

                if (entry.attempts >= MAX_ATTEMPTS) {
                    // Dropped from the queue but kept visible: something a
                    // person needs to know about, not something to retry
                    // forever behind their back.
                    entry.deadAt = new Date().toISOString();
                    this.entries.shift();
                    this.dead = [...(this.dead ?? []), entry];
                } else {
                    // 1m, 2m, 4m … capped. A hub outage should not become a
                    // request storm the moment it recovers.
                    const backoff = Math.min(60_000 * 2 ** (entry.attempts - 1), 30 * 60_000);
                    entry.nextAttemptAt = new Date(now + backoff).toISOString();
                }
                this.#flush();
                break;      // head-of-line: preserve order
            }
            this.#flush();
        }

        return { sent, failed, pending: this.entries.length };
    }
}

module.exports = { Outbox, MAX_ATTEMPTS };
