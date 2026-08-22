import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * ── ONE CARD PER JOB BOARD ────────────────────────────────────────────
 *
 * Collapsed, a card answers "is this board working?" in one line. Expanded, it
 * shows the board's live page — the actual automation, happening — with its
 * activity beside it.
 *
 * ── WHY THE PAGE IS A HOLE IN THE CARD ────────────────────────────────
 *
 * The live page is an Electron view: a native layer painted ON TOP of this
 * HTML, not an element inside it. React cannot draw it and cannot clip it.
 *
 * So the card leaves a gap of exactly the right size, measures where that gap
 * ended up on screen, and asks the main process to move the view there. When
 * the card collapses, or the tab changes, or the window is resized, the view is
 * moved away or repositioned to match. Everything here is bookkeeping for that
 * one illusion.
 *
 * Only one board's page is on screen at a time — they would otherwise stack on
 * top of each other, since none of them is clipped by anything.
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
    SIGNED_IN: ['ok', 'Signed in'],
    SIGNED_OUT: ['warn', 'Signed out'],
    STOPPED: ['stop', 'Stopped'],
    ERROR: ['stop', 'Problem'],
};

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

const Board = ({ board, embedded, openBoard, setOpenBoard }) => {
    const slot = useRef(null);
    const open = openBoard === board.board;

    const [tone, label] = TONE[board.state] ?? ['idle', board.state];
    const lines = board.lines ?? [];
    const latest = lines[lines.length - 1];
    const live = ['CONNECTING', 'WORKING', 'FILLING', 'SUBMITTING'].includes(board.state);

    // Keep the native view sitting exactly over the gap this card left for it.
    useLayoutEffect(() => {
        if (!open || !embedded) return undefined;

        const place = () => {
            const box = slot.current?.getBoundingClientRect();
            if (!box || box.width < 2) return;
            window.smartapply.showBoardView(board.board, {
                x: box.left, y: box.top, width: box.width, height: box.height,
            });
        };

        place();
        // The gap moves whenever anything above it does.
        const onScroll = () => place();
        const observer = new ResizeObserver(place);
        if (slot.current) observer.observe(slot.current);
        window.addEventListener('resize', onScroll, true);
        document.querySelector('.screen')?.addEventListener('scroll', onScroll, true);

        return () => {
            observer.disconnect();
            window.removeEventListener('resize', onScroll, true);
            document.querySelector('.screen')?.removeEventListener('scroll', onScroll, true);
            window.smartapply.hideBoardView(board.board);
        };
    }, [open, embedded, board.board]);

    return (
        <div className="card stack">
            <div className="row">
                <button
                    type="button"
                    className="quiet disclosure"
                    aria-expanded={open}
                    onClick={() => setOpenBoard(open ? null : board.board)}
                >
                    <span className={`chevron${open ? ' open' : ''}`} aria-hidden="true" />
                    <span>
                        <strong>{board.label}</strong>
                        <p className="muted" style={{ marginTop: 2 }}>
                            {latest ? `${latest.message} · ${time(latest.at)}` : 'Nothing yet'}
                        </p>
                    </span>
                </button>

                <span className={`pill ${tone}`}>
                    <span className={`dot${live ? ' live' : ''}`} />
                    {label}
                </span>
            </div>

            {!board.canFill && (
                <p className="muted">
                    Form filling is not switched on for this board — its jobs are opened
                    and passed to you.
                </p>
            )}

            {board.state === 'SIGNED_OUT' && (
                <div className="row">
                    <span className="muted">
                        {board.until
                            ? `On hold until ${new Date(board.until).toLocaleString()}`
                            : embedded
                                ? 'Open this board and sign in below.'
                                : 'Sign in and this board carries on by itself.'}
                    </span>
                    <button
                        type="button"
                        className="primary"
                        onClick={() => {
                            setOpenBoard(board.board);
                            window.smartapply.signIn(board.board);
                        }}
                    >
                        Sign in
                    </button>
                </div>
            )}

            {open && (
                <>
                    {embedded ? (
                        <div>
                            <p className="label" style={{ marginBottom: 6 }}>Live page</p>
                            {/* The gap the native view is moved over. */}
                            <div ref={slot} className="board-view" />
                            <p className="muted" style={{ marginTop: 6 }}>
                                This is the real page the app is working in. You can use it —
                                signing in here is how the board remembers you.
                            </p>
                        </div>
                    ) : (
                        <p className="note">
                            This build opens boards in a separate browser window.
                        </p>
                    )}

                    <div>
                        <p className="label" style={{ marginBottom: 6 }}>
                            Activity {lines.length > 0 ? `(${lines.length})` : ''}
                        </p>
                        {lines.length === 0 ? (
                            <p className="muted">Nothing yet.</p>
                        ) : (
                            <div className="log">
                                {[...lines].reverse().map((l, i) => (
                                    <div className="log-line" key={i}>
                                        <span className="log-time">{time(l.at)}</span>
                                        <span>{l.message}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

const Boards = ({ boards }) => {
    const [embedded, setEmbedded] = useState(false);
    const [openBoard, setOpenBoard] = useState(null);

    useEffect(() => {
        window.smartapply.browserIsEmbedded().then((r) => setEmbedded(Boolean(r.embedded)));
        // Leaving this tab must take the view with it — it floats above the
        // whole window and would otherwise cover whatever came next.
        return () => { window.smartapply.hideBoardView(null); };
    }, []);

    if (!boards || boards.length === 0) {
        return (
            <div className="card empty">
                <p className="value">No job boards yet</p>
                <p>They appear once the app knows which boards your jobs come from.</p>
            </div>
        );
    }

    return boards.map((b) => (
        <Board
            key={b.board}
            board={b}
            embedded={embedded}
            openBoard={openBoard}
            setOpenBoard={setOpenBoard}
        />
    ));
};

export default Boards;
