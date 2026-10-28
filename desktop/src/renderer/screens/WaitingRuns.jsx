import { useState } from 'react';

/**
 * ── APPLICATIONS ON HOLD FOR YOU ──────────────────────────────────────
 *
 * The banner above counts down because the app is holding still and watching.
 * These do not: the app has moved on, and the job waits — up to a day — until
 * the person has done what it needs. "I've done it" tries the job at once.
 */
const LABEL = {
    SIGN_IN: 'Sign-in',
    ACCOUNT_WALL: 'Sign-in',
    LEGAL_GATE: 'Terms',
    BOT_CHECK: 'Human check',
    EMAIL_VERIFY: 'Verification code',
};

const ago = (since) => {
    const m = Math.max(0, Math.round((Date.now() - since) / 60_000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
};

const WaitingRuns = ({ runs, onChanged }) => {
    const [busy, setBusy] = useState(null);
    if (!runs || runs.length === 0) return null;

    const resume = async (id) => {
        setBusy(id);
        await window.smartapply.runResume(id);
        setBusy(null);
        onChanged?.();
    };

    return (
        <section className="attention">
            <div className="attention-head">
                <span className="pill warn">On hold</span>
                <strong>{runs.length} application{runs.length === 1 ? '' : 's'} waiting for you</strong>
            </div>
            {runs.map((r) => (
                <div key={r.itemId} className="row">
                    <p className="attention-message">
                        <strong>{LABEL[r.gate.kind] ?? 'Needs you'}</strong>
                        {' — '}
                        {[r.boardLabel, r.company, r.title].filter(Boolean).join(' · ')}
                        <span className="muted"> · {r.gate.message} · since {ago(r.since)}</span>
                    </p>
                    <button
                        type="button"
                        disabled={busy === r.itemId}
                        onClick={() => resume(r.itemId)}
                    >
                        I’ve done it
                    </button>
                </div>
            ))}
        </section>
    );
};

export default WaitingRuns;
