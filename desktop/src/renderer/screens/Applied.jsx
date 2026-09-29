import { useCallback, useEffect, useState } from 'react';

/**
 * ── WHAT HAS ACTUALLY GONE OUT ────────────────────────────────────────
 *
 * Every application this consultant has submitted, grouped by the board the
 * job came from.
 *
 * ── WHY THIS IS FETCHED, NOT REMEMBERED ───────────────────────────────
 *
 * The app forgets an application the moment it is submitted — it leaves the
 * review list and nothing local replaces it. That is correct: the hub holds
 * the permanent record, and a second copy on a laptop is a second thing that
 * can disagree with it. So this asks the hub and shows what the hub says,
 * which is also why the list survives reinstalling the app, and why a
 * consultant and their recruiter always see the same history.
 */
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—');
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

const Applied = () => {
    const [state, setState] = useState({ loading: true });

    const load = useCallback(async () => {
        setState({ loading: true });
        const res = await window.smartapply.applications();
        setState(res.ok
            ? { byBoard: res.byBoard ?? {}, total: (res.applications ?? []).length }
            : { error: res.error });
    }, []);

    useEffect(() => { load(); }, [load]);

    if (state.loading) return <div className="card empty"><p>Loading…</p></div>;
    if (state.error) return <p className="note stop">{state.error}</p>;

    const boards = Object.entries(state.byBoard ?? {});

    if (boards.length === 0) {
        return (
            <div className="card empty">
                <p className="value">Nothing submitted yet</p>
                <p>Applications appear here once they have been sent to an employer.</p>
            </div>
        );
    }

    return (
        <>
            <div className="row">
                <h2>{state.total} application{state.total === 1 ? '' : 's'}</h2>
                <button type="button" className="quiet" onClick={load}>Refresh</button>
            </div>

            {boards.map(([board, rows]) => (
                <section className="card flush" key={board}>
                    <div className="pad row" style={{ background: 'var(--raised)' }}>
                        <strong>{board}</strong>
                        <span className="pill idle">{rows.length}</span>
                    </div>
                    <div className="divide">
                        {rows.map((a) => (
                            <div className="pad row" key={a.id}>
                                <div>
                                    <div>{a.company}</div>
                                    <p className="muted">
                                        {a.job_title}
                                        {a.answer_count ? ` · ${a.answer_count} answers recorded` : ''}
                                    </p>
                                </div>
                                <p className="muted" style={{ textAlign: 'right', flex: '0 0 auto' }}>
                                    {day(a.submitted_at)}<br />{time(a.submitted_at)}
                                </p>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </>
    );
};

export default Applied;
