/**
 * ── THE ATS LIVE MIRROR, FROM THE UI ──────────────────────────────────
 *
 * The operator surface for the fourth ingestion door:
 *
 *   SerpApi    POST /api/management/discovery/run
 *   JobsPipe   POST /api/management/jobspipe/poll
 *   ATS mirror /api/management/ats/*                    (this file)
 *
 * Unlike the first two it spends no credits — the employers' endpoints are free
 * — so there is no budget to guard. What there IS to guard is reach: this door
 * can put jobs in front of consultants faster than any other, so the controls
 * that matter are the agency switch, the OBSERVE/LIVE mode, and per-poll bounds.
 *
 * Reading is management; changing anything is ORG_ADMIN, and every change is
 * audited under module 'ats'.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────
 *
 * No route moves a job into a queue by hand. A job reaches a consultant only
 * through `ingestAdapted`, exactly as for every other door, so R-03 ("there is
 * nothing to call") holds for this door too.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { logAction } from './auditLogController.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { detectBoard } from '../connectors/ats/detect.js';
import { probeBoard, withConfig } from '../connectors/ats/index.js';
import { getOrCreateSettings } from '../services/atsPoller.js';
import {
    mineExistingPostings, guessBatch, countCompanies,
} from '../services/atsDiscover.js';
import { http, claimOne, pollClaimed } from '../jobs/atsMirror.js';
import { describeInterval, tierOf, floorFor } from '../config/atsSchedule.js';

const SERVER_LOOP = () => process.env.ATS_MIRROR_ENABLED === 'true';

/* ── schemas ──────────────────────────────────────────────────────────── */

const companyName = Joi.string().trim().min(1).max(255);

export const settingsSchema = Joi.object({
    isEnabled: Joi.boolean(),
    mode: Joi.string().valid('OBSERVE', 'LIVE'),
    minIntervalS: Joi.number().integer().min(60).max(86_400),
    maxIntervalS: Joi.number().integer().min(300).max(604_800),
    bootstrapAgeHours: Joi.number().integer().min(0).max(720),
    maxIngestPerPoll: Joi.number().integer().min(1).max(500),
    detailCapPerPoll: Joi.number().integer().min(1).max(200),
    closeOnRemoval: Joi.boolean(),
}).min(1);

export const probeSchema = Joi.object({
    input: Joi.string().trim().min(3).max(500).required(),
});

export const addBoardSchema = Joi.object({
    input: Joi.string().trim().min(3).max(500).required(),
    companyName: companyName.allow('', null),
    isPriority: Joi.boolean().default(false),
});

export const bulkSchema = Joi.object({
    items: Joi.array().items(Joi.object({
        input: Joi.string().trim().min(3).max(500).required(),
        companyName: companyName.allow('', null),
    })).min(1).max(300).required(),
});

export const patchBoardSchema = Joi.object({
    isEnabled: Joi.boolean(),
    isPriority: Joi.boolean(),
    companyName: companyName,
}).min(1);

export const guessSchema = Joi.object({
    offset: Joi.number().integer().min(0).default(0),
    limit: Joi.number().integer().min(1).max(15).default(8),
});

/* ── helpers ──────────────────────────────────────────────────────────── */

const probeCtx = () => ({ http, now: new Date() });

const familyByName = async (name) => {
    const { rows } = await query('SELECT * FROM lkp_ats_families WHERE name = $1', [name]);
    return rows[0] ?? null;
};

const audit = (req, action, entityId, entityName, description) => logAction({
    orgId: req.user.orgId, module: 'ats', action, entityType: 'AtsBoard',
    entityId, entityName, performedBy: req.user.id, performedByRole: req.user.role,
    description, ipAddress: req.ip,
}).catch(() => {});

