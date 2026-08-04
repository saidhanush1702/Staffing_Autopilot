import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
    ArrowLeft, ShieldCheck, Users, Briefcase, UserX,
    Mail, Phone, Globe, Calendar,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import { RoleBadge } from '../../components/ui/Badge.jsx';
import { badge, card, cardPad, TONE } from '../../design/tokens.js';

const StatCard = ({ icon: Icon, label, value, sub }) => (
    <div className={`${card} ${cardPad}`}>
        <div className="flex items-center gap-3">
            <span className="rounded-lg bg-brand-50 p-2">
                <Icon className="h-5 w-5 text-brand-600" />
            </span>
            <div>
                <p className="text-2xl font-semibold text-slate-900">{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
                {sub && <p className="text-xs text-slate-400">{sub}</p>}
            </div>
        </div>
    </div>
);

/**
 * SUPER_ADMIN view of one tenant.
 *
 * Shows headcount and the user list — who exists and whether their account is
 * active. Deliberately NOT the tenant's business data: no profiles, no
 * resumes, no change requests. The platform owner administers tenants; they do
 * not read inside them.
 */
const OrganizationDetail = () => {
    const { id } = useParams();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get(`/super-admin/organizations/${id}`)
            .then(({ data: d }) => setData(d))
            .catch((err) => setError(errorMessage(err)));
    }, [id]);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!data) return <PageLoader />;

    const { organization: org, counts, users } = data;

    return (
        <div>
            <Link
                to="/super-admin/organizations"
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
                <ArrowLeft className="h-4 w-4" /> Back to organizations
            </Link>

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">{org.name}</h1>
                    <p className="mt-1 text-sm text-slate-500">/{org.slug}</p>
                </div>
                <span className={`${badge} ${org.is_active ? TONE.success : TONE.danger}`}>
                    {org.is_active ? 'Active' : 'Disabled'}
                </span>
            </div>

            {/* ── headcount ────────────────────────────────────── */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    icon={ShieldCheck} label="Organization admins"
                    value={counts.org_admins}
                    sub={`${counts.org_admins_active} active`}
                />
                <StatCard
                    icon={Users} label="Recruiters"
                    value={counts.recruiters}
                    sub={`${counts.recruiters_active} active`}
                />
                <StatCard
                    icon={Briefcase} label="Consultants"
                    value={counts.consultants}
                    sub={`${counts.consultants_active} active`}
                />
                <StatCard
                    icon={UserX} label="Suspended / terminated"
                    value={(counts.suspended_users ?? 0) + (counts.terminated_users ?? 0)}
                    sub={`of ${counts.total_users} total`}
                />
            </div>

            {/* ── org details ──────────────────────────────────── */}
            <div className={`mt-6 ${card} ${cardPad}`}>
                <p className="text-sm font-medium text-slate-700">Organization details</p>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                        { icon: Mail, label: 'Contact email', value: org.contact_email },
                        { icon: Phone, label: 'Contact phone', value: org.contact_phone },
                        { icon: Globe, label: 'Timezone', value: org.timezone },
                        { icon: Calendar, label: 'Created', value: new Date(org.created_at).toLocaleDateString() },
                    ].map(({ icon: Icon, label, value }) => (
                        <div key={label} className="flex items-start gap-2">
                            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
                                <p className="mt-0.5 text-sm text-slate-800">
                                    {value ?? <span className="text-slate-400">Not set</span>}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── users ────────────────────────────────────────── */}
            <h2 className="mt-8 text-sm font-semibold text-slate-700">
                Users ({users.length})
            </h2>
            <TableShell className="mt-3" minWidth={820}>
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Email</th>
                            <th className="px-4 py-3">Role</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3">Last sign-in</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {users.length === 0 && (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No users yet.</td></tr>
                        )}
                        {users.map((u) => (
                            <tr key={u.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3 font-medium text-slate-900">{u.name}</td>
                                <td className="px-4 py-3 text-slate-500">{u.email}</td>
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
                                <td className="px-4 py-3 text-xs text-slate-400">
                                    {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
            </TableShell>
        </div>
    );
};

export default OrganizationDetail;
