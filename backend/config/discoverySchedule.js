/**
 * ── THE CYCLE, IN ONE PLACE ───────────────────────────────────────────
 *
 * The cron expression and the "next run" arithmetic live together here, and
 * both the scheduler and the API import them from this file.
 *
 * That matters more than it looks. If the UI computed its own countdown from a
 * hard-coded "every 4 hours", then changing the cron expression would leave a
 * screen confidently displaying a time the server has no intention of running
 * at — and nobody would notice until a run failed to appear. One definition,
 * two consumers.
 *
 * This module is deliberately free of imports from the controller or the
 * scheduler, so neither creates a cycle by depending on it.
 */

export const CYCLE_HOURS = 4;

/** Minute 0, every 4th hour: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00. */
export const CRON_EXPRESSION = `0 */${CYCLE_HOURS} * * *`;

export const schedulerTimezone = () => process.env.APP_TIMEZONE ?? 'UTC';

/**
 * Whether the server process runs the cycle at all.
 *
 * Distinct from a tenant's own on/off switch: this is a deployment decision,
 * so a developer's laptop does not quietly start crawling job boards. Both
 * have to be true for anything to happen, which is why the API reports them
 * separately — an admin who flips their switch and sees nothing happen needs
 * to be told the process-level one is off.
 */
export const isSchedulerAvailable = () => process.env.DISCOVERY_ENABLED === 'true';

/** Wall-clock time in an IANA zone, without pulling in a date library. */
const zonedClock = (date, timeZone) => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(date);

    const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    // hour12:false renders midnight as 24 in some ICU versions.
    return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
};

/**
 * The next moment the cron expression fires, as a real Date.
 *
 * Works from the wall clock in the scheduler's timezone rather than from UTC,
 * because that is what cron itself does. A DST shift inside the coming window
 * can move the true firing time by an hour; this is a countdown for a person
 * watching a screen, not a scheduling primitive, and it re-syncs from the
 * server on the next poll.
 */
export const nextRunAfter = (from = new Date(), timeZone = schedulerTimezone()) => {
    let clock;
    try {
        clock = zonedClock(from, timeZone);
    } catch {
        // A mistyped APP_TIMEZONE must not take the endpoint down.
        clock = zonedClock(from, 'UTC');
    }

    const { hour, minute, second } = clock;
    let seconds = (CYCLE_HOURS - (hour % CYCLE_HOURS)) * 3600 - (minute * 60) - second;
    if (seconds <= 0) seconds += CYCLE_HOURS * 3600;

    return new Date(from.getTime() + (seconds * 1000) - from.getMilliseconds());
};
