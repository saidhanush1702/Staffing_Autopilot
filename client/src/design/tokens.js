/**
 * ── THE DESIGN TEMPLATE ───────────────────────────────────────────────
 *
 * Every recurring surface in the app — card, modal, input, button, badge —
 * is defined ONCE here. Screens import these instead of retyping Tailwind
 * strings, so a change lands everywhere at the same time.
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
 *    `TONE.danger`, not `bg-red-50 text-red-700`. The five tones are defined
 *    as CSS variables in index.css under @theme.
 * 2. Raw `slate-*` is still correct for STRUCTURE — borders, page chrome,
 *    muted secondary text. Structure is not meaning.
 * 3. Sizes come from the scales below. If a screen needs a size that is not
 *    on a scale, add it here rather than inlining it — a one-off width is
 *    how a design system starts drifting.
 * 4. New shared surface? Add it here first, then use it.
 */

/* ── surfaces ─────────────────────────────────────────────────────── */

/** The standard card. Pair with a padding token. */
export const card = 'rounded-xl border border-slate-200 bg-white';

/** Card padding scale. `cardPad` is the default. */
export const cardPadTight = 'p-4';
export const cardPad = 'p-5';
export const cardPadRoomy = 'p-6';

/** A card that responds to being clicked. */
export const cardInteractive = `${card} transition-colors hover:border-slate-300 hover:bg-slate-50`;

/** Section heading above a card or table. */
export const sectionTitle = 'text-sm font-semibold text-slate-700';

/** Page heading. */
export const pageTitle = 'text-xl font-semibold text-slate-900';
export const pageSubtitle = 'mt-1 text-sm text-slate-500';

/* ── form controls ────────────────────────────────────────────────── */

/** Text input, select and textarea all share one look. */
export const inputBase = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm '
    + 'text-slate-900 placeholder:text-slate-400 outline-none transition-colors '
    + 'focus:border-brand-500 focus:ring-2 focus:ring-brand-100 '
    + 'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500';

/** The common case: a control sitting under its own label. */
export const input = `mt-1 ${inputBase}`;

/** Larger control, for the login screen and other standalone forms. */
export const inputLarge = 'w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm '
    + 'text-slate-900 placeholder:text-slate-400 outline-none transition-colors '
    + 'focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

export const fieldLabel = 'text-sm text-slate-600';
export const fieldHint = 'mt-1 text-xs text-slate-400';
export const requiredMark = 'text-danger-600';

/* ── buttons ──────────────────────────────────────────────────────── */

const btnBase = 'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 '
    + 'text-sm font-medium transition-colors '
    + 'disabled:cursor-not-allowed disabled:opacity-60';

export const btn = {
    /** The one affirmative action on a screen. */
    primary: `${btnBase} bg-brand-600 text-white hover:bg-brand-700`,
    /** Cancel, Back, and anything that abandons rather than commits. */
    secondary: `${btnBase} border border-slate-300 text-slate-600 hover:bg-slate-50`,
    /** Destructive and irreversible. */
    danger: `${btnBase} bg-danger-600 text-white hover:bg-danger-700`,
    /** Reversible but disruptive — suspending, pausing. */
    caution: `${btnBase} bg-warning-600 text-white hover:bg-warning-700`,
    /** Low-emphasis inline action inside a row or panel. */
    subtle: `${btnBase} text-slate-600 hover:bg-slate-100`,
    /** Pill shape, for the login screen's single full-width action. */
    pill: 'inline-flex w-full items-center justify-center gap-2 rounded-full bg-slate-900 '
        + 'px-4 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 '
        + 'disabled:cursor-not-allowed disabled:opacity-60',
};

/** Table-row scale — smaller than `btn`, same shapes. */
const btnSmBase = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs '
    + 'transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export const btnSm = {
    primary: `${btnSmBase} bg-brand-600 text-white hover:bg-brand-700`,
    secondary: `${btnSmBase} border border-slate-300 text-slate-600 hover:bg-slate-50`,
    danger: `${btnSmBase} border border-danger-200 text-danger-600 hover:bg-danger-50`,
    caution: `${btnSmBase} border border-slate-300 text-slate-600 hover:bg-warning-50`,
    success: `${btnSmBase} border border-success-200 bg-success-50 text-success-700 hover:bg-success-100`,
};

/** Icon-only affordance in a table cell — the "change this" pencil. */
export const iconBtn = 'rounded p-1 text-slate-400 transition-colors '
    + 'hover:bg-slate-100 hover:text-brand-600';

