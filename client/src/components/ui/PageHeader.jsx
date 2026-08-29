import { pageTitle, pageSubtitle } from '../../design/tokens.js';

/**
 * The first thing on every page: what this screen is, one line of why, and
 * the actions that belong to the whole screen rather than to a row.
 *
 * It exists so that "where is the New User button?" has the same answer on
 * all twenty screens. Actions wrap under the title on a phone rather than
 * squeezing it, because a truncated page title is a page you cannot identify.
 */
const PageHeader = ({ title, subtitle, icon: Icon, actions, children, className = '' }) => (
    <header className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
        <div className="flex min-w-0 items-start gap-3">
            {Icon && (
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl
                                 border border-brand-200 bg-brand-50 text-brand-600">
                    <Icon className="h-[1.15rem] w-[1.15rem]" />
                </span>
            )}
            <div className="min-w-0">
                <h1 className={pageTitle}>{title}</h1>
                {subtitle && <p className={pageSubtitle}>{subtitle}</p>}
                {children}
            </div>
        </div>

        {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
    </header>
);

export default PageHeader;
