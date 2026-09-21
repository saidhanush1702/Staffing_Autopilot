import { useEffect, useState, Fragment } from 'react';
import {
    Check, X, Loader2, AlertCircle, Inbox, ArrowRight,
    ChevronRight, ChevronDown, Clock, CheckCircle2, XCircle, MinusCircle,
    XOctagon, PauseCircle, UserX, GraduationCap, Plus, Minus,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import TableShell from '../../components/TableShell.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { PROFILE_SECTIONS } from '../../config/profileSections.js';
import { badge, TONE, pageSubtitle, btn } from '../../design/tokens.js';

/**
 * Profile change approvals — ORG_ADMIN and RECRUITER.
 *
 * ── WHY ONE DECISION PER REQUEST, NOT ONE PER FIELD ────────────────────
 *
 * This screen used to let a reviewer approve nine fields and reject a tenth.
 * Since My Profile and My Career merged into one page and one submission
 * (see pages/portal/MyProfile.jsx), that granularity stopped making sense —
 * there is no sensible per-skill checkbox on a submission a consultant meant
 * as one coherent update. So the action here is now ONE Approve / Reject for
 * the whole thing, with a review note. Every individual change is still
 * listed, read-only, so the reviewer can see exactly what they are deciding.
 *
 * A recruiter only ever receives requests from consultants currently assigned
 * to them — narrowed server-side in listChangeRequests(), not here.
 */

const STATUS_STYLE = {
    PENDING: { icon: Clock, cls: 'bg-warning-50 text-warning-700', text: 'Pending' },
    APPROVED: { icon: CheckCircle2, cls: 'bg-success-50 text-success-700', text: 'Approved' },
    // Historical only — new reviews never produce this any more, see the
    // header comment above. Old rows from before the merge can still carry
    // it, and the tab stays so that history remains findable.
    PARTIALLY_APPROVED: { icon: MinusCircle, cls: 'bg-info-50 text-info-700', text: 'Partly approved (old)' },
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

/**
 * A row's content, stripped of the columns that never carry a real change
 * (id, position, timestamps) so two rows that read identically to a human
 * compare as identical here too.
 */
const contentOf = (row) => {
    const { id: _id, position: _p, created_at: _c, updated_at: _u, ...rest } = row;
    return JSON.stringify(rest);
};

/**
 * What actually changed in one career section, for display.
 *
 * Computed client-side from the `live` and `snapshot` arrays the list
 * endpoint already sends — the same two arrays profileChangeController.js
 * derived its own summary text from, just re-diffed here so the reviewer can
 * see the actual entries, not only a count.
 */
const sectionDiff = (name, live = [], proposed = []) => {
    const def = PROFILE_SECTIONS[name];
    const liveSigs = new Map(live.map((r) => [contentOf(r), r]));
    const proposedSigs = new Map(proposed.map((r) => [contentOf(r), r]));

    const added = [...proposedSigs.entries()]
        .filter(([sig]) => !liveSigs.has(sig)).map(([, r]) => def.title(r));
    const removed = [...liveSigs.entries()]
        .filter(([sig]) => !proposedSigs.has(sig)).map(([, r]) => def.title(r));

    return { added, removed, label: def.label };
};

const skillsDiff = (live = [], proposed = []) => {
    const liveIds = new Map(live.map((s) => [s.skill_id, s.name]));
    const proposedIds = new Map(proposed.map((s) => [s.skillId, s.name]));
    const added = [...proposedIds.entries()].filter(([id]) => !liveIds.has(id)).map(([, n]) => n);
    const removed = [...liveIds.entries()].filter(([id]) => !proposedIds.has(id)).map(([, n]) => n);
    return { added, removed, label: 'Skills' };
};

/** The career record, laid out as a readable diff. Nothing here is clickable — see the header comment on why. */
const CareerDiff = ({ career }) => {
    if (!career?.snapshot) return null;
    const { live, snapshot } = career;

    const diffs = [
        ...(snapshot.skills ? [skillsDiff(live.skills, snapshot.skills)] : []),
        ...['education', 'experience', 'projects', 'certifications']
            .filter((n) => snapshot[n])
            .map((n) => sectionDiff(n, live[n], snapshot[n])),
    ].filter((d) => d.added.length || d.removed.length);

    if (diffs.length === 0) return null;

    return (
        <div className="px-6 py-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <GraduationCap className="h-4 w-4 text-slate-400" /> Career record
            </p>
            <div className="mt-2 space-y-1.5">
                {diffs.map((d) => (
                    <div key={d.label} className="text-sm">
                        <span className="w-44 shrink-0 font-medium text-slate-600">{d.label}: </span>
                        {d.added.map((name) => (
                            <span key={`+${name}`} className="mr-2 inline-flex items-center gap-0.5 text-success-700">
                                <Plus className="h-3 w-3" />{name}
                            </span>
                        ))}
                        {d.removed.map((name) => (
                            <span key={`-${name}`} className="mr-2 inline-flex items-center gap-0.5 text-danger-700 line-through">
                                <Minus className="h-3 w-3" />{name}
                            </span>
                        ))}
                    </div>
                ))}
            </div>
        </div>
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

    const [notes, setNotes] = useState({});
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
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);

    const toggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

    const label = (n) => schema?.fields?.[n]?.label ?? n;

    const decide = async (req, decision) => {
        setSubmitting(req.id);
        setRowError((e) => ({ ...e, [req.id]: '' }));
        try {
            await api.post(`/management/profile-changes/${req.id}/review`, {
                decision,
                reviewNote: notes[req.id] || null,
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
        { key: 'REJECTED', label: 'Rejected' },
        { key: 'ALL', label: 'All' },
    ];

    return (
        <div>
            <p className={pageSubtitle}>
                {user?.role === 'RECRUITER'
                    ? 'Submissions from the consultants assigned to you.'
                    : 'Submissions from every consultant in this organization.'}
                {' '}Each is reviewed as a whole — nothing takes effect until you approve it.
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
                            Requests appear when a consultant submits their profile for approval.
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
                                                    {req.field_count} field{req.field_count === 1 ? '' : 's'}
                                                </span>
                                                {req.has_career_changes && (
                                                    <span className="ml-1.5 inline-flex items-center gap-1 rounded bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                                                        <GraduationCap className="h-3 w-3" /> career
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
                                                        {/* Every individual change, read-only — the decision
                                                            below covers all of it at once. */}
                                                        <div className="divide-y divide-line-soft">
                                                            {req.fields.map((f) => (
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
                                                                        {readOnly && (
                                                                            <span className={`rounded px-2 py-0.5 text-xs font-medium ${f.status === 'APPROVED' ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>
                                                                                {f.status}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>

                                                        <CareerDiff career={req.career} />

                                                        {!readOnly && (
                                                            <div className="border-t border-line bg-slate-50 px-6 py-3">
                                                                <textarea
                                                                    value={notes[req.id] ?? ''}
                                                                    onChange={(e) => setNotes((n) => ({ ...n, [req.id]: e.target.value }))}
                                                                    placeholder="Note for the consultant (optional — required if you reject)"
                                                                    rows={2}
                                                                    className="w-full max-w-xl rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-400"
                                                                />
                                                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decide(req, 'APPROVED')}
                                                                        disabled={submitting === req.id}
                                                                        className={btn.primary}
                                                                    >
                                                                        {submitting === req.id
                                                                            ? <Loader2 className="h-4 w-4 animate-spin" />
                                                                            : <Check className="h-4 w-4" />}
                                                                        Approve
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => decide(req, 'REJECTED')}
                                                                        disabled={submitting === req.id}
                                                                        className="inline-flex items-center gap-1.5 rounded-lg border border-danger-300 bg-surface px-3 py-1.5 text-sm text-danger-700 hover:bg-danger-50 disabled:opacity-50"
                                                                    >
                                                                        <X className="h-4 w-4" /> Reject
                                                                    </button>
                                                                    <span className="text-xs text-slate-400">
                                                                        Approving applies everything above at once — there is no per-field decision any more.
                                                                    </span>
                                                                </div>
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
