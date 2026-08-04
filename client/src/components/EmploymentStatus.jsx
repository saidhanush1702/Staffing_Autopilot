import { CheckCircle2, PauseCircle, XOctagon, CircleDashed } from 'lucide-react';
import Badge from './ui/Badge.jsx';
import { STATUS_TONE } from '../design/tokens.js';
import { useLookups } from '../context/LookupContext.jsx';

/**
 * Employment state badge.
 *
 *   ACTIVE      normal
 *   SUSPENDED   access removed, still an employee — REVERSIBLE
 *   TERMINATED  no longer an employee — PERMANENT
 *
 * The LABEL comes from `lkp_user_statuses`, which migration 015 aligned with
 * the CHECK constraint on `users.employment_status`. Only the icon and the
 * tone are decided here — those are design choices and have no business in
 * the database.
 *
 * Adding a fourth state is therefore a seed entry plus one line in each map
 * below, and no screen changes at all.
 */
const STATUS_ICON = {
    ACTIVE: CheckCircle2,
    SUSPENDED: PauseCircle,
    TERMINATED: XOctagon,
};

const EmploymentStatus = ({ status, since, reason }) => {
    const { statusLabel } = useLookups();

    const title = [
        since && `Since ${new Date(since).toLocaleDateString()}`,
        reason,
    ].filter(Boolean).join(' — ') || undefined;

    return (
        <Badge
            tone={STATUS_TONE[status] ?? 'neutral'}
            icon={STATUS_ICON[status] ?? CircleDashed}
            title={title}
        >
            {statusLabel(status)}
        </Badge>
    );
};

export default EmploymentStatus;
