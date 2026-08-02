import { useEffect, useState } from 'react';
import { Plus, X, Loader2, AlertCircle, Power, ShieldAlert, Users as UsersIcon } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import PasswordCell from '../../components/PasswordCell.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';

const EMPTY = { name: '', email: '', phone: '', role: 'CONSULTANT', password: '' };

/** One tab per role. Order follows the hierarchy. */
const TABS = [
    { key: 'ORG_ADMIN', label: 'Org Admins' },
    { key: 'RECRUITER', label: 'Recruiters' },
    { key: 'CONSULTANT', label: 'Consultants' },
];

const ROLE_BADGE = {
    ORG_ADMIN: 'bg-role-orgadmin/10 text-role-orgadmin',
    RECRUITER: 'bg-role-recruiter/10 text-role-recruiter',
    CONSULTANT: 'bg-role-consultant/10 text-role-consultant',
};

const Users = () => {
    const [users, setUsers] = useState(null);
    const [error, setError] = useState('');
    const [activeTab, setActiveTab] = useState('ORG_ADMIN');

    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(EMPTY);
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    // Password reset dialog
    const [resetTarget, setResetTarget] = useState(null);
    const [newPassword, setNewPassword] = useState('');
    const [resetError, setResetError] = useState('');
    const [resetting, setResetting] = useState(false);

    const load = async () => {
        try {
            const { data } = await api.get('/management/users');
            setUsers(data.users);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    /** Open the form pre-set to the tab you're on (org admins can't be created here). */
    const openForm = () => {
        setForm({ ...EMPTY, role: activeTab === 'RECRUITER' ? 'RECRUITER' : 'CONSULTANT' });
        setFormError('');
        setShowForm(true);
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        setFormError('');
        setSaving(true);
        try {
            await api.post('/management/users', form);
            setActiveTab(form.role);          // jump to the tab the new user landed in
            setForm(EMPTY);
            setShowForm(false);
            await load();
        } catch (err) {
            setFormError(errorMessage(err, 'Could not create user.'));
        } finally {
            setSaving(false);
        }
    };

    const disable = async (u) => {
        if (!window.confirm(`Disable ${u.name}? They will not be able to sign in.`)) return;
        try {
            await api.delete(`/management/users/${u.id}`);
            await load();
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    const handleReset = async (e) => {
        e.preventDefault();
        setResetError('');
        setResetting(true);
        try {
            await api.post(`/management/users/${resetTarget.id}/reset-password`, { newPassword });
            setResetTarget(null);
            setNewPassword('');
        } catch (err) {
            setResetError(errorMessage(err, 'Could not reset password.'));
        } finally {
            setResetting(false);
        }
    };

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!users) return <PageLoader />;

    const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

    const countFor = (role) => users.filter((u) => u.role === role).length;
    const visible = users.filter((u) => u.role === activeTab);
    const activeLabel = TABS.find((t) => t.key === activeTab)?.label.toLowerCase();

    return (
        <div>
            {/* ── heading + add button ───────────────────────────── */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">Users</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Everyone in this organization, grouped by role.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => (showForm ? setShowForm(false) : openForm())}
                    className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                    {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {showForm ? 'Cancel' : 'Add user'}
                </button>
            </div>

            {/* ── add user form ──────────────────────────────────── */}
            {showForm && (
                <form onSubmit={handleCreate} className="mt-5 rounded-xl border border-slate-200 bg-white p-5">
                    {formError && (
                        <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                        </div>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="block">
                            <span className="text-sm text-slate-600">Name</span>
                            <input required value={form.name} onChange={set('name')} className={input} />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Email</span>
                            <input required type="email" value={form.email} onChange={set('email')} className={input} />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Phone</span>
                            <input value={form.phone} onChange={set('phone')} className={input} />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Role</span>
                            <select value={form.role} onChange={set('role')} className={input}>
                                <option value="CONSULTANT">Consultant</option>
                                <option value="RECRUITER">Recruiter</option>
                            </select>
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Password</span>
                            <input required type="text" minLength={8} value={form.password} onChange={set('password')} className={input} placeholder="min 8 characters" />
                        </label>
                    </div>
                    <button
                        type="submit"
                        disabled={saving}
                        className="mt-5 flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                    >
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Create user
                    </button>
                </form>
            )}

            {/* ── role tabs ──────────────────────────────────────── */}
            <div className="mt-6 border-b border-slate-200">
                <nav className="-mb-px flex gap-6" aria-label="User roles">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setActiveTab(tab.key)}
                                aria-current={isActive ? 'page' : undefined}
                                className={[
                                    'flex items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors',
                                    isActive
                                        ? 'border-brand-600 font-medium text-brand-700'
                                        : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
                                ].join(' ')}
                            >
                                {tab.label}
                                <span className={[
                                    'rounded-full px-2 py-0.5 text-xs',
                                    isActive ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500',
                                ].join(' ')}>
                                    {countFor(tab.key)}
                                </span>
                            </button>
                        );
                    })}
                </nav>
            </div>

            {/* ── table for the active tab ───────────────────────── */}
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
                <table className="w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Email</th>
                            <th className="px-4 py-3">Password</th>
                            <th className="px-4 py-3">Role</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {visible.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-4 py-12 text-center">
                                    <UsersIcon className="mx-auto h-8 w-8 text-slate-300" />
                                    <p className="mt-2 text-sm text-slate-500">No {activeLabel} yet.</p>
                                    {activeTab === 'ORG_ADMIN' && (
                                        <p className="mt-1 text-xs text-slate-400">
                                            Organization admins are created by the platform super admin.
                                        </p>
                                    )}
                                </td>
                            </tr>
                        )}
                        {visible.map((u) => (
                            <tr key={u.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-medium text-slate-900">{u.name}</td>
                                <td className="px-4 py-3 text-slate-500">{u.email}</td>
                                <td className="px-4 py-3">
                                    <PasswordCell
                                        userId={u.id}
                                        onReset={() => { setResetTarget(u); setNewPassword(''); setResetError(''); }}
                                    />
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role] ?? 'bg-slate-100 text-slate-600'}`}>
                                        {u.role.replace('_', ' ')}
                                    </span>
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                                        {u.is_active ? 'Active' : 'Disabled'}
                                    </span>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {u.role !== 'ORG_ADMIN' && u.is_active && (
                                        <button
                                            type="button"
                                            onClick={() => disable(u)}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                                        >
                                            <Power className="h-3.5 w-3.5" /> Disable
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                    Passwords are stored with reversible encryption, so they can be shown here.
                    <strong> Every reveal is recorded in the activity log below</strong> with your
                    name and the time. Revealed passwords hide again automatically after 30 seconds.
                </span>
            </div>

            <AuditLogPanel module="users" />

            {/* ── reset password dialog ──────────────────────────── */}
            {resetTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
                    <form onSubmit={handleReset} className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl">
                        <h2 className="text-base font-semibold text-slate-900">Reset password</h2>
                        <p className="mt-1 text-sm text-slate-500">
                            Set a new password for <strong>{resetTarget.name}</strong> ({resetTarget.email}).
                        </p>

                        {resetError && (
                            <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{resetError}
                            </div>
                        )}

                        <label className="mt-4 block">
                            <span className="text-sm text-slate-600">New password</span>
                            <input
                                required type="text" minLength={8} autoFocus
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                className={input}
                                placeholder="min 8 characters"
                            />
                        </label>

                        <div className="mt-6 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setResetTarget(null)}
                                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={resetting}
                                className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                            >
                                {resetting && <Loader2 className="h-4 w-4 animate-spin" />}
                                Reset password
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
};

export default Users;
