import { BrandMark } from './ui/Brand.jsx';

/**
 * What fills the content area while a lazily-loaded page is fetched.
 *
 * ── WHY THE MARK RATHER THAN A SPINNER ────────────────────────────────
 *
 * A bare spinner in the middle of an empty page is indistinguishable from a
 * page that has failed. The mark says which product is loading, and the ring
 * turning around it says the wait is expected — the same reassurance a splash
 * screen gives, without taking over the window.
 */
const PageLoader = () => (
    <div className="flex h-full min-h-[60vh] w-full flex-col items-center justify-center gap-4">
        <span className="relative flex h-12 w-12 items-center justify-center">
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-line
                             border-t-brand-600" />
            <BrandMark size="sm" />
        </span>
        <p className="text-xs font-medium text-slate-400">Loading…</p>
    </div>
);

export default PageLoader;
