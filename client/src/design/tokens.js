/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESIGN TEMPLATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every recurring surface in the app — card, modal, input, button, badge,
 * table, tab, chip, banner — is defined ONCE here. Screens import these
 * instead of retyping Tailwind strings, so a change lands everywhere at the
 * same time and cannot half-land.
 *
 * ── THE TWO HALVES OF THE SYSTEM ──────────────────────────────────────
 *
 *   index.css   VALUES.  Colour, radius, shadow, type scale, motion. Defined
 *               once as theme variables, and re-pointed for dark mode. No
 *               component knows dark mode exists.
 *   tokens.js   SHAPES.  The class strings that combine those values into the
 *               recurring surfaces below.
 *
 * ── HOW TO USE ────────────────────────────────────────────────────────
 *
 *   import { card, cardPad, input, btn, badge, TONE } from '../design/tokens.js';
 *
 *   <div className={`${card} ${cardPad}`}>…</div>
 *   <input className={input} />
 *   <button className={btn.primary}>Save</button>
 *   <span className={`${badge} ${TONE.success}`}>Active</span>
 *
 * ── RULES ─────────────────────────────────────────────────────────────
 *
 * 1. Anything that carries MEANING uses a TONE, never a raw palette colour.
 *    `TONE.danger`, not `bg-red-50 text-red-700`.
 * 2. Surfaces use the ELEVATION names — `bg-surface`, `bg-surface-raised`,
 *    `bg-canvas` — never `bg-white`. White is a light-mode implementation
 *    detail; `surface` is the idea.
 * 3. `slate-*` remains correct for STRUCTURE — borders, chrome, muted text.
 *    Structure is not meaning. The ramp inverts in dark mode, so `slate-900`
 *    means "loudest text" in both themes rather than "very dark".
 * 4. Sizes come from the scales below. A one-off width is how a design system
 *    starts drifting — add the step here instead.
 * 5. New shared surface? Add it here first, then use it.
 */

/* ══ SURFACES ═══════════════════════════════════════════════════════════ */

/**
 * The standard card. Pair with a padding token.
 *
 * `lit` is a no-op in light mode and adds the hairline top highlight in dark
 * mode, which is what stops a dark card reading as a hole in the page.
 */
export const card = 'rounded-xl border border-line bg-surface shadow-xs lit';

/** A card that needs to stand off the page — the one thing on a screen. */
export const cardRaised = 'rounded-2xl border border-line bg-surface shadow-md lit';

/** No border, no shadow: a grouping device inside an existing card. */
export const cardQuiet = 'rounded-xl bg-surface-sunken';

/** Card padding scale. `cardPad` is the default. */
export const cardPadTight = 'p-4';
export const cardPad = 'p-5';
export const cardPadRoomy = 'p-6';

/** A card that responds to being clicked. */
export const cardInteractive = `${card} cursor-pointer transition-all duration-150 `
    + 'hover:border-line-strong hover:shadow-md focus-visible:border-brand-400';

/** The strip a card can wear as a header or a footer. */
export const cardHeader = 'flex items-center justify-between gap-3 border-b border-line '
    + 'bg-surface-raised px-5 py-3.5';
export const cardFooter = 'flex items-center justify-between gap-3 border-t border-line '
    + 'bg-surface-raised px-5 py-3';

/** A hairline divider between rows inside a card. */
export const divider = 'border-t border-line-soft';
export const dividerList = 'divide-y divide-line-soft';

/* ══ TYPOGRAPHY ═════════════════════════════════════════════════════════ */

/** Page heading + its one-line explanation. */
export const pageTitle = 'font-display text-xl font-semibold tracking-tight text-slate-900';
export const pageSubtitle = 'mt-1 text-sm text-slate-500';

/** Section heading above a card or table. */
export const sectionTitle = 'font-display text-sm font-semibold text-slate-800';
export const sectionSubtitle = 'mt-0.5 text-xs text-slate-500';

/** The all-caps micro-label above a number or a field group. */
export const eyebrow = 'text-2xs font-semibold uppercase tracking-wider text-slate-400';

/** Body copy that is explanatory rather than structural. */
export const prose = 'text-sm leading-relaxed text-slate-600';
export const proseMuted = 'text-xs leading-relaxed text-slate-500';

/** Inline code / an identifier the user may need to copy. */
export const codeChip = 'rounded border border-line bg-surface-sunken px-1.5 py-0.5 '
    + 'font-mono text-xs text-slate-700';

/* ══ FORM CONTROLS ══════════════════════════════════════════════════════ */

/**
 * Text input, select and textarea all share one look, so a form never looks
 * assembled from three different kits.
 */
