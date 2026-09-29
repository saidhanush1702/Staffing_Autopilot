/**
 * ── LIGHT / DARK, IN THE RENDERER ─────────────────────────────────────
 *
 * Three settings — light, dark, system — resolved to one attribute on <html>,
 * which every colour in styles.css is keyed off. Changing it repaints the
 * whole app with no React re-render.
 *
 * ── WHY THIS IS NOT IN THE MAIN PROCESS ───────────────────────────────
 *
 * It could be: the main process already has a store, and could hold the
 * preference beside everything else. But that would put a cosmetic choice on
 * the IPC surface — a channel that can be called, that has to be versioned,
 * and that the preload has to expose — for something the renderer can decide
 * entirely on its own. The theme is the one piece of state with no security
 * boundary around it, so it stays local.
 *
 * ── WHY THE STORAGE WRITE IS ALLOWED TO FAIL ──────────────────────────
 *
 * The packaged app loads over `file:`, and storage on a file origin is not a
 * guarantee across Chromium versions. If it throws, `system` is the fallback
 * and the app follows the OS — which is a perfectly good desktop default, and
 * a far better outcome than a blank window over a colour preference.
 */

const KEY = 'smartapply.theme';

const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

export const readPreference = () => {
    try {
        const v = localStorage.getItem(KEY);
        return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
    } catch {
        return 'system';
    }
};

/** Preference -> the attribute value. The only place that resolves it. */
export const resolveTheme = (preference) => (
    preference === 'system' ? (prefersDark() ? 'dark' : 'light') : preference
);

export const applyTheme = (preference) => {
    const resolved = resolveTheme(preference);
    document.documentElement.setAttribute('data-theme', resolved);
    try { localStorage.setItem(KEY, preference); } catch { /* see above */ }
    return resolved;
};

/**
 * Called from main.jsx before React mounts, so the first frame is already the
 * right colour. The CSP forbids an inline script in index.html, which is where
 * the web app does this — a local module import is the next best thing and
 * costs a frame at most.
 */
export const bootTheme = () => {
    const preference = readPreference();
    document.documentElement.setAttribute('data-theme', resolveTheme(preference));
    return preference;
};

/**
 * On `system`, follow the OS live. Someone whose machine turns dark at sunset
 * should not have to restart an app that is meant to run all day.
 */
export const watchSystemTheme = (onChange) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => onChange(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
};
