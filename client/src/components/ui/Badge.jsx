import {
    badge as badgeShell, pill as pillShell, statusDot,
    TONE, TONE_OUTLINE, TONE_SOLID, ROLE_TONE,
} from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

/**
 * The badge. One shell, six tones — see TONE in the design tokens.
 *
 *   <Badge tone="success" icon={CheckCircle2}>Live</Badge>
 *   <Badge tone="warning" variant="pill" dot>Pending</Badge>
 *   <Badge tone="danger" variant="outline">Terminated</Badge>
 *
 * `dot` replaces the icon with a filled circle in the tone's colour. Use it
 * for a STATE (running, paused, offline), where a glyph would add nothing a
 * colour does not already say, and where a column of dots down a table is
 * scannable in a way a column of small icons is not.
 */
const VARIANT = {
    solid: (tone) => `${badgeShell} ${TONE[tone] ?? TONE.neutral}`,
    outline: (tone) => `${badgeShell} ${TONE_OUTLINE[tone] ?? TONE_OUTLINE.neutral}`,
    pill: (tone) => `${pillShell} ${TONE[tone] ?? TONE.neutral}`,
};

const Badge = ({
    tone = 'neutral',
    variant = 'solid',
    icon: Icon,
    dot = false,
    title,
    className = '',
    children,
}) => (
    <span title={title} className={`${(VARIANT[variant] ?? VARIANT.solid)(tone)} ${className}`}>
        {dot && <span className={`${statusDot} ${TONE_SOLID[tone] ?? TONE_SOLID.neutral}`} />}
        {!dot && Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        {children}
    </span>
);

/**
 * A user's role, coloured by the role accent and labelled from `lkp_roles`.
 *
 * This replaced three separate copies of the same map — Users,
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
