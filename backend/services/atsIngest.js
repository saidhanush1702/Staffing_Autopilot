/**
 * ── THE BRIDGE FROM THE MIRROR INTO THE EXISTING PIPELINE ─────────────
 *
 * Deliberately thin. A job the mirror finds is handed to `ingestAdapted` — the
 * function the JobsPipe webhook and the JobsPipe poller already share — which
 * fingerprints it (R-15), stores or re-sights it, evaluates every consultant on
 * the bench, writes `job_matches` and `queue_items`, and calls `promoteToReady`.
 * None of that is reimplemented here; a second copy of the matching loop would
 * be a second place for the doors to drift apart.
 *
 * What this module adds is only what is specific to this door:
 *
 *   · its OWN source row (`ATS_DIRECT`), passed in through `lookups`, so
 *     `ingestAdapted` never goes looking for the JobsPipe row.
 *   · the bench, loaded once and cached for a minute. Every board in a polling
 *     tick belongs to one of a handful of agencies, and re-reading every
 *     consultant's criteria for every board is the difference between a tick
 *     that takes a second and one that takes a minute.
 *   · provenance wording, so a queue item says it was detected on an employer's
 *     board rather than claiming a delivery that never happened.
 */
import { query } from '../db.js';
import { ingestAdapted } from '../controllers/jobspipeListener.js';
import { loadMatchableConsultants } from '../controllers/discoveryController.js';
import { SOURCE_NAME } from '../connectors/ats/adapted.js';

const BENCH_TTL_MS = 60_000;
const benchCache = new Map();   // orgId -> { at, bench }

export const clearBenchCache = () => benchCache.clear();

const getBench = async (orgId, now = Date.now()) => {
    const hit = benchCache.get(orgId);
    if (hit && now - hit.at < BENCH_TTL_MS) return hit.bench;
    const bench = await loadMatchableConsultants(orgId);
    benchCache.set(orgId, { at: now, bench });
    return bench;
};

/** Same shape the JobsPipe listener builds, for OUR source row. */
export const loadAtsLookups = async () => {
    const [src, wt, pt, qs] = await Promise.all([
        query('SELECT id, is_enabled FROM lkp_job_sources WHERE name = $1', [SOURCE_NAME]),
        query('SELECT id, name FROM lkp_work_types'),
        query('SELECT id, name FROM lkp_portal_types'),
        query('SELECT id, name FROM lkp_queue_statuses'),
    ]);
    return {
        source: src.rows[0] ?? null,
        workType: Object.fromEntries(wt.rows.map((r) => [r.name, r.id])),
        portalType: Object.fromEntries(pt.rows.map((r) => [r.name, r.id])),
        queueStatus: Object.fromEntries(qs.rows.map((r) => [r.name, r.id])),
    };
};

let lookupsCache = null;

/**
 * An `ingest(adapted)` function bound to one organisation.
 *
 * Lookups are cached for the life of the process: they are reference data the
 * migrations own. The bench is cached for a minute.
 *
 * @returns {(adapted) => Promise<{ outcome, isNew, postingId, matches, queued, … }>}
 */
export const createIngestor = (orgId) => async (adapted) => {
    lookupsCache ??= await loadAtsLookups();
    if (!lookupsCache.source) {
        // Migration 058 not applied. Do not cache the failure.
        lookupsCache = null;
        throw new Error(`No '${SOURCE_NAME}' row in lkp_job_sources — run the migrations.`);
    }
    const bench = await getBench(orgId);
    return ingestAdapted(orgId, adapted, {
        lookups: lookupsCache,
        consultants: bench,
        via: 'Detected live on the employer\'s board',
        viaLabel: 'ATS mirror',
    });
};
