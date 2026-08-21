import { useCallback, useEffect, useState } from 'react';

/**
 * ── WHAT HAS ACTUALLY GONE OUT ────────────────────────────────────────
 *
 * Every application this consultant has submitted, grouped by the board the job
 * came from.
 *
 * ── WHY THIS IS FETCHED, NOT REMEMBERED ───────────────────────────────
 *
 * The app forgets an application the moment it is submitted — it drops out of
 * the review list and nothing local replaces it. That is correct: the hub holds
 * the permanent record, and a second copy on a laptop is a second thing that
 * can disagree. So this asks the hub, and shows what the hub says.
 *
 * It is also why this list survives reinstalling the app, and why a consultant
 * and their recruiter are always looking at the same history.
 */
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const Applied = () => {
    const [state, setState] = useState({ loading: true });

    const load = useCallback(async () => {
        setState({ loading: true });
        const res = await window.smartapply.applications();
        setState(res.ok
            ? { loading: false, byBoard: res.byBoard ?? {}, total: (res.applications ?? []).length }
            : { loading: false, error: res.error });
    }, []);

    useEffect(() => { load(); }, [load]);

    if (state.loading) return (<><h2>Applied</h2><p className="muted">Loading…</p></>);
    if (state.error) {
        return (
            <>
                <h2>Applied</h2>
                <p className="note stop">{state.error}</p>
            </>
        );
    }

    const boards = Object.entries(state.byBoard ?? {});

    return (
        <>
            <div className="row">
                <h2 style={{ marginBottom: 0 }}>Applied ({state.total})</h2>
                <button type="button" className="secondary" onClick={load}>Refresh</button>
            </div>

            {boards.length === 0 && (
                <p className="muted">Nothing has been submitted yet.</p>
            )}

            {boards.map(([board, rows]) => (
                <div key={board} style={{ marginTop: 12 }}>
                    <p className="label" style={{ margin: '0 0 6px' }}>
                        {board} — {rows.length}
                    </p>
                    <div className="card">
                        {rows.map((a, i) => (
                            <div
                                key={a.id}
                                style={{
                                    padding: '8px 0',
                                    borderTop: i === 0 ? 'none' : '1px solid #e2e8f0',
                                }}
                            >
                                <div className="row">
                                    <div>
                                        <strong>{a.company}</strong>
                                        <p className="muted" style={{ margin: '2px 0 0' }}>
                                            {a.job_title}
                                        </p>
                                    </div>
                                    <span className="muted">{when(a.submitted_at)}</span>
                                </div>
                                <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                                    {a.answer_count} answer(s) recorded
                                    {a.portal_label ? ` · applied on ${a.portal_label}` : ''}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
};

export default Applied;
