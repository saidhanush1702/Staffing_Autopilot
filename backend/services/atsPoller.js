/**
 * ── POLL ONE BOARD ────────────────────────────────────────────────────
 *
 *   read the board  →  diff against what we remembered  →  for each NEW job:
 *   fetch its detail, hand it to the existing pipeline, remember it  →  retire
 *   what has gone  →  decide when to look again  →  write the ledger row.
 *
 * Everything that decides WHAT counts as new, gone or fresh is in
 * `atsDiff.js`, and everything that decides WHEN to look again is in
 * `config/atsSchedule.js`; both are pure and have their own tests. This file is
 * the part that touches the database and the network, and it is written so that
 * dying at any line leaves the system correct:
 *
 *   · ingest first, then remember. A crash between the two means the job is
 *     seen as new on the next poll and handed to `ingestAdapted` again, where
 *     R-15 and `ON CONFLICT DO NOTHING` make the repeat harmless.
 *   · the board's claim is a LEASE that lapses on its own, so a crashed worker
 *     cannot strand a board.
 *   · a failure is recorded against the board and backs it off; it never
 *     propagates, so one broken employer cannot stop a tick.
 *
 * ── THE TWO MODES ─────────────────────────────────────────────────────
 *
 *   OBSERVE  new jobs are detected and RECORDED, with the time it took to notice
 *            them. Nothing enters job_postings, so nothing is queued and no AI
 *            preparation is bought. It is how a new installation finds out
 *            whether the mirror earns its place before it is allowed to act.
 *   LIVE     new jobs go through the full pipeline.
 */
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { adapterFor, withConfig } from '../connectors/ats/index.js';
import { toAdapted } from '../connectors/ats/adapted.js';
import { sha256 } from '../connectors/ats/shared.js';
import { diffBoard, isFresh, latencySeconds } from './atsDiff.js';
import { nextIntervalS, withJitter, shouldPark } from '../config/atsSchedule.js';

const MAX_DETAIL_ATTEMPTS = 3;
const BASELINE_CHUNK = 500;
const RAW_SOURCE_LIMIT = 60_000;      // chars of the family's own payload kept per job
const DESCRIPTION_LIMIT = 20_000;

const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n));
const secs = (n) => n * 1000;

/* ── settings ─────────────────────────────────────────────────────────── */

/** The agency's settings, created (OFF, OBSERVE) the first time anyone asks. */
export const getOrCreateSettings = async (orgId) => {
    await query(
        'INSERT INTO ats_org_settings (organization_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [orgId],
    );
    const { rows } = await query('SELECT * FROM ats_org_settings WHERE organization_id = $1', [orgId]);
    return rows[0];
};

/* ── what we keep of a job ────────────────────────────────────────────── */

/**
 * The normalised item, kept so that (a) a job whose detail or ingest has to be
 * retried can be rebuilt without asking the board again, and (b) a parser fix
 * can be replayed over history — the reason `job_source_payloads` exists.
 * Bounded: a million jobs of 200 KB each is a database nobody wanted.
 */
export const capRaw = (item) => {
    const { raw, description, ...rest } = item;
    let source = raw ?? null;
    try {
        if (source && JSON.stringify(source).length > RAW_SOURCE_LIMIT) source = null;
    } catch { source = null; }
    return { item: { ...rest, description: clip(description, DESCRIPTION_LIMIT) }, source };
};

const itemFromRow = (r) => {
    const stored = r.raw?.item ?? {};
    return {
        ...stored,
        extId: r.ext_id,
        title: stored.title ?? r.title,
        locationText: stored.locationText ?? r.location_text,
        publishedAt: stored.publishedAt ?? (r.published_at ? new Date(r.published_at).toISOString() : null),
        sourceUrl: stored.sourceUrl ?? r.source_url,
        applyUrl: stored.applyUrl ?? r.apply_url,
        raw: r.raw?.source ?? stored.raw ?? null,
    };
};

/* ── writes ───────────────────────────────────────────────────────────── */

