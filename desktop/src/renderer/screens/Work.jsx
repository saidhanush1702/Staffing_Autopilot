import { useState } from 'react';
import Controls from './Controls.jsx';
import Review from './Review.jsx';

/**
 * ── THE SCREEN THE APP OPENS ON ───────────────────────────────────────
 *
 * Ordered by what a consultant needs first:
 *
 *   1. the start/stop control          — is it running, and do I want it to be?
 *   2. anything waiting on them        — the only part with a deadline
 *   3. boards that need signing in     — the usual reason nothing is happening
 *   4. numbers                         — context, not action
 *
 * Counters are last on purpose. "3 ready to work" is interesting; "an
 * application is waiting for you to submit" is the thing that matters, and
 * putting statistics above it would bury the one item with a person's name on
 * it under a row of numbers.
 */
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');

const Work = ({ snap, onRefresh, onOpenBoard }) => {
    const [checking, setChecking] = useState(false);
    const [checked, setChecked] = useState(null);

    const check = async () => {
        setChecking(true);
        setChecked(await window.smartapply.checkForJobs());
        setChecking(false);
        onRefresh();
    };

    const boards = snap.boards ?? [];
    const signedOut = boards.filter((b) => b.state === 'SIGNED_OUT');
    const waiting = snap.awaitingReview ?? [];
    const ready = snap.queue?.length ?? 0;

    return (
        <>
            <Controls snap={snap} onRefresh={onRefresh} />

            {waiting.length > 0 && <Review items={waiting} onRefresh={onRefresh} />}

            {signedOut.length > 0 && (
                <section className="card stack">
                    <div>
                        <h2>Sign in needed</h2>
                        <p className="muted">
                            Jobs on these boards are on hold until you sign in. A proper
                            browser window opens for you — this app never sees your
                            password, and the sign-in carries straight over to the
                            automation.
                        </p>
                    </div>
                    {signedOut.map((b) => (
                        <div className="row" key={b.board}>
                            <span>{b.label}</span>
                            <button
                                type="button"
                                className="primary"
                                onClick={() => {
                                    // Show the board first. The login page opens
                                    // in that board's own view, and starting the
                                    // sign-in while it is off screen looks like
                                    // the button did nothing at all.
                                    onOpenBoard?.(b.board);
                                    window.smartapply.signIn(b.board);
                                }}
                            >
                                Sign in
                            </button>
                        </div>
                    ))}
                </section>
            )}

            {snap.paused && (
                <p className="note warn">
                    Your account is paused, so nothing will be applied to. Your recruiter
                    can lift this.
                </p>
            )}

            {snap.state === 'OFFLINE' && (
                <p className="note stop">
                    {snap.detail || 'The hub is unreachable.'} Nothing is lost — anything
                    already done is queued and reported as soon as the connection returns.
                </p>
            )}

            <section className="card flush">
                <div className="grid">
                    <div>
                        <p className="label">Ready to work</p>
                        <p className="value">{ready}</p>
                    </div>
                    <div>
                        <p className="label">Waiting on you</p>
                        <p className="value">{waiting.length}</p>
                    </div>
                    <div>
                        <p className="label">To report</p>
                        <p className="value">{snap.pendingReports ?? 0}</p>
                    </div>
                </div>
            </section>

            {/*
              Reading and working are different actions, so they are different
              controls. This one only looks, which is why it is available even
              when nothing is running.
            */}
            <div className="row">
                <p className="muted">
                    {snap.lastCheckedAt
                        ? `Jobs last checked ${when(snap.lastCheckedAt)}`
                        : 'Jobs not checked yet'}
                    {snap.automationOn && snap.lastCycleAt
                        ? ` · last worked ${when(snap.lastCycleAt)}`
                        : ''}
                </p>
                <button
                    type="button"
                    className="secondary"
                    disabled={checking}
                    onClick={check}
                >
                    {checking ? 'Checking…' : 'Check for new jobs'}
                </button>
            </div>

            {checked && (
                <p className="muted" style={{ marginTop: -4 }}>
                    {checked.ok
                        ? (checked.waiting
                            ? `${checked.waiting} job${checked.waiting === 1 ? '' : 's'} waiting.`
                              + `${snap.automationOn ? '' : ' Press Start applying to work them.'}`
                            : 'Nothing new — the queue is empty.')
                        : checked.error}
                </p>
            )}
        </>
    );
};

export default Work;
