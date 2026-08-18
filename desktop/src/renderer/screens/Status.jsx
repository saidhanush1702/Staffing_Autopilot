const TONE = {
    IDLE: ['idle', 'Idle'],
    WORKING: ['ok', 'Working'],
    NEEDS_YOU: ['warn', 'Needs you'],
    PAUSED: ['idle', 'Paused'],
    OFFLINE: ['stop', 'Cannot reach the hub'],
    STARTING: ['idle', 'Starting'],
};

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * What the app is doing, and the two things that might need the consultant.
 *
 * ── WHY THE CYCLE LOG IS ON SCREEN ────────────────────────────────────
 *
 * A cycle that found nothing and a cycle that could not sign in look identical
 * from outside — both produce no applications. Showing the per-cycle counts is
 * the only way a consultant can tell "there was no work today" from "this has
 * been stuck for a week", without asking someone to read a log file.
 */
const Status = ({ snap, log, onRefresh }) => {
    const [tone, label] = TONE[snap.state] ?? ['idle', snap.state];
    const stalled = snap.pausedBoards ?? [];

    return (
        <div className="wrap">
            <div className="row">
                <div>
                    <h1>SmartApply</h1>
                    <p className="sub" style={{ margin: 0 }}>
                        {snap.consultant?.name ?? 'Consultant'}
                    </p>
                </div>
                <span className={`pill ${tone}`}>{label}</span>
            </div>

            {snap.state === 'OFFLINE' && (
                <div className="note stop" style={{ marginTop: 16 }}>
                    {snap.detail || 'The hub is unreachable.'} Nothing is lost — anything
                    already done is queued and will be reported as soon as the
                    connection returns.
                </div>
            )}

            {snap.paused && (
                <div className="note warn" style={{ marginTop: 16 }}>
                    Your account is paused, so the app will not apply to anything. Your
                    recruiter can lift this.
                </div>
            )}

            {/* The two things that actually need a person. */}
            {stalled.length > 0 && (
                <>
                    <h2>Needs you</h2>
                    {stalled.map((b) => (
                        <div className="card row" key={b.board}>
                            <div>
                                <strong>{b.board}</strong>
                                <p className="muted" style={{ margin: '2px 0 0' }}>
                                    {b.state === 'SESSION_EXPIRED'
                                        ? 'Your sign-in has expired. Jobs on this board are on hold.'
                                        : `This board asked us to verify — paused until ${when(b.until)}.`}
                                </p>
                            </div>
                            {b.state === 'SESSION_EXPIRED' && (
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => window.smartapply.signIn(b.board)}
                                >
                                    Sign in
                                </button>
                            )}
                        </div>
                    ))}
                </>
            )}

            <h2>Today</h2>
            <div className="card grid">
                <div>
                    <p className="label">Daily limit</p>
                    <p className="value">{snap.dailyCap}</p>
                </div>
                <div>
                    <p className="label">Ready to work</p>
                    <p className="value">{snap.queue?.length ?? 0}</p>
                </div>
                <div>
                    <p className="label">Waiting to report</p>
                    <p className="value">{snap.pendingReports}</p>
                </div>
            </div>

            <div className="card row">
                <div>
                    <p className="label">Last check</p>
                    <p style={{ margin: '2px 0 0' }}>{when(snap.lastCycleAt)}</p>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                        Next around {when(snap.nextCycleAt)}
                    </p>
                </div>
                <button type="button" className="secondary" onClick={() => {
                    window.smartapply.runNow();
                    onRefresh();
                }}>
                    Check now
                </button>
            </div>

            {(snap.cycleLog ?? []).length > 0 && (
                <>
                    <h2>Recent checks</h2>
                    {snap.cycleLog.map((c, i) => (
                        <div className="card" key={i}>
                            <div className="row">
                                <strong>{when(c.at)}</strong>
                                <span className="muted">
                                    {c.paused ? 'paused'
                                        : c.capReached ? 'daily limit reached'
                                            : `${c.opened ?? 0} opened · ${c.handedToHuman ?? 0} for you`}
                                </span>
                            </div>
                            {(c.errors?.length ?? 0) > 0 && (
                                <p className="muted" style={{ margin: '6px 0 0' }}>
                                    {c.errors.length} problem(s): {c.errors[0]}
                                </p>
                            )}
                        </div>
                    ))}
                </>
            )}

            {log.length > 0 && (
                <>
                    <h2>Activity</h2>
                    <div className="card log">{log.join('\n')}</div>
                </>
            )}

            <p className="muted" style={{ marginTop: 20 }}>
                Nothing is ever sent to an employer without you reviewing it and
                pressing submit yourself.
            </p>
        </div>
    );
};

export default Status;