export const inputBase = 'w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm '
    + 'text-slate-900 placeholder:text-slate-400 outline-none transition '
    + 'hover:border-slate-400 '
    + 'focus:border-brand-500 focus:ring-4 focus:ring-brand-500/12 '
    + 'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-slate-400';

/** The common case: a control sitting under its own label. */
export const input = `mt-1.5 ${inputBase}`;

/** Larger control, for the login screen and other standalone forms. */
export const inputLarge = 'w-full rounded-xl border border-slate-300 bg-surface px-3.5 py-3 text-md '
    + 'text-slate-900 placeholder:text-slate-400 outline-none transition '
    + 'hover:border-slate-400 '
    + 'focus:border-brand-500 focus:ring-4 focus:ring-brand-500/12';

/** A control that has failed validation. Append to `input`. */
export const inputInvalid = 'border-danger-400 focus:border-danger-500 focus:ring-danger-500/15';

export const fieldLabel = 'text-sm font-medium text-slate-700';
export const fieldHint = 'mt-1.5 text-xs text-slate-500';
export const fieldError = 'mt-1.5 flex items-center gap-1.5 text-xs font-medium text-danger-600';
export const requiredMark = 'text-danger-500';

/** A search box with room for a leading icon. */
export const searchInput = `${inputBase} pl-9`;
export const searchIcon = 'pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400';

/** Checkbox / radio, so a tick is the brand colour rather than the OS blue. */
export const checkbox = 'h-4 w-4 rounded border-slate-300 text-brand-600 accent-brand-600 '
    + 'transition focus-visible:ring-2 focus-visible:ring-brand-500';

/* ══ BUTTONS ════════════════════════════════════════════════════════════ */

/**
 * One base, six intents, three sizes.
 *
 * `active:translate-y-px` is the whole of the press feedback: a button that
 * moves one pixel under the cursor feels connected to the click in a way a
 * colour change alone does not.
 */
const btnBase = 'inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium '
    + 'whitespace-nowrap transition-all duration-150 outline-none '
    + 'active:translate-y-px '
    + 'disabled:pointer-events-none disabled:opacity-50';

const btnMd = 'px-3.5 py-2';

export const btn = {
    /** The one affirmative action on a screen. */
    primary: `${btnBase} ${btnMd} bg-brand-600 text-white shadow-brand hover:bg-brand-500 `
        + 'focus-visible:ring-4 focus-visible:ring-brand-500/25',
    /** Cancel, Back, and anything that abandons rather than commits. */
    secondary: `${btnBase} ${btnMd} border border-slate-300 bg-surface text-slate-700 shadow-xs `
        + 'hover:border-slate-400 hover:bg-surface-raised',
    /** Destructive and irreversible. */
    danger: `${btnBase} ${btnMd} bg-danger-600 text-white shadow-xs hover:bg-danger-500 `
        + 'focus-visible:ring-4 focus-visible:ring-danger-500/25',
    /** Reversible but disruptive — suspending, pausing. */
    caution: `${btnBase} ${btnMd} bg-warning-600 text-white shadow-xs hover:bg-warning-500`,
    /** Low-emphasis inline action inside a row or panel. */
    subtle: `${btnBase} ${btnMd} text-slate-600 hover:bg-slate-100 hover:text-slate-900`,
    /** Brand-tinted, for a secondary action that is still affirmative. */
    ghost: `${btnBase} ${btnMd} bg-brand-50 text-brand-700 hover:bg-brand-100`,
    /** Pill shape, for a screen's single full-width action. */
    pill: 'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 '
        + 'px-4 py-3 text-md font-semibold text-white shadow-brand transition-all duration-150 '
        + 'hover:bg-brand-500 active:translate-y-px '
        + 'focus-visible:ring-4 focus-visible:ring-brand-500/25 '
        + 'disabled:pointer-events-none disabled:opacity-50',
};

/** Table-row scale — smaller than `btn`, same shapes and the same intents. */
const btnSmBase = 'inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs '
    + 'font-medium whitespace-nowrap transition-all duration-150 active:translate-y-px '
    + 'disabled:pointer-events-none disabled:opacity-50';

export const btnSm = {
    primary: `${btnSmBase} bg-brand-600 text-white hover:bg-brand-500`,
    secondary: `${btnSmBase} border border-slate-300 bg-surface text-slate-700 hover:bg-surface-raised`,
    danger: `${btnSmBase} border border-danger-200 bg-danger-50 text-danger-700 hover:bg-danger-100`,
    caution: `${btnSmBase} border border-warning-200 bg-warning-50 text-warning-700 hover:bg-warning-100`,
    success: `${btnSmBase} border border-success-200 bg-success-50 text-success-700 hover:bg-success-100`,
    subtle: `${btnSmBase} text-slate-600 hover:bg-slate-100 hover:text-slate-900`,
};

