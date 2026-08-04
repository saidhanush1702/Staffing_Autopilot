import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
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
    const [showPassword, setShowPassword] = useState(false);
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

    const field = 'w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm '
        + 'text-slate-900 placeholder:text-slate-400 outline-none transition-colors '
        + 'focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

    return (
        <div className="min-h-screen w-full bg-white">
            {/* Full-bleed: no card, no surrounding page gutter — the two columns
                fill the whole viewport. On mobile the logo stacks above the form
                so it is never squeezed into an unreadable strip. */}
            <div className="grid min-h-screen w-full grid-cols-1 items-center gap-10 px-6 py-12
                            sm:px-10 lg:grid-cols-2 lg:gap-20 lg:px-20">

                    {/* logo — first on mobile, second on desktop */}
                    <div className="order-first flex justify-center lg:order-last">
                        <img
                            src="/image.png"
                            alt="Molina Technologies"
                            className="h-28 w-auto max-w-full object-contain sm:h-40 lg:h-auto lg:max-h-96"
                        />
                    </div>

                    {/* form */}
                    <div className="mx-auto w-full max-w-md">
                        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">
                            Welcome Back!
                        </h1>

                        <form onSubmit={handleSubmit} className="mt-6 sm:mt-8">
                            {error && (
                                <div
                                    role="alert"
                                    className="mb-5 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700"
                                >
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <label className="block">
                                <span className="text-sm text-slate-700">
                                    E-mail <span className="text-red-500">*</span>
                                </span>
                                <input
                                    type="email"
                                    required
                                    autoComplete="username"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className={`mt-1.5 ${field}`}
                                    placeholder="Type your Email"
                                />
                            </label>

                            <div className="mt-5">
                                <div className="flex items-baseline justify-between gap-3">
                                    <label htmlFor="password" className="text-sm text-slate-700">
                                        Password <span className="text-red-500">*</span>
                                    </label>
                                    {/* Wired up in a later phase — rendered now so the
                                        layout matches the agreed design. */}
                                    <button
                                        type="button"
                                        title="Password recovery is not available yet."
                                        onClick={() => setError(
                                            'Password recovery is not available yet — '
                                            + 'ask your organization admin to reset it for you.',
                                        )}
                                        className="text-sm text-slate-400 hover:text-slate-600 hover:underline"
                                    >
                                        Forgot your password?
                                    </button>
                                </div>

                                <div className="relative mt-1.5">
                                    <input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        required
                                        autoComplete="current-password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className={`${field} pr-12`}
                                        placeholder="Type your Password"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        title={showPassword ? 'Hide password' : 'Show password'}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-2
                                                   text-slate-400 transition-colors hover:text-slate-600
                                                   focus:outline-none focus:ring-2 focus:ring-brand-100"
                                    >
                                        {showPassword
                                            ? <EyeOff className="h-5 w-5" />
                                            : <Eye className="h-5 w-5" />}
                                    </button>
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={submitting}
                                className="mt-8 flex w-full items-center justify-center gap-2 rounded-full
                                           bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white
                                           transition-colors hover:bg-slate-800
                                           disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                                {submitting ? 'Signing in…' : 'Sign in'}
                            </button>
                        </form>
                    </div>
            </div>
        </div>
    );
};

export default Login;
