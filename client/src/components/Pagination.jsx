import { ChevronLeft, ChevronRight } from 'lucide-react';
import { btnSm, cardFooter } from '../design/tokens.js';

/**
 * Server-side pagination controls.
 * Renders nothing when everything fits on one page.
 */
const Pagination = ({ page, onChange }) => {
    if (!page || page.total <= page.limit) return null;

    const { currentPage, pageCount, total, limit, offset } = page;
    const from = offset + 1;
    const to = Math.min(offset + limit, total);

    return (
        <div className={cardFooter}>
            <p className="text-xs text-slate-500">
                Showing <strong className="font-semibold text-slate-800">{from}–{to}</strong>
                {' of '}
                <strong className="font-semibold text-slate-800">{total}</strong>
            </p>

            <div className="flex items-center gap-2">
                <button
                    type="button"
                    className={btnSm.secondary}
                    disabled={currentPage <= 1}
                    onClick={() => onChange(currentPage - 1)}
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Previous</span>
                </button>

                <span className="px-1 text-xs tabular-nums text-slate-500">
                    {currentPage} <span className="text-slate-400">/</span> {pageCount}
                </span>

                <button
                    type="button"
                    className={btnSm.secondary}
                    disabled={currentPage >= pageCount}
                    onClick={() => onChange(currentPage + 1)}
                >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    );
};

export default Pagination;
