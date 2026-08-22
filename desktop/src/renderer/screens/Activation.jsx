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
 * The one-time code identifies the person AND binds to this machine, so it
 * takes the place of a login entirely.
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
        <div className="centred">
            <div className="centred-inner">
                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                    <h1>SmartApply</h1>
                    <p className="sub">
                        Enter the activation code your administrator gave you.
                        You only do this once.
                    </p>
                </div>

                <form className="card stack" onSubmit={submit}>
                    <div>
                        <label className="label" htmlFor="code">Activation code</label>
                        <input
                            id="code"
                            value={code}
                            onChange={(ev) => setCode(ev.target.value)}
                            placeholder="XXXX-XXXX-XXXX"
                            autoFocus
                            spellCheck={false}
                            style={{ marginTop: 6 }}
                        />
                    </div>

                    {error && <p className="note stop">{error}</p>}

                    <button
                        type="submit"
                        className="primary big"
                        disabled={busy || code.trim().length < 4}
                    >
                        {busy ? 'Activating…' : 'Activate'}
                    </button>
                </form>

                <div className="note" style={{ marginTop: 14 }}>
                    <strong>This app never asks for a job-board password.</strong> When a
                    job needs you signed in somewhere, it opens a normal browser window and
                    steps aside so you can sign in yourself — including any code sent to
                    your phone. Your sign-ins stay on this machine.
                </div>

                <p className="muted" style={{ marginTop: 12, textAlign: 'center' }}>
                    The code works on this computer only, and expires. If it does not work,
                    ask your administrator for a new one.
                </p>
            </div>
        </div>
    );
};

export default Activation;
