import { useState } from 'react';

/**
 * ── ONE CARD PER JOB BOARD ────────────────────────────────────────────
 *
 * What the app is doing, board by board, in the board's own words: connecting,
 * reading a page, filling, waiting for you, stopped.
 *
 * ── WHY IT IS SPLIT BY BOARD RATHER THAN BEING ONE LOG ────────────────
 *
 * A single stream interleaves three boards, and the question a consultant
 * actually has is never "what happened at 14:32" — it is "is LinkedIn working?"
 * Answering that from a merged log means reading past everything else. Split by
 * board, it is the first line of the right card.
 *
 * Every board is listed even when it has done nothing. A board that is absent
 * because nothing has happened looks identical to a board that is broken.
 */
const TONE = {
    IDLE: ['idle', 'Idle'],
    CONNECTING: ['ok', 'Connecting'],
    WORKING: ['ok', 'Working'],
    FILLING: ['ok', 'Filling'],
    SUBMITTING: ['ok', 'Submitting'],
    SUBMITTED: ['ok', 'Submitted'],
    READY_TO_SUBMIT: ['warn', 'Waiting on you'],
    PARKED: ['warn', 'Parked'],
    HANDED_OVER: ['idle', 'Handed to you'],
    SIGNED_IN: ['ok', 'Signed in'],
    SIGNED_OUT: ['warn', 'Signed out'],
    STOPPED: ['stop', 'Stopped'],
    ERROR: ['stop', 'Problem'],
};

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

const Board = ({ board }) => {
    const [open, setOpen] = useState(false);
    const [tone, label] = TONE[board.state] ?? ['idle', board.state];
    const lines = board.lines ?? [];
    const latest = lines[lines.length - 1];

    return (
        <div className="card">
            <div className="row">
                <div>
                    <strong>{board.label}</strong>
                    <p className="muted" style={{ margin: '2px 0 0' }}>
                        {latest ? latest.message : 'Nothing yet'}
                        {latest ? ` · ${time(latest.at)}` : ''}
                    </p>
                    {!board.canFill && (
                        <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                            Form filling is not switched on for this board yet — jobs here are
                            opened and passed to you.
                        </p>
                    )}
                </div>
                <span className={`pill ${tone}`}>{label}</span>
            </div>

            {board.state === 'SIGNED_OUT' && (
                <div className="row" style={{ marginTop: 10 }}>
                    <span className="muted">
                        {board.until
                            ? `On hold until ${new Date(board.until).toLocaleString()}`
                            : 'Sign in and this board carries on by itself.'}
                    </span>
                    <button
                        type="button"
                        className="primary"
                        onClick={() => window.smartapply.signIn(board.board)}
                    >
                        Sign in
                    </button>
                </div>
            )}

            {lines.length > 0 && (
                <>
                    <p style={{ margin: '10px 0 0' }}>
                        <button type="button" className="secondary" onClick={() => setOpen(!open)}>
                            {open ? 'Hide activity' : `Activity (${lines.length})`}
                        </button>
                    </p>
                    {open && (
                        <div className="card log" style={{ marginTop: 8 }}>
                            {lines.map((l, i) => (
                                <div key={i}>{`${time(l.at)}  ${l.message}`}</div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

const Boards = ({ boards }) => {
    if (!boards || boards.length === 0) return null;
    return (
        <>
            <h2>Job boards</h2>
            {boards.map((b) => <Board key={b.board} board={b} />)}
        </>
    );
};

export default Boards;
