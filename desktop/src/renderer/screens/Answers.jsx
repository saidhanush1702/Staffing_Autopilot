import { useCallback, useEffect, useState } from 'react';

/**
 * ── THE ANSWER BANK ───────────────────────────────────────────────────
 *
 * Every question this consultant has answered, and the exact words the app
 * types into their applications.
 *
 * ── WHY IT IS WORTH A TAB OF ITS OWN ──────────────────────────────────
 *
 * The Questions tab shows what is blocking a job right now; this shows what has
 * already been decided, which is the thing somebody checks when an application
 * said something they did not expect. The tool that did the typing is the
 * obvious place to look.
 *
 * Answers can be changed here, and a change takes effect on the next
 * application — never on one already sent. Answers are revisions, not edits: an
 * application keeps the wording it went out with, whatever is written here
 * afterwards.
 */
const when = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

const Entry = ({ a, onSaved }) => {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(a.answer_text ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const save = async () => {
        const next = text.trim();
        if (!next || next === a.answer_text) { setEditing(false); return; }
        setBusy(true);
        setError('');
        const res = await window.smartapply.answerQuestion(a.question_id, next);
        setBusy(false);
        if (res?.ok) { setEditing(false); onSaved(); } else setError(res?.error ?? 'That did not save.');
    };

    return (
        <div className="card stack">
            <div>
                <p className="qa-q">{a.question_text}</p>
                {editing ? (
                    <textarea
                        className="answer"
                        rows={2}
                        value={text}
                        autoFocus
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                            if (e.key === 'Escape') { setText(a.answer_text ?? ''); setEditing(false); }
                        }}
                        style={{ marginTop: 6 }}
                    />
                ) : (
                    <p className="qa-a" style={{ marginTop: 4 }}>{a.answer_text}</p>
                )}
            </div>

            {error && <p className="note stop">{error}</p>}

            <div className="row">
                <p className="muted">
                    {a.category_label ? `${a.category_label} · ` : ''}
                    {a.revision_no > 1 ? `revision ${a.revision_no} · ` : ''}
                    {when(a.answered_at)}
                </p>
                {editing ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                        <button
                            type="button"
                            className="quiet"
                            onClick={() => { setText(a.answer_text ?? ''); setEditing(false); }}
                        >
                            Cancel
                        </button>
                        <button type="button" className="primary" disabled={busy} onClick={save}>
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                    </span>
                ) : (
                    <button type="button" className="quiet" onClick={() => setEditing(true)}>
                        Change
                    </button>
                )}
            </div>
        </div>
    );
};

const Answers = ({ onChanged }) => {
    const [state, setState] = useState({ loading: true });
    const [filter, setFilter] = useState('');

    const load = useCallback(async () => {
        const res = await window.smartapply.answerBank();
        setState(res?.ok ? { answers: res.answers ?? [] } : { error: res?.error });
    }, []);

    useEffect(() => { load(); }, [load]);

    if (state.loading) return <div className="card empty"><p>Loading…</p></div>;
    if (state.error) return <p className="note stop">{state.error}</p>;

    const all = state.answers ?? [];
    const needle = filter.trim().toLowerCase();
    const shown = needle
        ? all.filter((a) => `${a.question_text} ${a.answer_text}`.toLowerCase().includes(needle))
        : all;

    if (all.length === 0) {
        return (
            <div className="card empty">
                <p className="value">No answers yet</p>
                <p>
                    Answers appear here once you have answered a question on the
                    Questions tab.
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="row">
                <h2>{all.length} answer{all.length === 1 ? '' : 's'}</h2>
                <input
                    className="search"
                    value={filter}
                    placeholder="Search"
                    onChange={(e) => setFilter(e.target.value)}
                />
            </div>
            <p className="muted" style={{ marginTop: -4 }}>
                These are the words the app types into your applications. Changing one
                affects the next application, never one already sent.
            </p>

            {shown.length === 0
                ? <div className="card empty"><p>Nothing matches “{filter}”.</p></div>
                : shown.map((a) => (
                    <Entry
                        key={a.question_id}
                        a={a}
                        onSaved={() => { load(); onChanged?.(); }}
                    />
                ))}
        </>
    );
};

export default Answers;