const saveJob = (client, board, item, fields) => client.query(
    `INSERT INTO ats_board_jobs
        (board_id, ext_id, organization_id, title, location_text, state, published_at,
         first_seen_at, last_seen_at, latency_s, content_hash, apply_url, source_url,
         posting_id, matches, queued, detail_attempts, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now(), $8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (board_id, ext_id) DO UPDATE SET
        state = EXCLUDED.state,
        title = EXCLUDED.title,
        location_text = EXCLUDED.location_text,
        published_at = COALESCE(EXCLUDED.published_at, ats_board_jobs.published_at),
        last_seen_at = now(),
        content_hash = EXCLUDED.content_hash,
        apply_url = COALESCE(EXCLUDED.apply_url, ats_board_jobs.apply_url),
        source_url = COALESCE(EXCLUDED.source_url, ats_board_jobs.source_url),
        posting_id = COALESCE(EXCLUDED.posting_id, ats_board_jobs.posting_id),
        matches = EXCLUDED.matches,
        queued = EXCLUDED.queued,
        detail_attempts = EXCLUDED.detail_attempts,
        raw = COALESCE(EXCLUDED.raw, ats_board_jobs.raw)`,
    [board.id, item.extId, board.organization_id,
        clip(item.title, 255), clip(item.locationText, 255), fields.state,
        item.publishedAt ?? null, fields.latencyS ?? null,
        sha256(JSON.stringify([item.title, item.locationText, item.description ?? null])),
        clip(item.applyUrl, 1000), clip(item.sourceUrl, 1000),
        fields.postingId ?? null, fields.matches ?? 0, fields.queued ?? 0,
        fields.attempts ?? 0,
        fields.raw === undefined ? JSON.stringify(capRaw(item)) : fields.raw],
);

const insertBaseline = async (client, board, items) => {
    for (let i = 0; i < items.length; i += BASELINE_CHUNK) {
        const chunk = items.slice(i, i + BASELINE_CHUNK);
        await client.query(
            `INSERT INTO ats_board_jobs
                (board_id, ext_id, organization_id, title, location_text, state,
                 published_at, first_seen_at, last_seen_at, apply_url, source_url)
             SELECT $1, t.ext_id, $2, t.title, t.loc, 'BASELINE', t.pub::timestamptz, now(), now(), t.apply, t.src
               FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
                    AS t(ext_id, title, loc, pub, apply, src)
             ON CONFLICT (board_id, ext_id) DO NOTHING`,
            [board.id, board.organization_id,
                chunk.map((x) => x.extId),
                chunk.map((x) => clip(x.title, 255)),
                chunk.map((x) => clip(x.locationText, 255)),
                chunk.map((x) => x.publishedAt ?? null),
                chunk.map((x) => clip(x.applyUrl, 1000)),
                chunk.map((x) => clip(x.sourceUrl, 1000))],
        );
    }
};

/* ── the poll ─────────────────────────────────────────────────────────── */

/**
 * @param {object} row       ats_boards row joined with its family:
 *                           family, family_min_interval_s, plus the board columns
 * @param {object} opts
 * @param {object} opts.settings   ats_org_settings row
 * @param {Function} opts.http     (url, opts) → { json, notModified, … }
 * @param {Function} opts.ingest   (adapted) → ingestAdapted result
 * @param {string}   [opts.trigger]  'SCHEDULED' | 'MANUAL' | 'ADD'
 * @param {Date}     [opts.now]
 * @param {Function} [opts.rand]
 * @returns the ledger row that was written
 */