/** Icon-only affordance in a table cell — the "change this" pencil. */
export const iconBtn = 'inline-flex items-center justify-center rounded-md p-1.5 text-slate-400 '
    + 'transition-colors hover:bg-slate-100 hover:text-brand-600';

/** Icon-only affordance in the app shell — bigger target, quieter idle state. */
export const iconBtnShell = 'inline-flex h-9 w-9 items-center justify-center rounded-lg '
    + 'text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900';

/* ══ SWITCHES ═══════════════════════════════════════════════════════════ */

/**
 * On/off switch, for a setting that commits immediately rather than on save.
 * Use it where the state itself is the point and a button label would have to
 * be read twice ("Turn off" — so is it currently on?).
 *
 *   <button role="switch" aria-checked={on}
 *           className={`${toggleTrack} ${on ? toggleTrackOn : toggleTrackOff}`}>
 *     <span className={`${toggleKnob} ${on ? toggleKnobOn : toggleKnobOff}`} />
 *   </button>
 */
export const toggleTrack = 'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center '
    + 'rounded-full border-2 border-transparent transition-colors outline-none '
    + 'focus-visible:ring-4 focus-visible:ring-brand-500/25 '
    + 'disabled:cursor-not-allowed disabled:opacity-50';
export const toggleTrackOn = 'bg-brand-600';
export const toggleTrackOff = 'bg-slate-300';
export const toggleKnob = 'pointer-events-none inline-block h-5 w-5 transform rounded-full '
    + 'bg-white shadow-sm transition-transform duration-200';
export const toggleKnobOn = 'translate-x-5';
export const toggleKnobOff = 'translate-x-0';

/* ══ READOUTS ═══════════════════════════════════════════════════════════ */

/**
 * Live numbers that change in place — clocks, countdowns, timers. Tabular
 * figures keep every digit the same width, so a ticking value does not make
 * the text beside it jitter left and right once a second.
 */
export const readout = 'font-mono tabular-nums text-slate-900';
export const readoutLarge = 'font-mono tabular-nums text-2xl font-semibold text-slate-900';
export const readoutLabel = 'text-2xs font-semibold uppercase tracking-wider text-slate-400';

/** The headline figure on a stat tile. Display face, tight, tabular. */
export const metric = 'font-display text-3xl font-semibold tracking-tight tabular-nums text-slate-900';
export const metricSm = 'font-display text-2xl font-semibold tracking-tight tabular-nums text-slate-900';

/* ══ TONES ══════════════════════════════════════════════════════════════ */

/**
 * Five meanings plus brand and neutral. Everything coloured picks one.
 *
 *   success  it worked / it is live / it is approved
 *   warning  reversible problem, needs attention
 *   danger   refused, failed, or permanent
 *   info     neutral notice, in progress
 *   brand    the product's own accent
 *   neutral  no signal — the default
 */
export const TONE = {
    success: 'bg-success-50 text-success-700',
    warning: 'bg-warning-50 text-warning-700',
    danger: 'bg-danger-50 text-danger-700',
    info: 'bg-info-50 text-info-700',
    neutral: 'bg-slate-100 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
};

/** Same meanings, bordered — for a badge that must read on a tinted row. */
export const TONE_OUTLINE = {
    success: 'border border-success-200 bg-success-50 text-success-700',
    warning: 'border border-warning-200 bg-warning-50 text-warning-700',
    danger: 'border border-danger-200 bg-danger-50 text-danger-700',
    info: 'border border-info-200 bg-info-50 text-info-700',
    neutral: 'border border-line bg-surface-sunken text-slate-600',
    brand: 'border border-brand-200 bg-brand-50 text-brand-700',
};

/** Same meanings, as a block-level alert. */
export const TONE_ALERT = {
    success: 'border border-success-200 bg-success-50 text-success-800',
    warning: 'border border-warning-200 bg-warning-50 text-warning-800',
    danger: 'border border-danger-200 bg-danger-50 text-danger-800',
    info: 'border border-info-200 bg-info-50 text-info-800',
    neutral: 'border border-line bg-surface-sunken text-slate-700',
    brand: 'border border-brand-200 bg-brand-50 text-brand-800',
};

/** Icon colour on its own, for a tone used without a filled background. */
export const TONE_TEXT = {
    success: 'text-success-600',
    warning: 'text-warning-600',
    danger: 'text-danger-600',
    info: 'text-info-600',
    neutral: 'text-slate-500',
    brand: 'text-brand-600',
};