/** A board row as the screen wants it: schedule described, tier derived. */
const shapeBoard = (b) => ({
    id: b.id,
    family: b.family,
    familyLabel: b.family_label,
    boardKey: b.board_key,
    companyName: b.company_name,
    // A board with no real name cannot feed queues: see services/atsPoller.js.
    needsCompanyName: !b.company_name,
    careersUrl: b.careers_url,
    isEnabled: b.is_enabled,
    isPriority: b.is_priority,
    status: b.status,
    intervalS: b.interval_s,
    cadence: describeInterval(b.interval_s),
    tier: tierOf(b.interval_s, floorFor({
        minIntervalS: b.settings_min_interval_s, familyMinS: b.family_min_interval_s, isPriority: b.is_priority,
    })),
    nextPollAt: b.next_poll_at,
    lastPolledAt: b.last_polled_at,
    lastSuccessAt: b.last_success_at,
    lastChangedAt: b.last_changed_at,
    lastError: b.last_error,
    baselinedAt: b.baselined_at,
    jobsOpen: b.jobs_open,
    jobsDetected: b.jobs_detected,
    jobsIngested: b.jobs_ingested,
    jobsQueued: b.jobs_queued,
});

const BOARD_COLUMNS = `
    b.*, f.name AS family, f.label AS family_label, f.min_interval_s AS family_min_interval_s,
    COALESCE(s.min_interval_s, 120) AS settings_min_interval_s`;

const BOARD_FROM = `
    FROM ats_boards b
    JOIN lkp_ats_families f ON f.id = b.family_id
    LEFT JOIN ats_org_settings s ON s.organization_id = b.organization_id`;

const loadBoard = async (orgId, id) => {
    const { rows } = await query(
        `SELECT ${BOARD_COLUMNS} ${BOARD_FROM} WHERE b.id = $1 AND b.organization_id = $2`,
        [id, orgId],
    );
    return rows[0] ?? null;
};

const settingsView = (s) => ({
    isEnabled: s.is_enabled,
    mode: s.mode,
    minIntervalS: s.min_interval_s,
    maxIntervalS: s.max_interval_s,
    bootstrapAgeHours: s.bootstrap_age_hours,
    maxIngestPerPoll: s.max_ingest_per_poll,
    detailCapPerPoll: s.detail_cap_per_poll,
    closeOnRemoval: s.close_on_removal,
    updatedAt: s.updated_at,
});

/* ── overview ─────────────────────────────────────────────────────────── */

