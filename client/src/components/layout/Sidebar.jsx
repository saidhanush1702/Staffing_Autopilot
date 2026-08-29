import { useEffect, useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
    Building2, LayoutDashboard, Users, Contact, Link2, UserCircle,
    ShieldCheck, ClipboardCheck, X, Search, MessageSquare, Radar, Briefcase, Laptop,
    PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { RoleBadge } from '../ui/Badge.jsx';
import Brand, { BrandMark } from '../ui/Brand.jsx';
import Avatar from '../ui/Avatar.jsx';
import api from '../../api/axios.js';
import {
    navItem, navItemActive, navItemIdle, navGroupLabel, navMarker, countPill, iconBtnShell,
} from '../../design/tokens.js';

/**
 * ── THE NAVIGATION ────────────────────────────────────────────────────
 *
 * Items are filtered by the SAME role lists used on the routes, so a user
 * never sees a link they cannot open.
 *
 * ── WHY IT IS GROUPED ─────────────────────────────────────────────────
 *
 * An org admin has eight destinations. As one flat column they are eight
 * equally-weighted things to read every time; grouped, they are four labelled
 * areas — people, review, sourcing, system — and a person who knows they want
 * to approve something skips three quarters of the list without reading it.
 *
 * The groups are also the product's own shape. "Review" holding both
 * approvals queues is the reason a recruiter can be told "everything waiting
 * on you is under Review" and have that stay true as the app grows.
 *
 * `badge` names a counter fetched below:
 *   approvals   pending profile change requests awaiting this reviewer
 *   incomplete  required profile fields the consultant still has to fill
 *   answers     answers this reviewer can actually act on (locked sensitive
 *               items are excluded, so the badge never sends a recruiter to an
 *               inbox where nothing is clickable)
 *   unanswered  questions the consultant has not answered yet
 */
const NAV_GROUPS = [
    {
        label: 'Platform',
        roles: ['SUPER_ADMIN'],
        items: [
            { to: '/super-admin', label: 'Overview', icon: ShieldCheck, roles: ['SUPER_ADMIN'] },
            { to: '/super-admin/organizations', label: 'Organizations', icon: Building2, roles: ['SUPER_ADMIN'] },
        ],
    },
    {
        label: null, // the dashboard stands alone, above the groups
        roles: ['ORG_ADMIN', 'RECRUITER', 'CONSULTANT'],
        items: [
            { to: '/management', label: 'Dashboard', icon: LayoutDashboard, roles: ['ORG_ADMIN', 'RECRUITER'] },
            { to: '/portal', label: 'Dashboard', icon: LayoutDashboard, roles: ['CONSULTANT'] },
        ],
    },
    {
        label: 'People',
        roles: ['ORG_ADMIN', 'RECRUITER'],
        items: [
            { to: '/management/users', label: 'Users', icon: Users, roles: ['ORG_ADMIN'] },
            // Same route for both roles; the label differs because a recruiter
            // only ever receives their own assigned consultants from the server.
            { to: '/management/consultants', label: 'Consultants', icon: Contact, roles: ['ORG_ADMIN'] },
            { to: '/management/consultants', label: 'My Consultants', icon: Contact, roles: ['RECRUITER'] },
            { to: '/management/assignments', label: 'Assignments', icon: Link2, roles: ['ORG_ADMIN'] },
        ],
    },
    {
        label: 'Review',
        roles: ['ORG_ADMIN', 'RECRUITER'],
        items: [
            {
                to: '/management/approvals', label: 'Approvals', icon: ClipboardCheck,
                roles: ['ORG_ADMIN', 'RECRUITER'], badge: 'approvals',
            },
            {
                to: '/management/answers', label: 'Answer approvals', icon: MessageSquare,
                roles: ['ORG_ADMIN', 'RECRUITER'], badge: 'answers',
            },
        ],
    },
    {
        label: 'Sourcing',
        roles: ['ORG_ADMIN', 'RECRUITER'],
        items: [
            { to: '/management/postings', label: 'Job Postings', icon: Briefcase, roles: ['ORG_ADMIN', 'RECRUITER'] },
            { to: '/management/discovery', label: 'Job Discovery', icon: Radar, roles: ['ORG_ADMIN', 'RECRUITER'] },
        ],
    },
    {
        label: 'System',
        roles: ['ORG_ADMIN', 'RECRUITER'],
        items: [
            { to: '/management/devices', label: 'Desktop Access', icon: Laptop, roles: ['ORG_ADMIN', 'RECRUITER'] },
        ],
    },
    {
        label: 'My account',
        roles: ['CONSULTANT'],
        items: [
            {
                to: '/portal/profile', label: 'My Profile', icon: UserCircle,
                roles: ['CONSULTANT'], badge: 'incomplete',
            },
            // Read-only for the consultant — their recruiter owns the criteria (R-23).
            { to: '/portal/criteria', label: 'My Search Criteria', icon: Search, roles: ['CONSULTANT'] },
            {
                to: '/portal/answers', label: 'My Answers', icon: MessageSquare,
                roles: ['CONSULTANT'], badge: 'unanswered',
            },
        ],
    },
];

/** Routes whose NavLink must match exactly, or every child would light them up. */
const EXACT = new Set(['/super-admin', '/management', '/portal']);

const POLL_MS = 30_000;
const COLLAPSE_KEY = 'smartapply.nav.collapsed';

/**
 * Static column from `lg` up; an off-canvas drawer below that, where a
 * permanent 17rem column would leave almost nothing for the page itself.
 * `open` / `onClose` are owned by Layout, which also renders the toggle.
 *
 * ── COLLAPSING ────────────────────────────────────────────────────────
 *
 * On a wide screen the column can shrink to an icon rail. This is not a
 * space-saving gimmick: the tables in this app are wide, and 13rem of page is
 * the difference between a readable Assignments grid and one that scrolls
 * sideways. The choice is remembered, because a person who wants the rail
 * wants it every day.
 */
const Sidebar = ({ open = false, onClose = () => {} }) => {
    const { user } = useAuth();
    const location = useLocation();
    const [badges, setBadges] = useState({ approvals: 0, incomplete: 0, answers: 0, unanswered: 0 });
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
    });

    const toggleCollapsed = () => setCollapsed((v) => {
        const next = !v;
        try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* not worth failing over */ }
        return next;
    });

    const refreshBadges = useCallback(async () => {
        if (!user) return;
        try {
            if (user.role === 'ORG_ADMIN' || user.role === 'RECRUITER') {
                const [changes, answers] = await Promise.all([
                    api.get('/management/profile-changes/count'),
                    api.get('/management/answers/count'),
                ]);
                setBadges((b) => ({
                    ...b,
                    approvals: changes.data.pending,
                    // `pending` counts only what THIS reviewer can act on. A
                    // recruiter's badge deliberately excludes locked sensitive
                    // items — sending them to an inbox where nothing is
                    // clickable would be worse than no badge.
                    answers: answers.data.pending,
                }));
            } else if (user.role === 'CONSULTANT') {
                const [me, unanswered] = await Promise.all([
                    api.get('/portal/me'),
                    api.get('/portal/answers/count'),
                ]);
                setBadges((b) => ({
                    ...b,
                    incomplete: me.data.missingFields.length,
                    unanswered: unanswered.data.outstanding,
                }));
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

    // A drawer is never collapsed: on a phone there is no rail to fall back to,
    // and an icon-only overlay is just a worse menu.
    const rail = collapsed && !open;

    const groups = NAV_GROUPS
        .filter((g) => g.roles.includes(user.role))
        .map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(user.role)) }))
        .filter((g) => g.items.length > 0);

    return (
        <>
            {/* Scrim, mobile only. */}
            {open && (
                <button
                    type="button"
                    aria-label="Close navigation"
                    onClick={onClose}
                    className="animate-fade-in fixed inset-0 z-30 bg-overlay/50 backdrop-blur-sm lg:hidden"
                />
            )}

            <aside
                className={[
                    'z-40 flex shrink-0 flex-col border-r border-line bg-surface',
                    'fixed inset-y-0 left-0 lg:static lg:translate-x-0',
                    'transition-[transform,width] duration-200 ease-[var(--ease-out-soft)]',
                    rail ? 'w-rail' : 'w-sidebar',
                    open ? 'translate-x-0 shadow-2xl' : '-translate-x-full lg:shadow-none',
                ].join(' ')}
            >
                {/* ── brand ─────────────────────────────────────────────── */}
                <div className={`flex h-header shrink-0 items-center border-b border-line
                                 ${rail ? 'justify-center px-2' : 'gap-2 pl-4 pr-3'}`}>
                    {rail ? (
                        <BrandMark size="md" />
                    ) : (
                        <>
                            <Brand subtitle={user.organizationName ?? 'Platform'} className="flex-1" />
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close navigation"
                                className={`${iconBtnShell} h-8 w-8 lg:hidden`}
                            >
                                <X className="h-[1.15rem] w-[1.15rem]" />
                            </button>
                        </>
                    )}
                </div>

                {/* ── links ─────────────────────────────────────────────── */}
                <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3">
                    {groups.map((group, gi) => (
                        <div key={group.label ?? `g${gi}`}>
                            {group.label && !rail && (
                                <p className={navGroupLabel}>{group.label}</p>
                            )}
                            {/* In the rail the labels are gone, so the groups
                                need a rule between them or they run together. */}
                            {group.label && rail && gi > 0 && (
                                <div className="mx-2 my-2 h-px bg-line" />
                            )}
                            {!group.label && <div className="pt-3" />}

                            <div className="space-y-0.5">
                                {group.items.map(({ to, label, icon: Icon, badge }) => {
                                    const count = badge ? badges[badge] : 0;
                                    const tip = badge === 'incomplete'
                                        ? `${count} required field${count === 1 ? '' : 's'} still missing`
                                        : `${count} awaiting your review`;

                                    return (
                                        <NavLink
                                            key={`${to}-${label}`}
                                            to={to}
                                            end={EXACT.has(to)}
                                            title={rail ? label : undefined}
                                            className={({ isActive }) => [
                                                navItem,
                                                isActive ? navItemActive : navItemIdle,
                                                rail ? 'justify-center px-0' : '',
                                            ].join(' ')}
                                        >
                                            {({ isActive }) => (
                                                <>
                                                    {isActive && !rail && <span className={navMarker} />}
                                                    <span className="relative shrink-0">
                                                        <Icon className="h-[1.15rem] w-[1.15rem]" />
                                                        {/* In the rail there is nowhere to put a
                                                            number, so it becomes a dot — still
                                                            "something is waiting", just quieter. */}
                                                        {rail && count > 0 && (
                                                            <span
                                                                title={tip}
                                                                className="absolute -right-1 -top-1 h-2 w-2 rounded-full
                                                                           bg-brand-600 ring-2 ring-surface"
                                                            />
                                                        )}
                                                    </span>

                                                    {!rail && (
                                                        <>
                                                            <span className="flex-1 truncate">{label}</span>
                                                            {count > 0 && (
                                                                <span
                                                                    title={tip}
                                                                    className={`${countPill} ${
                                                                        badge === 'incomplete'
                                                                            ? 'bg-warning-100 text-warning-700'
                                                                            : 'bg-brand-600 text-white'}`}
                                                                >
                                                                    {count}
                                                                </span>
                                                            )}
                                                        </>
                                                    )}
                                                </>
                                            )}
                                        </NavLink>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </nav>

                {/* ── who you are ───────────────────────────────────────── */}
                <div className="shrink-0 border-t border-line p-2.5">
                    {rail ? (
                        <div className="flex flex-col items-center gap-2">
                            <Avatar name={user.name} email={user.email} size="md" />
                            <button
                                type="button"
                                onClick={toggleCollapsed}
                                title="Expand navigation"
                                aria-label="Expand navigation"
                                className={`${iconBtnShell} h-8 w-8`}
                            >
                                <PanelLeftOpen className="h-[1.15rem] w-[1.15rem]" />
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5">
                            <Avatar name={user.name} email={user.email} size="lg" />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
                                <RoleBadge role={user.role} className="mt-1" />
                            </div>
                            <button
                                type="button"
                                onClick={toggleCollapsed}
                                title="Collapse navigation"
                                aria-label="Collapse navigation"
                                className={`${iconBtnShell} hidden h-8 w-8 lg:inline-flex`}
                            >
                                <PanelLeftClose className="h-[1.15rem] w-[1.15rem]" />
                            </button>
                        </div>
                    )}
                </div>
            </aside>
        </>
    );
};

export default Sidebar;
