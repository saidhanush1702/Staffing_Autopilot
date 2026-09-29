import { useState } from 'react';
import { Mark, IconShield } from '../icons.jsx';
import ThemeButton from './ThemeButton.jsx';

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
 *
 * ── WHY THE PROMISE IS ON THE FIRST SCREEN ────────────────────────────
 *
 * "This app never asks for a job-board password" is the single most important
 * thing a consultant can know about it, and the moment they are most likely to
 * doubt it is the moment they are typing a code into an app they have never
 * run. So it is stated here, before anything is entered — not in a settings
 * page nobody opens.
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
            <div style={{ position: 'fixed', top: 12, right: 14 }}>
                <ThemeButton />
            </div>

            <div className="centred-inner">
                <div style={{ textAlign: 'center', marginBottom: 22 }}>
                    <span className="mark" style={{ margin: '0 auto 14px', width: 44, height: 44, borderRadius: 13 }}>
                        <Mark />
                    </span>
                    <h1>Activate SmartApply</h1>
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
                            style={{ marginTop: 7 }}
                        />
                    </div>

                    {error && <p className="note stop">{error}</p>}

                    <button
                        type="submit"
                        className="primary big"
                        disabled={busy || code.trim().length < 4}
                    >
                        {busy ? 'Activating…' : 'Activate this computer'}
                    </button>
                </form>

                <div className="note" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{ flex: '0 0 auto', width: 16, height: 16, marginTop: 1 }}>
                        <IconShield />
                    </span>
                    <span>
                        <strong>This app never asks for a job-board password.</strong> When a
                        job needs you signed in somewhere, it opens a normal browser window and
                        steps aside so you can sign in yourself — including any code sent to
                        your phone. Your sign-ins stay on this machine.
                    </span>
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
