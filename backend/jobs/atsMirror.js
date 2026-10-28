/**
 * ── THE ATS MIRROR SCHEDULER ──────────────────────────────────────────
 *
 * A fourth ingestion door, beside the SerpApi cycle, the JobsPipe webhook and
 * the JobsPipe poller, changing nothing about any of them.
 *
 *   every few seconds:  claim the boards that are DUE  →  poll them with bounded
 *   concurrency  →  each poll decides its own next due time.
 *
 * Unlike the other doors this one has no credit meter and no cron expression. A
 * board is due when ITS OWN `next_poll_at` says so, and that moves with how the
 * board behaves (config/atsSchedule.js). The tick is just a loop that asks
 * "what is due now?" — which is why it can run every 15 seconds without doing
 * 15 seconds' worth of work: on a quiet system the answer is usually "nothing".
 *
 * ── OFF UNTIL SOMEBODY TURNS IT ON, TWICE ─────────────────────────────
 *
 *   1. ATS_MIRROR_ENABLED=true in the server environment — otherwise the process
 *      never starts the loop, exactly like WORKER_ENABLED and
 *      JOBSPIPE_POLL_ENABLED. A fresh checkout must not start reaching out to
 *      other people's servers because it booted.
 *   2. the agency's own switch (ats_org_settings.is_enabled), and even then the
 *      agency starts in OBSERVE mode.
 *
 * ── SAFE TO RUN TWICE ─────────────────────────────────────────────────
 *
 * Boards are CLAIMED with `FOR UPDATE SKIP LOCKED` and a lease that lapses by
 * itself, so two server processes (or a tick that overruns) cannot poll the
 * same board at once, and a crashed process strands nothing for longer than the
 * lease.
 */
import 'dotenv/config';
import { query } from '../db.js';
import { httpJson, createLimiter, hostOf } from '../connectors/ats/http.js';
import { pollBoard } from '../services/atsPoller.js';
import { createIngestor } from '../services/atsIngest.js';

const TICK_SECONDS = Number(process.env.ATS_TICK_SECONDS ?? 15);
const BATCH = Number(process.env.ATS_BATCH ?? 40);
const WORKERS = Number(process.env.ATS_WORKERS ?? 8);
const CLAIM_SECONDS = Number(process.env.ATS_CLAIM_SECONDS ?? 300);
const KEEP_RUNS_DAYS = Number(process.env.ATS_KEEP_RUNS_DAYS ?? 14);

/** One limiter for the whole process, so politeness is global, not per tick. */
const limiter = createLimiter();
export const http = (url, opts) => limiter.run(hostOf(url), () => httpJson(url, opts));

const BOARD_SELECT = `
    b.*,
    f.name           AS family,
    f.min_interval_s AS family_min_interval_s`;

/* ── claiming ─────────────────────────────────────────────────────────── */

/** Take up to `limit` due boards for enabled agencies. */
export const claimDue = async (limit = BATCH) => {
    const { rows } = await query(
        `WITH due AS (
            SELECT b.id
              FROM ats_boards b
              JOIN ats_org_settings s
                ON s.organization_id = b.organization_id AND s.is_enabled
             WHERE b.is_enabled
               AND b.status <> 'NOT_FOUND'
               AND b.next_poll_at <= now()
               AND (b.claimed_until IS NULL OR b.claimed_until < now())
             ORDER BY b.next_poll_at
             LIMIT $1
               FOR UPDATE OF b SKIP LOCKED
         ),
         taken AS (
            UPDATE ats_boards b
               SET claimed_until = now() + make_interval(secs => $2)
              FROM due
             WHERE b.id = due.id
         RETURNING b.*
         )
         SELECT ${BOARD_SELECT}
           FROM taken b
           JOIN lkp_ats_families f ON f.id = b.family_id`,
        [limit, CLAIM_SECONDS],
    );
    return rows;
};

/** Claim ONE board for a manual / on-add poll. null if it is already being polled. */
export const claimOne = async (boardId, orgId) => {
    const { rows } = await query(
        `WITH taken AS (
            UPDATE ats_boards b
               SET claimed_until = now() + make_interval(secs => $3)
             WHERE b.id = $1 AND b.organization_id = $2
               AND (b.claimed_until IS NULL OR b.claimed_until < now())
         RETURNING b.*
         )
         SELECT ${BOARD_SELECT}
           FROM taken b
           JOIN lkp_ats_families f ON f.id = b.family_id`,
        [boardId, orgId, CLAIM_SECONDS],
    );
    return rows[0] ?? null;
};

