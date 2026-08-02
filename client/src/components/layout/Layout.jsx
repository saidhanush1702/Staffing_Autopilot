import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

const Layout = ({ children }) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = async () => {
        await logout();
        navigate('/', { replace: true });
    };

    return (
        <div className="flex h-screen bg-slate-50">
            <Sidebar />

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
                    <p className="text-sm text-slate-500">
                        Signed in as <span className="font-medium text-slate-800">{user?.name}</span>
                    </p>
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                    >
                        <LogOut className="h-4 w-4" />
                        Sign out
                    </button>
                </header>

                <main className="flex-1 overflow-y-auto p-6">{children}</main>
            </div>
        </div>
    );
};

export default Layout;
