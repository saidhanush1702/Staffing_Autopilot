/**
 * ── THE CYCLE, IN ONE PLACE ───────────────────────────────────────────
 *
 * The scheduler and the API both import from here, so a screen can never show
 * a countdown to a time the server has no intention of running at.
 *
 * ── WHY THIS IS NO LONGER A CRON EXPRESSION ───────────────────────────
 *
 * The interval used to be one environment variable compiled into one cron
 * expression for the whole deployment. It is now per organisation, owned by an
 * ORG_ADMIN from the discovery screen, because two agencies on different
 * provider plans cannot share one interval — and the interval is the single
 * biggest lever on the bill.
 *
 * A fixed cron cannot express "every N hours, where N differs per tenant". So
 * the scheduler ticks on a fast, fixed heartbeat and asks each organisation
 * whether it is DUE. That also makes the schedule self-correcting: a tenant
 * whose run was skipped because the process was down simply comes due on the
 * next tick, instead of waiting for the next slot on a rigid clock.
 *
 * This module is deliberately free of imports from the controller or the
 * scheduler, so neither creates a cycle by depending on it.
 */

/** How often the scheduler wakes to look for due organisations. */
export const TICK_CRON = '*/15 * * * *';
const TICK_MINUTES = 15;

export const MIN_CYCLE_HOURS = 1;
export const MAX_CYCLE_HOURS = 24;
export const DEFAULT_CYCLE_HOURS = 6;

export const clampCycleHours = (value) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_CYCLE_HOURS;
    return Math.min(MAX_CYCLE_HOURS, Math.max(MIN_CYCLE_HOURS, n));
};

export const schedulerTimezone = () => process.env.APP_TIMEZONE ?? 'UTC';

/**
 * Whether the server process runs the cycle at all.
 *
 * Distinct from a tenant's own on/off switch: this is a deployment decision, so
 * a developer's laptop does not quietly start spending an agency's provider
 * credits just because the database says the cycle is on. Both have to be true.
 */
export const isSchedulerAvailable = () => process.env.DISCOVERY_ENABLED === 'true';

/**
 * When the next automatic run is due.
 *
 * Measured from the last automatic run, not from a fixed wall-clock grid. An
 * organisation that has never run automatically is due immediately — which is
 * what an admin expects the moment they switch the cycle on.
 */
export const nextRunAfter = (lastRunAt, cycleHours, now = new Date()) => {
    const hours = clampCycleHours(cycleHours);
    if (!lastRunAt) return new Date(now);

    const next = new Date(new Date(lastRunAt).getTime() + hours * 3_600_000);
    return next < now ? new Date(now) : next;
};

/**
 * Is this organisation due?
 *
 * The tick window is allowed as slack. Without it a cycle whose due moment
 * falls between two ticks would wait a whole extra tick every time, and a
 * 1-hour cycle would drift into a 1h15m one.
 */
export const isDue = (lastRunAt, cycleHours, now = new Date()) => {
    if (!lastRunAt) return true;
    const hours = clampCycleHours(cycleHours);
    const elapsedMs = now.getTime() - new Date(lastRunAt).getTime();
    return elapsedMs >= (hours * 3_600_000) - (TICK_MINUTES * 60_000);
};

/** Runs per day at this interval — for the cost estimate on the screen. */
export const runsPerDay = (cycleHours) => 24 / clampCycleHours(cycleHours);
