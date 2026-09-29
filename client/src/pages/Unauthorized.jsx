import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { HOME_FOR_ROLE } from './Login.jsx';
import { BrandMark } from '../components/ui/Brand.jsx';
import { btn, card } from '../design/tokens.js';

/**
 * Reached when a route's guard refuses a signed-in user.
 *
 * It names the role that was refused rather than saying "access denied",
 * because the usual cause is a bookmark from a colleague with a different
 * role — and knowing which role you are is what turns a dead end into "ask
 * an admin for X".
 */
const Unauthorized = () => {
    const { user } = useAuth();
    const home = user ? (HOME_FOR_ROLE[user.role] ?? '/') : '/';

    return (
        <div className="grid-fade flex min-h-screen flex-col items-center justify-center gap-6
                        bg-canvas px-4 text-center">
            <BrandMark size="lg" />

            <div className={`${card} max-w-md p-8`}>
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl
                                 bg-danger-50 text-danger-600">
                    <ShieldOff className="h-6 w-6" />
                </span>

                <h1 className="mt-5 font-display text-xl font-semibold text-slate-900">Access denied</h1>
                <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    Your role
                    {' '}
                    <strong className="font-medium text-slate-700">
                        {user?.role?.replace(/_/g, ' ').toLowerCase() ?? 'unknown'}
                    </strong>
                    {' '}
                    does not have permission to open that page. If you need it, ask your
                    organization admin.
                </p>

                <Link to={home} className={`mt-6 ${btn.primary}`}>
                    <ArrowLeft className="h-4 w-4" />
                    Back to my dashboard
                </Link>
            </div>
        </div>
    );
};

export default Unauthorized;
