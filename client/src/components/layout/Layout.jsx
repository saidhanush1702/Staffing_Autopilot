import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

const Layout = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [navOpen, setNavOpen] = useState(false);

    const handleLogout = async () => {
        await logout();
        navigate('/', { replace: true });
    };

    return (
        <div className="flex h-screen bg-slate-50">
            <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        aria-label="Open navigation"
                        className="-ml-1 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900 lg:hidden"
                    >
                        <Menu className="h-5 w-5" />
                    </button>

                    {/* The label is the first thing worth dropping on a narrow
                        screen — the name alone still answers "who am I?". */}
                    <p className="min-w-0 flex-1 truncate text-sm text-slate-500">
                        <span className="hidden sm:inline">Signed in as </span>
                        <span className="font-medium text-slate-800">{user?.name}</span>
                    </p>

                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 sm:px-3"
                    >
                        <LogOut className="h-4 w-4" />
                        <span className="hidden sm:inline">Sign out</span>
                    </button>
                </header>

                <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
            </div>
        </div>
    );
};

export default Layout;
