import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { errorMessage } from '../api/axios.js';
import Alert from '../components/ui/Alert.jsx';
import ThemeToggle from '../components/ui/ThemeToggle.jsx';
import { inputLarge, btn, requiredMark, fieldLabel } from '../design/tokens.js';

/** Where each role lands after signing in. */
export const HOME_FOR_ROLE = {
    SUPER_ADMIN: '/super-admin',
    ORG_ADMIN: '/management',
    RECRUITER: '/management',
    CONSULTANT: '/portal',
};

/**
 * ── THE FIRST SCREEN ──────────────────────────────────────────────────
 *
 * Two columns: the form on the left, the product's case for itself on the
 * right. The right column is not decoration — it is the only place in the
 * product where somebody who has been handed a link and a password finds out
 * what they have been given access to.
 *
 * ── WHY THE PANEL IS DRAWN, NOT PHOTOGRAPHED ──────────────────────────
 *
 * A gradient built from the design tokens is correct in both themes, weighs
 * nothing, and cannot go stale the way a screenshot of last quarter's
 * dashboard does. It also means the login page cannot drift from the palette
 * the rest of the app uses, because it is reading the same variables.
 *
 * Below `lg` the panel is dropped entirely rather than stacked. On a phone it
 * would be a screenful of marketing standing between a person and the field
 * they came to type in.
 */
const POINTS = [
    'Applications filled and reviewed before anything is sent',
    'Every answer approved by a recruiter, once, then reused',
    'One record of what went out, shared by consultant and recruiter',
];

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

    return (
        <div className="flex min-h-screen w-full bg-canvas">
            {/* ══ FORM ══════════════════════════════════════════════════ */}
            <div className="relative flex w-full flex-col lg:w-[46%] lg:min-w-[30rem]">
                <div className="flex items-center justify-between p-5 sm:px-8">
                    {/*
                      The company's own mark, not the product's.

                      It is a transparent PNG whose wordmark is a dark red, so
                      on the dark theme's near-black canvas the lower half of it
                      would all but vanish. The plate under it appears only in
                      dark mode — the standard fix for a single light-background
                      logo asset, and the one that does not require the brand to
                      be redrawn.
                    */}
                    <span className="inline-flex rounded-xl px-2.5 py-1.5 transition-colors dark:bg-white/92">
                        <img
                            src="/image.png"
                            alt="Molina Technologies"
                            className="h-9 w-auto object-contain sm:h-11"
                        />
                    </span>
                    <ThemeToggle />
                </div>

                <div className="flex flex-1 items-center justify-center px-5 pb-12 sm:px-8">
                    <div className="w-full max-w-sm animate-rise">
                        <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900">
                            Welcome back
                        </h1>
                        <p className="mt-2 text-md text-slate-500">
                            Sign in to your SmartApply workspace.
                        </p>

                        <form onSubmit={handleSubmit} className="mt-8">
                            {error && <Alert tone="danger" className="mb-5">{error}</Alert>}

                            <label className="block">
                                <span className={fieldLabel}>
                                    Email <span className={requiredMark}>*</span>
                                </span>
                                <span className="relative mt-1.5 block">
                                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-[1.15rem]
                                                     w-[1.15rem] -translate-y-1/2 text-slate-400" />
                                    <input
                                        type="email"
                                        required
                                        autoComplete="username"
                                        autoFocus
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        className={`${inputLarge} pl-11`}
                                        placeholder="you@company.com"
                                    />
                                </span>
                            </label>

                            <div className="mt-5">
                                <div className="flex items-baseline justify-between gap-3">
                                    <label htmlFor="password" className={fieldLabel}>
                                        Password <span className={requiredMark}>*</span>
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
                                        className="text-xs font-medium text-slate-500 transition-colors
                                                   hover:text-brand-600"
                                    >
                                        Forgot password?
                                    </button>
                                </div>

                                <div className="relative mt-1.5">
                                    <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-[1.15rem]
                                                     w-[1.15rem] -translate-y-1/2 text-slate-400" />
                                    <input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        required
                                        autoComplete="current-password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className={`${inputLarge} pl-11 pr-12`}
                                        placeholder="••••••••"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword((v) => !v)}
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        title={showPassword ? 'Hide password' : 'Show password'}
                                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2
                                                   text-slate-400 transition-colors hover:text-slate-700"
                                    >
                                        {showPassword
                                            ? <EyeOff className="h-[1.15rem] w-[1.15rem]" />
                                            : <Eye className="h-[1.15rem] w-[1.15rem]" />}
                                    </button>
                                </div>
                            </div>

                            <button type="submit" disabled={submitting} className={`mt-7 ${btn.pill}`}>
                                {submitting
                                    ? <><Loader2 className="h-4 w-4 animate-spin" />Signing in…</>
                                    : <>Sign in<ArrowRight className="h-4 w-4" /></>}
                            </button>
                        </form>

                        <p className="mt-8 flex items-center justify-center gap-1.5 text-xs text-slate-400">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Your session is protected and expires automatically.
                        </p>
                    </div>
                </div>
            </div>

            {/* ══ PANEL ═════════════════════════════════════════════════ */}
            <div className="brand-mesh relative hidden flex-1 overflow-hidden lg:flex">
                {/* A soft top-left highlight, so the mesh reads as lit rather
                    than as a flat printed gradient. */}
                <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(255,255,255,0.16),transparent_60%)]" />

                <div className="relative flex flex-1 flex-col justify-between p-12 xl:p-16">
                    <div className="max-w-lg">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/55">
                            Staffing automation
                        </p>
                        <h2 className="mt-5 font-display text-4xl font-bold leading-[1.15] tracking-tight text-white
                                       xl:text-5xl xl:leading-[1.1]">
                            Every application,
                            <br />
                            reviewed before it&rsquo;s sent.
                        </h2>
                        <p className="mt-5 max-w-md text-md leading-relaxed text-white/70">
                            SmartApply fills job applications for your consultants, stops at the
                            submit step, and keeps recruiters and consultants looking at exactly
                            the same record.
                        </p>

                        <ul className="mt-9 space-y-3.5">
                            {POINTS.map((point) => (
                                <li key={point} className="flex items-start gap-3 text-sm text-white/80">
                                    <CheckCircle2 className="mt-0.5 h-[1.15rem] w-[1.15rem] shrink-0 text-white/45" />
                                    {point}
                                </li>
                            ))}
                        </ul>
                    </div>

                    <p className="text-xs text-white/40">
                        © {new Date().getFullYear()} Molina Technologies LLC · SmartApply
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Login;
