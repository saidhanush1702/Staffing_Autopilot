import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Server-side pagination controls.
 * Renders nothing when everything fits on one page.
 */
const Pagination = ({ page, onChange }) => {
    if (!page || page.total <= page.limit) return null;

    const { currentPage, pageCount, total, limit, offset } = page;
    const from = offset + 1;
    const to = Math.min(offset + limit, total);

    const btn = 'flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40';

    return (
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs text-slate-500">
                Showing <strong>{from}–{to}</strong> of <strong>{total}</strong>
            </p>
            <div className="flex items-center gap-2">
                <button
                    type="button" className={btn}
                    disabled={currentPage <= 1}
                    onClick={() => onChange(currentPage - 1)}
                >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </button>
                <span className="px-2 text-xs text-slate-500">
                    Page {currentPage} of {pageCount}
                </span>
                <button
                    type="button" className={btn}
                    disabled={currentPage >= pageCount}
                    onClick={() => onChange(currentPage + 1)}
                >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
};

export default Pagination;
