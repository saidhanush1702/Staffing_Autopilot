import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * ── ONE SCREEN FOR EVERYTHING THE APP DOES TO A JOB ───────────────────
 *
 * This used to be a row of sub-tabs — one per job board — each with its own
 * log, and a separate card for the AI agent. It described a system in which a
 * job belonged to a board and was either a "bot job" or an "agent job".
 *
 * It is neither. Every job is opened, taken by a written flow if the page has
 * one, carried on by the AI agent if not, and stopped for a person when
 * something needs them. So there is one view: the live page of the job being
 * worked, and one stream of what is happening to it, each line tagged with the
 * hand that was on it — "bot" for a written flow, "agent" for the AI.
 *
 * ── WHY THE PAGE IS A HOLE IN THE LAYOUT ──────────────────────────────
 *
 * An Electron view is a native layer painted ON TOP of this HTML — nothing
 * clips it — so React cannot draw the page. It leaves a gap, measures where the
 * gap landed, and asks the main process to move the view over it, re-measuring
 * on every scroll, resize and layout change.
 *
 * ── AND WHY FULL SCREEN KEEPS A STRIP ─────────────────────────────────
 *
 * In full screen the view covers everything except a bar at the top. An HTML
 * button underneath the view would be invisible and unclickable, so the way out
 * has to live outside the view's bounds. Escape works too.
 */
const TONE = {
    IDLE: ['idle', 'Idle'],
    CONNECTING: ['brand', 'Opening'],
    WORKING: ['brand', 'Working'],
    FILLING: ['brand', 'Filling'],
    AGENT: ['brand', 'AI agent working'],
    SUBMITTING: ['brand', 'Submitting'],
    SUBMITTED: ['ok', 'Submitted'],
    READY_TO_SUBMIT: ['warn', 'Ready to review'],
    PARKED: ['warn', 'Waiting for you'],
    HANDED_OVER: ['idle', 'Could not apply'],
    CLOSED: ['idle', 'Expired'],
    SIGNED_IN: ['ok', 'Signed in'],
    SIGNED_OUT: ['warn', 'Waiting for you'],
    STOPPED: ['stop', 'Stopped'],
    ERROR: ['stop', 'Problem'],
};

const LIVE = ['CONNECTING', 'WORKING', 'FILLING', 'AGENT', 'SUBMITTING'];
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

