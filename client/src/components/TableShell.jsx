import { card, cardHeader, sectionTitle, sectionSubtitle } from '../design/tokens.js';

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
 *
 * `title` / `action` add the header band — use them when the table is one of
 * several blocks on a page and needs a lid of its own.
 */
const TableShell = ({
    minWidth = 720,
    title,
    subtitle,
    action,
    children,
    footer,
    className = '',
}) => (
    <div className={`overflow-hidden ${card} ${className}`}>
        {(title || action) && (
            <div className={cardHeader}>
                <div className="min-w-0">
                    {title && <h2 className={sectionTitle}>{title}</h2>}
                    {subtitle && <p className={sectionSubtitle}>{subtitle}</p>}
                </div>
                {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
            </div>
        )}
        <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth }}>
                {children}
            </table>
        </div>
        {footer}
    </div>
);

export default TableShell;
