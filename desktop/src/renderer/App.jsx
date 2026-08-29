import { useCallback, useEffect, useState } from 'react';
import Activation from './screens/Activation.jsx';
import Work from './screens/Work.jsx';
import Boards from './screens/Boards.jsx';
import Questions from './screens/Questions.jsx';
import Answers from './screens/Answers.jsx';
import Applied from './screens/Applied.jsx';
import Activity from './screens/Activity.jsx';
import StatusPill from './screens/StatusPill.jsx';
import Attention from './screens/Attention.jsx';
import ThemeButton from './screens/ThemeButton.jsx';
import {
    Mark, IconWork, IconQuestion, IconAnswers, IconBoards, IconApplied, IconActivity,
} from './icons.jsx';

/**
 * ── THE SHELL ─────────────────────────────────────────────────────────
 *
 * Six tabs, one job each:
 *
 *   Work       what is happening now, and anything waiting on you
 *   Questions  applications held up because nobody has answered something
 *   Answers    the approved answer bank, for reference
 *   Boards     each job board's own state and story
 *   Applied    what has actually gone out
 *   Activity   the raw log, for when something looks wrong
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
 * ── WHY THE TABS CARRY ICONS ──────────────────────────────────────────
 *
 * Six text labels in a row are six words to read every time. A glyph beside
 * each gives the row a shape that is recognised rather than read, which is
 * what makes returning to the same tab all day cheap. The labels stay: an
 * icon-only tab bar is a quiz.
 *
 * All state still arrives from the main process. This component fetches
 * nothing, because the renderer has no network access at all.
 */
const TABS = [
    { id: 'work', label: 'Work', icon: IconWork },
    { id: 'questions', label: 'Questions', icon: IconQuestion },
    { id: 'answers', label: 'Answers', icon: IconAnswers },
    { id: 'boards', label: 'Boards', icon: IconBoards },
    { id: 'applied', label: 'Applied', icon: IconApplied },
    { id: 'activity', label: 'Activity', icon: IconActivity },
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
                    <span className="mark" style={{ margin: '0 auto 14px' }}><Mark /></span>
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
                    <div className="card stack">
                        <div className="row">
                            <h1>Access removed</h1>
                            <span className="pill stop">Revoked</span>
                        </div>
                        <p className="sub" style={{ marginTop: 0 }}>
                            {snap.detail || 'An administrator revoked this device.'}
                        </p>
                        <div className="note stop">
                            Everything this app held on your machine has been deleted, including
                            saved sign-ins. Ask your administrator for a new activation code if
                            you should still have access.
                        </div>
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
                <span className="mark"><Mark /></span>
                <div>
                    <div className="brand">SmartApply</div>
                    <div className="brand-sub">{snap.consultant?.name ?? 'Consultant'}</div>
                </div>
                <div className="topbar-spacer" />
                <StatusPill snap={snap} />
                <ThemeButton />
            </header>

            <nav className="tabs" role="tablist">
                {TABS.map((t) => {
                    const Icon = t.icon;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === t.id}
                            className="tab"
                            onClick={() => setTab(t.id)}
                        >
                            <Icon />
                            {t.label}
                            {counts[t.id] > 0 && (
                                <span
                                    className={`tab-count${['work', 'questions'].includes(t.id) ? ' alert' : ''}`}
                                >
                                    {counts[t.id]}
                                </span>
                            )}
                        </button>
                    );
                })}
            </nav>

            {/* Above the tabs, deliberately: the automation has STOPPED and is
                waiting on a person, and that must not be something you have to
                be on the right tab to discover. */}
            <Attention attention={snap.attention} onChanged={refresh} />

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
