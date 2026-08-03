import { useEffect, useState, Fragment } from 'react';
import {
    Check, X, Loader2, AlertCircle, Inbox, ArrowRight,
    ChevronRight, ChevronDown, Clock, CheckCircle2, XCircle, MinusCircle,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Profile change approvals — ORG_ADMIN and RECRUITER.
 *
 * One collapsed row per request; expand to review each field individually.
 * A recruiter only ever receives requests from consultants currently assigned
 * to them — narrowed server-side in listChangeRequests(), not here.
 */

const STATUS_STYLE = {
    PENDING: { icon: Clock, cls: 'bg-amber-50 text-amber-700', text: 'Pending' },
    APPROVED: { icon: CheckCircle2, cls: 'bg-emerald-50 text-emerald-700', text: 'Approved' },
    PARTIALLY_APPROVED: { icon: MinusCircle, cls: 'bg-sky-50 text-sky-700', text: 'Partly approved' },
    REJECTED: { icon: XCircle, cls: 'bg-red-50 text-red-700', text: 'Rejected' },
    WITHDRAWN: { icon: MinusCircle, cls: 'bg-slate-100 text-slate-600', text: 'Withdrawn' },
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

    if (error) return <p className="text-sm text-red-600">{error}</p>;
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
            <h1 className="text-xl font-semibold text-slate-900">Profile approvals</h1>
            <p className="mt-1 text-sm text-slate-500">
                {user?.role === 'RECRUITER'
                    ? 'Change requests from the consultants assigned to you.'
                    : 'Change requests from every consultant in this organization.'}
                {' '}Nothing takes effect until approved.
            </p>

            <div className="mt-6 border-b border-slate-200">
                <nav className="-mb-px flex gap-6">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setTab(t.key)}
                            className={[
                                'border-b-2 px-1 pb-3 text-sm transition-colors',
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
                <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-16">
                    <Inbox className="h-8 w-8 text-slate-300" />
                    <p className="text-sm text-slate-500">Nothing here.</p>
                    {tab === 'PENDING' && (
                        <p className="text-xs text-slate-400">
                            Requests appear when a consultant submits profile changes.
                        </p>
                    )}
                </div>
            ) : (
                <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <table className="w-full text-sm">
                        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
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
                        <tbody className="divide-y divide-slate-100">
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
                                            </td>
                                            <td className="px-4 py-3 text-slate-600">
                                                {req.recruiter_name ?? <span className="text-slate-400">Unassigned</span>}
                                            </td>
                                            <td className="px-4 py-3">
                                                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                                                    {req.field_count} change{req.field_count === 1 ? '' : 's'}
                                                </span>
                                                {readOnly && (
                                                    <span className="ml-2 text-xs text-slate-500">
                                                        {req.approved_count > 0 && (
                                                            <span className="text-emerald-600">{req.approved_count} ✓</span>
                                                        )}
                                                        {req.approved_count > 0 && req.rejected_count > 0 && ' · '}
                                                        {req.rejected_count > 0 && (
                                                            <span className="text-red-600">{req.rejected_count} ✗</span>
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
                                            <tr className="bg-slate-50/60">
                                                <td colSpan={7} className="px-0 py-0">
                                                    <div className="border-y border-slate-200 bg-white">
                                                        <div className="divide-y divide-slate-100">
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
                                                                                <span className={`rounded px-2 py-0.5 text-xs font-medium ${f.status === 'APPROVED' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                                                                                    {f.status}
                                                                                </span>
                                                                            ) : (
                                                                                <span className="flex gap-1">
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={() => decide(req.id, f.field_name, 'APPROVED')}
                                                                                        title="Approve this field"
                                                                                        className={`rounded-lg border p-1.5 transition-colors ${d === 'APPROVED' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 text-slate-500 hover:bg-emerald-50'}`}
                                                                                    >
                                                                                        <Check className="h-3.5 w-3.5" />
                                                                                    </button>
                                                                                    <button
                                                                                        type="button"
                                                                                        onClick={() => decide(req.id, f.field_name, 'REJECTED')}
                                                                                        title="Reject this field"
                                                                                        className={`rounded-lg border p-1.5 transition-colors ${d === 'REJECTED' ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 text-slate-500 hover:bg-red-50'}`}
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
                                                                                className="mt-2 w-full max-w-md rounded-lg border border-red-200 px-3 py-1.5 text-xs outline-none focus:border-red-400"
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
                                                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3">
                                                                <div className="flex gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decideAll(req, 'APPROVED')}
                                                                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-emerald-50"
                                                                    >
                                                                        Approve all
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decideAll(req, 'REJECTED')}
                                                                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-red-50"
                                                                    >
                                                                        Reject all
                                                                    </button>
                                                                </div>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => submit(req)}
                                                                    disabled={submitting === req.id}
                                                                    className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                                                                >
                                                                    {submitting === req.id && <Loader2 className="h-4 w-4 animate-spin" />}
                                                                    Submit review
                                                                </button>
                                                            </div>
                                                        )}

                                                        {readOnly && req.reviewed_at && (
                                                            <div className="border-t border-slate-200 bg-slate-50 px-6 py-3 text-xs text-slate-600">
                                                                Reviewed by <strong>{req.reviewed_by_name}</strong>
                                                                {' '}({roleLabel(req.reviewed_by_role)}) on{' '}
                                                                {new Date(req.reviewed_at).toLocaleString()}
                                                                {req.review_note && <> — {req.review_note}</>}
                                                            </div>
                                                        )}

                                                        {rowError[req.id] && (
                                                            <div className="flex items-start gap-2 border-t border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700">
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
                    </table>

                    <Pagination page={page} onChange={(p) => load(tab, p)} />
                </div>
            )}

            <AuditLogPanel module="profile_changes" />
        </div>
    );
};

export default ProfileApprovals;
