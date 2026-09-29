import { useState } from 'react';

/**
 * ── WHAT THE LAST PASS ACTUALLY DID ───────────────────────────────────
 *
 * The app used to finish a run and say nothing. Jobs left the queue, some were
 * applied to, some were not, and the only account of it was a scrolling log
 * where each job's fate was one line among forty.
 *
 * ── WHY THE REASONS ARE THE POINT, NOT THE COUNTS ─────────────────────
 *
 * "6 skipped" is not information. Six closed postings is a normal afternoon;
 * six errors means something is broken; six already-applied means the queue is
 * repeating itself — three completely different situations behind one number.
 *
 * So every group opens to name the jobs and quote the reason recorded against
 * each one. The counts are the summary; the reasons are the answer.
 *
 * ── AND WHY IT IS ORDERED BY WHAT NEEDS DOING ─────────────────────────
 *
 * Not by size, and not by the order things happened. Anything waiting on the
 * consultant comes first, then anything they could unblock, then the rest —
 * because the only reason to read a summary is to find out what to do next.
 */
const GROUPS = [
    ['SUBMITTED', 'Applied', 'ok'],
    ['READY_TO_SUBMIT', 'Filled, waiting for you', 'warn'],
    ['PARKED', 'Waiting on an answer', 'warn'],
    ['HANDED_OVER', 'For you to apply by hand', 'idle'],
    ['CLOSED', 'Expired — no longer accepting applications', 'idle'],
    ['ALREADY_APPLIED', 'Already applied', 'idle'],
    ['NEEDS_SIGN_IN', 'Needs you to sign in', 'warn'],
    ['BOARD_STOPPED', 'Board stopped for the day', 'stop'],
    ['ERROR', 'Could not be processed', 'stop'],
];

const when = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

const Group = ({ label, tone, rows }) => {
    const [open, setOpen] = useState(false);
    return (
        <div className="pad">
            <div className="row">
                <button
                    type="button"
                    className="quiet disclosure"
                    onClick={() => setOpen((v) => !v)}
                >
                    <span className={`chevron${open ? ' open' : ''}`} />
                    <span>{label}</span>
                </button>
                <span className={`pill ${tone}`}>{rows.length}</span>
            </div>

            {open && (
                <div style={{ marginTop: 8 }}>
                    {rows.map((r, i) => (
                        <div className="qa" key={`${r.company}-${i}`}>
                            <p className="qa-a">
                                {r.company}
                                {/* The agent's work is marked, because it is the work
                                    to read most closely before it is sent. */}
                                {r.filledBy === 'AGENT' && (
                                    <span className="pill brand" style={{ marginLeft: 8 }}>AI agent</span>
                                )}
                            </p>
                            <p className="qa-q">
                                {r.title}
                                {r.board ? ` · ${r.board}` : ''}
                            </p>
                            {r.reason && <p className="muted" style={{ marginTop: 3 }}>{r.reason}</p>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

const LastRun = ({ snap }) => {
    const run = (snap.cycleLog ?? [])[0];
    if (!run) return null;

    const outcomes = run.outcomes ?? [];
    // A pass that looked at nothing is not worth a card. It happens constantly
    // — the loop polls whether or not there is work — and reporting each one
    // would bury the run that actually did something.
    if (outcomes.length === 0 && !run.stopped) return null;

    const groups = GROUPS
        .map(([key, label, tone]) => [label, tone, outcomes.filter((o) => o.result === key)])
        .filter(([, , rows]) => rows.length > 0);

    // Anything the ledger does not have a heading for still has to appear.
    const named = new Set(GROUPS.map(([k]) => k));
    const rest = outcomes.filter((o) => !named.has(o.result));
    if (rest.length > 0) groups.push(['Other', 'idle', rest]);

    const applied = outcomes.filter((o) => o.result === 'SUBMITTED').length;
    const byAgent = outcomes.filter(
        (o) => o.filledBy === 'AGENT' && (o.result === 'SUBMITTED' || o.result === 'READY_TO_SUBMIT'),
    ).length;
    const needsYou = outcomes.filter(
        (o) => o.result === 'READY_TO_SUBMIT' || o.result === 'PARKED'
            || o.result === 'HANDED_OVER' || o.result === 'NEEDS_SIGN_IN',
    ).length;

    return (
        <section className="card flush">
            <div className="pad row">
                <div>
                    <p className="label">Last run</p>
                    <p className="muted" style={{ marginTop: 2 }}>
                        {outcomes.length} job{outcomes.length === 1 ? '' : 's'} worked
                        {run.at ? ` · finished ${when(run.at)}` : ''}
                        {run.stopped ? ' · stopped part-way' : ''}
                        {byAgent > 0 ? ` · ${byAgent} filled by the AI agent` : ''}
                    </p>
                </div>
                <span className={`pill ${applied > 0 ? 'ok' : 'idle'}`}>
                    {applied} applied
                </span>
            </div>

            {needsYou > 0 && (
                <div className="pad" style={{ paddingTop: 0 }}>
                    <p className="note warn">
                        {needsYou} of these need something from you. Open the group to see
                        which, and why.
                    </p>
                </div>
            )}

            <div className="divide">
                {groups.map(([label, tone, rows]) => (
                    <Group key={label} label={label} tone={tone} rows={rows} />
                ))}
            </div>
        </section>
    );
};

export default LastRun;
