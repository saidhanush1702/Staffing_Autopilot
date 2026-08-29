/**
 * ── ICONS ─────────────────────────────────────────────────────────────
 *
 * Drawn here rather than pulled from a package. The renderer ships inside an
 * Electron bundle that already carries a browser engine; adding an icon
 * library to it for eleven glyphs would be several hundred kilobytes for
 * eleven paths.
 *
 * They inherit `currentColor`, so a tab, a pill and a button each colour their
 * own icon and none of them need a light and a dark copy.
 *
 * All are drawn on a 24-unit grid with a 2-unit round-capped stroke, which is
 * what keeps them looking like one family rather than eleven decisions.
 */

const Svg = ({ children, ...rest }) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        width="100%"
        height="100%"
        {...rest}
    >
        {children}
    </svg>
);

/* ── the product mark ───────────────────────────────────────────────── */

/** A stylised A whose crossbar is the check the app performs before sending. */
export const Mark = () => (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="100%" height="100%">
        <path d="M5 19 12 5l7 14" stroke="currentColor" strokeWidth="2.4"
              strokeLinecap="round" strokeLinejoin="round" />
        <path d="m8.6 14.2 2 2 4.2-4.2" stroke="currentColor" strokeWidth="2.1"
              strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
    </svg>
);

/* ── tabs ───────────────────────────────────────────────────────────── */

export const IconWork = () => (
    <Svg><path d="M4 7h16v13H4z" /><path d="M9 7V4h6v3" /><path d="M4 12h16" /></Svg>
);

export const IconQuestion = () => (
    <Svg><circle cx="12" cy="12" r="9" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.3" /><path d="M12 17h.01" /></Svg>
);

export const IconAnswers = () => (
    <Svg><path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" /><path d="m8.5 10.5 2 2 4-4" /></Svg>
);

export const IconBoards = () => (
    <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M10 9v11" /></Svg>
);

export const IconApplied = () => (
    <Svg><path d="m3 11 18-8-8 18-2-7z" /><path d="m11 14 10-11" /></Svg>
);

export const IconActivity = () => (
    <Svg><path d="M3 12h4l2.5-7 5 14L17 12h4" /></Svg>
);

/* ── shell ──────────────────────────────────────────────────────────── */

export const IconSun = () => (
    <Svg>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
);

export const IconMoon = () => (
    <Svg><path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a6.6 6.6 0 0 0 9.5 9.5" /></Svg>
);

export const IconShield = () => (
    <Svg><path d="M12 3 5 6v5.5c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6z" /><path d="m9.2 12.2 2 2 3.6-3.8" /></Svg>
);
