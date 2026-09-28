import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { getAppTimeZone, getAppTimeZoneLabel, formatDate, formatTime } from '../../utils/datetime.js';

/**
 * The header's live clock — always the app's one time zone, regardless of
 * the viewer's own machine, so a date stamped here always agrees with a
 * date stamped anywhere else in the app.
 *
 * `getAppTimeZone`/`getAppTimeZoneLabel` are read fresh on every render
 * rather than destructured once, so the once-a-second tick below also picks
 * up a zone that changed after login (LookupContext calls `setAppTimeZone`
 * as soon as `GET /api/lookups` answers) without this component needing its
 * own subscription to that change.
 */
const DateTimeCard = ({ className = '' }) => {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    return (
        <div
            title={`${getAppTimeZoneLabel()} (${getAppTimeZone()})`}
            className={`hidden shrink-0 items-center gap-2 rounded-lg border border-line
                       bg-surface px-3 py-1.5 shadow-xs sm:flex ${className}`}
        >
            <Clock className="h-4 w-4 shrink-0 text-slate-400" />
            <span className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                {formatDate(now)}
            </span>
            <span className="text-slate-300">|</span>
            <span className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                {formatTime(now)}
            </span>
            <span className="text-2xs font-bold tracking-wide text-brand-600">
                {getAppTimeZoneLabel()}
            </span>
        </div>
    );
};

export default DateTimeCard;
