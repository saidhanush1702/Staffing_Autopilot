import { useCallback, useEffect, useState } from 'react';
import {
    Laptop, Plus, Loader2, AlertCircle, Copy, Check, Power,
    Wifi, WifiOff, Clock, ShieldOff, TriangleAlert,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, input, fieldLabel,
    TONE, TONE_ALERT, pageTitle, pageSubtitle,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, tableEmpty,
} from '../../design/tokens.js';

/** What each device state means, and how urgently it reads. */
const STATE = {
    ONLINE: { tone: 'success', icon: Wifi, text: 'Online' },
    IDLE: { tone: 'neutral', icon: WifiOff, text: 'Idle' },
    PENDING: { tone: 'warning', icon: Clock, text: 'Waiting for activation' },
    EXPIRED: { tone: 'danger', icon: Clock, text: 'Code expired' },
    REVOKED: { tone: 'danger', icon: ShieldOff, text: 'Revoked' },
};

/**
 * Desktop app access — ORG_ADMIN issues, anyone in management can look.
 *
 * ── WHY THE CODE IS SHOWN ONLY ONCE ───────────────────────────────────
 *
 * The activation code is stored hashed, exactly like a password, so nothing can
 * retrieve it later — not this screen, not an admin reading the database. That
 * is deliberate: a code that can be looked up forever is a credential sitting
 * in a table. If it is lost, issue another; issuing revokes the old one.
 */
