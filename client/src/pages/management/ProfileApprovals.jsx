import { useEffect, useState, Fragment } from 'react';
import {
    Check, X, Loader2, AlertCircle, Inbox, ArrowRight,
    ChevronRight, ChevronDown, Clock, CheckCircle2, XCircle, MinusCircle,
    XOctagon, PauseCircle, UserX,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import TableShell from '../../components/TableShell.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { badge, TONE, pageTitle, pageSubtitle, btn } from '../../design/tokens.js';

/**
 * Profile change approvals — ORG_ADMIN and RECRUITER.
 *
 * One collapsed row per request; expand to review each field individually.
 * A recruiter only ever receives requests from consultants currently assigned
 * to them — narrowed server-side in listChangeRequests(), not here.
 */

const STATUS_STYLE = {
    PENDING: { icon: Clock, cls: 'bg-warning-50 text-warning-700', text: 'Pending' },
    APPROVED: { icon: CheckCircle2, cls: 'bg-success-50 text-success-700', text: 'Approved' },
    PARTIALLY_APPROVED: { icon: MinusCircle, cls: 'bg-info-50 text-info-700', text: 'Partly approved' },
    REJECTED: { icon: XCircle, cls: 'bg-danger-50 text-danger-700', text: 'Rejected' },
    WITHDRAWN: { icon: MinusCircle, cls: 'bg-slate-100 text-slate-600', text: 'Withdrawn' },
    // Nobody judged these values — the consultant was terminated, so the
    // request stopped being decidable. Distinct from Rejected on purpose.
    CANCELLED: { icon: XOctagon, cls: 'bg-slate-100 text-slate-500', text: 'Cancelled' },
};

const roleLabel = (r) => (r ? r.replace('_', ' ') : '');

const StatusPill = ({ status }) => {
    const s = STATUS_STYLE[status] ?? STATUS_STYLE.PENDING;
    const Icon = s.icon;
    return (
        <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>
            <Icon className="h-3.5 w-3.5" />{s.text}
        </span>
    );
};

const ProfileApprovals = () => {
    const { user } = useAuth();
    const [requests, setRequests] = useState(null);
    const [page, setPage] = useState(null);
    const [schema, setSchema] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('PENDING');
    const [expanded, setExpanded] = useState({});

    const [decisions, setDecisions] = useState({});
    const [submitting, setSubmitting] = useState(null);
    const [rowError, setRowError] = useState({});

    const load = async (status = tab, p = 1) => {
        try {
            const [reqRes, schRes] = await Promise.all([
                api.get('/management/profile-changes', { params: { status, page: p, limit: 25 } }),
                api.get('/profile-schema'),
            ]);
            setRequests(reqRes.data.requests);
            setPage(reqRes.data.page);
            setSchema(schRes.data);
            setDecisions({});
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

    const toggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

    const decide = (reqId, fieldName, decision) =>
        setDecisions((d) => ({
            ...d,
            [reqId]: { ...d[reqId], [fieldName]: { ...d[reqId]?.[fieldName], decision } },
        }));

    const setNote = (reqId, fieldName, note) =>
        setDecisions((d) => ({
            ...d,
            [reqId]: { ...d[reqId], [fieldName]: { ...d[reqId]?.[fieldName], note } },
        }));

    const decideAll = (req, decision) =>
        setDecisions((d) => ({
            ...d,
            [req.id]: Object.fromEntries(
                req.fields.map((f) => [f.field_name, { ...d[req.id]?.[f.field_name], decision }]),
            ),
        }));

    const label = (n) => schema?.fields?.[n]?.label ?? n;

    const submit = async (req) => {
        const chosen = decisions[req.id] ?? {};
        const missing = req.fields.filter((f) => !chosen[f.field_name]?.decision);
        if (missing.length) {
            setRowError((e) => ({
                ...e,
                [req.id]: `Decide every field first — still open: ${missing.map((f) => label(f.field_name)).join(', ')}`,
            }));
            return;
        }
        setSubmitting(req.id);
        setRowError((e) => ({ ...e, [req.id]: '' }));
        try {
            await api.post(`/management/profile-changes/${req.id}/review`, {
                decisions: req.fields.map((f) => ({
                    fieldName: f.field_name,
                    decision: chosen[f.field_name].decision,
                    note: chosen[f.field_name].note || null,
                })),
            });
            await load(tab);
        } catch (err) {
            setRowError((e) => ({ ...e, [req.id]: errorMessage(err, 'Review failed.') }));
        } finally {
            setSubmitting(null);
        }
    };

    if (error) return <p className="text-sm text-danger-600">{error}</p>;
    if (!requests || !schema) return <PageLoader />;

    const TABS = [
        { key: 'PENDING', label: 'Pending' },
        { key: 'APPROVED', label: 'Approved' },
        { key: 'PARTIALLY_APPROVED', label: 'Partly approved' },
        { key: 'REJECTED', label: 'Rejected' },
        { key: 'ALL', label: 'All' },
    ];

    return (
        <div>
            <h1 className={pageTitle}>Profile approvals</h1>
            <p className={pageSubtitle}>
                {user?.role === 'RECRUITER'
                    ? 'Change requests from the consultants assigned to you.'
                    : 'Change requests from every consultant in this organization.'}
                {' '}Nothing takes effect until approved.
            </p>

            <div className="mt-6 border-b border-line">
                <nav className="-mb-px flex gap-4 overflow-x-auto sm:gap-6">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setTab(t.key)}
                            className={[
                                'shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm transition-colors',
                                tab === t.key
                                    ? 'border-brand-600 font-medium text-brand-700'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
                            ].join(' ')}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>

            {requests.length === 0 ? (
                <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-surface py-16">
                    <Inbox className="h-8 w-8 text-slate-300" />
                    <p className="text-sm text-slate-500">Nothing here.</p>
                    {tab === 'PENDING' && (
                        <p className="text-xs text-slate-400">
                            Requests appear when a consultant submits profile changes.
                        </p>
                    )}
                </div>
            ) : (
                <TableShell
                    className="mt-6"
                    minWidth={880}
                    footer={<Pagination page={page} onChange={(p) => load(tab, p)} />}
                >
                        <thead className="border-b border-line bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="w-10 px-3 py-3" />
                                <th className="px-4 py-3">Consultant</th>
                                <th className="px-4 py-3">Assigned recruiter</th>
                                <th className="px-4 py-3">Changes</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Reviewed by</th>
                                <th className="px-4 py-3">Submitted</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-line-soft">
                            {requests.map((req) => {
                                const isOpen = Boolean(expanded[req.id]);
                                const chosen = decisions[req.id] ?? {};
                                const readOnly = req.status !== 'PENDING';

                                return (
                                    <Fragment key={req.id}>
                                        {/* ── collapsed summary row ────────────── */}
                                        <tr
                                            onClick={() => toggle(req.id)}
                                            className="cursor-pointer hover:bg-slate-50"
                                        >
                                            <td className="px-3 py-3 text-slate-400">
                                                {isOpen
                                                    ? <ChevronDown className="h-4 w-4" />
                                                    : <ChevronRight className="h-4 w-4" />}
                                            </td>
                                            <td className="px-4 py-3">
                                                <p className="font-medium text-slate-900">{req.consultant_name}</p>
                                                <p className="text-xs text-slate-500">{req.consultant_email}</p>
                                                {/* A suspended consultant's request stays reviewable —
                                                    suspension is temporary and their work should survive it.
                                                    Flag it so the decision is made knowingly. (C-2) */}
                                                {req.consultant_employment_status === 'SUSPENDED' && (
                                                    <span
                                                        title="This consultant's access is suspended. Their changes can still be reviewed."
                                                        className="mt-1 inline-flex items-center gap-1 rounded bg-warning-50 px-2 py-0.5 text-xs font-medium text-warning-700"
                                                    >
                                                        <PauseCircle className="h-3 w-3" /> Suspended
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3 text-slate-600">
                                                {/* Not merely "no recruiter yet" — a recruiter only ever
                                                    sees their own consultants, so nobody but an admin will
                                                    ever pick this up. Flagged rather than left blank. */}
                                                {req.is_unassigned ? (
                                                    <span
                                                        title="No recruiter is assigned, so this request will only ever appear to an organisation admin."
                                                        className={`inline-flex items-center gap-1 ${badge} ${TONE.warning}`}
                                                    >
                                                        <UserX className="h-3 w-3" /> Unassigned
                                                    </span>
                                                ) : req.recruiter_name}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                                    {req.field_count} change{req.field_count === 1 ? '' : 's'}
                                                </span>
                                                {readOnly && (
                                                    <span className="ml-2 text-xs text-slate-500">
                                                        {req.approved_count > 0 && (
                                                            <span className="text-success-600">{req.approved_count} ✓</span>
                                                        )}
                                                        {req.approved_count > 0 && req.rejected_count > 0 && ' · '}
                                                        {req.rejected_count > 0 && (
                                                            <span className="text-danger-600">{req.rejected_count} ✗</span>
                                                        )}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-4 py-3"><StatusPill status={req.status} /></td>
                                            <td className="px-4 py-3">
                                                {req.reviewed_by_name ? (
                                                    <>
                                                        <p className="text-slate-700">{req.reviewed_by_name}</p>
                                                        <p className="text-xs text-slate-400">
                                                            {roleLabel(req.reviewed_by_role)}
                                                        </p>
                                                    </>
                                                ) : <span className="text-slate-400">—</span>}
                                            </td>
                                            <td className="px-4 py-3 text-xs text-slate-500">
                                                {new Date(req.submitted_at).toLocaleString()}
                                            </td>
                                        </tr>

                                        {/* ── expanded detail row ──────────────── */}
                                        {isOpen && (
                                            <tr className="bg-surface-raised">
                                                <td colSpan={7} className="px-0 py-0">
                                                    <div className="border-y border-line bg-surface">
                                                        <div className="divide-y divide-line-soft">
                                                            {req.fields.map((f) => {
                                                                const d = chosen[f.field_name]?.decision
                                                                    ?? (readOnly ? f.status : null);
                                                                return (
                                                                    <div key={f.field_name} className="px-6 py-3">
                                                                        <div className="flex flex-wrap items-center gap-3">
                                                                            <span className="w-44 shrink-0 text-sm font-medium text-slate-700">
                                                                                {label(f.field_name)}
                                                                            </span>
                                                                            <span className="flex flex-1 items-center gap-2 text-sm">
                                                                                <span className="text-slate-400 line-through">
                                                                                    {f.old_display ?? '(empty)'}
                                                                                </span>
                                                                                <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                                                                                <span className="font-medium text-slate-900">
                                                                                    {f.new_display ?? '(cleared)'}
                                                                                </span>
                                                                            </span>

                                                                            {readOnly ? (
                                                                                <span className={`rounded px-2 py-0.5 text-xs font-medium ${f.status === 'APPROVED' ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>
                                                                                    {f.status}
                                                                                </span>
                                                                            ) : (
                                                                                <span className="flex gap-1">
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={() => decide(req.id, f.field_name, 'APPROVED')}
                                                                                        title="Approve this field"
                                                                                        className={`rounded-lg border p-1.5 transition-colors ${d === 'APPROVED' ? 'border-success-500 bg-success-100 text-success-700' : 'border-slate-300 text-slate-500 hover:bg-success-50'}`}
                                                                                    >
                                                                                        <Check className="h-3.5 w-3.5" />
                                                                                    </button>
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={() => decide(req.id, f.field_name, 'REJECTED')}
                                                                                        title="Reject this field"
                                                                                        className={`rounded-lg border p-1.5 transition-colors ${d === 'REJECTED' ? 'border-danger-500 bg-danger-100 text-danger-700' : 'border-slate-300 text-slate-500 hover:bg-danger-50'}`}
                                                                                    >
                                                                                        <X className="h-3.5 w-3.5" />
                                                                                    </button>
                                                                                </span>
                                                                            )}
                                                                        </div>

                                                                        {!readOnly && d === 'REJECTED' && (
                                                                            <input
                                                                                value={chosen[f.field_name]?.note ?? ''}
                                                                                onChange={(e) => setNote(req.id, f.field_name, e.target.value)}
                                                                                placeholder="Why? The consultant will see this."
                                                                                className="mt-2 w-full max-w-md rounded-lg border border-danger-200 px-3 py-1.5 text-xs outline-none focus:border-danger-400"
                                                                            />
                                                                        )}
                                                                        {readOnly && f.review_note && (
                                                                            <p className="mt-1 text-xs text-slate-500">
                                                                                Note: {f.review_note}
                                                                            </p>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>

                                                        {!readOnly && (
                                                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-slate-50 px-6 py-3">
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decideAll(req, 'APPROVED')}
                                                                        className="rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-xs text-slate-600 hover:bg-success-50"
                                                                    >
                                                                        Approve all
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decideAll(req, 'REJECTED')}
                                                                        className="rounded-lg border border-slate-300 bg-surface px-3 py-1.5 text-xs text-slate-600 hover:bg-danger-50"
                                                                    >
                                                                        Reject all
                                                                    </button>
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => submit(req)}
                                                                    disabled={submitting === req.id}
                                                                    className={btn.primary}
                                                                >
                                                                    {submitting === req.id && <Loader2 className="h-4 w-4 animate-spin" />}
                                                                    Submit review
                                                                </button>
                                                            </div>
                                                        )}

                                                        {readOnly && req.reviewed_at && (
                                                            <div className="border-t border-line bg-slate-50 px-6 py-3 text-xs text-slate-600">
                                                                Reviewed by <strong>{req.reviewed_by_name}</strong>
                                                                {' '}({roleLabel(req.reviewed_by_role)}) on{' '}
                                                                {new Date(req.reviewed_at).toLocaleString()}
                                                                {req.review_note && <> — {req.review_note}</>}
                                                            </div>
                                                        )}

                                                        {rowError[req.id] && (
                                                            <div className="flex items-start gap-2 border-t border-danger-200 bg-danger-50 px-6 py-2 text-xs text-danger-700">
                                                                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                                {rowError[req.id]}
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                </TableShell>
            )}

            <AuditLogPanel module="profile_changes" />
        </div>
    );
};

export default ProfileApprovals;