export const pollBoard = async (row, {
    settings, http, ingest, trigger = 'SCHEDULED', now = new Date(), rand = Math.random,
}) => {
    const startedMs = Date.now();
    const board = withConfig({ ...row });
    const adapter = adapterFor(row.family);
    const isBootstrap = !row.baselined_at;

    const run = {
        id: uuidv4(), outcome: 'OK', http_status: null, bytes: null, jobs_listed: 0,
        new_found: 0, detail_fetches: 0, ingested: 0, duplicates: 0, matches: 0,
        queued: 0, closed: 0, error: null,
    };

    const writeRun = () => query(
        `INSERT INTO ats_poll_runs
            (id, organization_id, board_id, started_at, duration_ms, trigger, outcome,
             http_status, bytes, jobs_listed, new_found, detail_fetches, ingested,
             duplicates, matches, queued, closed, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [run.id, row.organization_id, row.id, new Date(startedMs), Date.now() - startedMs,
            trigger, run.outcome, run.http_status, run.bytes, run.jobs_listed, run.new_found,
            run.detail_fetches, run.ingested, run.duplicates, run.matches, run.queued,
            run.closed, clip(run.error, 500)],
    );

    const schedule = (result, extra = {}) => {
        const base = nextIntervalS({
            intervalS: row.interval_s, result, isPriority: row.is_priority,
            minIntervalS: settings.min_interval_s, maxIntervalS: settings.max_interval_s,
            familyMinS: row.family_min_interval_s, ...extra,
        });
        const wait = withJitter(base, rand);
        return { intervalS: base, nextPollAt: new Date(now.getTime() + secs(wait)) };
    };

    /* ── failure: record it, back off, never throw ─────────────────── */
    const fail = async (err) => {
        const notFound = err?.kind === 'NOT_FOUND';
        run.outcome = notFound ? 'NOT_FOUND' : 'ERROR';
        run.http_status = err?.status ?? null;
        run.error = err?.message ?? String(err);

        const failures = notFound ? row.consecutive_failures : row.consecutive_failures + 1;
        const notFounds = notFound ? row.consecutive_not_found + 1 : 0;
        const parked = notFound && shouldPark(notFounds);
        const { intervalS, nextPollAt } = schedule(notFound ? 'not_found' : 'error',
            { retryAfterS: err?.retryAfterS ?? null });

        await query(
            `UPDATE ats_boards
                SET interval_s = $2, next_poll_at = $3, claimed_until = NULL,
                    last_polled_at = $4, last_error = $5,
                    consecutive_failures = $6, consecutive_not_found = $7,
                    status = $8
              WHERE id = $1`,
            [row.id, intervalS, nextPollAt, now, clip(run.error, 500), failures, notFounds,
                parked ? 'NOT_FOUND' : (failures >= 3 || notFound ? 'FAILING' : row.status)],
        );
        await writeRun();
        console.warn(`[ats-mirror] ${row.family}/${row.board_key}: ${run.outcome} — ${run.error}`);
        return { ...run };
    };

    try {
        /* ── what we remember ──────────────────────────────────────── */
        const { rows: knownRows } = await query(
            'SELECT ext_id, state, closed_at, missed_polls FROM ats_board_jobs WHERE board_id = $1',
            [row.id],
        );
        const known = new Map(knownRows.map((r) => [r.ext_id, r]));

        /* ── read the board ────────────────────────────────────────── */
        let list;
        try {
            list = await adapter.fetchList(board, {
                http, now, etag: row.etag, prevHash: row.list_hash,
                knownIds: new Set(known.keys()), isBootstrap,
                maxPages: isBootstrap ? 3 : 5,
            });
        } catch (err) {
            return await fail(err);
        }

        run.http_status = list.status ?? 200;
        run.bytes = list.bytes ?? null;

        const notModified = Boolean(list.notModified);
        const items = notModified ? [] : (list.items ?? []);
        run.jobs_listed = items.length;

        // ── MAY THIS BOARD FEED QUEUES? ───────────────────────────────
        //
        // Only with a REAL company name. R-15 fingerprints company + title +
        // location, and "northwindlabs" (the humanised board key) is a different
        // company from "Northwind Labs" — so a job read here and the same job
        // found by SerpApi or JobsPipe would become two postings and reach a
        // consultant twice (asserted in tests/atsMirror.test.mjs). Greenhouse
        // and SmartRecruiters state the name; Lever, Ashby and Workday do not,
        // and until somebody supplies it that board only OBSERVES.
        const hasRealName = Boolean(row.company_name) || items.some((i) => i.companyName);
        const live = settings.mode === 'LIVE' && hasRealName;

        const d = notModified
            ? { candidates: [], baseline: [], seen: [], reopened: [], missed: [], toClose: [], suspicious: false }
            : diffBoard({
                items, known, complete: Boolean(list.complete), isBootstrap,
                bootstrapAgeHours: settings.bootstrap_age_hours, now,
            });
        run.new_found = d.candidates.length;
        run.closed = d.toClose.length;

        /* ── remember what is merely there ─────────────────────────── */
        if (d.baseline.length) {
            await withTransaction((client) => insertBaseline(client, board, d.baseline));
        }

        /* ── the work: this poll's new jobs, then any backlog ──────── */
        const work = d.candidates.map((item) => ({ item, isNew: true, attempts: 0 }));

        if (live) {
            const { rows: pendingRows } = await query(
                `SELECT ext_id, title, location_text, published_at, source_url, apply_url,
                        detail_attempts, raw
                   FROM ats_board_jobs
                  WHERE board_id = $1 AND state IN ('DETECTED', 'FAILED')
                    AND detail_attempts < $2 AND closed_at IS NULL
                  ORDER BY first_seen_at DESC
                  LIMIT 100`,
                [row.id, MAX_DETAIL_ATTEMPTS],
            );
            const inThisPoll = new Set(work.map((w) => w.item.extId));
            for (const r of pendingRows) {
                if (!inThisPoll.has(r.ext_id)) {
                    work.push({ item: itemFromRow(r), isNew: false, attempts: r.detail_attempts });
                }
            }
        }

        let detailsLeft = settings.detail_cap_per_poll;
        let ingestsLeft = settings.max_ingest_per_poll;
        let newlyIngested = 0;

        for (const w of work) {
            let { item } = w;
            const detectedAt = new Date();
            const latencyS = w.isNew ? latencySeconds(item, detectedAt, { isBootstrap }) : null;
            // One upsert, so no transaction. `item` is read at CALL time: a detail
            // fetched after this closure was made is what gets saved.
            const persist = (state, extra = {}) => saveJob({ query }, board, item, {
                state, latencyS, attempts: w.attempts, ...extra,
            });

            /* OBSERVE: record the detection and stop. */
            if (!live) {
                await persist('OBSERVED');
                continue;
            }

            /* Over the per-poll bounds: keep it, do it next time. */
            if (ingestsLeft <= 0) { await persist('DETECTED'); continue; }

            /* The description / real location / exact date, where the list lacks them. */
            if (item.needsDetail && !item.detailed) {
                if (detailsLeft <= 0) { await persist('DETECTED'); continue; }
                detailsLeft -= 1;
                run.detail_fetches += 1;
                try {
                    const extra = await adapter.fetchDetail(board, item, { http, now });
                    item = { ...item, ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== null)), detailed: true };
                } catch (err) {
                    w.attempts += 1;
                    if (w.attempts < MAX_DETAIL_ATTEMPTS) {
                        // Try again next poll rather than ingest a job with no description.
                        await persist('DETECTED', { attempts: w.attempts });
                        continue;
                    }
                    // Out of attempts: a job with a title and a place is still
                    // worth a consultant's attention.
                    item = { ...item, detailed: true };
                }
            }

            /* First contact: the detail may have revealed the job is not fresh after all. */
            if (isBootstrap && !isFresh(item, settings.bootstrap_age_hours, now)) {
                await persist('BASELINE');
                continue;
            }

            const adapted = toAdapted(board, item, adapter, now);
            if (!adapted) {
                await persist('FAILED', { attempts: MAX_DETAIL_ATTEMPTS });   // terminal: unusable
                continue;
            }

            let out;
            try {
                out = await ingest(adapted);
                if (out?.outcome === 'ERROR') throw new Error(out.detail ?? 'ingest refused the posting');
            } catch (err) {
                w.attempts += 1;
                console.error(`[ats-mirror] ingest failed for ${row.family}/${row.board_key}#${item.extId}: ${err.message}`);
                await persist('FAILED', { attempts: w.attempts });
                continue;
            }

            ingestsLeft -= 1;
            run.matches += out.matches ?? 0;
            run.queued += out.queued ?? 0;
            if (out.isNew) { run.ingested += 1; newlyIngested += 1; } else { run.duplicates += 1; }

            await persist(out.isNew ? 'INGESTED' : 'DUPLICATE', {
                postingId: out.postingId, matches: out.matches ?? 0, queued: out.queued ?? 0,
                attempts: w.attempts,
            });
        }

        /* ── retire what has gone ──────────────────────────────────── */
        await withTransaction(async (client) => {
            if (d.seen.length) {
                await client.query(
                    `UPDATE ats_board_jobs SET last_seen_at = now(), missed_polls = 0
                      WHERE board_id = $1 AND ext_id = ANY($2)`,
                    [row.id, d.seen],
                );
            }
            if (d.reopened.length) {
                await client.query(
                    'UPDATE ats_board_jobs SET closed_at = NULL, missed_polls = 0 WHERE board_id = $1 AND ext_id = ANY($2)',
                    [row.id, d.reopened],
                );
            }
            const stillMissing = d.missed.filter((id) => !d.toClose.includes(id));
            if (stillMissing.length) {
                await client.query(
                    'UPDATE ats_board_jobs SET missed_polls = missed_polls + 1 WHERE board_id = $1 AND ext_id = ANY($2)',
                    [row.id, stillMissing],
                );
            }
            if (d.toClose.length) {
                await client.query(
                    `UPDATE ats_board_jobs SET closed_at = now(), missed_polls = missed_polls + 1
                      WHERE board_id = $1 AND ext_id = ANY($2) AND closed_at IS NULL`,
                    [row.id, d.toClose],
                );
                if (settings.close_on_removal) {
                    // Opt-in, because it reaches postings other doors created.
                    await client.query(
                        `UPDATE job_postings SET is_active = FALSE
                          WHERE organization_id = $1
                            AND id IN (SELECT posting_id FROM ats_board_jobs
                                        WHERE board_id = $2 AND ext_id = ANY($3)
                                          AND posting_id IS NOT NULL)`,
                        [row.organization_id, row.id, d.toClose],
                    );
                }
            }
        });

        /* ── when to look again, and what to remember about the board ── */
        const changed = d.candidates.length > 0 || d.toClose.length > 0
            || (!isBootstrap && d.baseline.length > 0);
        const { intervalS, nextPollAt } = schedule(changed ? 'changed' : 'unchanged');

        run.outcome = notModified ? 'NOT_MODIFIED' : (isBootstrap ? 'BASELINED' : 'OK');

        // Their name for themselves beats a humanised key; only fill a gap.
        const discoveredName = items.find((i) => i.companyName)?.companyName ?? null;

        await query(
            `UPDATE ats_boards SET
                etag = COALESCE($2, etag),
                list_hash = COALESCE($3, list_hash),
                interval_s = $4, next_poll_at = $5, claimed_until = NULL,
                last_polled_at = $6, last_success_at = $6,
                last_changed_at = CASE WHEN $7 THEN $6 ELSE last_changed_at END,
                last_error = NULL, consecutive_failures = 0, consecutive_not_found = 0,
                status = 'ACTIVE',
                baselined_at = COALESCE(baselined_at, $6),
                jobs_open = COALESCE($8, jobs_open),
                jobs_detected = jobs_detected + $9,
                jobs_ingested = jobs_ingested + $10,
                jobs_queued = jobs_queued + $11,
                company_name = COALESCE(company_name, $12)
              WHERE id = $1`,
            [row.id, list.etag ?? null, list.listHash ?? null, intervalS, nextPollAt, now,
                changed, notModified ? null : (list.total ?? items.length),
                d.candidates.length, newlyIngested, run.queued, discoveredName],
        );

        await writeRun();

        if (run.new_found || run.closed) {
            console.log(`[ats-mirror] ${row.family}/${row.board_key}: ${run.jobs_listed} listed, `
                + `${run.new_found} new, ${run.ingested} ingested, ${run.duplicates} already held, `
                + `${run.queued} queued, ${run.closed} closed${live ? '' : ' (observe)'}`);
        }
        return { ...run };
    } catch (err) {
        // Anything unexpected is still a failed poll of ONE board.
        return fail(err);
    }
};