/* ── switches ─────────────────────────────────────────────────────── */

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
    + 'focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 '
    + 'disabled:cursor-not-allowed disabled:opacity-60';
export const toggleTrackOn = 'bg-brand-600';
export const toggleTrackOff = 'bg-slate-300';
export const toggleKnob = 'pointer-events-none inline-block h-5 w-5 transform rounded-full '
    + 'bg-white shadow transition-transform';
export const toggleKnobOn = 'translate-x-5';
export const toggleKnobOff = 'translate-x-0';

/* ── readouts ─────────────────────────────────────────────────────── */

/**
 * Live numbers that change in place — clocks, countdowns, timers. Tabular
 * figures keep every digit the same width, so a ticking value does not make
 * the text beside it jitter left and right once a second.
 */
export const readout = 'font-mono tabular-nums text-slate-900';
export const readoutLarge = 'font-mono tabular-nums text-2xl font-semibold text-slate-900';
export const readoutLabel = 'text-xs uppercase tracking-wide text-slate-400';

/* ── tones ────────────────────────────────────────────────────────── */

/**
 * Five meanings. Everything coloured picks one.
 *
 *   success  it worked / it is live / it is approved
 *   warning  reversible problem, needs attention
 *   danger   refused, failed, or permanent
 *   info     neutral notice, in progress
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

/** Same five meanings, as a bordered alert block. */
export const TONE_ALERT = {
    success: 'bg-success-50 text-success-700',
    warning: 'bg-warning-50 text-warning-700',
    danger: 'bg-danger-50 text-danger-700',
    info: 'bg-info-50 text-info-700',
    neutral: 'bg-slate-50 text-slate-600',
    brand: 'bg-brand-50 text-brand-700',
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

/* ── badges ───────────────────────────────────────────────────────── */

/** Badge shell. Combine with a TONE. */
export const badge = 'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium';

/** Rounded count pill, for tab counters. */
export const countPill = 'rounded-full px-2 py-0.5 text-xs font-medium';

/**
 * Role accent colours. Keyed by the role NAME the database stores, so the
 * label beside it can come from `lkp_roles` without the two disagreeing.
 */
export const ROLE_TONE = {
    SUPER_ADMIN: 'bg-role-super/10 text-role-super',
    ORG_ADMIN: 'bg-role-orgadmin/10 text-role-orgadmin',
    RECRUITER: 'bg-role-recruiter/10 text-role-recruiter',
    CONSULTANT: 'bg-role-consultant/10 text-role-consultant',
};

/**
 * Employment status → tone. The LABEL comes from `lkp_user_statuses`;
 * only the colour is decided here, because colour is a design choice and
 * does not belong in the database.
 */
export const STATUS_TONE = {
    ACTIVE: 'success',
    SUSPENDED: 'warning',
    TERMINATED: 'danger',
};

/* ── modals ───────────────────────────────────────────────────────── */

/**
 * One width scale for every dialog in the app.
 *
 *   sm      confirmations and single-field forms
 *   md      forms and pickers — the default
 *   lg      side-by-side or long content
 *   viewer  full-viewport media, e.g. a resume
 *
 * Anything not on this scale is a bug, not a special case.
 */
export const MODAL_SIZE = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
};

export const MODAL_BACKDROP = 'fixed inset-0 z-50 flex items-center justify-center '
    + 'overflow-y-auto bg-slate-900/40 p-4';
export const MODAL_PANEL = 'my-auto flex max-h-[85vh] w-full flex-col rounded-xl bg-white shadow-xl';
export const MODAL_SECTION = 'p-5';

/* ── tables ───────────────────────────────────────────────────────── */

export const tableHead = 'border-b border-slate-200 bg-slate-50 text-left text-xs '
    + 'uppercase tracking-wide text-slate-500';
export const tableHeadCell = 'px-4 py-3';
export const tableBody = 'divide-y divide-slate-100';
export const tableRow = 'hover:bg-slate-50';
export const tableCell = 'px-4 py-3';
export const tableEmpty = 'px-4 py-8 text-center text-slate-400';

/* ── tabs ─────────────────────────────────────────────────────────── */

export const tabBar = 'border-b border-slate-200';
export const tabNav = '-mb-px flex gap-4 overflow-x-auto sm:gap-6';
export const tabItem = 'flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 text-sm transition-colors';
export const tabActive = 'border-brand-600 font-medium text-brand-700';
export const tabIdle = 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700';
