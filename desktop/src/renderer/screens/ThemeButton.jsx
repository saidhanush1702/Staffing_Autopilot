import { useEffect, useState } from 'react';
import { applyTheme, readPreference, resolveTheme, watchSystemTheme } from '../theme.js';
import { IconMoon, IconSun } from '../icons.jsx';

/**
 * One button in the top bar, cycling light → dark → follow the system.
 *
 * ── WHY A CYCLE RATHER THAN A SWITCH ──────────────────────────────────
 *
 * Because `system` has to be reachable. A two-state switch cannot express
 * "whatever my machine is doing", which is the setting most people actually
 * want on a desktop app that stays open all day and is looked at across a
 * whole working day's worth of light.
 *
 * The icon shows the theme currently in effect, and the tooltip names the
 * setting behind it — which is the only way to tell "dark" apart from "system,
 * and the system is dark".
 */
const NEXT = { light: 'dark', dark: 'system', system: 'light' };
const TITLE = {
    light: 'Light theme — click for dark',
    dark: 'Dark theme — click to follow your system',
    system: 'Following your system — click for light',
};

const ThemeButton = () => {
    const [preference, setPreference] = useState(readPreference);
    const [resolved, setResolved] = useState(() => resolveTheme(readPreference()));

    useEffect(() => { setResolved(applyTheme(preference)); }, [preference]);

    // On `system`, follow the OS live rather than until the next restart.
    useEffect(() => {
        if (preference !== 'system') return undefined;
        return watchSystemTheme((next) => {
            document.documentElement.setAttribute('data-theme', next);
            setResolved(next);
        });
    }, [preference]);

    return (
        <button
            type="button"
            className="icon-btn"
            title={TITLE[preference]}
            aria-label={TITLE[preference]}
            onClick={() => setPreference(NEXT[preference])}
        >
            {resolved === 'dark' ? <IconMoon /> : <IconSun />}
        </button>
    );
};

export default ThemeButton;
