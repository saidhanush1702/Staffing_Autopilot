import { useEffect, useState } from 'react';
import { Link2, Loader2, AlertCircle, UserCheck, Users as UsersIcon, Pencil } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import AssignmentPicker from '../../components/AssignmentPicker.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';

const VIEWS = [
    { key: 'CONSULTANTS', label: 'By consultant', icon: UsersIcon },
    { key: 'RECRUITERS', label: 'By recruiter', icon: UserCheck },
];

const Assignments = () => {
    const [assignments, setAssignments] = useState(null);
    const [recruiters, setRecruiters] = useState([]);
    const [consultants, setConsultants] = useState([]);
    const [error, setError] = useState('');

    const [consultantId, setConsultantId] = useState('');
    const [recruiterId, setRecruiterId] = useState('');
    const [reason, setReason] = useState('');
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);
    const [view, setView] = useState('CONSULTANTS');

    // Which bulk-edit dialog is open, if any.
    //   { kind: 'ROSTER',    recruiter,  current: consultantId[] }
    //   { kind: 'RECRUITER', consultant, current: recruiterId | null }
    const [picker, setPicker] = useState(null);

    const load = async () => {
        try {
            const [aRes, uRes] = await Promise.all([
                api.get('/management/assignments'),
                // The dropdowns need every user, so opt out of the default page size.
                api.get('/management/users', { params: { limit: 200 } }),
            ]);
            setAssignments(aRes.data.assignments);
            setRecruiters(uRes.data.users.filter((u) => u.role === 'RECRUITER' && u.is_active));
            setConsultants(uRes.data.users.filter((u) => u.role === 'CONSULTANT' && u.is_active));
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const handleAssign = async (e) => {
        e.preventDefault();
        setFormError('');
        setSaving(true);
        try {
            await api.post('/management/assignments', { consultantId, recruiterId, reason });
            setConsultantId(''); setRecruiterId(''); setReason('');
            await load();
        } catch (err) {
            setFormError(errorMessage(err, 'Could not assign consultant.'));
        } finally {
            setSaving(false);
        }
    };

    /**
     * Both bulk saves send the DESIRED END STATE, not a list of deltas — the
     * server reconciles. They reject with a plain message string, which is
     * what AssignmentPicker renders in its own error slot.
     */
    const saveRoster = async (recruiterId, consultantIds, reason) => {
        try {
            await api.put(`/management/assignments/recruiter/${recruiterId}`, { consultantIds, reason });
            setPicker(null);
            await load();
        } catch (err) {
            throw errorMessage(err, 'Could not update this recruiter’s consultants.');
        }
    };

    const saveRecruiter = async (consultantId, recruiterId, reason) => {
        try {
            await api.put(`/management/assignments/consultant/${consultantId}`, { recruiterId, reason });
            setPicker(null);
            await load();
        } catch (err) {
            throw errorMessage(err, 'Could not change this consultant’s recruiter.');
        }
    };

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!assignments) return <PageLoader />;

    const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
    const current = assignments.filter((a) => !a.effective_to);
    const history = assignments.filter((a) => a.effective_to);

    /**
     * The same links, read from both ends.
     *
     * Both lists start from the PEOPLE rather than from the assignment rows,
     * so someone with no link still appears. An unassigned consultant and an
     * idle recruiter are exactly what an admin opens this page to find, and
     * neither has an assignment row to be found through.
     */
    const byConsultant = new Map(current.map((a) => [a.consultant_id, a]));
    const consultantRows = consultants.map((c) => ({
        consultant: c,
        assignment: byConsultant.get(c.id) ?? null,
    }));
    const recruiterRows = recruiters.map((r) => ({
        recruiter: r,
        items: current.filter((a) => a.recruiter_id === r.id),
    }));

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">Assignments</h1>
            <p className="mt-1 text-sm text-slate-500">
                A recruiter can only see consultants currently assigned to them.
                Reassigning closes the old link and opens a new one — history is kept.
            </p>

            <form onSubmit={handleAssign} className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
                {formError && (
                    <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                    </div>
                )}
                <div className="grid gap-4 sm:grid-cols-3">
                    <label className="block">
                        <span className="text-sm text-slate-600">Consultant</span>
                        <select required value={consultantId} onChange={(e) => setConsultantId(e.target.value)} className={input}>
                            <option value="">Select…</option>
                            {consultants.map((c) => (
                                <option key={c.id} value={c.id}>{c.name} — {c.email}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="text-sm text-slate-600">Recruiter</span>
                        <select required value={recruiterId} onChange={(e) => setRecruiterId(e.target.value)} className={input}>
                            <option value="">Select…</option>
                            {recruiters.map((r) => (
                                <option key={r.id} value={r.id}>{r.name} — {r.email}</option>
                            ))}
                        </select>
                    </label>
                    <label className="block">
                        <span className="text-sm text-slate-600">Reason (optional)</span>
                        <input value={reason} onChange={(e) => setReason(e.target.value)} className={input} placeholder="Rebalancing workload" />
                    </label>
                </div>
                <button
                    type="submit"
                    disabled={saving}
                    className="mt-5 flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                    Assign
                </button>
            </form>

            {/* -- current assignments, read from either end -------------- */}
            <h2 className="mt-8 text-sm font-semibold text-slate-700">Current assignments</h2>

            <div className="mt-3 border-b border-slate-200">
                <nav className="-mb-px flex gap-4 overflow-x-auto sm:gap-6">
                    {VIEWS.map((v) => (
                        <button
                            key={v.key}
                            type="button"
                            onClick={() => setView(v.key)}
                            className={[
                                'flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors',
                                view === v.key
                                    ? 'border-brand-600 font-medium text-brand-700'
                                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
                            ].join(' ')}
                        >
                            <v.icon className="h-4 w-4" />
                            {v.label}
                        </button>
                    ))}
                </nav>
            </div>

            {view === 'CONSULTANTS' ? (
                <TableShell className="mt-3" minWidth={720}>
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Consultant</th>
                            <th className="px-4 py-3">Assigned recruiter</th>
                            <th className="px-4 py-3">Since</th>
                            <th className="px-4 py-3">Reason</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {consultantRows.length === 0 && (
                            <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No consultants yet.</td></tr>
                        )}
                        {consultantRows.map(({ consultant, assignment }) => (
                            <tr key={consultant.id} className="hover:bg-slate-50">
                                <td className="whitespace-nowrap px-4 py-3">
                                    <p className="font-medium text-slate-900">{consultant.name}</p>
                                    <p className="text-xs text-slate-500">{consultant.email}</p>
                                </td>
                                <td className="px-4 py-3 text-slate-600">
                                    <span className="flex items-center gap-2">
                                        {assignment
                                            ? assignment.recruiter_name
                                            : <span className="text-amber-600">Unassigned</span>}
                                        <button
                                            type="button"
                                            onClick={() => setPicker({
                                                kind: 'RECRUITER',
                                                consultant,
                                                current: assignment?.recruiter_id ?? null,
                                            })}
                                            title={`Change ${consultant.name}'s recruiter`}
                                            aria-label={`Change ${consultant.name}'s recruiter`}
                                            className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                    </span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-500">
                                    {assignment?.effective_from ?? '—'}
                                </td>
                                <td className="px-4 py-3 text-slate-400">{assignment?.reason ?? '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </TableShell>
            ) : (
                <TableShell className="mt-3" minWidth={720}>
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Recruiter</th>
                            <th className="px-4 py-3">Assigned consultants</th>
                            <th className="w-24 px-4 py-3">Count</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {recruiterRows.length === 0 && (
                            <tr><td colSpan={3} className="px-4 py-8 text-center text-slate-400">No recruiters yet.</td></tr>
                        )}
                        {recruiterRows.map(({ recruiter, items }) => (
                            <tr key={recruiter.id} className="hover:bg-slate-50">
                                <td className="whitespace-nowrap px-4 py-3 align-top">
                                    <p className="font-medium text-slate-900">{recruiter.name}</p>
                                    <p className="text-xs text-slate-500">{recruiter.email}</p>
                                </td>
                                <td className="px-4 py-3">
                                    <div className="flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            {items.length === 0 ? (
                                                <span className="text-sm text-slate-400">None assigned</span>
                                            ) : (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {items.map((a) => (
                                                        <span
                                                            key={a.id}
                                                            title={'Since ' + a.effective_from}
                                                            className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                                                        >
                                                            {a.consultant_name}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setPicker({
                                                kind: 'ROSTER',
                                                recruiter,
                                                current: items.map((a) => a.consultant_id),
                                            })}
                                            title={`Change ${recruiter.name}'s consultants`}
                                            aria-label={`Change ${recruiter.name}'s consultants`}
                                            className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-brand-600"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </td>
                                <td className="px-4 py-3 align-top">
                                    <span className={[
                                        'rounded-full px-2 py-0.5 text-xs font-medium',
                                        items.length === 0
                                            ? 'bg-slate-100 text-slate-500'
                                            : 'bg-brand-50 text-brand-700',
                                    ].join(' ')}>
                                        {items.length}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </TableShell>
            )}

            {history.length > 0 && (
                <>
                    <h2 className="mt-8 text-sm font-semibold text-slate-700">History</h2>
                    <TableShell className="mt-3" minWidth={640}>
                            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                                <tr>
                                    <th className="px-4 py-3">Consultant</th>
                                    <th className="px-4 py-3">Recruiter</th>
                                    <th className="px-4 py-3">From</th>
                                    <th className="px-4 py-3">To</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {history.map((a) => (
                                    <tr key={a.id} className="text-slate-500">
                                        <td className="px-4 py-3">{a.consultant_name}</td>
                                        <td className="px-4 py-3">{a.recruiter_name}</td>
                                        <td className="px-4 py-3">{a.effective_from}</td>
                                        <td className="px-4 py-3">{a.effective_to}</td>
                                    </tr>
                                ))}
                            </tbody>
                    </TableShell>
                </>
            )}

            {/* Bulk edit, from whichever end the admin is looking at. */}
            {picker?.kind === 'ROSTER' && (
                <AssignmentPicker
                    mode="multi"
                    title={`Consultants for ${picker.recruiter.name}`}
                    subtitle="Tick to assign, untick to release. Someone already on another recruiter moves across."
                    emptyText="No active consultants in this organization yet."
                    options={consultants.map((c) => {
                        const held = byConsultant.get(c.id);
                        return {
                            id: c.id,
                            name: c.name,
                            email: c.email,
                            // Only flag a consultant held by a DIFFERENT recruiter —
                            // "currently with the person you are editing" is noise.
                            hint: held && held.recruiter_id !== picker.recruiter.id
                                ? `Currently with ${held.recruiter_name}`
                                : null,
                        };
                    })}
                    initial={picker.current}
                    onSave={(ids, reason) => saveRoster(picker.recruiter.id, ids, reason)}
                    onClose={() => setPicker(null)}
                />
            )}

            {picker?.kind === 'RECRUITER' && (
                <AssignmentPicker
                    mode="single"
                    title={`Recruiter for ${picker.consultant.name}`}
                    subtitle="A consultant has one recruiter at a time. Choosing a new one closes the old link."
                    emptyText="No active recruiters in this organization yet."
                    options={recruiters.map((r) => ({ id: r.id, name: r.name, email: r.email }))}
                    initial={picker.current}
                    onSave={(id, reason) => saveRecruiter(picker.consultant.id, id, reason)}
                    onClose={() => setPicker(null)}
                />
            )}

            <AuditLogPanel module="assignments" />
        </div>
    );
};

export default Assignments;
