import { useCallback, useEffect, useState } from 'react';
import Activation from './screens/Activation.jsx';
import Work from './screens/Work.jsx';
import Boards from './screens/Boards.jsx';
import Questions from './screens/Questions.jsx';
import Answers from './screens/Answers.jsx';
import Applied from './screens/Applied.jsx';
import Activity from './screens/Activity.jsx';
import StatusPill from './screens/StatusPill.jsx';

/**
 * ── THE SHELL ─────────────────────────────────────────────────────────
 *
 * Four tabs, one job each:
 *
 *   Work      what is happening now, and anything waiting on you
 *   Boards    each job board's own state and story
 *   Applied   what has actually gone out
 *   Activity  the raw log, for when something looks wrong
 *
 * ── WHY TABS RATHER THAN ONE PAGE ─────────────────────────────────────
 *
 * Everything used to live on a single scrolling screen: controls, review
 * queue, board cards, counters, history and log, in that order. Each part was
 * fine and the whole was unreadable — the one thing a consultant opens the app
 * to see, "is anything waiting on me?", was several screens down.
 *
 * The split follows how often each is needed. Work is where the app opens and
 * where most people never leave; Activity exists for the day something breaks.
 *
 * All state still arrives from the main process. This component fetches
 * nothing, because the renderer has no network access at all.
 */
const TABS = [
    { id: 'work', label: 'Work' },
    { id: 'questions', label: 'Questions' },
    { id: 'answers', label: 'Answers' },
    { id: 'boards', label: 'Boards' },
    { id: 'applied', label: 'Applied' },
    { id: 'activity', label: 'Activity' },
];

const App = () => {
    const [snap, setSnap] = useState(null);
    const [log, setLog] = useState([]);
    const [tab, setTab] = useState('work');
    // Set when something asks for a board to be shown — a sign-in prompt, or
    // the Work tab handing over. Boards opens that card and clears it.
    const [showBoard, setShowBoard] = useState(null);

    const refresh = useCallback(async () => {
        setSnap(await window.smartapply.snapshot());
    }, []);

    useEffect(() => {
        refresh();
        const offStatus = window.smartapply.onStatus(setSnap);
        const offLog = window.smartapply.onLog(
            (line) => setLog((prev) => [...prev.slice(-200), { at: new Date(), line }]),
        );
        const offShow = window.smartapply.onShowBoard((board) => {
            setTab('boards');
            setShowBoard(board);
        });
        return () => { offStatus(); offLog(); offShow(); };
    }, [refresh]);

    if (!snap) {
        return (
            <div className="centred">
                <div className="centred-inner empty">
                    <p className="value">Starting…</p>
                </div>
            </div>
        );
    }

    // Revocation is terminal and takes the whole window. Anything less would
    // leave someone clicking at an app that has already wiped itself.
    if (snap.state === 'REVOKED') {
        return (
            <div className="centred">
                <div className="centred-inner">
                    <h1>Access removed</h1>
                    <p className="sub">
                        {snap.detail || 'An administrator revoked this device.'}
                    </p>
                    <div className="note stop" style={{ marginTop: 16 }}>
                        Everything this app held on your machine has been deleted, including
                        saved sign-ins. Ask your administrator for a new activation code if
                        you should still have access.
                    </div>
                </div>
            </div>
        );
    }

    if (!snap.activated) return <Activation onActivated={refresh} />;

    const waiting = snap.awaitingReview?.length ?? 0;
    const needsSignIn = (snap.boards ?? []).filter((b) => b.state === 'SIGNED_OUT').length;

    const counts = {
        work: waiting,
        // Every one of these is an application that cannot be sent, so it is
        // flagged as loudly as work waiting on a person.
        questions: snap.outstandingQuestions ?? 0,
        answers: 0,
        boards: needsSignIn,
        applied: 0,
        activity: 0,
    };

    return (
        <div className="app">
            <header className="topbar">
                <div>
                    <div className="brand">SmartApply</div>
                    <div className="brand-sub">{snap.consultant?.name ?? 'Consultant'}</div>
                </div>
                <div className="topbar-spacer" />
                <StatusPill snap={snap} />
            </header>

            <nav className="tabs" role="tablist">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === t.id}
                        className="tab"
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}
                        {counts[t.id] > 0 && (
                            <span
                                className={`tab-count${['work', 'questions'].includes(t.id) ? ' alert' : ''}`}
                            >
                                {counts[t.id]}
                            </span>
                        )}
                    </button>
                ))}
            </nav>

            {/* Boards is a live browser page; it gets the whole window. The
                reading tabs stay in a capped column. */}
            <main className={`screen${tab === 'boards' ? ' flush' : ''}`}>
                <div className={`screen-inner${tab === 'boards' ? ' wide' : ''}`}>
                    {tab === 'work' && (
                        <Work
                            snap={snap}
                            onRefresh={refresh}
                            onOpenBoard={(board) => { setTab('boards'); setShowBoard(board); }}
                        />
                    )}
                    {tab === 'questions' && <Questions onChanged={refresh} />}
                    {tab === 'answers' && <Answers onChanged={refresh} />}
                    {tab === 'boards' && (
                        <Boards
                            boards={snap.boards}
                            snap={snap}
                            showBoard={showBoard}
                            onShown={() => setShowBoard(null)}
                        />
                    )}
                    {tab === 'applied' && <Applied />}
                    {tab === 'activity' && <Activity log={log} snap={snap} />}
                </div>
            </main>
        </div>
    );
};

export default App;
