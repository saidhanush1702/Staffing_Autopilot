/**
 * ── THE MARK ──────────────────────────────────────────────────────────
 *
 * Drawn rather than loaded. A logo that ships as an image has to be exported
 * twice — once for light backgrounds, once for dark — and the two copies
 * drift. As SVG it inherits `currentColor` on the wordmark and paints its
 * glyph from the brand token, so it is correct in both themes by
 * construction and stays crisp at any size.
 *
 * The glyph is a stylised A: two strokes rising to a point, with the crossbar
 * broken into a chevron — the check the product performs on every application
 * before it goes out.
 */

const GLYPH_SIZE = {
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-8 w-8 rounded-[0.55rem]',
    lg: 'h-10 w-10 rounded-xl',
};

/** The glyph on its own — for a collapsed sidebar, a favicon slot, an avatar. */
export const BrandMark = ({ size = 'md', className = '' }) => (
    <span
        aria-hidden="true"
        className={`inline-flex shrink-0 items-center justify-center bg-brand-600 text-white
                    shadow-brand ${GLYPH_SIZE[size] ?? GLYPH_SIZE.md} ${className}`}
    >
        <svg viewBox="0 0 24 24" fill="none" className="h-[60%] w-[60%]">
            <path
                d="M5 19 12 5l7 14"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="m8.6 14.2 2 2 4.2-4.2"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.55"
            />
        </svg>
    </span>
);

/**
 * Glyph plus wordmark plus an optional second line — the organisation the
 * signed-in person belongs to, which is the one piece of context that answers
 * "am I looking at the right tenant?".
 */
const Brand = ({ subtitle, size = 'md', className = '' }) => (
    <span className={`flex min-w-0 items-center gap-2.5 ${className}`}>
        <BrandMark size={size} />
        <span className="min-w-0">
            <span className="block truncate font-display text-[0.9375rem] font-bold tracking-tight text-slate-900">
                SmartApply
            </span>
            {subtitle && (
                <span className="block truncate text-2xs font-medium text-slate-500">
                    {subtitle}
                </span>
            )}
        </span>
    </span>
);

export default Brand;
