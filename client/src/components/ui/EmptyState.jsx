import { emptyShell, emptyIcon, emptyTitle, emptyBody } from '../../design/tokens.js';

/**
 * What a list looks like when it is empty.
 *
 * ── WHY IT ALWAYS SAYS WHY ────────────────────────────────────────────
 *
 * "No results" is the same message for three different situations: nothing
 * exists yet, a filter excluded everything, or a request failed quietly. Only
 * the first is normal, and only the user can tell them apart — so `body` is
 * not optional in practice, and an `action` is offered wherever the emptiness
 * is something the user can do something about.
 */
const EmptyState = ({ icon: Icon, title, body, action, className = '' }) => (
    <div className={`${emptyShell} ${className}`}>
        {Icon && (
            <span className={emptyIcon}>
                <Icon className="h-5 w-5" />
            </span>
        )}
        <p className={emptyTitle}>{title}</p>
        {body && <p className={emptyBody}>{body}</p>}
        {action && <div className="mt-4">{action}</div>}
    </div>
);

export default EmptyState;
