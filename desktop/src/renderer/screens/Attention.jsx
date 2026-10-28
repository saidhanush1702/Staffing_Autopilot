import { useEffect, useState } from 'react';

/**
 * ── THE BOT IS WAITING FOR YOU ────────────────────────────────────────
 *
 * Shown above everything, on every tab, because the one moment a consultant
 * must not miss is the one where the automation has stopped and is waiting on
 * them. Tucked inside a tab it would be missed by exactly the person it exists
 * for.
 *
 * ── WHY IT COUNTS DOWN FROM A DEADLINE ────────────────────────────────
 *
 * The main process sends `until` — a timestamp — once, and this ticks against
 * its own clock. The alternative, being told the remaining seconds thirty
 * times, is thirty messages per gate on the IPC channel, and a renderer that
 * misses one shows the wrong number. A deadline cannot drift.
 *
 * ── AND WHY THE BAR EMPTIES RATHER THAN FILLS ─────────────────────────
 *
 * What is running out is time to act. A bar that empties says that without
 * anybody reading the number.
 */
const LABEL = {
    BOT_CHECK: 'Human check',
    UNKNOWN_QUESTIONS: 'Needs an answer',
    SIGN_IN: 'Sign-in',
    ACCOUNT_WALL: 'Sign-in',
    LEGAL_GATE: 'Terms',
    EMAIL_VERIFY: 'Verification code',
};

/** Seconds, as a person says them. */
const clock = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
};

const Attention = ({ attention, onChanged }) => {
    const [now, setNow] = useState(Date.now());
    const [busy, setBusy] = useState(null);

    // One timer for the whole banner, and only while there is something to
    // count. An interval left running behind a dismissed banner is a wasted
    // wake-up every second for the life of the app.
    useEffect(() => {
        if (!attention) return undefined;
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, [attention?.until]);

    // A new pause is a new decision; nothing should look pressed from the last.
    // The notice is included: when a press found the gate still up, the buttons
    // must come back, or "Checking…" would sit there for the rest of the wait.
    useEffect(() => { setBusy(null); }, [attention?.kind, attention?.until, attention?.notice]);

    // And a press that changed nothing on screen must not leave the button
    // greyed out either. The main process answers within a poll tick.
    useEffect(() => {
        if (busy !== 'continue') return undefined;
        const id = setTimeout(() => setBusy(null), 4_000);
        return () => clearTimeout(id);
    }, [busy]);

    if (!attention) return null;

    const left = attention.until - now;
    const fraction = Math.max(0, Math.min(1, left / (attention.totalMs || 1)));
    const nearlyOut = left <= 15_000;

    const press = async (which) => {
        setBusy(which);
        if (which === 'continue') await window.smartapply.attentionContinue();
        else if (which === 'force') await window.smartapply.attentionForce();
        else await window.smartapply.attentionSkip();
        onChanged?.();
    };

    return (
        <section className={`attention${nearlyOut ? ' urgent' : ''}`}>
            <div className="attention-head">
                <span className="pill warn">
                    <span className="dot live" />
                    {LABEL[attention.kind] ?? 'Needs you'}
                </span>
                <strong>{attention.headline}</strong>
                <span className="attention-spacer" />
                <span className="attention-clock mono">{clock(left)}</span>
            </div>

            {(attention.company || attention.boardLabel) && (
                <p className="muted">
                    {[attention.boardLabel, attention.company, attention.title]
                        .filter(Boolean).join(' · ')}
                </p>
            )}

            <p className="attention-message">{attention.message}</p>

            {/* A press of "I've done it" looked, and the gate is still up. Said
                out loud, so nobody sits watching a countdown wondering why. */}
            {attention.notice && (
                <p className="note stop">
                    {attention.notice} Finish it, then press “I’ve done it” again — or
                    carry on anyway.
                </p>
            )}

            {/* Empties as the time runs out. */}
            <div className="attention-track">
                <div className="attention-fill" style={{ width: `${fraction * 100}%` }} />
            </div>

            <div className="row">
                <p className="muted">
                    {attention.releaseOnContinue
                        ? 'Answer in the form or on the Questions tab, then press “I’ve done it” — '
                          + 'it carries on straight away.'
                        : 'If nobody does this in time, this job goes to the back of the queue '
                          + 'and the app moves on.'}
                </p>
                <span style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        className="quiet"
                        disabled={busy !== null}
                        onClick={() => press('skip')}
                    >
                        Do this one later
                    </button>
                    {attention.notice && (
                        <button
                            type="button"
                            className="secondary"
                            disabled={busy !== null}
                            onClick={() => press('force')}
                        >
                            Continue anyway
                        </button>
                    )}
                    <button
                        type="button"
                        className="primary"
                        disabled={busy !== null}
                        onClick={() => press('continue')}
                    >
                        {busy === 'continue' ? 'Going on…' : 'I’ve done it'}
                    </button>
                </span>
            </div>
        </section>
    );
};

export default Attention;