/** Solid fill, for a status dot or a filled counter. */
export const TONE_SOLID = {
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500',
    info: 'bg-info-500',
    neutral: 'bg-slate-400',
    brand: 'bg-brand-600',
};

/** The 4px accent bar down the left edge of an alert or a highlighted row. */
export const TONE_RAIL = {
    success: 'border-l-2 border-l-success-500',
    warning: 'border-l-2 border-l-warning-500',
    danger: 'border-l-2 border-l-danger-500',
    info: 'border-l-2 border-l-info-500',
    neutral: 'border-l-2 border-l-slate-300',
    brand: 'border-l-2 border-l-brand-500',
};

/**
 * The standard block-level notice. Combine with a TONE_ALERT.
 *
 * Prefer the <Alert> component, which picks the icon from the tone. Use these
 * raw when the notice is a bare line of text with no icon — inside a table
 * cell, or under a field.
 */
export const alertShell = 'flex items-start gap-2.5 rounded-lg p-3 text-sm';

/** The same notice at row scale — under a field, inside a cell. */
export const alertShellSm = 'flex items-start gap-2 rounded-lg p-2 text-xs';

/* ══ BADGES & CHIPS ═════════════════════════════════════════════════════ */

/** Badge shell. Combine with a TONE. */
export const badge = 'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium';

/** Pill-shaped variant, for a status rather than a label. */
export const pill = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium';

/** A small dot used inside a pill to carry the tone. */
export const statusDot = 'h-1.5 w-1.5 shrink-0 rounded-full';

/** Rounded count pill, for tab counters. */
export const countPill = 'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 '
    + 'text-2xs font-semibold tabular-nums';

/** A removable filter chip. */
export const chip = 'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface '
    + 'py-1 pl-2.5 pr-1.5 text-xs text-slate-700';

/**
 * Role accent colours. Keyed by the role NAME the database stores, so the
 * label beside it can come from `lkp_roles` without the two disagreeing.
 */
export const ROLE_TONE = {
    SUPER_ADMIN: 'bg-role-super/12 text-role-super',
    ORG_ADMIN: 'bg-role-orgadmin/12 text-role-orgadmin',
    RECRUITER: 'bg-role-recruiter/12 text-role-recruiter',
    CONSULTANT: 'bg-role-consultant/12 text-role-consultant',
};

/**
 * Employment status → tone. The LABEL comes from `lkp_user_statuses`; only the
 * colour is decided here, because colour is a design choice and does not
 * belong in the database.
 */
export const STATUS_TONE = {
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    TERMINATED: 'danger',
};

/* ══ AVATARS ════════════════════════════════════════════════════════════ */

/**
 * Initials on a tinted disc. Deterministic: the same name always gets the
 * same colour, so a person is recognisable down a long list before their name
 * is read.
 */
export const avatar = 'inline-flex shrink-0 items-center justify-center rounded-full '
    + 'font-display font-semibold uppercase select-none';

export const AVATAR_SIZE = {
    xs: 'h-6 w-6 text-2xs',
    sm: 'h-8 w-8 text-xs',
    md: 'h-9 w-9 text-xs',
    lg: 'h-11 w-11 text-sm',
    xl: 'h-16 w-16 text-lg',
};

/** The palette an avatar is hashed into. */
export const AVATAR_TONES = [
    'bg-brand-100 text-brand-700',
    'bg-accent-100 text-accent-700',
    'bg-info-100 text-info-700',
    'bg-warning-100 text-warning-700',
    'bg-success-100 text-success-700',
    'bg-role-super/15 text-role-super',
];

/* ══ MODALS ═════════════════════════════════════════════════════════════ */

/**
 * One width scale for every dialog in the app.
 *
 *   sm      confirmations and single-field forms
 *   md      forms and pickers — the default
 *   lg      side-by-side or long content
 *   xl      a full working surface inside a dialog
 *
 * Anything not on this scale is a bug, not a special case.
 */
export const MODAL_SIZE = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
};

export const MODAL_BACKDROP = 'fixed inset-0 z-50 flex items-center justify-center '
    + 'overflow-y-auto bg-overlay/55 p-4 backdrop-blur-sm animate-fade-in';
export const MODAL_PANEL = 'my-auto flex max-h-[86vh] w-full flex-col overflow-hidden rounded-2xl '
    + 'border border-line bg-surface shadow-2xl animate-pop';
export const MODAL_SECTION = 'p-5';
export const MODAL_HEADER = 'flex items-start justify-between gap-3 border-b border-line '
    + 'bg-surface-raised p-5';
