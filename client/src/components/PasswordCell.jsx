import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Copy, Check, Loader2, KeyRound } from 'lucide-react';
import api, { errorMessage } from '../api/axios.js';

const AUTO_HIDE_MS = 30_000;

/**
 * Masked password with click-to-reveal, for the ORG_ADMIN users table.
 *
 * The password is NOT part of the user list payload — it is fetched from
 * /users/:id/password only when the eye is clicked. That keeps passwords out
 * of every page load, and makes the server-side audit row meaningful: one
 * click, one reveal, one log entry.
 *
 * Auto-hides after 30 seconds so a revealed password doesn't sit on screen.
 */
const PasswordCell = ({ userId, onReset }) => {
    const [password, setPassword] = useState(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    const timer = useRef(null);

    useEffect(() => () => clearTimeout(timer.current), []);

    const hide = () => {
        clearTimeout(timer.current);
        setPassword(null);
        setCopied(false);
        setError('');
    };

    const reveal = async () => {
        setLoading(true);
        setError('');
        try {
            const { data } = await api.get(`/management/users/${userId}/password`);
            setPassword(data.password);
            timer.current = setTimeout(hide, AUTO_HIDE_MS);
        } catch (err) {
            setError(errorMessage(err, 'Could not reveal password.'));
        } finally {
            setLoading(false);
        }
    };

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(password);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError('Clipboard unavailable.');
        }
    };

    if (error) {
        return (
            <span className="flex items-center gap-2 text-xs text-red-600">
                {error}
                <button type="button" onClick={hide} className="underline">retry</button>
            </span>
        );
    }

    return (
        <span className="flex items-center gap-1.5">
            <code className="min-w-[7rem] rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-700">
                {password ?? '••••••••'}
            </code>

            <button
                type="button"
                onClick={password ? hide : reveal}
                disabled={loading}
                title={password ? 'Hide' : 'Reveal password (this is logged)'}
                className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
            >
                {loading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : password
                        ? <EyeOff className="h-3.5 w-3.5" />
                        : <Eye className="h-3.5 w-3.5" />}
            </button>

            {password && (
                <button
                    type="button"
                    onClick={copy}
                    title="Copy to clipboard"
                    className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                    {copied
                        ? <Check className="h-3.5 w-3.5 text-emerald-600" />
                        : <Copy className="h-3.5 w-3.5" />}
                </button>
            )}

            <button
                type="button"
                onClick={onReset}
                title="Set a new password"
                className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
                <KeyRound className="h-3.5 w-3.5" />
            </button>
        </span>
    );
};

export default PasswordCell;
