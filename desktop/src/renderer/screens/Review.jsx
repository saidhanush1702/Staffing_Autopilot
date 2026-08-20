import { useState } from 'react';

/**
 * ── THE REVIEW STEP ───────────────────────────────────────────────────
 *
 * Spec §5.3 step 4, and the decision the whole system is built around: the app
 * fills the form and stops. A person reads it and presses submit on the portal
 * themselves.
 *
 * ── WHY THE BUTTON SAYS "I SUBMITTED IT" ──────────────────────────────
 *
 * It is past tense on purpose. The button does not send the application — it
 * records that the consultant already did, so the hub's record matches what the
 * employer actually received. Naming it "Submit" would describe something this
 * app cannot do: there is no submit channel in the preload bridge or the main
 * process for it to call.
 *
 * ── WHY EVERY ANSWER IS SHOWN ─────────────────────────────────────────
 *
 * The answers are listed exactly as they were typed, in the order the form
 * asked. Reviewing means reading what is about to go out under your own name;
 * a summary saying "12 fields filled" would be asking the consultant to take
 * the machine's word for it.
 */
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const SOURCE_NOTE = {
    ANSWER: 'from your approved answers',
    PROFILE: 'from your profile',
    RESUME: 'your resume file',
};

const Application = ({ entry, onRefresh }) => {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const act = async (what, fn) => {
        setBusy(what);
        setError('');
        const res = await fn();
        setBusy('');
        if (res?.ok) onRefresh();
        else setError(res?.error ?? 'That did not work.');
    };

    return (
        <div className="card">
            <div className="row">
                <div>
                    <strong>{entry.company}</strong>
                    <p className="muted" style={{ margin: '2px 0 0' }}>
                        {entry.title} · {entry.boardLabel} · filled {when(entry.filledAt)}
                    </p>
                </div>
                <button
                    type="button"
                    className="primary"
                    disabled={busy !== ''}
                    onClick={() => act('open', () => window.smartapply.openReview(entry.itemId))}
                >
                    {busy === 'open' ? 'Opening…' : 'Open and check'}
                </button>
            </div>

            {!entry.attachedResume && (
                <p className="note warn" style={{ marginTop: 10 }}>
                    No resume was attached — the form had nowhere to put one, or you have
                    none on file. Check before you submit.
                </p>
            )}

            {(entry.optionalUnanswered ?? []).length > 0 && (
                <p className="note" style={{ marginTop: 10 }}>
                    {entry.optionalUnanswered.length} optional question(s) were left blank
                    because nobody has approved an answer for them. You can fill them in
                    yourself in the browser window.
                </p>
            )}

            <p style={{ margin: '10px 0 0' }}>
                <button type="button" className="secondary" onClick={() => setOpen(!open)}>
                    {open ? 'Hide' : `Show what was filled in (${entry.qa.length})`}
                </button>
            </p>

            {open && (
                <div style={{ marginTop: 10 }}>
                    {entry.qa.map((q, i) => (
                        <div key={i} style={{ padding: '6px 0', borderTop: '1px solid #e2e8f0' }}>
                            <p className="label" style={{ margin: 0 }}>{q.questionText}</p>
                            <p style={{ margin: '2px 0 0' }}>{q.answerText}</p>
                            {SOURCE_NOTE[q.source] && (
                                <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
                                    {SOURCE_NOTE[q.source]}
                                </p>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {error && <p className="note stop" style={{ marginTop: 10 }}>{error}</p>}

            <div className="row" style={{ marginTop: 12 }}>
                <button
                    type="button"
                    className="secondary"
                    disabled={busy !== ''}
                    onClick={() => act('discard',
                        () => window.smartapply.discardReview(entry.itemId,
                            'The consultant chose not to submit this one.'))}
                >
                    {busy === 'discard' ? 'Removing…' : 'Do not send this'}
                </button>
                <button
                    type="button"
                    className="primary"
                    disabled={busy !== ''}
                    onClick={() => act('submitted',
                        () => window.smartapply.markSubmitted(entry.itemId))}
                >
                    {busy === 'submitted' ? 'Recording…' : 'I submitted it'}
                </button>
            </div>
        </div>
    );
};

const Review = ({ items, onRefresh }) => {
    if (!items || items.length === 0) return null;

    return (
        <>
            <h2>Ready for you to submit ({items.length})</h2>
            <p className="muted" style={{ margin: '0 0 10px' }}>
                Each of these is filled in and waiting on the portal. Open it, read it,
                and press submit there yourself — then tell this app you did, so your
                recruiter sees it.
            </p>
            {items.map((entry) => (
                <Application key={entry.itemId} entry={entry} onRefresh={onRefresh} />
            ))}
        </>
    );
};

export default Review;
