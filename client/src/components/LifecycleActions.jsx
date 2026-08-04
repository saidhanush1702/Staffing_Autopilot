import { useState } from 'react';
import { createPortal } from 'react-dom';
import { PauseCircle, PlayCircle, XOctagon, Loader2, AlertTriangle } from 'lucide-react';
import api, { errorMessage } from '../api/axios.js';

/**
 * Suspend / Reactivate / Terminate.
 *
 *   ACTIVE     → [Suspend] [Terminate]
 *   SUSPENDED  → [Reactivate] [Terminate]
 *   TERMINATED → nothing. It is permanent, so no control is offered.
 *
 * Termination asks for confirmation and states plainly that it cannot be
 * undone — the server refuses a reactivate either way, but a destructive
 * action should never be one accidental click away.
 */
const LifecycleActions = ({ user, onDone }) => {
    const [dialog, setDialog] = useState(null);   // 'suspend' | 'terminate'
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const status = user.employment_status ?? 'ACTIVE';
    if (status === 'TERMINATED') {
        return <span className="text-xs text-slate-400">No actions</span>;
    }

    const run = async (action, body) => {
        setBusy(true);
        setError('');
        try {
            await api.post(`/management/users/${user.id}/${action}`, body ?? {});
            setDialog(null);
            setReason('');
            await onDone();
        } catch (err) {
            setError(errorMessage(err, 'Action failed.'));
        } finally {
            setBusy(false);
        }
    };

    const btn = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors';

    return (
        <>
            <span className="flex flex-wrap justify-end gap-1.5">
                {status === 'ACTIVE' ? (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDialog('suspend'); }}
                        title="Remove portal access — reversible"
                        className={`${btn} border-slate-300 text-slate-600 hover:bg-amber-50`}
                    >
                        <PauseCircle className="h-3.5 w-3.5" /> Suspend
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); run('reactivate'); }}
                        disabled={busy}
                        title="Restore portal access"
                        className={`${btn} border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}
                    >
                        <PlayCircle className="h-3.5 w-3.5" /> Reactivate
                    </button>
                )}

                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setDialog('terminate'); }}
                    title="Permanently end employment — cannot be undone"
                    className={`${btn} border-red-200 text-red-600 hover:bg-red-50`}
                >
                    <XOctagon className="h-3.5 w-3.5" /> Terminate
                </button>
            </span>

            {/* Rendered into <body>, not into the table cell this component
                lives in. A `fixed` overlay nested inside a table is laid out
                against the nearest positioned/transformed ancestor and clipped
                by any `overflow` on the way up, which is why the dialog came
                out mis-centred and cropped. A portal has no ancestors to
                inherit, so it centres on the viewport every time. */}
            {dialog && createPortal(
                <div
                    role="dialog"
                    aria-modal="true"
                    className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4"
                    onClick={(e) => { e.stopPropagation(); setDialog(null); setError(''); }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        className="my-auto w-full max-w-sm rounded-xl bg-white p-5 shadow-xl sm:p-6"
                    >
                        {dialog === 'terminate' ? (
                            <>
                                <div className="flex items-start gap-2">
                                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                                    <div>
                                        <h2 className="text-base font-semibold text-slate-900">
                                            Terminate {user.name}?
                                        </h2>
                                        <p className="mt-1 text-sm text-slate-600">
                                            They will lose portal access permanently and stop being an
                                            employee of this organization.
                                        </p>
                                        <p className="mt-2 text-sm font-medium text-red-700">
                                            This cannot be undone. A terminated person can never be
                                            reactivated — you would have to create a new account.
                                        </p>
                                        <p className="mt-2 text-xs text-slate-500">
                                            Their record and history are kept. Any current assignment
                                            is released.
                                        </p>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                <h2 className="text-base font-semibold text-slate-900">
                                    Suspend {user.name}?
                                </h2>
                                <p className="mt-1 text-sm text-slate-600">
                                    They cannot sign in until reactivated, but remain an employee.
                                    Use this for leave or a temporary hold.
                                </p>
                            </>
                        )}

                        {error && (
                            <p className="mt-3 rounded-lg bg-red-50 p-2 text-xs text-red-700">{error}</p>
                        )}

                        <label className="mt-4 block">
                            <span className="text-sm text-slate-600">
                                Reason {dialog === 'terminate' ? '(recorded permanently)' : '(optional)'}
                            </span>
                            <input
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                autoFocus
                                placeholder={dialog === 'terminate' ? 'Resigned, contract ended…' : 'On leave…'}
                                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                            />
                        </label>

                        {/* Stacked on phones so neither button gets truncated;
                            side by side from sm up, confirm last. */}
                        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                onClick={() => { setDialog(null); setError(''); }}
                                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => run(dialog, { reason: reason || null })}
                                className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${dialog === 'terminate' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'}`}
                            >
                                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                {dialog === 'terminate' ? 'Terminate permanently' : 'Suspend access'}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </>
    );
};

export default LifecycleActions;
