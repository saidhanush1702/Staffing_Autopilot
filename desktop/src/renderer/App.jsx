import { useCallback, useEffect, useState } from 'react';
import Activation from './screens/Activation.jsx';
import Status from './screens/Status.jsx';

/**
 * The whole app is two screens: activate, or show what is happening.
 *
 * All state arrives from the main process — this component never fetches
 * anything, because the renderer has no network access at all. It subscribes to
 * pushes and asks for a snapshot on mount, and that is the entirety of its
 * relationship with the outside world.
 */
const App = () => {
    const [snap, setSnap] = useState(null);
    const [log, setLog] = useState([]);

    const refresh = useCallback(async () => {
        setSnap(await window.smartapply.snapshot());
    }, []);

    useEffect(() => {
        refresh();
        const offStatus = window.smartapply.onStatus(setSnap);
        const offLog = window.smartapply.onLog(
            (line) => setLog((prev) => [...prev.slice(-80), line]),
        );
        return () => { offStatus(); offLog(); };
    }, [refresh]);

    if (!snap) {
        return <div className="wrap"><p className="sub">Starting…</p></div>;
    }

    // Revocation is terminal and gets the whole screen. Anything less would let
    // a consultant keep clicking at an app that has already wiped itself.
    if (snap.state === 'REVOKED') {
        return (
            <div className="wrap">
                <h1>Access removed</h1>
                <p className="sub">{snap.detail || 'An administrator revoked this device.'}</p>
                <div className="note stop">
                    Everything this app held on your machine has been deleted, including
                    saved sign-ins. Ask your administrator for a new activation code if
                    you should still have access.
                </div>
            </div>
        );
    }

    return snap.activated
        ? <Status snap={snap} log={log} onRefresh={refresh} />
        : <Activation onActivated={refresh} />;
};

export default App;
