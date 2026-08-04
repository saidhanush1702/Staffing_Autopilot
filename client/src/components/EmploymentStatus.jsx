import { CheckCircle2, PauseCircle, XOctagon } from 'lucide-react';

/**
 * Employment state badge.
 *
 *   ACTIVE      normal
 *   SUSPENDED   access removed, still an employee — REVERSIBLE
 *   TERMINATED  no longer an employee — PERMANENT
 */
export const STATUS_META = {
    ACTIVE: {
        label: 'Active', icon: CheckCircle2,
        cls: 'bg-emerald-50 text-emerald-700',
    },
    SUSPENDED: {
        label: 'Suspended', icon: PauseCircle,
        cls: 'bg-amber-50 text-amber-700',
    },
    TERMINATED: {
        label: 'Terminated', icon: XOctagon,
        cls: 'bg-red-50 text-red-700',
    },
};

const EmploymentStatus = ({ status, since, reason }) => {
    const meta = STATUS_META[status] ?? STATUS_META.ACTIVE;
    const Icon = meta.icon;

    const title = [
        since && `Since ${new Date(since).toLocaleDateString()}`,
        reason,
    ].filter(Boolean).join(' — ') || undefined;

    return (
        <span
            title={title}
            className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${meta.cls}`}
        >
            <Icon className="h-3.5 w-3.5" />{meta.label}
        </span>
    );
};

export default EmploymentStatus;
