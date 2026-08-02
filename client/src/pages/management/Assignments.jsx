import { useEffect, useState } from 'react';
import { Link2, Loader2, AlertCircle } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';

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

    const load = async () => {
        try {
            const [aRes, uRes] = await Promise.all([
                api.get('/management/assignments'),
                api.get('/management/users'),
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

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!assignments) return <PageLoader />;

    const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
    const current = assignments.filter((a) => !a.effective_to);
    const history = assignments.filter((a) => a.effective_to);

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

            <h2 className="mt-8 text-sm font-semibold text-slate-700">Current assignments</h2>
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Consultant</th>
                            <th className="px-4 py-3">Recruiter</th>
                            <th className="px-4 py-3">Since</th>
                            <th className="px-4 py-3">Reason</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {current.length === 0 && (
                            <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No current assignments.</td></tr>
                        )}
                        {current.map((a) => (
                            <tr key={a.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-medium text-slate-900">{a.consultant_name}</td>
                                <td className="px-4 py-3 text-slate-600">{a.recruiter_name}</td>
                                <td className="px-4 py-3 text-slate-500">{a.effective_from}</td>
                                <td className="px-4 py-3 text-slate-400">{a.reason ?? '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {history.length > 0 && (
                <>
                    <h2 className="mt-8 text-sm font-semibold text-slate-700">History</h2>
                    <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
                        <table className="w-full text-sm">
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
                        </table>
                    </div>
                </>
            )}

            <AuditLogPanel module="assignments" />
        </div>
    );
};

export default Assignments;
