import { badge as badgeShell, TONE, ROLE_TONE } from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

/**
 * The badge. One shell, six tones — see TONE in the design tokens.
 *
 *   <Badge tone="success" icon={CheckCircle2}>Live</Badge>
 */
const Badge = ({ tone = 'neutral', icon: Icon, title, className = '', children }) => (
    <span title={title} className={`${badgeShell} ${TONE[tone] ?? TONE.neutral} ${className}`}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {children}
    </span>
);

/**
 * A user's role, coloured by the role accent and labelled from `lkp_roles`.
 *
 * This replaced three separate copies of the same ROLE_BADGE map — Users,
 * OrganizationDetail and Sidebar each had their own, and each had its own
 * chance to drift when a role is added.
 */
export const RoleBadge = ({ role, className = '' }) => {
    const { roleLabel } = useLookups();
    return (
        <span className={`${badgeShell} ${ROLE_TONE[role] ?? TONE.neutral} ${className}`}>
            {roleLabel(role)}
        </span>
    );
};

export default Badge;
