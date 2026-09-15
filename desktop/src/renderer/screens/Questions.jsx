import { useCallback, useEffect, useState } from 'react';

/**
 * ── THE QUESTIONS HOLDING JOBS UP ─────────────────────────────────────
 *
 * Only questions with an application actually waiting on them, most-blocking
 * first. The bank holds plenty a consultant could answer one day; these are the
 * ones costing them a job right now.
 *
 * ── WHY ANSWERING HAPPENS HERE ────────────────────────────────────────
 *
 * This is where the job is. The consultant is looking at "4 applications are
 * waiting on your notice period" — sending them to a web portal to find the
 * same question again is how a two-minute job becomes tomorrow's, and by
 * tomorrow the posting may be closed.
 *
 * An answer counts immediately. It is theirs, about them, for their own
 * application; nothing waits for a second person to agree that their notice
 * period is what they say it is.
 *
 * ── AND WHY IT SAYS WHAT IT WILL UNBLOCK ──────────────────────────────
 *
 * Each row leads with the number of applications it releases. Answering is a
 * chore; knowing that this particular chore sends four applications is the
 * difference between doing it now and closing the laptop.
 */
const Row = ({ q, suggestion, onAnswered }) => {
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        setError('');
        const res = await window.smartapply.answerQuestion(q.question_id, text.trim());
        setBusy(false);
        if (res?.ok) onAnswered(res.released ?? 0);
        else setError(res?.error ?? 'That did not save.');
    };

    return (
        <div className="card stack">
            <div>
                <p className="lead">{q.asked_as}</p>
                <p className="muted" style={{ marginTop: 3 }}>
                    <strong>{q.waiting_jobs}</strong>
                    {q.waiting_jobs === 1 ? ' application is' : ' applications are'} waiting
                    {q.example_company ? ` · asked by ${q.example_company}` : ''}
                    {q.is_required ? '' : ' · optional'}
                </p>
            </div>

            {/*
                An answer the consultant already gave to a differently-worded
                question. Offered, never applied: "Use this answer" only fills
                the box, and nothing is saved until they press Save.
            */}
            {suggestion && !text && (
                <div className="note">
                    <p>
                        You have answered a question like this before:{' '}
                        <strong>&ldquo;{suggestion.fromQuestion}&rdquo;</strong>
                    </p>
                    <p className="qa-a" style={{ marginTop: 4 }}>{suggestion.suggestedAnswer}</p>
                    <button
                        type="button"
                        className="secondary"
                        style={{ marginTop: 6 }}
                        onClick={() => setText(suggestion.suggestedAnswer)}
                    >
                        Use this answer
                    </button>
                </div>
            )}

            <textarea
                className="answer"
                rows={2}
                value={text}
                placeholder="Your answer"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    // Enter saves; Shift+Enter is a new line. These answers are
                    // usually four words, and reaching for the mouse each time
                    // is most of the effort.
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                }}
            />

            {error && <p className="note stop">{error}</p>}

            <div className="row">
                <p className="muted">Enter to save · Shift+Enter for a new line</p>
                <button
                    type="button"
                    className="primary"
                    disabled={busy || !text.trim()}
                    onClick={save}
                >
                    {busy ? 'Saving…' : 'Save answer'}
                </button>
            </div>
        </div>
    );
};

const Questions = ({ onChanged }) => {
    const [state, setState] = useState({ loading: true });
    const [freed, setFreed] = useState(0);
    const [suggestions, setSuggestions] = useState({});

    const load = useCallback(async () => {
        const res = await window.smartapply.questions();
        setState(res?.ok ? { questions: res.questions ?? [] } : { error: res?.error });
        // After the list, never before it: suggestions wait on a model, and
        // the questions themselves must not.
        if (res?.ok && (res.questions ?? []).length > 0) {
            window.smartapply.questionSuggestions?.()
                .then((s) => { if (s?.ok) setSuggestions(s.suggestions ?? {}); })
                .catch(() => {});
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const answered = async (released) => {
        setFreed((n) => n + released);
        await load();
        onChanged?.();
    };

    if (state.loading) return <div className="card empty"><p>Loading…</p></div>;
    if (state.error) return <p className="note stop">{state.error}</p>;

    const questions = state.questions ?? [];

    return (
        <>
            {freed > 0 && (
                <p className="note">
                    {freed} application{freed === 1 ? '' : 's'} released and back in the
                    queue.
                </p>
            )}

            {questions.length === 0 ? (
                <div className="card empty">
                    <p className="value">Nothing to answer</p>
                    <p>
                        Questions appear here when an application asks something the app
                        cannot answer from your profile.
                    </p>
                </div>
            ) : (
                <>
                    <p className="muted">
                        Answer these and the applications waiting on them go straight back
                        into the queue. Most-blocking first.
                    </p>
                    {questions.map((q) => (
                        <Row
                            key={q.question_id}
                            q={q}
                            suggestion={suggestions[q.question_id] ?? null}
                            onAnswered={answered}
                        />
                    ))}
                </>
            )}
        </>
    );
};

export default Questions;
