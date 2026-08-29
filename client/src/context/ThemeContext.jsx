import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * ── LIGHT / DARK ──────────────────────────────────────────────────────
 *
 * Three settings, two outcomes:
 *
 *   light    always light
 *   dark     always dark
 *   system   follow the operating system, and keep following it
 *
 * `system` is the default because most people have already made this choice
 * once, at the OS level, and asking again is asking twice.
 *
 * ── WHERE THE STATE ACTUALLY LIVES ────────────────────────────────────
 *
 * On `<html data-theme>`, not in React. Every colour in the app is a CSS
 * variable re-pointed by that one attribute (see index.css), so the entire
 * interface changes on a single DOM write with no re-render anywhere.
 *
 * React holds the *preference*; the attribute holds the *result*. They are
 * different things: `system` is a valid preference and never a valid
 * attribute value.
 *
 * ── WHY THE FIRST WRITE HAPPENS IN index.html ─────────────────────────
 *
 * A dark-mode user whose theme is applied by React sees a white page for as
 * long as the bundle takes to parse. The inline script in index.html stamps
 * the attribute before the first paint; this provider adopts whatever that
 * script decided, which is why it never has to guess on mount.
 */

const STORAGE_KEY = 'smartapply.theme';
const ThemeContext = createContext(null);

/** What the OS is asking for right now. */
const systemPrefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

/** A stored preference, or `system` when there is none or it is nonsense. */
const readStored = () => {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    } catch {
        // Private mode, or storage disabled. The app still has to render.
        return 'system';
    }
};

/** Preference → the attribute value. This is the only place that resolves it. */
const resolve = (preference) => (
    preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference
);

const apply = (resolved) => {
    document.documentElement.setAttribute('data-theme', resolved);
    // Keep the browser's own chrome — the address bar on mobile, the gap
    // beside a scrollbar — in step with the page it is framing.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0f17' : '#f6f8fb');
};

export const ThemeProvider = ({ children }) => {
    const [preference, setPreference] = useState(readStored);
    const [resolved, setResolved] = useState(() => resolve(readStored()));

    // Preference changed: write it down, and repaint.
    useEffect(() => {
        const next = resolve(preference);
        setResolved(next);
        apply(next);
        try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* not worth failing over */ }
    }, [preference]);

    // On `system`, the OS can change under us — at sunset, or when someone
    // flips it in another window. Follow it live rather than until reload.
    useEffect(() => {
        if (preference !== 'system') return undefined;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
            const next = systemPrefersDark() ? 'dark' : 'light';
            setResolved(next);
            apply(next);
        };
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [preference]);

    // Another tab changed the setting. One person, one choice.
    useEffect(() => {
        const onStorage = (e) => {
            if (e.key === STORAGE_KEY) setPreference(readStored());
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const value = useMemo(() => ({
        /** 'light' | 'dark' | 'system' — what the user asked for. */
        preference,
        /** 'light' | 'dark' — what is actually on screen. */
        resolved,
        isDark: resolved === 'dark',
        setPreference,
        /**
         * The keyboard-shortcut / single-button path: flip to the opposite of
         * what is currently showing, which also settles `system` into an
         * explicit choice — the only sensible reading of "not this one".
         */
        toggle: () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    }), [preference, resolved]);

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
    return ctx;
};

/** Bind a key to the theme toggle. Used by the shell for ⌘/Ctrl+J. */
export const useThemeShortcut = () => {
    const { toggle } = useTheme();
    const handler = useCallback((e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
            e.preventDefault();
            toggle();
        }
    }, [toggle]);

    useEffect(() => {
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handler]);
};

export default ThemeContext;
