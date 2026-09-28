/**
 * ── ONE CLOCK FOR THE WHOLE APP ────────────────────────────────────────
 *
 * Every date the app shows a person — a timestamp, "reviewed on", the
 * header clock — renders in one time zone, no matter where the browser
 * itself is set.
 *
 * That zone is not hardcoded here. `GET /api/lookups` carries it down from
 * the server's own `APP_TIMEZONE` (see backend/config/discoverySchedule.js)
 * and `setAppTimeZone` below is called once it arrives — see
 * `LookupContext.jsx`. Change the setting in the backend's environment,
 * restart it, and the browser follows on the next login. Nothing in this
 * file, or in any screen that imports `formatDate` / `formatTime` /
 * `formatDateTime`, ever needs to change.
 *
 * The constants below are only the fallback used before that first fetch
 * lands (the login screen, or a request that fails) — today's deployment
 * is Eastern time, so that is what a person sees while the real value is
 * still in flight.
 *
 * Values stay in UTC everywhere else (the database, the wire format) —
 * only the last mile, turning a Date into text, goes through here.
 */
const FALLBACK_TIME_ZONE = 'America/New_York';
const FALLBACK_TIME_ZONE_LABEL = 'EST';

let appTimeZone = FALLBACK_TIME_ZONE;
let appTimeZoneLabel = FALLBACK_TIME_ZONE_LABEL;

/** Called once per session, from LookupContext, with the server's own setting. */
export const setAppTimeZone = (timezone, label) => {
    if (timezone) appTimeZone = timezone;
    appTimeZoneLabel = label || timezone || FALLBACK_TIME_ZONE_LABEL;
};

export const getAppTimeZone = () => appTimeZone;
export const getAppTimeZoneLabel = () => appTimeZoneLabel;

const asDate = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** e.g. "9/21/2026" */
export const formatDate = (value, opts) => {
    const d = asDate(value);
    if (!d) return '';
    return d.toLocaleDateString('en-US', { timeZone: appTimeZone, ...opts });
};

/** e.g. "4:00:03 AM" */
export const formatTime = (value, opts) => {
    const d = asDate(value);
    if (!d) return '';
    return d.toLocaleTimeString('en-US', { timeZone: appTimeZone, ...opts });
};

/** e.g. "9/21/2026, 4:00:03 AM" */
export const formatDateTime = (value, opts) => {
    const d = asDate(value);
    if (!d) return '';
    return d.toLocaleString('en-US', { timeZone: appTimeZone, ...opts });
};
