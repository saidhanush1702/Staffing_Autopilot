import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Power, Loader2, AlertCircle, X } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';

const EMPTY_FORM = {
    name: '', slug: '', contactEmail: '', contactPhone: '',
    adminName: '', adminEmail: '', adminPassword: '',
};

const Organizations = () => {
    const navigate = useNavigate();
    const [orgs, setOrgs] = useState(null);
    const [error, setError] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            const { data } = await api.get('/super-admin/organizations');
            setOrgs(data.organizations);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    const handleCreate = async (e) => {
        e.preventDefault();
        setFormError('');
        setSaving(true);
        try {
            await api.post('/super-admin/organizations', form);
            setShowForm(false);
            setForm(EMPTY_FORM);
            await load();
        } catch (err) {
            setFormError(errorMessage(err, 'Could not create organization.'));
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async (org) => {
        try {
            await api.post(`/super-admin/organizations/${org.id}/toggle-active`);
            await load();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!orgs) return <PageLoader />;

    const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

    return (
        <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">Organizations</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Each organization is one staffing agency, fully isolated from the others.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowForm((s) => !s)}
                    className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                    {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {showForm ? 'Cancel' : 'New organization'}
                </button>
            </div>

            {showForm && (
                <form onSubmit={handleCreate} className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
                    {formError && (
                        <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                        </div>
                    )}

                    <p className="text-sm font-medium text-slate-700">Organization</p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <label className="block">
                            <span className="text-sm text-slate-600">Name</span>
                            <input required minLength={2} maxLength={255} value={form.name} onChange={set('name')} className={input} placeholder="Molina Staffing" />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Slug</span>
                            <input
                                required minLength={2} maxLength={60}
                                pattern="[a-z0-9-]+"
                                title="Lowercase letters, numbers and hyphens only."
                                value={form.slug}
                                onChange={(e) => setForm((f) => ({
                                    ...f,
                                    slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                                }))}
                                className={input}
                                placeholder="molina"
                            />
                            <span className="mt-1 block text-xs text-slate-400">
                                Short unique handle for this organization — lowercase letters,
                                numbers and hyphens. Permanent once set.
                            </span>
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Contact email</span>
                            <input type="email" value={form.contactEmail} onChange={set('contactEmail')} className={input} />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Contact phone</span>
                            <input
                                inputMode="numeric" maxLength={10} pattern="[0-9]{10}"
                                title="Exactly 10 digits, no spaces or symbols."
                                placeholder="5550101234"
                                value={form.contactPhone}
                                onChange={(e) => setForm((f) => ({
                                    ...f, contactPhone: e.target.value.replace(/\D/g, '').slice(0, 10),
                                }))}
                                className={input}
                            />
                        </label>
                    </div>

                    <p className="mt-6 text-sm font-medium text-slate-700">First organization admin</p>
                    <div className="mt-3 grid gap-4 sm:grid-cols-3">
                        <label className="block">
                            <span className="text-sm text-slate-600">Name</span>
                            <input required minLength={2} maxLength={255} value={form.adminName} onChange={set('adminName')} className={input} />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Email</span>
                            <input required type="email" maxLength={255} value={form.adminEmail} onChange={set('adminEmail')} className={input} />
                            <span className="mt-1 block text-xs text-slate-400">
                                Must not already exist on any organization.
                            </span>
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Password</span>
                            <input required type="text" minLength={8} value={form.adminPassword} onChange={set('adminPassword')} className={input} placeholder="min 8 characters" />
                        </label>
                    </div>

                    <button
                        type="submit"
                        disabled={saving}
                        className="mt-6 flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                    >
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Create organization
                    </button>
                </form>
            )}

            <TableShell className="mt-6" minWidth={900}>
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Organization</th>
                            <th className="px-4 py-3">Slug</th>
                            <th className="px-4 py-3">Admins</th>
                            <th className="px-4 py-3">Recruiters</th>
                            <th className="px-4 py-3">Consultants</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {orgs.length === 0 && (
                            <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No organizations yet.</td></tr>
                        )}
                        {orgs.map((o) => (
                            <tr
                                key={o.id}
                                onClick={() => navigate(`/super-admin/organizations/${o.id}`)}
                                className="cursor-pointer hover:bg-slate-50"
                            >
                                <td className="px-4 py-3 font-medium text-slate-900">{o.name}</td>
                                <td className="px-4 py-3 text-slate-500">{o.slug}</td>
                                <td className="px-4 py-3 text-slate-600">{o.admin_count}</td>
                                <td className="px-4 py-3 text-slate-600">{o.recruiter_count}</td>
                                <td className="px-4 py-3 text-slate-600">{o.consultant_count}</td>
                                <td className="px-4 py-3">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${o.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                                        {o.is_active ? 'Active' : 'Disabled'}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); toggleActive(o); }}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                    >
                                        <Power className="h-3.5 w-3.5" />
                                        {o.is_active ? 'Disable' : 'Enable'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
            </TableShell>
        </div>
    );
};

export default Organizations;