export const MODAL_FOOTER = 'border-t border-line bg-surface-raised p-4';

/** The side drawer, for a record opened beside the list it came from. */
export const DRAWER_BACKDROP = 'fixed inset-0 z-50 flex justify-end bg-overlay/50 '
    + 'backdrop-blur-sm animate-fade-in';
export const DRAWER_PANEL = 'flex h-full w-full max-w-xl flex-col border-l border-line '
    + 'bg-surface shadow-2xl animate-slide-in';

/* ══ TABLES ═════════════════════════════════════════════════════════════ */

export const tableHead = 'border-b border-line bg-surface-raised text-left text-2xs '
    + 'font-semibold uppercase tracking-wider text-slate-500';
export const tableHeadCell = 'px-4 py-3 whitespace-nowrap';
export const tableBody = 'divide-y divide-line-soft';
export const tableRow = 'transition-colors hover:bg-surface-raised';
export const tableRowActive = 'bg-brand-50/60';
export const tableCell = 'px-4 py-3 align-middle text-slate-700';
export const tableCellStrong = 'px-4 py-3 align-middle font-medium text-slate-900';
export const tableEmpty = 'px-4 py-14 text-center text-slate-400';

/** The sticky header a long table keeps while its body scrolls. */
export const tableHeadSticky = 'sticky top-0 z-10';

/* ══ TABS ═══════════════════════════════════════════════════════════════ */

export const tabBar = 'border-b border-line';
export const tabNav = '-mb-px flex gap-5 overflow-x-auto sm:gap-7';
export const tabItem = 'flex shrink-0 items-center gap-2 border-b-2 px-0.5 pb-3 text-sm '
    + 'font-medium transition-colors';
export const tabActive = 'border-brand-600 text-brand-700';
export const tabIdle = 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800';

/** Segmented control: the same choice, when there are only two or three. */
export const segmentGroup = 'inline-flex rounded-lg border border-line bg-surface-sunken p-0.5';
export const segmentItem = 'rounded-md px-3 py-1.5 text-xs font-medium transition-all';
export const segmentActive = 'bg-surface text-slate-900 shadow-xs';
export const segmentIdle = 'text-slate-500 hover:text-slate-800';

/* ══ NAVIGATION ═════════════════════════════════════════════════════════ */

export const navItem = 'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm '
    + 'font-medium transition-all duration-150';
export const navItemActive = 'bg-brand-50 text-brand-700';
export const navItemIdle = 'text-slate-600 hover:bg-slate-100 hover:text-slate-900';
export const navGroupLabel = 'px-3 pb-1.5 pt-4 text-2xs font-semibold uppercase '
    + 'tracking-wider text-slate-400';

/** The 3px marker on the active nav row's leading edge. */
export const navMarker = 'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-brand-600';

/** A dropdown menu hung off a shell control. */
export const menuPanel = 'absolute z-50 min-w-52 overflow-hidden rounded-xl border border-line '
    + 'bg-surface p-1 shadow-xl animate-pop';
export const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm '
    + 'text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900';
export const menuItemDanger = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left '
    + 'text-sm text-danger-600 transition-colors hover:bg-danger-50';
export const menuLabel = 'px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-slate-400';
export const menuSeparator = 'my-1 h-px bg-line';

/* ══ LAYOUT ═════════════════════════════════════════════════════════════ */

/** The width every page's content is capped at, and its gutter. */
export const pageShell = 'mx-auto w-full max-w-content';
export const pageGutter = 'px-4 py-5 sm:px-6 sm:py-6';

/** Vertical rhythm between the blocks of a page. */
export const stack = 'space-y-5';
export const stackTight = 'space-y-3';

/** The standard responsive grid for stat tiles. */
export const statGrid = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4';

/** A toolbar above a table: filters left, actions right, wraps on mobile. */
export const toolbar = 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between';

/* ══ EMPTY & LOADING ════════════════════════════════════════════════════ */

export const emptyShell = 'flex flex-col items-center justify-center px-6 py-14 text-center';
export const emptyIcon = 'mb-3 flex h-12 w-12 items-center justify-center rounded-2xl '
    + 'bg-surface-sunken text-slate-400';
export const emptyTitle = 'font-display text-sm font-semibold text-slate-800';
export const emptyBody = 'mt-1 max-w-sm text-sm text-slate-500';

/** A shimmering placeholder block. `.skeleton` is defined in index.css. */
export const skeletonLine = 'skeleton h-3 w-full';
export const skeletonBlock = 'skeleton h-20 w-full rounded-lg';
