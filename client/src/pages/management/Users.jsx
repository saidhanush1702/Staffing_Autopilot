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
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import { RoleBadge } from '../../components/ui/Badge.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    card, cardPad, input, fieldLabel, fieldHint, btn, countPill, TONE, TONE_ALERT,
    pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

const EMPTY = { name: '', email: '', phone: '', role: 'CONSULTANT', password: '' };

/**
 * Which roles get a tab, in hierarchy order. The KEYS are the values the
 * database stores, so they live in code; the visible text comes from
 * `lkp_roles` at render time. Adding a role means seeding it, not editing
 * three label maps.
 */
const TAB_ROLES = ['ORG_ADMIN', 'RECRUITER', 'CONSULTANT'];

/** Roles an ORG_ADMIN may create here — never another ORG_ADMIN. */
const CREATABLE_ROLES = ['CONSULTANT', 'RECRUITER'];

const Users = () => {
    const { user } = useAuth();
    const { roleLabel } = useLookups();
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

    // Counts cover the whole organisation, not just the fetched page.
    const countFor = (role) =>
        (showAll ? counts[role]?.total : counts[role]?.active) ?? 0;
    const visible = users;   // already filtered by role on the server
    const activeLabel = roleLabel(activeTab).toLowerCase();

    return (
        <div>
            {/* ── heading + add button ───────────────────────────── */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className={pageTitle}>Users</h1>
                    <p className={pageSubtitle}>
                        Everyone in this organization, grouped by role.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => (showForm ? setShowForm(false) : openForm())}
                    className={`shrink-0 ${btn.primary}`}
                >
                    {showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    {showForm ? 'Cancel' : 'Add user'}
                </button>
            </div>

            {/* ── add user form ──────────────────────────────────── */}
            {showForm && (
                <form onSubmit={handleCreate} className={`mt-5 ${card} ${cardPad}`}>
                    {formError && (
                        <div className={`mb-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                        </div>
                    )}
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="block">
                            <span className={fieldLabel}>Name</span>
                            <input
                                required minLength={2} maxLength={255}
                                pattern="[A-Za-z][A-Za-z .'\-]*"
                                title="Letters, spaces, hyphens and apostrophes only."
                                value={form.name} onChange={set('name')} className={input}
                            />
                        </label>
                        <label className="block">
                            <span className={fieldLabel}>Email</span>
                            <input
                                required type="email" maxLength={255}
                                title="Must be unique across the whole platform."
                                value={form.email} onChange={set('email')} className={input}
                            />
                            <span className={`block ${fieldHint}`}>
                                Used to sign in — must not already exist on any organization.
                            </span>
                        </label>
                        <label className="block">
                            <span className={fieldLabel}>Phone</span>
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
                            <span className={fieldLabel}>Role</span>
                            {/* Options come from lkp_roles — the label is never
                                typed here, only the set of roles allowed. */}
                            <select value={form.role} onChange={set('role')} className={input}>
                                {CREATABLE_ROLES.map((r) => (
                                    <option key={r} value={r}>{roleLabel(r)}</option>
                                ))}
                            </select>
                        </label>
                        <label className="block">
                            <span className={fieldLabel}>Password</span>
                            <input
                                required type="text" minLength={8} maxLength={200}
                                title="At least 8 characters."
                                value={form.password} onChange={set('password')}
                                className={input} placeholder="min 8 characters"
                            />
                        </label>
                    </div>
                    <button type="submit" disabled={saving} className={`mt-5 ${btn.primary}`}>
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Create user
                    </button>
                </form>
            )}

            {/* ── role tabs ──────────────────────────────────────── */}
            <div className={`mt-6 ${tabBar}`}>
                <nav className={tabNav} aria-label="User roles">
                    {TAB_ROLES.map((roleKey) => {
                        const isActive = activeTab === roleKey;
                        return (
                            <button
                                key={roleKey}
                                type="button"
                                onClick={() => setActiveTab(roleKey)}
                                aria-current={isActive ? 'page' : undefined}
                                className={`${tabItem} ${isActive ? tabActive : tabIdle}`}
                            >
                                {roleLabel(roleKey)}
                                <span className={`${countPill} ${isActive ? TONE.brand : TONE.neutral}`}>
                                    {countFor(roleKey)}
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
                                    <RoleBadge role={u.role} />
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

            <div className={`mt-4 flex items-start gap-2 rounded-lg border border-warning-200 p-3 text-xs ${TONE_ALERT.warning}`}>
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
                <Modal
                    size="sm"
                    icon={Lock}
                    tone="brand"
                    title="Reset password"
                    subtitle={`Set a new password for ${resetTarget.name} (${resetTarget.email}).`}
                    as="form"
                    onSubmit={handleReset}
                    onClose={() => setResetTarget(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setResetTarget(null)}
                            confirmType="submit"
                            confirmLabel="Reset password"
                            busy={resetting}
                        />
                    )}
                >
                    {resetError && (
                        <div className={`mb-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{resetError}
                        </div>
                    )}

                    <label className="block">
                        <span className={fieldLabel}>New password</span>
                        <input
                            required type="text" minLength={8} autoFocus
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className={input}
                            placeholder="min 8 characters"
                        />
                    </label>
                </Modal>
            )}
        </div>
    );
};

export default Users;
