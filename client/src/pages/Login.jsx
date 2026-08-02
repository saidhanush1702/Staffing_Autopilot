import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { errorMessage } from '../api/axios.js';

/** Where each role lands after signing in. */
export const HOME_FOR_ROLE = {
    SUPER_ADMIN: '/super-admin',
    ORG_ADMIN: '/management',
    RECRUITER: '/management',
    CONSULTANT: '/portal',
};

const Login = () => {
    const { user, loading, login } = useAuth();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Already signed in? Skip the form.
    useEffect(() => {
        if (!loading && user) navigate(HOME_FOR_ROLE[user.role] ?? '/', { replace: true });
    }, [user, loading, navigate]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSubmitting(true);
        try {
            const data = await login(email.trim(), password);
            navigate(HOME_FOR_ROLE[data.role] ?? '/', { replace: true });
        } catch (err) {
            setError(errorMessage(err, 'Unable to sign in.'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
            <div className="w-full max-w-sm">
                <div className="mb-6 text-center">
                    <h1 className="text-2xl font-semibold text-slate-900">Staffing Autopilot</h1>
                    <p className="mt-1 text-sm text-slate-500">Sign in to your account</p>
                </div>

                <form
                    onSubmit={handleSubmit}
                    className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                    {error && (
                        <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    <label className="block">
                        <span className="text-sm font-medium text-slate-700">Email</span>
                        <input
                            type="email"
                            required
                            autoComplete="username"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                            placeholder="you@company.com"
                        />
                    </label>

                    <label className="mt-4 block">
                        <span className="text-sm font-medium text-slate-700">Password</span>
                        <input
                            type="password"
                            required
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                            placeholder="••••••••"
                        />
                    </label>

                    <button
                        type="submit"
                        disabled={submitting}
                        className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {submitting
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <LogIn className="h-4 w-4" />}
                        {submitting ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>

                <p className="mt-4 text-center text-xs text-slate-400">
                    Seeded accounts: superadmin@staffing.local · admin@molina.local ·
                    recruiter1@molina.local · consultant1@molina.local
                </p>
            </div>
        </div>
    );
};

export default Login;