const settingsFor = async (orgIds) => {
    const { rows } = await query(
        'SELECT * FROM ats_org_settings WHERE organization_id = ANY($1)',
        [orgIds],
    );
    return new Map(rows.map((r) => [r.organization_id, r]));
};

/* ── polling ──────────────────────────────────────────────────────────── */

/**
 * Poll one already-claimed board.
 *
 * An agency that is switched OFF can still have a board polled by hand (to
 * verify it), but it is held in OBSERVE: turning the feature off must never
 * leave a back door that still creates queue items.
 */
export const pollClaimed = async (row, settings, {
    trigger = 'SCHEDULED', now = new Date(),
    // Injectable so the "agency is OFF" guard can be tested without a network.
    httpClient = http, ingest = createIngestor(row.organization_id),
} = {}) => {
    const effective = settings.is_enabled ? settings : { ...settings, mode: 'OBSERVE' };
    return pollBoard(row, { settings: effective, http: httpClient, ingest, trigger, now });
};

/** One tick: claim what is due and poll it with bounded concurrency. */
let ticking = false;
export const tick = async ({ limit = BATCH, workers = WORKERS } = {}) => {
    if (ticking) return { skipped: true };
    ticking = true;
    const started = Date.now();
    const summary = { claimed: 0, polled: 0, newJobs: 0, ingested: 0, queued: 0, errors: 0 };

    try {
        const due = await claimDue(limit);
        summary.claimed = due.length;
        if (due.length === 0) return summary;

        const settings = await settingsFor([...new Set(due.map((b) => b.organization_id))]);
        const queue = [...due];

        const worker = async () => {
            for (let row = queue.shift(); row; row = queue.shift()) {
                try {
                    const cfg = settings.get(row.organization_id);
                    const r = await pollClaimed(row, cfg);
                    summary.polled += 1;
                    summary.newJobs += r.new_found;
                    summary.ingested += r.ingested;
                    summary.queued += r.queued;
                    if (r.outcome === 'ERROR' || r.outcome === 'NOT_FOUND') summary.errors += 1;
                } catch (err) {
                    // pollBoard already swallows its own failures; reaching here
                    // means the bookkeeping itself failed. Release the board so
                    // it is retried, not stranded for the full lease.
                    summary.errors += 1;
                    console.error(`[ats-mirror] unrecoverable on ${row.family}/${row.board_key}: ${err.message}`);
                    await query(
                        `UPDATE ats_boards SET claimed_until = NULL,
                                next_poll_at = now() + interval '5 minutes' WHERE id = $1`,
                        [row.id],
                    ).catch(() => {});
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(workers, due.length) }, worker));
        return { ...summary, ms: Date.now() - started };
    } finally {
        ticking = false;
    }
};

/** Poll ledger rows older than the retention window are noise. */
export const pruneRuns = async () => {
    const { rowCount } = await query(
        `DELETE FROM ats_poll_runs WHERE started_at < now() - make_interval(days => $1)`,
        [KEEP_RUNS_DAYS],
    );
    return rowCount;
};

/* ── the loop ─────────────────────────────────────────────────────────── */

export const startAtsMirror = () => {
    if (process.env.ATS_MIRROR_ENABLED !== 'true') {
        console.log('[ats-mirror] disabled (ATS_MIRROR_ENABLED is not "true")');
        return null;
    }

    let lastPrune = 0;
    const timer = setInterval(async () => {
        try {
            const s = await tick();
            if (!s.skipped && s.polled > 0 && (s.newJobs || s.errors)) {
                console.log(`[ats-mirror] tick: ${s.polled} polled, ${s.newJobs} new, `
                    + `${s.ingested} ingested, ${s.queued} queued, ${s.errors} errors (${s.ms}ms)`);
            }
            if (Date.now() - lastPrune > 3_600_000) {
                lastPrune = Date.now();
                const n = await pruneRuns();
                if (n) console.log(`[ats-mirror] pruned ${n} old poll record(s)`);
            }
        } catch (err) {
            console.error('[ats-mirror] tick failed:', err.message);
        }
    }, TICK_SECONDS * 1000);

    // Never keep the process alive on this alone.
    timer.unref?.();
    console.log(`✅ ATS live mirror started (tick ${TICK_SECONDS}s, ${WORKERS} workers, batch ${BATCH})`);
    return { stop: () => clearInterval(timer) };
};