const Devices = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [devices, setDevices] = useState(null);
    const [consultants, setConsultants] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const [issuing, setIssuing] = useState(false);
    const [chosen, setChosen] = useState('');
    const [issued, setIssued] = useState(null);
    const [copied, setCopied] = useState(false);
    const [revoking, setRevoking] = useState(null);

    const load = useCallback(async () => {
        try {
            const [d, c] = await Promise.all([
                api.get('/management/devices'),
                api.get('/management/consultants?limit=200'),
            ]);
            setDevices(d.data.devices);
            setConsultants((c.data.consultants ?? c.data.data ?? [])
                .filter((x) => x.employment_status === 'ACTIVE'));
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error && !devices) return <p className="text-sm text-danger-700">{error}</p>;
    if (!devices) return <PageLoader />;

    const issue = async () => {
        if (!chosen) return;
        setBusy(true);
        setError('');
        try {
            const { data } = await api.post('/management/devices', { consultantId: chosen });
            setIssued(data);
            setCopied(false);
            await load();
        } catch (err) {
            setError(errorMessage(err, 'Could not issue an activation code.'));
        } finally {
            setBusy(false);
        }
    };

    const revoke = async () => {
        setBusy(true);
        setError('');
        try {
            await api.delete(`/management/devices/${revoking.id}`);
            setRevoking(null);
            await load();
        } catch (err) {
            setError(errorMessage(err, 'Could not revoke that device.'));
        } finally {
            setBusy(false);
        }
    };

    const live = devices.filter((d) => !d.revoked_at);

    return (
        <div>
            <h1 className={pageTitle}>Desktop app access</h1>
            <p className={pageSubtitle}>
                One device per consultant. Issuing a new code replaces whatever they
                had before, and revoking stops the app on its next check-in.
            </p>

            {error && (
                <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>Devices ({live.length} active)</h2>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={() => { setIssuing(true); setChosen(''); setIssued(null); }}
                        className={btn.primary}
                    >
                        <Plus className="h-4 w-4" /> Issue access
                    </button>
                )}
            </div>

            <TableShell className="mt-3" minWidth={880}>
                <thead className={tableHead}>
                    <tr>
                        <th className={tableHeadCell}>Consultant</th>
                        <th className={tableHeadCell}>Machine</th>
                        <th className={tableHeadCell}>State</th>
                        <th className={tableHeadCell}>Last seen</th>
                        <th className={tableHeadCell}>Boards</th>
                        {isAdmin && <th className={tableHeadCell} />}
                    </tr>
                </thead>
                <tbody className={tableBody}>
                    {devices.length === 0 && (
                        <tr><td colSpan={isAdmin ? 6 : 5} className={tableEmpty}>
                            <Laptop className="mx-auto h-8 w-8 text-slate-300" />
                            <p className="mt-2">Nobody has desktop app access yet.</p>
                        </td></tr>
                    )}

                    {devices.map((d) => {
                        const s = STATE[d.state] ?? STATE.IDLE;
                        const stalled = d.stalled_boards ?? [];
                        return (
                            <tr key={d.id} className={tableRow}>
                                <td className={tableCell}>
                                    <p className="font-medium text-slate-900">{d.consultant_name}</p>
                                    {d.issued_by_name && (
                                        <p className="text-xs text-slate-400">
                                            issued by {d.issued_by_name}
                                        </p>
                                    )}
                                </td>
                                <td className={`${tableCell} text-slate-600`}>
                                    {d.machine_label ?? <span className="text-slate-300">—</span>}
                                    {d.app_version && (
                                        <span className="ml-1 text-xs text-slate-400">
                                            v{d.app_version}
                                        </span>
                                    )}
                                </td>
                                <td className={tableCell}>
                                    <span className={`${badge} ${TONE[s.tone]}`}>
                                        <s.icon className="h-3.5 w-3.5" /> {s.text}
                                    </span>
                                    {d.revoke_reason && (
                                        <p className="mt-1 max-w-xs text-xs text-slate-400">
                                            {d.revoke_reason}
                                        </p>
                                    )}
                                </td>
                                <td className={`${tableCell} whitespace-nowrap text-slate-500`}>
                                    {d.last_seen_at
                                        ? new Date(d.last_seen_at).toLocaleString()
                                        : <span className="text-slate-300">never</span>}
                                </td>
                                <td className={tableCell}>
                                    {/* A stalled board is why a consultant is quietly
                                        applying to nothing. It belongs where somebody
                                        will actually see it. */}
                                    {stalled.length === 0
                                        ? <span className="text-xs text-slate-400">all fine</span>
                                        : stalled.map((b) => (
                                            <span
                                                key={b.board}
                                                title={b.state}
                                                className={`${badge} ${TONE.warning} mr-1`}
                                            >
                                                <TriangleAlert className="h-3 w-3" /> {b.board}
                                            </span>
                                        ))}
                                </td>
                                {isAdmin && (
                                    <td className={`${tableCell} text-right`}>
                                        {!d.revoked_at && (
                                            <button
                                                type="button"
                                                onClick={() => setRevoking(d)}
                                                className={btnSm.danger}
                                            >
                                                <Power className="h-3.5 w-3.5" /> Revoke
                                            </button>
                                        )}
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </TableShell>

            {/* ── issue ──────────────────────────────────────────── */}
            {issuing && (
                <Modal
                    size="sm"
                    tone="brand"
                    icon={Laptop}
                    title={issued ? 'Activation code' : 'Issue desktop app access'}
                    onClose={() => { setIssuing(false); setIssued(null); }}
                    footer={issued ? (
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => { setIssuing(false); setIssued(null); }}
                                className={btn.primary}
                            >
                                Done
                            </button>
                        </div>
                    ) : (
                        <ModalActions
                            onCancel={() => setIssuing(false)}
                            onConfirm={issue}
                            confirmLabel="Issue code"
                            busy={busy}
                            disabled={!chosen}
                        />
                    )}
                >
                    {issued ? (
                        <>
                            <p className="text-sm text-slate-600">
                                Give this to <strong>{issued.consultant.name}</strong>. They enter
                                it once, on their own machine, the first time they open the app.
                            </p>
                            <div className={`mt-3 ${card} ${cardPad} text-center`}>
                                <p className="font-mono text-2xl tracking-widest text-slate-900">
                                    {issued.activationCode}
                                </p>
                                <button
                                    type="button"
                                    onClick={() => {
                                        navigator.clipboard?.writeText(issued.activationCode);
                                        setCopied(true);
                                    }}
                                    className={`mt-3 ${btnSm.secondary}`}
                                >
                                    {copied
                                        ? <><Check className="h-3.5 w-3.5" /> Copied</>
                                        : <><Copy className="h-3.5 w-3.5" /> Copy</>}
                                </button>
                            </div>
                            <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.warning}`}>
                                This code is shown once and cannot be looked up again — it is
                                stored hashed, like a password. If it is lost, issue a new one.
                                Expires {new Date(issued.expiresAt).toLocaleString()}.
                            </p>
                        </>
                    ) : (
                        <>
                            <label className={fieldLabel} htmlFor="consultant">Consultant</label>
                            <select
                                id="consultant"
                                value={chosen}
                                onChange={(e) => setChosen(e.target.value)}
                                className={input}
                            >
                                <option value="">Choose a consultant…</option>
                                {consultants.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            <p className="mt-2 text-xs text-slate-500">
                                If they already have a device, issuing replaces it — the old one
                                stops working immediately. One machine per consultant, so two
                                cannot apply to the same job under one name.
                            </p>
                        </>
                    )}
                </Modal>
            )}

            {/* ── revoke ─────────────────────────────────────────── */}
            {revoking && (
                <Modal
                    size="sm"
                    tone="danger"
                    icon={ShieldOff}
                    title="Revoke desktop app access?"
                    onClose={() => setRevoking(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setRevoking(null)}
                            onConfirm={revoke}
                            confirmLabel="Revoke"
                            busy={busy}
                            variant="danger"
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        <strong>{revoking.consultant_name}</strong>&rsquo;s app stops on its next
                        check-in, within a minute, and wipes everything it holds locally.
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                        Applications already submitted are unaffected — those records are
                        permanent. To give access back you issue a new code.
                    </p>
                </Modal>
            )}

            <AuditLogPanel module="devices" />
        </div>
    );
};

export default Devices;
