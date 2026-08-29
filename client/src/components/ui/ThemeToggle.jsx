import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext.jsx';
import { segmentGroup, segmentItem, segmentActive, segmentIdle, iconBtnShell } from '../../design/tokens.js';

const OPTIONS = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
];

/**
 * ── THE THEME CONTROL, IN TWO SHAPES ──────────────────────────────────
 *
 *   variant="segmented"  all three settings at once — for a settings panel or
 *                        a menu, where the point is to SEE the choice
 *   variant="icon"       one button that flips to the other theme — for the
 *                        header, where the point is to CHANGE it
 *
 * The icon variant deliberately shows the theme you would GET, not the one
 * you are in: a moon means "go dark". A control that displays the current
 * state has to be read twice before it can be used.
 */
const ThemeToggle = ({ variant = 'icon', className = '' }) => {
    const { preference, resolved, setPreference, toggle } = useTheme();

    if (variant === 'segmented') {
        return (
            <div role="radiogroup" aria-label="Colour theme" className={`${segmentGroup} ${className}`}>
                {OPTIONS.map(({ value, icon: Icon, label }) => (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={preference === value}
                        title={label}
                        onClick={() => setPreference(value)}
                        className={`${segmentItem} flex items-center gap-1.5 ${
                            preference === value ? segmentActive : segmentIdle}`}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </button>
                ))}
            </div>
        );
    }

    const goingDark = resolved === 'light';

    return (
        <button
            type="button"
            onClick={toggle}
            title={`Switch to ${goingDark ? 'dark' : 'light'} mode  ·  Ctrl+J`}
            aria-label={`Switch to ${goingDark ? 'dark' : 'light'} mode`}
            className={`${iconBtnShell} ${className}`}
        >
            {goingDark ? <Moon className="h-[1.15rem] w-[1.15rem]" /> : <Sun className="h-[1.15rem] w-[1.15rem]" />}
        </button>
    );
};

export default ThemeToggle;
