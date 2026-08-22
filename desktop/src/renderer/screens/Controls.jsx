import { useState } from 'react';

/**
 * ── THE START BUTTON ──────────────────────────────────────────────────
 *
 * The app does nothing to anybody's job queue until this is pressed. Opening
 * it, activating it, even having work waiting — none of that begins an
 * application. Somebody decides to start.
 *
 * ── WHY THE SUBMIT CHOICE IS ONLY OFFERED BEFORE STARTING ─────────────
 *
 * "Submit automatically" changes what happens to a real application, and jobs
 * are worked one after another with no pause. If it could be flipped mid-run,
 * some applications in the same batch would have been sent and others left for
 * review, with nothing on screen saying which was which — and the consultant
 * would have to work that out afterwards, from the outside, on their own
 * account.
 *
 * So it is a decision made on the way in. To change it: stop, choose, start.
 */
const Controls = ({ snap, onRefresh }) => {
    const [autoSubmit, setAutoSubmit] = useState(Boolean(snap.autoSubmit));
    const [busy, setBusy] = useState(false);

    const running = Boolean(snap.automationOn);
    const waiting = snap.queue?.length ?? 0;

    const act = async (fn) => {
        setBusy(true);
        await fn();
        setBusy(false);
        onRefresh();
    };

    return (
        <section className={`card stack${running ? '' : ' accent'}`}>
            <div className="row">
                <div>
                    <h2>{running ? 'Applying to jobs' : 'Not running'}</h2>
                    <p className="muted" style={{ marginTop: 3 }}>
                        {running
                            ? (snap.autoSubmit
                                ? 'Each application is filled in and submitted for you.'
                                : 'Each application is filled in and left for you to submit.')
                            : (waiting
                                ? `${waiting} job${waiting === 1 ? '' : 's'} ready when you are.`
                                : 'Nothing is being applied to.')}
                    </p>
                </div>

                <button
                    type="button"
                    className={running ? 'secondary big' : 'primary big'}
                    disabled={busy}
                    onClick={() => act(running
                        ? window.smartapply.stopAutomation
                        : () => window.smartapply.startAutomation({ autoSubmit }))}
                >
                    {busy ? 'Working…' : (running ? 'Stop' : 'Start applying')}
                </button>
            </div>

            {running ? (
                <p className="muted">
                    Stop first to change whether applications are submitted automatically.
                </p>
            ) : (
                <label className="switch">
                    <input
                        type="checkbox"
                        checked={autoSubmit}
                        onChange={(e) => setAutoSubmit(e.target.checked)}
                    />
                    <span>
                        <strong>Submit applications automatically</strong>
                        <p className="muted" style={{ marginTop: 2 }}>
                            {autoSubmit
                                ? 'Applications are sent to employers without you seeing them '
                                  + 'first. Anything the app cannot answer still stops and waits.'
                                : 'Applications are filled in and held for you to read and submit.'}
                        </p>
                    </span>
                </label>
            )}
        </section>
    );
};

export default Controls;
