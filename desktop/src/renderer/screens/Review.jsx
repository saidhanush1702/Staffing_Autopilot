import { useState } from 'react';

/**
 * ── THE REVIEW STEP ───────────────────────────────────────────────────
 *
 * Applications that are filled in and stopped at the portal's submit step.
 *
 * ── TWO SUBMIT BUTTONS, AND THEY DO DIFFERENT THINGS ──────────────────
 *
 *   "Submit"              presses the portal's submit button from here
 *   "I sent it myself"    records what the consultant did in the browser
 *
 * The distinction that matters survives either way: no application is sent
 * without a person reading the answers and choosing to send it. The app never
 * reaches either button on its own — the work loop stops here and waits.
 *
 * ── WHY EVERY ANSWER IS SHOWN ─────────────────────────────────────────
 *
 * Listed exactly as typed, in the order the form asked. Reviewing means
 * reading what is about to go out under your own name; "12 fields filled"
 * would be asking someone to take the machine's word for it.
 */
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');

const SOURCE = {
    ANSWER: 'your approved answer',
    PROFILE: 'from your profile',
    PORTAL: 'the portal already had this',
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

    const optional = entry.optionalUnanswered ?? [];

    return (
        <div className="card stack">
            <div className="row">
                <div>
                    <h2>{entry.company}</h2>
                    <p className="muted" style={{ marginTop: 2 }}>
                        {entry.title} · {entry.boardLabel} · filled {when(entry.filledAt)}
                    </p>
                </div>
                <span className="pill warn">Waiting on you</span>
            </div>

            {entry.filledBy === 'AGENT' && (
                <p className="note warn">
                    The AI agent filled this one — the site is new to the app, or its
                    automation broke. It used only your profile and approved answers, but it
                    matched them to the questions by meaning, so read each answer before you
                    submit.
                </p>
            )}

            {!entry.attachedResume && (
                <p className="note warn">
                    No resume was attached — the form had nowhere to put one, or you have
                    none on file. Check before submitting.
                </p>
            )}

            {optional.length > 0 && (
                <p className="note">
                    {optional.length} optional question{optional.length === 1 ? '' : 's'} left
                    blank because nobody has approved an answer. You can fill them in in the
                    browser.
                </p>
            )}

            <div>
                <button type="button" className="quiet" onClick={() => setOpen(!open)}>
                    {open ? 'Hide answers' : `Show the ${entry.qa.length} answers filled in`}
                </button>
                {open && (
                    <div style={{ marginTop: 6 }}>
                        {entry.qa.map((q, i) => (
                            <div className="qa" key={i}>
                                <p className="qa-q">{q.questionText}</p>
                                <p className="qa-a">{q.answerText}</p>
                                {SOURCE[q.source] && (
                                    <p className="muted">
                                        {SOURCE[q.source]}
                                        {q.matchedBy === 'AGENT' && q.source === 'ANSWER'
                                            ? ' · matched to this question by the AI agent'
                                            : ''}
                                    </p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {error && <p className="note stop">{error}</p>}

            <div className="row">
                <button
                    type="button"
                    className="quiet"
                    disabled={busy !== ''}
                    onClick={() => act('open', () => window.smartapply.openReview(entry.itemId))}
                >
                    {busy === 'open' ? 'Opening…' : 'Open in browser'}
                </button>

                <span style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        className="danger"
                        disabled={busy !== ''}
                        onClick={() => act('discard', () => window.smartapply.discardReview(
                            entry.itemId, 'The consultant chose not to submit this one.',
                        ))}
                    >
                        {busy === 'discard' ? 'Removing…' : 'Do not send'}
                    </button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={busy !== ''}
                        onClick={() => act('recorded', () => window.smartapply.markSubmitted(entry.itemId))}
                    >
                        {busy === 'recorded' ? 'Recording…' : 'I sent it myself'}
                    </button>
                    <button
                        type="button"
                        className="primary"
                        disabled={busy !== ''}
                        onClick={() => act('submitting', () => window.smartapply.submitApplication(entry.itemId))}
                    >
                        {busy === 'submitting' ? 'Submitting…' : 'Submit'}
                    </button>
                </span>
            </div>
        </div>
    );
};

const Review = ({ items, onRefresh }) => (
    <>
        <div className="row">
            <h2>Ready to submit ({items.length})</h2>
        </div>
        <p className="muted" style={{ marginTop: -4 }}>
            Each is filled in and stopped at the portal&rsquo;s submit step. Nothing is
            sent until you say so.
        </p>
        {items.map((entry) => (
            <Application key={entry.itemId} entry={entry} onRefresh={onRefresh} />
        ))}
    </>
);

export default Review;
