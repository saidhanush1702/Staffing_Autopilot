import { useEffect, useState } from 'react';
import {
    Plus, X, Loader2, AlertCircle, ShieldAlert, Lock, Eye, EyeOff,
    Users as UsersIcon,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import PasswordCell from '../../components/PasswordCell.jsx';
import Pagination from '../../components/Pagination.jsx';
import TableShell from '../../components/TableShell.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import LifecycleActions from '../../components/LifecycleActions.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

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
    const { user } = useAuth();
    const [users, setUsers] = useState(null);
    const [page, setPage] = useState(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [error, setError] = useState('');
    const [activeTab, setActiveTab] = useState('ORG_ADMIN');
    const [counts, setCounts] = useState({});
    const [showAll, setShowAll] = useState(false);

    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState(EMPTY);
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    // Password reset dialog
    const [resetTarget, setResetTarget] = useState(null);
    const [newPassword, setNewPassword] = useState('');
    const [resetError, setResetError] = useState('');
    const [resetting, setResetting] = useState(false);

    /**
     * Role filtering happens SERVER-SIDE. Filtering a paginated page in the
     * browser meant a tab could show zero rows simply because none of its
     * users landed on page 1.
     */
    const load = async (p = 1, role = activeTab, all = showAll) => {
        try {
            const { data } = await api.get('/management/users', {
                params: { page: p, limit: 25, role, includeInactive: all || undefined },
            });
            setUsers(data.users);
            setPage(data.page);
            setCounts(data.counts ?? {});
            setCurrentPage(p);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(1, activeTab, showAll); /* eslint-disable-next-line */ },
        [activeTab, showAll]);

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

    // Counts cover the whole organisation, not just the fetched page.
    const countFor = (role) =>
        (showAll ? counts[role]?.total : counts[role]?.active) ?? 0;
    const visible = users;   // already filtered by role on the server
    const activeLabel = TABS.find((t) => t.key === activeTab)?.label.toLowerCase();

    return (
        <div>
            {/* ── heading + add button ───────────────────────────── */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">Users</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        Everyone in this organization, grouped by role.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => (showForm ? setShowForm(false) : openForm())}
                    className="flex shrink-0 items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
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
                            <input
                                required minLength={2} maxLength={255}
                                pattern="[A-Za-z][A-Za-z .'\-]*"
                                title="Letters, spaces, hyphens and apostrophes only."
                                value={form.name} onChange={set('name')} className={input}
                            />
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Email</span>
                            <input
                                required type="email" maxLength={255}
                                title="Must be unique across the whole platform."
                                value={form.email} onChange={set('email')} className={input}
                            />
                            <span className="mt-1 block text-xs text-slate-400">
                                Used to sign in — must not already exist on any organization.
                            </span>
                        </label>
                        <label className="block">
                            <span className="text-sm text-slate-600">Phone</span>
                            {/* Mirrors PROFILE_FIELDS.phone on the server. */}
                            <input
                                inputMode="numeric" maxLength={10} pattern="[0-9]{10}"
                                title="Exactly 10 digits, no spaces or symbols."
                                placeholder="5550101234"
                                value={form.phone}
                                onChange={(e) => setForm((f) => ({
                                    ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10),
                                }))}
                                className={input}
                            />
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
                            <input
                                required type="text" minLength={8} maxLength={200}
                                title="At least 8 characters."
                                value={form.password} onChange={set('password')}
                                className={input} placeholder="min 8 characters"
                            />
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
                <nav className="-mb-px flex gap-4 overflow-x-auto sm:gap-6" aria-label="User roles">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <button
                                key={tab.key}
                                type="button"
                                onClick={() => setActiveTab(tab.key)}
                                aria-current={isActive ? 'page' : undefined}
                                className={[
                                    'flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors',
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

            {/* Day to day an admin wants the current roster; history is opt-in. */}
            <div className="mt-3 flex items-center justify-end">
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                    {showAll ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showAll ? 'Show active only' : `Show all ${activeLabel}`}
                </button>
            </div>

            {/* ── table for the active tab ───────────────────────── */}
            <TableShell
                className="mt-4"
                minWidth={860}
                footer={<Pagination page={page} onChange={(p) => load(p)} />}
            >
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
                                <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">{u.name}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-500">{u.email}</td>
                                <td className="px-4 py-3">
                                    {/* Layer 3, cosmetic only: the server refuses a peer admin's
                                        password regardless. Hiding the controls avoids offering
                                        buttons that can only ever return 403. */}
                                    {u.role === 'ORG_ADMIN' && u.id !== user?.id ? (
                                        <span
                                            title="Another organization admin's password is not accessible"
                                            className="inline-flex items-center gap-1.5 text-xs text-slate-400"
                                        >
                                            <Lock className="h-3.5 w-3.5" /> Not accessible
                                        </span>
                                    ) : (
                                        <PasswordCell
                                            userId={u.id}
                                            onReset={() => { setResetTarget(u); setNewPassword(''); setResetError(''); }}
                                        />
                                    )}
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role] ?? 'bg-slate-100 text-slate-600'}`}>
                                        {u.role.replace('_', ' ')}
                                    </span>
                                </td>
                                <td className="px-4 py-3">
                                    <EmploymentStatus
                                        status={u.employment_status}
                                        since={u.terminated_at ?? u.suspended_at}
                                        reason={u.termination_reason ?? u.suspend_reason}
                                    />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-right">
                                    {u.role !== 'ORG_ADMIN' && (
                                        <LifecycleActions user={u} onDone={() => load(currentPage)} />
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
            </TableShell>

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
