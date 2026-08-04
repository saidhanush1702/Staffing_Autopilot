import { useState } from 'react';
import { PauseCircle, PlayCircle, XOctagon, AlertTriangle } from 'lucide-react';
import api, { errorMessage } from '../api/axios.js';
import Modal, { ModalActions } from './ui/Modal.jsx';
import { btnSm, input, fieldLabel, TONE_ALERT } from '../design/tokens.js';

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

    const isTerminate = dialog === 'terminate';

    return (
        <>
            <span className="flex flex-wrap justify-end gap-1.5">
                {status === 'ACTIVE' ? (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDialog('suspend'); }}
                        title="Remove portal access — reversible"
                        className={btnSm.caution}
                    >
                        <PauseCircle className="h-3.5 w-3.5" /> Suspend
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); run('reactivate'); }}
                        disabled={busy}
                        title="Restore portal access"
                        className={btnSm.success}
                    >
                        <PlayCircle className="h-3.5 w-3.5" /> Reactivate
                    </button>
                )}

                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setDialog('terminate'); }}
                    title="Permanently end employment — cannot be undone"
                    className={btnSm.danger}
                >
                    <XOctagon className="h-3.5 w-3.5" /> Terminate
                </button>
            </span>

            {dialog && (
                <Modal
                    size="sm"
                    tone={isTerminate ? 'danger' : 'warning'}
                    icon={isTerminate ? AlertTriangle : PauseCircle}
                    title={`${isTerminate ? 'Terminate' : 'Suspend'} ${user.name}?`}
                    onClose={() => { setDialog(null); setError(''); }}
                    footer={(
                        <ModalActions
                            onCancel={() => { setDialog(null); setError(''); }}
                            onConfirm={() => run(dialog, { reason: reason || null })}
                            confirmLabel={isTerminate ? 'Terminate permanently' : 'Suspend access'}
                            variant={isTerminate ? 'danger' : 'caution'}
                            busy={busy}
                        />
                    )}
                >
                    {isTerminate ? (
                        <>
                            <p className="text-sm text-slate-600">
                                They will lose portal access permanently and stop being an
                                employee of this organization.
                            </p>
                            <p className="mt-2 text-sm font-medium text-danger-700">
                                This cannot be undone. A terminated person can never be
                                reactivated — you would have to create a new account.
                            </p>
                            <p className="mt-2 text-xs text-slate-500">
                                Their record and history are kept. Any current assignment
                                is released.
                            </p>
                        </>
                    ) : (
                        <p className="text-sm text-slate-600">
                            They cannot sign in until reactivated, but remain an employee.
                            Use this for leave or a temporary hold.
                        </p>
                    )}

                    {error && (
                        <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>{error}</p>
                    )}

                    <label className="mt-4 block">
                        <span className={fieldLabel}>
                            Reason {isTerminate ? '(recorded permanently)' : '(optional)'}
                        </span>
                        <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            autoFocus
                            placeholder={isTerminate ? 'Resigned, contract ended…' : 'On leave…'}
                            className={input}
                        />
                    </label>
                </Modal>
            )}
        </>
    );
};

export default LifecycleActions;
