import { useEffect, useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
    Building2, LayoutDashboard, Users, Contact, Link2, UserCircle,
    ShieldCheck, ClipboardCheck, X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { RoleBadge } from '../ui/Badge.jsx';
import api from '../../api/axios.js';

/**
 * Nav items are filtered by the SAME role lists used on the routes, so a user
 * never sees a link they cannot open.
 *
 * `badge` names a counter fetched below:
 *   approvals — pending profile change requests awaiting this reviewer
 *   incomplete — required profile fields the consultant still has to fill
 */
const NAV_ITEMS = [
    { to: '/super-admin', label: 'Platform', icon: ShieldCheck, roles: ['SUPER_ADMIN'] },
    { to: '/super-admin/organizations', label: 'Organizations', icon: Building2, roles: ['SUPER_ADMIN'] },

    { to: '/management', label: 'Dashboard', icon: LayoutDashboard, roles: ['ORG_ADMIN', 'RECRUITER'] },
    { to: '/management/users', label: 'Users', icon: Users, roles: ['ORG_ADMIN'] },
    // Same route for both roles; the label differs because a recruiter only
    // ever receives their own assigned consultants from the server.
    { to: '/management/consultants', label: 'Consultants', icon: Contact, roles: ['ORG_ADMIN'] },
    { to: '/management/consultants', label: 'My Consultants', icon: Contact, roles: ['RECRUITER'] },
    {
        to: '/management/approvals', label: 'Approvals', icon: ClipboardCheck,
        roles: ['ORG_ADMIN', 'RECRUITER'], badge: 'approvals',
    },
    { to: '/management/assignments', label: 'Assignments', icon: Link2, roles: ['ORG_ADMIN'] },

    { to: '/portal', label: 'Dashboard', icon: LayoutDashboard, roles: ['CONSULTANT'] },
    {
        to: '/portal/profile', label: 'My Profile', icon: UserCircle,
        roles: ['CONSULTANT'], badge: 'incomplete',
    },
];

const POLL_MS = 30_000;

/**
 * Static column from `lg` up; an off-canvas drawer below that, where a
 * permanent 16rem column would leave almost nothing for the page itself.
 * `open` / `onClose` are owned by Layout, which also renders the toggle.
 */
const Sidebar = ({ open = false, onClose = () => {} }) => {
    const { user } = useAuth();
    const location = useLocation();
    const [badges, setBadges] = useState({ approvals: 0, incomplete: 0 });

    const refreshBadges = useCallback(async () => {
        if (!user) return;
        try {
            if (user.role === 'ORG_ADMIN' || user.role === 'RECRUITER') {
                const { data } = await api.get('/management/profile-changes/count');
                setBadges((b) => ({ ...b, approvals: data.pending }));
            } else if (user.role === 'CONSULTANT') {
                const { data } = await api.get('/portal/me');
                setBadges((b) => ({ ...b, incomplete: data.missingFields.length }));
            }
        } catch { /* a stale badge must never break the shell */ }
    }, [user]);

    /**
     * Counts were previously fetched once per session, so a badge stayed wrong
     * until the user logged out and back in. Three triggers now keep it live:
     *   - on navigation, which covers "I just approved something"
     *   - on a 30s poll, which covers changes made by someone else
     *   - on window focus, which covers coming back to an idle tab
     */
    useEffect(() => { refreshBadges(); }, [refreshBadges, location.pathname]);

    // Tapping a link on a phone should reveal the page, not leave the drawer
    // covering it.
    useEffect(() => { onClose(); /* eslint-disable-next-line */ }, [location.pathname]);

    // Escape closes the drawer, as any overlay should.
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        if (!user) return undefined;
        const id = setInterval(refreshBadges, POLL_MS);
        const onFocus = () => refreshBadges();
        window.addEventListener('focus', onFocus);
        return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
    }, [user, refreshBadges]);

    if (!user) return null;

    const items = NAV_ITEMS.filter((i) => i.roles.includes(user.role));

    return (
        <>
            {/* Scrim, mobile only. */}
            {open && (
                <button
                    type="button"
                    aria-label="Close navigation"
                    onClick={onClose}
                    className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
                />
            )}

            <aside
                className={[
                    'z-40 flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white',
                    'fixed inset-y-0 left-0 transition-transform duration-200 lg:static lg:translate-x-0',
                    open ? 'translate-x-0' : '-translate-x-full',
                ].join(' ')}
            >
            <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-5 py-4">
                <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">Staffing Autopilot</p>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                        {user.organizationName ?? 'Platform'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close navigation"
                    className="-mr-1 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 lg:hidden"
                >
                    <X className="h-5 w-5" />
                </button>
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto p-3">
                {items.map(({ to, label, icon: Icon, badge }) => {
                    const count = badge ? badges[badge] : 0;
                    return (
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
                            <span className="flex-1">{label}</span>
                            {count > 0 && (
                                <span
                                    title={badge === 'incomplete'
                                        ? `${count} required field${count === 1 ? '' : 's'} still missing`
                                        : `${count} awaiting your review`}
                                    className={[
                                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                        badge === 'incomplete'
                                            ? 'bg-amber-100 text-amber-700'
                                            : 'bg-brand-600 text-white',
                                    ].join(' ')}
                                >
                                    {count}
                                </span>
                            )}
                        </NavLink>
                    );
                })}
            </nav>

            <div className="border-t border-slate-200 p-4">
                <p className="truncate text-sm font-medium text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
                <RoleBadge role={user.role} className="mt-2" />
            </div>
            </aside>
        </>
    );
};

export default Sidebar;
