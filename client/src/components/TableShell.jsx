import { card } from '../design/tokens.js';

/**
 * Card wrapper + horizontal scroll container for a data table.
 *
 * Every table here has a floor width below which its columns stop being
 * readable rather than merely narrow. Below that floor the honest behaviour is
 * to scroll sideways *inside the card*. The alternative — what these tables did
 * before — is the table forcing the whole page wider, which pushes the sidebar
 * and header off-screen and breaks the layout rather than just the table.
 *
 * minWidth is an inline style, not a Tailwind class, on purpose: Tailwind
 * cannot generate `min-w-[...]` from a runtime value, so a prop-driven class
 * would silently produce no CSS at all.
 */
const TableShell = ({ minWidth = 720, children, footer, className = '' }) => (
    <div className={`overflow-hidden ${card} ${className}`}>
        <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth }}>
                {children}
            </table>
        </div>
        {footer}
    </div>
);

export default TableShell;
