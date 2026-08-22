/**
 * ── THE RAW LOG ───────────────────────────────────────────────────────
 *
 * Everything the app said, newest first, plus a summary of recent passes.
 *
 * ── WHY THIS IS ITS OWN TAB ───────────────────────────────────────────
 *
 * Nobody opens this app to read a log, so it is not on the first screen. But
 * on the day something is wrong it is the only screen that helps, and a
 * consultant asked to explain what happened should not have to find a file on
 * disk to do it.
 *
 * The per-pass summary above the log answers a question the log itself cannot:
 * a pass that found nothing and a pass that could not sign in both produce no
 * applications, and only the counts tell them apart.
 */
const time = (d) => (d ? new Date(d).toLocaleTimeString() : '');

const Activity = ({ log, snap }) => {
    const cycles = snap.cycleLog ?? [];

    return (
        <>
            {cycles.length > 0 && (
                <section className="card flush">
                    <div className="pad" style={{ background: 'var(--raised)' }}>
                        <strong>Recent checks</strong>
                    </div>
                    <div className="divide">
                        {cycles.map((c, i) => (
                            <div className="pad row" key={i}>
                                <span className="muted">{time(c.at)}</span>
                                <span className="muted" style={{ textAlign: 'right' }}>
                                    {c.paused ? 'paused'
                                        : c.stopped ? 'stopped'
                                            : `${c.filled ?? 0} filled · ${c.submitted ?? 0} sent · `
                                              + `${c.parked ?? 0} parked · ${c.handedToHuman ?? 0} passed to you`}
                                    {(c.errors?.length ?? 0) > 0 && (
                                        <><br /><span style={{ color: 'var(--stop)' }}>
                                            {c.errors.length} problem{c.errors.length === 1 ? '' : 's'}
                                        </span></>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            <section className="card">
                <h2>Log</h2>
                {log.length === 0 ? (
                    <p className="muted" style={{ marginTop: 6 }}>
                        Nothing yet. Lines appear here as the app works.
                    </p>
                ) : (
                    <div className="log" style={{ marginTop: 8, maxHeight: 420 }}>
                        {[...log].reverse().map((entry, i) => (
                            <div className="log-line" key={i}>
                                <span className="log-time">{time(entry.at)}</span>
                                <span>{entry.line}</span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </>
    );
};

export default Activity;
