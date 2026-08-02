import { NavLink } from 'react-router-dom';
import {
    Building2, LayoutDashboard, Users, Link2, UserCircle, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Nav items are filtered by the SAME role lists used on the routes, so a user
 * never sees a link they cannot open.
 */
const NAV_ITEMS = [
    { to: '/super-admin', label: 'Platform', icon: ShieldCheck, roles: ['SUPER_ADMIN'] },
    { to: '/super-admin/organizations', label: 'Organizations', icon: Building2, roles: ['SUPER_ADMIN'] },

    { to: '/management', label: 'Dashboard', icon: LayoutDashboard, roles: ['ORG_ADMIN', 'RECRUITER'] },
    { to: '/management/users', label: 'Users', icon: Users, roles: ['ORG_ADMIN'] },
    { to: '/management/consultants', label: 'My Consultants', icon: Users, roles: ['RECRUITER'] },
    { to: '/management/assignments', label: 'Assignments', icon: Link2, roles: ['ORG_ADMIN'] },

    { to: '/portal', label: 'Dashboard', icon: LayoutDashboard, roles: ['CONSULTANT'] },
    { to: '/portal/profile', label: 'My Profile', icon: UserCircle, roles: ['CONSULTANT'] },
];

const ROLE_STYLES = {
    SUPER_ADMIN: 'bg-role-super/10 text-role-super',
    ORG_ADMIN: 'bg-role-orgadmin/10 text-role-orgadmin',
    RECRUITER: 'bg-role-recruiter/10 text-role-recruiter',
    CONSULTANT: 'bg-role-consultant/10 text-role-consultant',
};

const Sidebar = () => {
    const { user } = useAuth();
    if (!user) return null;

    const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));

    return (
        <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-5 py-4">
                <p className="text-sm font-semibold text-slate-900">Staffing Autopilot</p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                    {user.organizationName ?? 'Platform'}
                </p>
            </div>

            <nav className="flex-1 space-y-1 p-3">
                {items.map(({ to, label, icon: Icon }) => (
                    <NavLink
                        key={to}
                        to={to}
                        end={to === '/super-admin' || to === '/management' || to === '/portal'}
                        className={({ isActive }) =>
                            [
                                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                                isActive
                                    ? 'bg-brand-50 font-medium text-brand-700'
                                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
                            ].join(' ')}
                    >
                        <Icon className="h-4 w-4" />
                        {label}
                    </NavLink>
                ))}
            </nav>

            <div className="border-t border-slate-200 p-4">
                <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
                <span className={`mt-2 inline-block rounded px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLES[user.role]}`}>
                    {user.role.replace('_', ' ')}
                </span>
            </div>
        </aside>
    );
};

export default Sidebar;