/** GET /api/management/ats */
export const getOverview = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const settings = await getOrCreateSettings(orgId);

        const [families, byStatus, last24h, latency, covered] = await Promise.all([
            query('SELECT id, name, label, min_interval_s, supports_etag FROM lkp_ats_families ORDER BY sort_order'),
            query(
                `SELECT status, count(*)::int AS n, COALESCE(sum(jobs_open),0)::int AS jobs
                   FROM ats_boards WHERE organization_id = $1 GROUP BY status`,
                [orgId],
            ),
            query(
                `SELECT count(*)::int AS polls,
                        count(*) FILTER (WHERE outcome = 'NOT_MODIFIED')::int AS not_modified,
                        count(*) FILTER (WHERE outcome IN ('ERROR','NOT_FOUND'))::int AS errors,
                        COALESCE(sum(new_found),0)::int AS new_jobs,
                        COALESCE(sum(ingested),0)::int AS ingested,
                        COALESCE(sum(queued),0)::int AS queued,
                        COALESCE(round(avg(duration_ms)),0)::int AS avg_ms,
                        COALESCE(sum(bytes),0)::bigint AS bytes
                   FROM ats_poll_runs
                  WHERE organization_id = $1 AND started_at > now() - interval '24 hours'`,
                [orgId],
            ),
            // THE number: seconds from the employer publishing to us noticing.
            // Only real measurements — baseline and day-precision rows are NULL.
            query(
                `SELECT count(*)::int AS n,
                        percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_s) AS p50,
                        percentile_cont(0.9) WITHIN GROUP (ORDER BY latency_s) AS p90
                   FROM ats_board_jobs
                  WHERE organization_id = $1 AND latency_s IS NOT NULL
                    AND first_seen_at > now() - interval '7 days'`,
                [orgId],
            ),
            query(
                `SELECT count(DISTINCT company)::int AS companies FROM job_postings WHERE organization_id = $1`,
                [orgId],
            ),
        ]);

        const status = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
        const l = latency.rows[0];
        const a = last24h.rows[0];

        return res.json({
            settings: settingsView(settings),
            serverLoopRunning: SERVER_LOOP(),
            families: families.rows,
            boards: {
                total: Object.values(status).reduce((n, x) => n + x, 0),
                byStatus: status,
                jobsOpen: byStatus.rows.reduce((n, r) => n + r.jobs, 0),
            },
            last24h: {
                polls: a.polls,
                notModified: a.not_modified,
                // Share of polls that were free 304s: the number that says
                // whether minute-level polling is affordable.
                notModifiedShare: a.polls ? Math.round((a.not_modified / a.polls) * 100) : 0,
                errors: a.errors,
                newJobs: a.new_jobs,
                ingested: a.ingested,
                queued: a.queued,
                avgDurationMs: a.avg_ms,
                megabytes: Math.round(Number(a.bytes) / 1_048_576 * 10) / 10,
            },
            latency: {
                measured: l.n,
                medianSeconds: l.p50 === null ? null : Math.round(l.p50),
                p90Seconds: l.p90 === null ? null : Math.round(l.p90),
            },
            poolCompanies: covered.rows[0].companies,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── settings ─────────────────────────────────────────────────────────── */

/** PATCH /api/management/ats/settings — ORG_ADMIN */
export const updateSettings = async (req, res, next) => {
    try {
        const current = await getOrCreateSettings(req.user.orgId);
        const b = req.body;

        const next_ = {
            is_enabled: b.isEnabled ?? current.is_enabled,
            mode: b.mode ?? current.mode,
            min_interval_s: b.minIntervalS ?? current.min_interval_s,
            max_interval_s: b.maxIntervalS ?? current.max_interval_s,
            bootstrap_age_hours: b.bootstrapAgeHours ?? current.bootstrap_age_hours,
            max_ingest_per_poll: b.maxIngestPerPoll ?? current.max_ingest_per_poll,
            detail_cap_per_poll: b.detailCapPerPoll ?? current.detail_cap_per_poll,
            close_on_removal: b.closeOnRemoval ?? current.close_on_removal,
        };

        if (next_.min_interval_s > next_.max_interval_s) {
            return res.status(422).json({ error: 'The minimum interval cannot exceed the maximum.' });
        }

        const { rows } = await query(
            `UPDATE ats_org_settings
                SET is_enabled = $2, mode = $3, min_interval_s = $4, max_interval_s = $5,
                    bootstrap_age_hours = $6, max_ingest_per_poll = $7,
                    detail_cap_per_poll = $8, close_on_removal = $9, updated_by = $10
              WHERE organization_id = $1
          RETURNING *`,
            [req.user.orgId, next_.is_enabled, next_.mode, next_.min_interval_s, next_.max_interval_s,
                next_.bootstrap_age_hours, next_.max_ingest_per_poll, next_.detail_cap_per_poll,
                next_.close_on_removal, req.user.id],
        );

        const changes = Object.entries(next_)
            .filter(([k, v]) => v !== current[k])
            .map(([k, v]) => `${k}=${v}`);
        await audit(req, 'ATS settings changed', req.user.orgId, 'ATS live mirror', changes.join(', ') || 'no change');

        return res.json({ settings: settingsView(rows[0]) });
    } catch (err) {
        return next(err);
    }
};

/* ── the registry ─────────────────────────────────────────────────────── */

const BOARD_SORTS = {
    activity: 'b.last_changed_at DESC NULLS LAST',
    name: 'lower(COALESCE(b.company_name, b.board_key))',
    jobs: 'b.jobs_open DESC',
    polled: 'b.last_polled_at DESC NULLS LAST',
};

/** GET /api/management/ats/boards?search=&status=&family=&sort=&page=&limit= */
export const listBoards = async (req, res, next) => {
    try {
        const paging = readPaging(req);
        const params = [req.user.orgId];
        const where = ['b.organization_id = $1'];

        const search = (req.query.search ?? '').trim();
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            where.push(`(lower(b.board_key) LIKE $${params.length} OR lower(COALESCE(b.company_name,'')) LIKE $${params.length})`);
        }
        if (req.query.status) { params.push(String(req.query.status)); where.push(`b.status = $${params.length}`); }
        if (req.query.family) { params.push(String(req.query.family)); where.push(`f.name = $${params.length}`); }
        if (req.query.needsName === 'true') where.push('b.company_name IS NULL');

        params.push(paging.limit, paging.offset);
        const order = BOARD_SORTS[req.query.sort] ?? BOARD_SORTS.activity;

        const { rows } = await query(
            `SELECT ${BOARD_COLUMNS}, count(*) OVER () AS total_count
               ${BOARD_FROM}
              WHERE ${where.join(' AND ')}
              ORDER BY ${order}, b.id
              LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
        );
        const page = pageResult(rows, paging);
        return res.json({ ...page, data: page.data.map(shapeBoard) });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/ats/boards/:id */
export const getBoard = async (req, res, next) => {
    try {
        const board = await loadBoard(req.user.orgId, req.params.id);
        if (!board) return res.status(404).json({ error: 'Board not found.' });

        const [runs, jobs] = await Promise.all([
            query(
                `SELECT started_at, trigger, outcome, http_status, bytes, duration_ms, jobs_listed,
                        new_found, ingested, duplicates, queued, closed, error
                   FROM ats_poll_runs WHERE board_id = $1 ORDER BY started_at DESC LIMIT 20`,
                [board.id],
            ),
            query(
                `SELECT ext_id, title, location_text, state, published_at, first_seen_at, latency_s,
                        matches, queued, closed_at, source_url
                   FROM ats_board_jobs WHERE board_id = $1 AND state <> 'BASELINE'
                  ORDER BY first_seen_at DESC LIMIT 20`,
                [board.id],
            ),
        ]);
        return res.json({ board: shapeBoard(board), runs: runs.rows, jobs: jobs.rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/ats/probe — reads a board, writes NOTHING.
 *
 * What "Verify" calls before a board is saved: the address is real if it
 * answers, and the right company if the sample titles look like theirs.
 */
export const probe = async (req, res, next) => {
    try {
        const detected = detectBoard(req.body.input);
        if (!detected) {
            return res.status(422).json({
                error: 'That is not a Greenhouse, Lever, Ashby, Workday or SmartRecruiters careers link.',
            });
        }

        const result = await probeBoard(
            withConfig({ family: detected.family, board_key: detected.key, config: detected.config, company_name: null }),
            probeCtx(),
        );
        if (!result.ok) {
            return res.status(result.notFound ? 404 : 502).json({
                error: result.notFound
                    ? `No ${detected.family.toLowerCase()} board exists at "${detected.key}".`
                    : `Could not read that board right now: ${result.error}`,
            });
        }

        const family = await familyByName(detected.family);
        const { rows: existing } = await query(
            'SELECT id FROM ats_boards WHERE organization_id = $1 AND family_id = $2 AND board_key = $3',
            [req.user.orgId, family.id, detected.key],
        );

        return res.json({
            family: detected.family,
            familyLabel: family.label,
            key: detected.key,
            total: result.total,
            sample: result.sample,
            // Greenhouse and SmartRecruiters state it; the rest need a person.
            suggestedCompanyName: result.companyName ?? null,
            needsCompanyName: !result.companyName,
            alreadyRegistered: existing[0]?.id ?? null,
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/ats/boards — ORG_ADMIN. Verifies, saves, baselines at once. */
export const addBoard = async (req, res, next) => {
    try {
        const detected = detectBoard(req.body.input);
        if (!detected) return res.status(422).json({ error: 'That is not a recognised careers link.' });

        const family = await familyByName(detected.family);
        if (!family) return res.status(422).json({ error: `${detected.family} is not supported.` });

        const probeResult = await probeBoard(
            withConfig({ family: detected.family, board_key: detected.key, config: detected.config, company_name: null }),
            probeCtx(),
        );
        if (!probeResult.ok) {
            return res.status(probeResult.notFound ? 404 : 502).json({
                error: probeResult.notFound
                    ? `No board exists at "${detected.key}".`
                    : `Could not read that board right now: ${probeResult.error}`,
            });
        }

        const name = (req.body.companyName ?? '').trim() || probeResult.companyName;
        if (!name) {
            return res.status(422).json({
                error: `${family.label} does not say which company this is. Enter the company name `
                    + '— it is what stops the same job being queued twice when another source also finds it.',
                needsCompanyName: true,
            });
        }

        const id = uuidv4();
        const { rowCount } = await query(
            `INSERT INTO ats_boards
                (id, organization_id, family_id, board_key, config, company_name, careers_url,
                 is_priority, status, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)
             ON CONFLICT (organization_id, family_id, board_key) DO NOTHING`,
            [id, req.user.orgId, family.id, detected.key, JSON.stringify(detected.config), name,
                String(req.body.input).startsWith('http') ? String(req.body.input).slice(0, 500) : null,
                req.body.isPriority, req.user.id],
        );
        if (rowCount === 0) return res.status(409).json({ error: 'That board is already in the registry.' });

        await audit(req, 'ATS board added', id, `${name} (${family.label})`,
            `${detected.family}/${detected.key}, ${probeResult.total} open job(s)`);

        // Read it immediately so the first thing the operator sees is real.
        const settings = await getOrCreateSettings(req.user.orgId);
        const claimed = await claimOne(id, req.user.orgId);
        const run = claimed ? await pollClaimed(claimed, settings, { trigger: 'ADD' }) : null;

        return res.status(201).json({ board: shapeBoard(await loadBoard(req.user.orgId, id)), firstPoll: run });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/ats/boards/bulk — ORG_ADMIN.
 *
 * Does NOT probe: 200 sequential probes would outlast any HTTP request. Boards
 * go in as PENDING and the scheduler baselines them over the next minutes; one
 * that does not exist simply fails its first poll and is parked.
 */
export const addBoardsBulk = async (req, res, next) => {
    try {
        const families = new Map((await query('SELECT id, name FROM lkp_ats_families')).rows.map((f) => [f.name, f.id]));
        const results = [];

        for (const item of req.body.items) {
            const d = detectBoard(item.input);
            if (!d) { results.push({ input: item.input, result: 'invalid' }); continue; }

            const { rowCount } = await query(
                `INSERT INTO ats_boards
                    (id, organization_id, family_id, board_key, config, company_name, careers_url, status, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)
                 ON CONFLICT (organization_id, family_id, board_key) DO NOTHING`,
                [uuidv4(), req.user.orgId, families.get(d.family), d.key, JSON.stringify(d.config),
                    (item.companyName ?? '').trim() || null,
                    item.input.startsWith('http') ? item.input.slice(0, 500) : null, req.user.id],
            );
            results.push({
                input: item.input, family: d.family, key: d.key,
                result: rowCount ? 'added' : 'exists',
            });
        }

        const added = results.filter((r) => r.result === 'added').length;
        await audit(req, 'ATS boards added in bulk', null, 'ATS live mirror',
            `${added} added, ${results.filter((r) => r.result === 'exists').length} already present, `
            + `${results.filter((r) => r.result === 'invalid').length} unrecognised`);

        return res.status(201).json({ added, results });
    } catch (err) {
        return next(err);
    }
};

/** PATCH /api/management/ats/boards/:id — ORG_ADMIN */
export const patchBoard = async (req, res, next) => {
    try {
        const board = await loadBoard(req.user.orgId, req.params.id);
        if (!board) return res.status(404).json({ error: 'Board not found.' });
        const b = req.body;

        await query(
            `UPDATE ats_boards
                SET is_enabled = $2, is_priority = $3, company_name = $4,
                    -- re-enabling a parked board gives it a fresh start
                    status = CASE WHEN $2 AND status = 'NOT_FOUND' THEN 'PENDING' ELSE status END,
                    consecutive_not_found = CASE WHEN $2 AND status = 'NOT_FOUND' THEN 0 ELSE consecutive_not_found END,
                    next_poll_at = CASE WHEN $2 AND NOT is_enabled THEN now() ELSE next_poll_at END
              WHERE id = $1`,
            [board.id, b.isEnabled ?? board.is_enabled, b.isPriority ?? board.is_priority,
                b.companyName ?? board.company_name],
        );
        await audit(req, 'ATS board updated', board.id, board.company_name ?? board.board_key,
            Object.entries(b).map(([k, v]) => `${k}=${v}`).join(', '));

        return res.json({ board: shapeBoard(await loadBoard(req.user.orgId, board.id)) });
    } catch (err) {
        return next(err);
    }
};

/**
 * DELETE /api/management/ats/boards/:id — ORG_ADMIN.
 *
 * Removes the board and what we remembered about it. Postings it already
 * produced stay: they are real jobs in the pool and may have queue items.
 */
export const deleteBoard = async (req, res, next) => {
    try {
        const board = await loadBoard(req.user.orgId, req.params.id);
        if (!board) return res.status(404).json({ error: 'Board not found.' });

        await query('DELETE FROM ats_boards WHERE id = $1 AND organization_id = $2', [board.id, req.user.orgId]);
        await audit(req, 'ATS board removed', board.id, board.company_name ?? board.board_key,
            `${board.family}/${board.board_key}; ${board.jobs_ingested} posting(s) it produced were kept`);
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/ats/boards/:id/poll — ORG_ADMIN. Read this board now. */
export const pollNow = async (req, res, next) => {
    try {
        const board = await loadBoard(req.user.orgId, req.params.id);
        if (!board) return res.status(404).json({ error: 'Board not found.' });

        const settings = await getOrCreateSettings(req.user.orgId);
        const claimed = await claimOne(board.id, req.user.orgId);
        if (!claimed) return res.status(409).json({ error: 'That board is being read right now. Try again in a moment.' });

        const run = await pollClaimed(claimed, settings, { trigger: 'MANUAL' });
        return res.json({ run, board: shapeBoard(await loadBoard(req.user.orgId, board.id)) });
    } catch (err) {
        return next(err);
    }
};

/* ── the live feed ────────────────────────────────────────────────────── */

/**
 * GET /api/management/ats/jobs?state=&boardId=&limit=
 *
 * What the mirror has noticed, newest first, with how long it took. BASELINE
 * rows are the board's existing stock, not news, and are never listed.
 */
export const listDetected = async (req, res, next) => {
    try {
        const params = [req.user.orgId];
        const where = ["j.organization_id = $1", "j.state <> 'BASELINE'"];
        if (req.query.state) { params.push(String(req.query.state)); where.push(`j.state = $${params.length}`); }
        if (req.query.boardId) { params.push(String(req.query.boardId)); where.push(`j.board_id = $${params.length}`); }
        params.push(Math.min(Number(req.query.limit) || 50, 200));

        const { rows } = await query(
            `SELECT j.ext_id, j.title, j.location_text, j.state, j.published_at, j.first_seen_at,
                    j.latency_s, j.matches, j.queued, j.closed_at, j.source_url, j.posting_id,
                    b.id AS board_id, COALESCE(b.company_name, b.board_key) AS company,
                    f.name AS family, f.label AS family_label
               FROM ats_board_jobs j
               JOIN ats_boards b ON b.id = j.board_id
               JOIN lkp_ats_families f ON f.id = b.family_id
              WHERE ${where.join(' AND ')}
              ORDER BY j.first_seen_at DESC
              LIMIT $${params.length}`,
            params,
        );
        return res.json({ jobs: rows });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/ats/runs?limit= */
export const listRuns = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT r.started_at, r.trigger, r.outcome, r.http_status, r.bytes, r.duration_ms,
                    r.jobs_listed, r.new_found, r.ingested, r.duplicates, r.queued, r.closed, r.error,
                    b.id AS board_id, COALESCE(b.company_name, b.board_key) AS company, f.label AS family_label
               FROM ats_poll_runs r
               JOIN ats_boards b ON b.id = r.board_id
               JOIN lkp_ats_families f ON f.id = b.family_id
              WHERE r.organization_id = $1
              ORDER BY r.started_at DESC
              LIMIT $2`,
            [req.user.orgId, Math.min(Number(req.query.limit) || 50, 200)],
        );
        return res.json({ runs: rows });
    } catch (err) {
        return next(err);
    }
};

/* ── discovery ────────────────────────────────────────────────────────── */

/** GET /api/management/ats/discover/postings — boards implied by postings we hold. */
export const discoverFromPostings = async (req, res, next) => {
    try {
        return res.json({ candidates: await mineExistingPostings(req.user.orgId) });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/ats/discover/companies — one batch of the company scan. */
export const discoverFromCompanies = async (req, res, next) => {
    try {
        const { offset, limit } = req.body;
        const [batch, total] = await Promise.all([
            guessBatch(req.user.orgId, { offset, limit, ctx: probeCtx() }),
            countCompanies(req.user.orgId),
        ]);
        return res.json({ ...batch, totalCompanies: total });
    } catch (err) {
        return next(err);
    }
};
