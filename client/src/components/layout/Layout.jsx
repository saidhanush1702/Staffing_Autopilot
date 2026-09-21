import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut, Menu } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import ThemeToggle from '../ui/ThemeToggle.jsx';
import Avatar from '../ui/Avatar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useThemeShortcut } from '../../context/ThemeContext.jsx';
import {
    iconBtnShell, menuPanel, menuItemDanger, menuLabel, menuSeparator,
    pageShell, pageGutter,
} from '../../design/tokens.js';

/**
 * ── WHERE AM I? ───────────────────────────────────────────────────────
 *
 * The header names the current screen. It reads from a map rather than from
 * the page component because the header renders before the lazily-loaded page
 * arrives — a title that appears a beat after the rest of the chrome is worse
 * than no title, and this way the breadcrumb is correct on the first frame.
 *
 * Longest match wins, so `/management/consultants/12` inherits the
 * `/management/consultants` entry without needing one of its own.
 */
const SECTION = {
    '/super-admin': ['Platform', 'Overview'],
    '/super-admin/organizations': ['Platform', 'Organizations'],

    '/management': ['Workspace', 'Dashboard'],
    '/management/users': ['People', 'Users'],
    '/management/consultants': ['People', 'Consultants'],
    '/management/assignments': ['People', 'Assignments'],
    '/management/approvals': ['Review', 'Approvals'],
    '/management/answers': ['Review', 'Approvals'],
    '/management/postings': ['Sourcing', 'Job postings'],
    '/management/discovery': ['Sourcing', 'Job discovery'],
    '/management/jobspipe': ['Sourcing', 'JobsPipe feed'],
    '/management/devices': ['System', 'Desktop access'],
    '/management/ai-models': ['System', 'AI models'],

    '/portal': ['Workspace', 'Dashboard'],
    '/portal/profile': ['My account', 'My profile'],
    '/portal/criteria': ['My account', 'My search criteria'],
    '/portal/answers': ['My account', 'My answers'],
};

const sectionFor = (pathname) => {
    const match = Object.keys(SECTION)
        .filter((p) => pathname === p || pathname.startsWith(`${p}/`))
        .sort((a, b) => b.length - a.length)[0];
    return SECTION[match] ?? [];
};

const Layout = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [navOpen, setNavOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef(null);

    useThemeShortcut();

    // Close the account menu on an outside click or on Escape — the two things
    // every person tries when a popover is in the way.
    useEffect(() => {
        if (!menuOpen) return undefined;
        const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    // Navigating with the menu open would leave it hanging over the new page.
    useEffect(() => { setMenuOpen(false); }, [location.pathname]);

    const handleLogout = async () => {
        await logout();
        navigate('/', { replace: true });
    };

    const [group, page] = sectionFor(location.pathname);

    return (
        <div className="flex h-screen overflow-hidden bg-canvas">
            <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

            <div className="flex min-w-0 flex-1 flex-col">
                {/*
                  Sticky and translucent: a long table scrolls under the header
                  rather than past it, so the account menu and the theme switch
                  are reachable from row 400 without scrolling back up.
                */}
                <header className="glass sticky top-0 z-20 flex h-header shrink-0 items-center gap-2
                                   border-b border-line px-3 sm:px-5">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        aria-label="Open navigation"
                        className={`${iconBtnShell} lg:hidden`}
                    >
                        <Menu className="h-[1.15rem] w-[1.15rem]" />
                    </button>

                    {/* The group is the first thing worth dropping on a narrow
                        screen — the page name alone still answers "where am I?". */}
                    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5">
                        {group && (
                            <>
                                <span className="hidden text-sm text-slate-500 sm:inline">{group}</span>
                                <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-slate-300 sm:inline" />
                            </>
                        )}
                        <span className="truncate font-display text-sm font-semibold text-slate-900">
                            {page ?? 'SmartApply'}
                        </span>
                    </nav>

                    <ThemeToggle />

                    {/* ── account ───────────────────────────────────────── */}
                    <div className="relative" ref={menuRef}>
                        <button
                            type="button"
                            onClick={() => setMenuOpen((v) => !v)}
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition-colors
                                       hover:bg-slate-100"
                        >
                            <Avatar name={user?.name} email={user?.email} size="md" />
                            <span className="hidden min-w-0 max-w-36 truncate text-sm font-medium
                                             text-slate-700 xl:inline">
                                {user?.name}
                            </span>
                        </button>

                        {menuOpen && (
                            <div role="menu" className={`${menuPanel} right-0 top-[calc(100%+0.5rem)] w-64`}>
                                <div className="flex items-center gap-2.5 px-2.5 py-2">
                                    <Avatar name={user?.name} email={user?.email} size="lg" />
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-slate-900">
                                            {user?.name}
                                        </p>
                                        <p className="truncate text-xs text-slate-500">{user?.email}</p>
                                    </div>
                                </div>

                                <div className={menuSeparator} />

                                <p className={menuLabel}>Appearance</p>
                                <div className="px-2.5 pb-2 pt-1">
                                    <ThemeToggle variant="segmented" className="w-full justify-between" />
                                </div>

                                <div className={menuSeparator} />

                                <button type="button" role="menuitem" onClick={handleLogout} className={menuItemDanger}>
                                    <LogOut className="h-4 w-4" />
                                    Sign out
                                </button>
                            </div>
                        )}
                    </div>

                    {/* On a phone the account menu is a long reach; sign-out
                        stays available as its own control. */}
                    <button
                        type="button"
                        onClick={handleLogout}
                        aria-label="Sign out"
                        className={`${iconBtnShell} sm:hidden`}
                    >
                        <LogOut className="h-[1.15rem] w-[1.15rem]" />
                    </button>
                </header>

                <main className="flex-1 overflow-y-auto">
                    <div className={`${pageShell} ${pageGutter} animate-rise`} key={location.pathname}>
                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
};

export default Layout;
