import { useState } from 'react';

/**
 * First run, and only ever once.
 *
 * ── WHAT IS NOT ON THIS SCREEN ────────────────────────────────────────
 *
 * There is no email field, no password field, and no way to type a portal
 * credential. R-18 says the app never holds, stores or transmits a portal
 * password, and the cleanest way to honour that is for no such input to exist
 * anywhere in the codebase.
 *
 * The one-time code identifies the person AND binds to this machine, so it takes
 * the place of a login entirely.
 */
const Activation = ({ onActivated }) => {
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const res = await window.smartapply.activate(code.trim());
        setBusy(false);
        if (res.ok) onActivated();
        else setError(res.error);
    };

    return (
        <div className="wrap">
            <h1>Set up SmartApply</h1>
            <p className="sub">
                Enter the activation code your administrator gave you. You only do this once.
            </p>

            <form className="card" onSubmit={submit}>
                <label className="label" htmlFor="code">Activation code</label>
                <div style={{ marginTop: 6 }}>
                    <input
                        id="code"
                        value={code}
                        onChange={(ev) => setCode(ev.target.value)}
                        placeholder="XXXX-XXXX-XXXX"
                        autoFocus
                        spellCheck={false}
                    />
                </div>

                {error && <p className="note stop" style={{ marginTop: 12 }}>{error}</p>}

                <div style={{ marginTop: 14 }}>
                    <button type="submit" className="primary" disabled={busy || code.trim().length < 4}>
                        {busy ? 'Activating…' : 'Activate'}
                    </button>
                </div>
            </form>

            <div className="note" style={{ marginTop: 16 }}>
                <strong>This app never asks for a job-board password.</strong> When a job
                needs you signed in somewhere, it opens a normal browser window and
                steps aside so you can sign in yourself — including any code sent to
                your phone. Your sign-ins stay on this machine.
            </div>

            <p className="muted" style={{ marginTop: 12 }}>
                The code works on this computer only, and expires. If it does not work,
                ask your administrator to issue a new one.
            </p>
        </div>
    );
};

export default Activation;
