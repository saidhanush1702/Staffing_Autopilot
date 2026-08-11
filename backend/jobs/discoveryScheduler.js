/**
 * ── THE 4-HOUR CYCLE ──────────────────────────────────────────────────
 *
 * Runs discovery for every active organisation, every four hours.
 *
 * Design notes worth keeping:
 *
 * · ONE ORGANISATION AT A TIME, sequentially. Running tenants in parallel
 *   would multiply the request rate at every board by the tenant count, which
 *   is precisely how a polite crawler becomes an impolite one.
 *
 * · OVERLAP IS IMPOSSIBLE, twice over: an in-process guard for the common
 *   case, and `uq_one_running_discovery` in the database for the case where
 *   two server processes are running. The database one is the guarantee; the
 *   in-process one just avoids pointless work.
 *
 * · THE SCHEDULE IS OPT-IN TWICE. `DISCOVERY_ENABLED=true` in the environment
 *   decides whether this PROCESS runs the cycle at all, so a fresh checkout
 *   does not start reaching out to job boards on its own and a developer
 *   running the server locally does not silently add load. Then each tenant
 *   opts in separately via `organizations.discovery_schedule_enabled`, which
 *   an ORG_ADMIN owns from the Job Discovery screen. Both must be true.
 *
 * · A FAILING RUN NEVER KILLS THE SCHEDULER. It is logged and the next tick
 *   happens as normal.
 */
import cron from 'node-cron';
import { query } from '../db.js';
import { executeRun } from '../controllers/discoveryController.js';
import {
    CRON_EXPRESSION, CYCLE_HOURS, schedulerTimezone, isSchedulerAvailable,
} from '../config/discoverySchedule.js';

let running = false;
let task = null;

/** One tick: discovery for each participating organisation, in sequence. */
export const runCycle = async () => {
    if (running) {
        console.log('[discovery] previous cycle still running — skipping this tick');
        return;
    }
    running = true;

    try {
        // Only tenants that switched the cycle on. A tenant that turned it off
        // is skipped entirely rather than run and discarded.
        const { rows: orgs } = await query(
            `SELECT id, name FROM organizations
              WHERE is_active AND discovery_schedule_enabled
              ORDER BY name`,
        );

        if (orgs.length === 0) {
            console.log('[discovery] no organisation has the automatic cycle switched on');
            return;
        }

        for (const org of orgs) {
            try {
                const result = await executeRun(org.id, { trigger: 'SCHEDULED' });

                if (result.alreadyRunning) {
                    console.log(`[discovery] ${org.name}: a run is already in progress`);
                    continue;
                }
                const r = result.run;
                console.log(
                    `[discovery] ${org.name}: ${r.provider_calls} API call(s), `
                    + `${r.postings_new} new, ${r.postings_duplicate} repeat, `
                    + `${r.matches_found} matched, ${r.queued} queued, ${r.held_by_cap} held`
                    + (r.queries_failed ? `, ${r.queries_failed} search(es) failed` : ''),
                );
            } catch (err) {
                // One tenant's failure must not stop the others.
                console.error(`[discovery] ${org.name} failed:`, err.message);
            }
        }
    } catch (err) {
        console.error('[discovery] cycle failed:', err.message);
    } finally {
        running = false;
    }
};

export const startDiscoveryScheduler = () => {
    if (!isSchedulerAvailable()) {
        console.log('   Discovery scheduler OFF (set DISCOVERY_ENABLED=true to enable)');
        return null;
    }
    if (task) return task;

    task = cron.schedule(CRON_EXPRESSION, runCycle, { timezone: schedulerTimezone() });

    console.log(
        `   Discovery scheduler ON — every ${CYCLE_HOURS} hours (${schedulerTimezone()}), `
        + 'per-organisation switch in Job Discovery',
    );
    return task;
};

export const stopDiscoveryScheduler = () => {
    if (task) { task.stop(); task = null; }
};
