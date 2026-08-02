import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { HOME_FOR_ROLE } from './Login.jsx';

const Unauthorized = () => {
    const { user } = useAuth();
    const home = user ? (HOME_FOR_ROLE[user.role] ?? '/') : '/';

    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center">
            <ShieldOff className="h-12 w-12 text-red-500" />
            <h1 className="text-xl font-semibold text-slate-900">Access denied</h1>
            <p className="max-w-md text-sm text-slate-500">
                Your role ({user?.role?.replace('_', ' ') ?? 'unknown'}) does not have
                permission to view that page.
            </p>
            <Link
                to={home}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
                Back to my dashboard
            </Link>
        </div>
    );
};

export default Unauthorized;
