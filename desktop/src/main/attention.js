/**
 * ── WHEN THE BOT NEEDS A PERSON ───────────────────────────────────────
 *
 * The automation runs with the consultant sitting in front of the machine, so
 * the four things it cannot do for itself — sign in, clear a human check,
 * accept somebody's terms, answer a question nobody has answered before — are
 * no longer dead ends. They are a pause, a notification, and a countdown.
 *
 * ── ONE MECHANISM, NOT FOUR ───────────────────────────────────────────
 *
 * Every one of those gates used to have its own private waiting loop, its own
 * timeout, and no way at all to tell the consultant it was waiting. They differ
 * in exactly two respects: how long to wait, and how to tell whether the person
 * has finished. Both are arguments. Everything else — the notification, the
 * countdown on screen, the two buttons, the polling, the bookkeeping — is the
 * same every time, and lives here once.
 *
 * ── WHY THE DEADLINE IS SENT, NOT THE SECONDS REMAINING ───────────────
 *
 * The renderer counts down from a timestamp it is given once, rather than
 * being told "58 left… 57 left…" thirty times. A ticking message per second,
 * per gate, would be pure noise on the IPC channel, and a renderer that missed
 * one would show the wrong number. Given `until`, it can draw a smooth
 * countdown on its own clock and always agree with this one.
 *
 * ── AND WHY IT NEVER BLOCKS ANYTHING BUT ITSELF ───────────────────────
 *
 * `raise` resolves one of three ways and the caller decides what each means:
 *
 *   'done'     the person did it; carry on with this job
 *   'skipped'  the person said move on; give this job up now
 *   'timeout'  nobody answered; the caller falls back to whatever it did before
 *
 * There is no fourth outcome and no exception path, so a gate can never leave
 * the work loop wedged waiting for something that is not coming.
 */

/** How long each kind of gate is worth waiting for. */
const WAIT_MS = {
    // A challenge is a few clicks. Long enough to walk back to the desk.
    BOT_CHECK: 60_000,
    // Reading a question and typing an answer, with the form on screen.
    UNKNOWN_QUESTIONS: 120_000,
    // Credentials, and very often a code from a phone.
    SIGN_IN: 300_000,
    ACCOUNT_WALL: 300_000,
    // Reading terms before agreeing to them is not something to rush.
    LEGAL_GATE: 300_000,
};

/** What the person is being asked to do, in a few words. */
const HEADLINE = {
    BOT_CHECK: 'Human check needed',
    UNKNOWN_QUESTIONS: 'A question needs your answer',
    SIGN_IN: 'Sign-in needed',
    ACCOUNT_WALL: 'Sign-in needed to continue',
    LEGAL_GATE: 'Terms need your agreement',
};

/** How often to look at whether they have finished. */
const POLL_MS = 2_000;

class Attention {
    /**
     * @param notify   shows an OS notification; the app supplies it so this
     *   module needs no Electron and stays testable
     * @param publish  pushes the current pause to the screen, or null to clear
     * @param pollMs   overridable so the suite does not wait in real seconds
     */
    constructor({ notify = () => {}, publish = () => {}, pollMs = POLL_MS } = {}) {
        this.notify = notify;
        this.publish = publish;
        this.pollMs = pollMs;
        this.current = null;
        // Set by the two buttons. Read on the next poll rather than acted on
        // immediately, so a press and a check can never interleave badly.
        this.continueAsked = false;
        this.skipAsked = false;
    }

    /** What the screen should be showing, if anything. */
    snapshot() {
        return this.current;
    }

    /** "I have done it" — recheck now instead of waiting out the clock. */
    continueNow() {
        if (!this.current) return false;
        this.continueAsked = true;
        return true;
    }

    /** "Not doing this one" — give the job up without waiting. */
    skip() {
        if (!this.current) return false;
        this.skipAsked = true;
        return true;
    }

    /**
     * Pause, tell the consultant, and wait for them.
     *
     * @param kind    one of WAIT_MS's keys
     * @param check   async () => boolean — has the person finished?
     * @param waitMs  overrides the default for this kind
     * @returns 'done' | 'skipped' | 'timeout'
     */
    async raise({
        kind, board = null, boardLabel = null, company = null, title = null,
        message = '', check = async () => false, waitMs = null,
        holdUntilDeadline = false,
    }) {
        const total = waitMs ?? WAIT_MS[kind] ?? 60_000;
        const startedAt = Date.now();

        this.continueAsked = false;
        this.skipAsked = false;
        this.current = {
            kind,
            headline: HEADLINE[kind] ?? 'The app needs you',
            message,
            board,
            boardLabel,
            company,
            title,
            startedAt,
            // The renderer draws its countdown from this, on its own clock.
            until: startedAt + total,
            totalMs: total,
            // Tells the screen whether pressing on is possible before the
            // clock runs out, so the banner can say which it is.
            holdUntilDeadline,
        };
        this.publish(this.current);
        this.notify(this.current);

        try {
            // Asked BEFORE any waiting: the gate may already be satisfied — a
            // session that was live all along, a question answered a moment ago
            // on another job — and a pause nobody needed is still a pause.
            //
            // Skipped when the caller wants the full window: for questions
            // there is nothing to be already-satisfied about, and asking would
            // only risk the very thing `holdUntilDeadline` exists to prevent.
            if (!holdUntilDeadline && await check()) return 'done';

            while (Date.now() < this.current.until) {
                await new Promise((r) => { setTimeout(r, this.pollMs); });

                if (this.skipAsked) return 'skipped';

                // A press of "I've done it" is a request to look again, not a
                // claim that the work is done. If the gate is still up, the
                // countdown carries on rather than the job being abandoned on
                // somebody's optimism. This is the ONE way past a
                // `holdUntilDeadline` wait, and it is deliberate: it is the
                // consultant saying so, not the app guessing.
                if (this.continueAsked) {
                    this.continueAsked = false;
                    if (await check()) return 'done';
                    continue;
                }

                // ── WHY POLLING IS NOT ALWAYS ALLOWED TO END THE WAIT ──
                //
                // A gate like a captcha or a sign-in is either up or it is
                // not, so noticing the moment it clears is exactly right.
                //
                // A form is different, and polling it is actively wrong. "Has
                // every required field got something in it?" turns true after
                // the FIRST CHARACTER of the last answer — so a consultant
                // typing "30 days" would have the bot move on at "3", taking a
                // half-typed answer with it. There is no reliable way to tell
                // "finished typing" from "paused mid-word", so for those the
                // clock is the answer and the button is the shortcut.
                if (holdUntilDeadline) continue;

                if (await check()) return 'done';
            }

            // The window is over. Look once, now, and take whatever is there.
            return (await check()) ? 'done' : 'timeout';
        } finally {
            this.current = null;
            this.publish(null);
        }
    }
}

module.exports = { Attention, WAIT_MS, HEADLINE };