const Boards = ({ snap, showBoard, onShown }) => {
    const slot = useRef(null);
    const [embedded, setEmbedded] = useState(false);
    const [applied, setApplied] = useState(0);
    const [full, setFull] = useState(false);
    const [onlyAgent, setOnlyAgent] = useState(false);

    const applying = snap?.applying ?? { state: 'IDLE', session: null, lines: [] };
    // The page in front: whatever is being worked, else whatever somebody asked
    // to see (a sign-in prompt), else the last thing worked.
    const [pinned, setPinned] = useState(null);
    const selected = showBoard ?? applying.session ?? pinned;

    useEffect(() => {
        if (applying.session) setPinned(applying.session);
    }, [applying.session]);

    useEffect(() => {
        window.smartapply.browserIsEmbedded().then((r) => setEmbedded(Boolean(r.embedded)));

        // How many have gone out. Asked of the hub rather than kept locally: the
        // app forgets an application once submitted, and the hub holds the
        // running total.
        window.smartapply.applications().then((res) => {
            if (!res?.ok) return;
            setApplied(Object.values(res.byBoard ?? {}).reduce((n, rows) => n + rows.length, 0));
        });

        // Leaving this tab must take the view with it — it floats above the
        // whole window and would otherwise cover whatever came next.
        return () => { window.smartapply.hideBoardView(null); };
    }, []);

    // Something elsewhere asked for a page: a sign-in prompt, or the Work tab.
    useEffect(() => {
        if (!showBoard) return;
        onShown?.();
    }, [showBoard, onShown]);

    useEffect(() => {
        if (!full) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setFull(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [full]);

    const place = useCallback(() => {
        const box = slot.current?.getBoundingClientRect();
        if (!box || box.width < 2 || !selected) return;
        window.smartapply.showBoardView(selected, {
            x: box.left, y: box.top, width: box.width, height: box.height,
        });
    }, [selected]);

    // Keep the native view sitting exactly over the gap left for it.
    useLayoutEffect(() => {
        if (!embedded || !selected) return undefined;
        place();

        const observer = new ResizeObserver(place);
        if (slot.current) observer.observe(slot.current);
        const screen = document.querySelector('.screen');
        window.addEventListener('resize', place, true);
        screen?.addEventListener('scroll', place, true);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', place, true);
            screen?.removeEventListener('scroll', place, true);
            window.smartapply.hideBoardView(selected);
        };
    }, [embedded, selected, full, place]);

    const [tone, label] = TONE[applying.state] ?? ['idle', applying.state];
    const live = LIVE.includes(applying.state);
    const waiting = snap?.queue?.length ?? 0;
    const signedOut = (snap?.boards ?? []).find((b) => b.state === 'SIGNED_OUT');
    const lines = (onlyAgent ? applying.lines.filter((l) => l.by === 'agent') : applying.lines);

    const activity = (
        <div className="board-activity">
            <div className="row">
                <p className="label">Activity</p>
                <label className="muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                        type="checkbox"
                        checked={onlyAgent}
                        onChange={(e) => setOnlyAgent(e.target.checked)}
                    />
                    AI agent only
                </label>
            </div>
            {lines.length === 0
                ? <p className="muted" style={{ marginTop: 6 }}>Nothing yet.</p>
                : (
                    <div className="log" style={{ maxHeight: 'none', marginTop: 6 }}>
                        {[...lines].reverse().map((l, i) => (
                            <div className="log-line" key={`${l.at}-${i}`}>
                                <span className="log-time">{time(l.at)}</span>
                                <span className={`pill ${l.by === 'agent' ? 'brand' : 'idle'}`} style={{ marginRight: 6 }}>
                                    {l.by === 'agent' ? 'agent' : 'bot'}
                                </span>
                                <span>{l.message}</span>
                            </div>
                        ))}
                    </div>
                )}
        </div>
    );

    return (
        <>
            {full && (
                <div className="fullbar">
                    <span>
                        <strong>AI agent</strong>
                        <span className={`pill ${tone}`} style={{ marginLeft: 10 }}>
                            <span className={`dot${live ? ' live' : ''}`} />
                            {label}
                        </span>
                    </span>
                    <button type="button" className="secondary" onClick={() => setFull(false)}>
                        Exit full screen · Esc
                    </button>
                </div>
            )}

            {!full && (
                <div className="card stack">
                    <div className="row">
                        <div>
                            <h2>
                                AI agent
                                <span className={`pill ${tone}`} style={{ marginLeft: 10 }}>
                                    <span className={`dot${live ? ' live' : ''}`} />
                                    {label}
                                </span>
                            </h2>
                            <p className="muted" style={{ marginTop: 3 }}>
                                Every job is opened here. A written flow takes it when the page has one; the
                                AI agent carries on when it does not.
                            </p>
                        </div>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            {signedOut && (
                                <button
                                    type="button"
                                    className="primary"
                                    onClick={() => window.smartapply.signIn(signedOut.board)}
                                    title="Opens a proper browser window for this site"
                                >
                                    Sign in to {signedOut.label}
                                </button>
                            )}
                            {embedded && (
                                <button type="button" className="secondary" onClick={() => setFull(true)}>
                                    Full screen
                                </button>
                            )}
                        </span>
                    </div>
                    <div className="counts">
                        <span><strong>{waiting}</strong> in queue</span>
                        <span className="counts-sep" />
                        <span><strong>{applied}</strong> applied</span>
                    </div>
                </div>
            )}

            {embedded ? (
                <div className={full ? 'board-split full' : 'board-split'}>
                    <div ref={slot} className="board-view" />
                    {!full && activity}
                </div>
            ) : (
                <>
                    <p className="note">This build opens pages in a separate browser window.</p>
                    {activity}
                </>
            )}
        </>
    );
};

export default Boards;
