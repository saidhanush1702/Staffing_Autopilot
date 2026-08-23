import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * ── ONE BOARD AT A TIME ───────────────────────────────────────────────
 *
 * A row of sub-tabs — LinkedIn, Built In, and the rest — and under the chosen
 * one, a split: the board's live page on the left, what the app is doing to it
 * on the right.
 *
 * ── WHY SUB-TABS RATHER THAN A LIST OF CARDS ──────────────────────────
 *
 * Only one board's page can be on screen anyway. An Electron view is a native
 * layer painted ON TOP of this HTML — nothing clips it, so two open at once
 * would overlap. A list of expandable cards pretended otherwise; sub-tabs say
 * out loud what was always true.
 *
 * ── WHY THE PAGE IS A HOLE IN THE LAYOUT ──────────────────────────────
 *
 * For the same reason, React cannot draw the page. It leaves a gap, measures
 * where the gap landed, and asks the main process to move the view over it —
 * re-measuring on every scroll, resize and layout change. All the bookkeeping
 * below serves that one illusion.
 *
 * ── AND WHY FULL SCREEN KEEPS A STRIP ─────────────────────────────────
 *
 * In full screen the view covers everything except a bar at the top. That bar
 * is not decoration: an HTML button underneath the view would be both invisible
 * and unclickable, so the only way out has to live outside the view's bounds.
 * Escape works too.
 */
const TONE = {
    IDLE: ['idle', 'Idle'],
    CONNECTING: ['brand', 'Opening'],
    WORKING: ['brand', 'Working'],
    FILLING: ['brand', 'Filling'],
    SUBMITTING: ['brand', 'Submitting'],
    SUBMITTED: ['ok', 'Submitted'],
    READY_TO_SUBMIT: ['warn', 'Waiting on you'],
    PARKED: ['warn', 'Parked'],
    HANDED_OVER: ['idle', 'Passed to you'],
    CLOSED: ['idle', 'Expired'],
    SIGNED_IN: ['ok', 'Signed in'],
    SIGNED_OUT: ['warn', 'Signed out'],
    STOPPED: ['stop', 'Stopped'],
    ERROR: ['stop', 'Problem'],
};

const LIVE = ['CONNECTING', 'WORKING', 'FILLING', 'SUBMITTING'];
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

/** Count the queue by the board each job belongs to. */
const queueByBoard = (queue = []) => queue.reduce((acc, item) => {
    const key = String(item.portal ?? '').toUpperCase();
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
}, {});

const Boards = ({ boards, snap, showBoard, onShown }) => {
    const slot = useRef(null);
    const [embedded, setEmbedded] = useState(false);
    const [applied, setApplied] = useState({});
    const [selected, setSelected] = useState(boards?.[0]?.board ?? null);
    const [full, setFull] = useState(false);

    useEffect(() => {
        window.smartapply.browserIsEmbedded().then((r) => setEmbedded(Boolean(r.embedded)));

        // How many have gone out, per board. Asked of the hub rather than kept
        // locally: the app forgets an application once submitted, and the hub
        // is the only thing holding the running total.
        window.smartapply.applications().then((res) => {
            if (!res?.ok) return;
            const counts = {};
            for (const [key, rows] of Object.entries(res.byBoard ?? {})) {
                counts[String(key).toUpperCase()] = rows.length;
            }
            setApplied(counts);
        });

        // Leaving this tab must take the view with it — it floats above the
        // whole window and would otherwise cover whatever came next.
        return () => { window.smartapply.hideBoardView(null); };
    }, []);

    // Something elsewhere asked for a board: a sign-in prompt, or the Work tab.
    useEffect(() => {
        if (!showBoard) return;
        setSelected(showBoard);
        onShown?.();
    }, [showBoard, onShown]);

    // Escape is the reliable way out, since the view covers most of what a
    // person would otherwise reach for.
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

    if (!boards || boards.length === 0) {
        return (
            <div className="card empty">
                <p className="value">No job boards yet</p>
                <p>They appear once the app knows which boards your jobs come from.</p>
            </div>
        );
    }

    const waiting = queueByBoard(snap?.queue);
    const board = boards.find((b) => b.board === selected) ?? boards[0];
    const [tone, label] = TONE[board.state] ?? ['idle', board.state];
    const lines = board.lines ?? [];
    const live = LIVE.includes(board.state);

    const activity = (
        <div className="board-activity">
            <p className="label">Activity</p>
            {lines.length === 0
                ? <p className="muted" style={{ marginTop: 6 }}>Nothing yet.</p>
                : (
                    <div className="log" style={{ maxHeight: 'none', marginTop: 6 }}>
                        {[...lines].reverse().map((l, i) => (
                            <div className="log-line" key={i}>
                                <span className="log-time">{time(l.at)}</span>
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
                        <strong>{board.label}</strong>
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

            {/* Sub-tabs, hidden in full screen where the point is the page. */}
            {!full && (
                <div className="subtabs" role="tablist">
                    {boards.map((b) => {
                        const [t] = TONE[b.state] ?? ['idle'];
                        return (
                            <button
                                key={b.board}
                                type="button"
                                role="tab"
                                aria-selected={b.board === board.board}
                                className="subtab"
                                onClick={() => setSelected(b.board)}
                            >
                                <span
                                    className={`dot tone-${t}${LIVE.includes(b.state) ? ' live' : ''}`}
                                />
                                {b.label}
                                <span className="subtab-count">{waiting[b.board] ?? 0}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {!full && (
                <div className="row">
                    <div className="counts">
                        <span><strong>{waiting[board.board] ?? 0}</strong> in queue</span>
                        <span className="counts-sep" />
                        <span><strong>{applied[board.board] ?? 0}</strong> applied</span>
                        {!board.canFill && (
                            <>
                                <span className="counts-sep" />
                                <span className="muted">filling not switched on</span>
                            </>
                        )}
                    </div>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        {board.state === 'SIGNED_OUT' && (
                            <button
                                type="button"
                                className="primary"
                                onClick={() => window.smartapply.signIn(board.board)}
                                title="Opens a proper browser window for this board"
                            >
                                Sign in
                            </button>
                        )}
                        {embedded && (
                            <button
                                type="button"
                                className="secondary"
                                onClick={() => setFull(true)}
                            >
                                Full screen
                            </button>
                        )}
                    </span>
                </div>
            )}

            {embedded ? (
                <div className={full ? 'board-split full' : 'board-split'}>
                    <div ref={slot} className="board-view" />
                    {!full && activity}
                </div>
            ) : (
                <>
                    <p className="note">This build opens boards in a separate browser window.</p>
                    {activity}
                </>
            )}
        </>
    );
};

export default Boards;
