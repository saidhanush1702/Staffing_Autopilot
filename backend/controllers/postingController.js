/**
 * The posting pool and the queues it feeds. Phase 5, read side.
 *
 * Discovery writes; these endpoints let a person see what it did — which jobs
 * were found, which consultant each was useful for, and why.
 */
import Joi from 'joi';
import { query } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';

export const toggleSourceSchema = Joi.object({
    isEnabled: Joi.boolean(),
    rateLimitMs: Joi.number().integer().min(1000).max(120000),
    // Result pages per search term. Each one is a paid API credit, so the
    // ceiling is deliberately low — 20 pages across 6 terms is 120 credits per
    // run, which on most plans is a day's budget in a single cycle.
    maxPages: Joi.number().integer().min(1).max(10),
}).min(1);

/** GET /api/management/postings */
export const listPostings = async (req, res, next) => {
    try {
        const search = (req.query.search ?? '').trim() || null;
        const sourceId = req.query.sourceId ? Number(req.query.sourceId) : null;
        const limit = Math.min(Number(req.query.limit ?? 50), 200);

        const { rows } = await query(
            `SELECT p.id, p.company, p.title, p.location_text, p.is_remote,
                    p.source_url, p.pay_min, p.pay_max, p.pay_unit, p.pay_currency,
                    p.first_seen_at, p.last_seen_at, p.times_seen, p.posted_at,
                    w.label AS work_type_label,
                    s.label AS source_label, s.name AS source_name,
                    (SELECT COUNT(*)::int FROM queue_items q WHERE q.posting_id = p.id) AS queued_count,
                    (SELECT COUNT(*)::int FROM job_matches m WHERE m.posting_id = p.id) AS match_count
               FROM job_postings p
          LEFT JOIN lkp_work_types w  ON w.id = p.work_type_id
          LEFT JOIN lkp_job_sources s ON s.id = p.first_source_id
              WHERE p.organization_id = $1
                AND ($2::text IS NULL OR p.company ILIKE '%' || $2 || '%'
                                      OR p.title   ILIKE '%' || $2 || '%')
                AND ($3::int IS NULL OR p.first_source_id = $3)
              ORDER BY p.first_seen_at DESC
              LIMIT $4`,
            [req.user.orgId, search, sourceId, limit],
        );
        return res.json({ postings: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/postings/:id
 * The posting, everywhere it was seen, and who it matched.
 */
export const getPosting = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT p.*, w.label AS work_type_label, s.label AS source_label
               FROM job_postings p
          LEFT JOIN lkp_work_types w  ON w.id = p.work_type_id
          LEFT JOIN lkp_job_sources s ON s.id = p.first_source_id
              WHERE p.id = $1 AND p.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        const posting = rows[0];
        if (!posting) return res.status(404).json({ error: 'Posting not found.' });

        const [sightings, matches] = await Promise.all([
            query(
                `SELECT g.seen_at, g.source_url, s.label AS source_label
                   FROM job_posting_sightings g
                   JOIN lkp_job_sources s ON s.id = g.source_id
                  WHERE g.posting_id = $1 ORDER BY g.seen_at DESC LIMIT 25`,
                [posting.id],
            ),
            query(
                `SELECT m.score, m.reason, m.status, m.matched_at,
                        u.name AS consultant_name, u.id AS consultant_id,
                        v.version_no AS criteria_version_no
                   FROM job_matches m
                   JOIN users u ON u.id = m.consultant_id
              LEFT JOIN search_criteria_versions v ON v.id = m.criteria_version_id
                  WHERE m.posting_id = $1
                  ORDER BY m.score DESC`,
                [posting.id],
            ),
        ]);

        return res.json({
            posting,
            sightings: sightings.rows,
            matches: matches.rows,
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/consultants/:id/queue
 *
 * The answer to "which jobs are useful for this person, and why" — each item
 * carries the score, the reason, and the criteria version that matched it.
 */
export const listConsultantQueue = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }

        // ── why this is filtered by default ───────────────────────────
        //
        // The cap now gates promotion to READY rather than queue creation, so
        // EVERY match becomes a queue item and the surplus waits at QUEUED. A
        // busy consultant can therefore have hundreds of them, and an unfiltered
        // list buries the handful that actually need a person in a wall of
        // items nobody can act on yet.
        //
        // `?status=ALL` is still available for anyone who wants the whole thing.
        const ACTIONABLE = ['READY', 'FILLING', 'PARKED_UNKNOWN', 'AWAITING_REVIEW'];
        const statusFilter = (req.query.status ?? '').toUpperCase();
        const wantAll = statusFilter === 'ALL';
        const statuses = wantAll ? null
            : (statusFilter ? [statusFilter] : ACTIONABLE);
        const limit = Math.min(Number(req.query.limit ?? 100), 500);

        const [queue, held] = await Promise.all([
            query(
                `SELECT q.id, q.is_overlap, q.queued_at, q.skip_reason, q.park_reason,
                        st.name AS status_name, st.label AS status_label,
                        p.id AS posting_id, p.company, p.title, p.location_text,
                        p.is_remote, p.source_url,
                        p.pay_min, p.pay_max, p.pay_unit,
                        m.score, m.reason,
                        v.version_no AS criteria_version_no,
                        src.label AS source_label,
                        q.channel,
                        COUNT(*) OVER () AS total_count
                   FROM queue_items q
                   JOIN lkp_queue_statuses st ON st.id = q.status_id
                   JOIN job_postings p ON p.id = q.posting_id
              LEFT JOIN job_matches m ON m.id = q.match_id
              LEFT JOIN search_criteria_versions v ON v.id = m.criteria_version_id
              LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
                  WHERE q.consultant_id = $1 AND q.organization_id = $2
                    AND ($3::text[] IS NULL OR st.name = ANY($3::text[]))
                  ORDER BY st.sort_order, q.queued_at DESC
                  LIMIT $4`,
                [req.params.id, req.user.orgId, statuses, limit],
            ),
            // Waiting on a cap slot. These are QUEUED items now, not held
            // matches — the cap moved to the readiness gate, so surplus work
            // waits here as a real queue item rather than as a match nobody can
            // see. Shown so a recruiter knows work is waiting rather than
            // assuming discovery found nothing.
            query(
                `SELECT q.id, q.queued_at AS matched_at, q.channel,
                        m.score, m.reason,
                        p.company, p.title, p.location_text, p.source_url
                   FROM queue_items q
                   JOIN lkp_queue_statuses st ON st.id = q.status_id
                   JOIN job_postings p ON p.id = q.posting_id
              LEFT JOIN job_matches m ON m.id = q.match_id
                  WHERE q.consultant_id = $1 AND q.organization_id = $2
                    AND st.name = 'QUEUED'
                  ORDER BY COALESCE(m.score, 0) DESC, q.queued_at ASC
                  LIMIT 50`,
                [req.params.id, req.user.orgId],
            ),
        ]);

        // The cap counts items that reached READY today, in the AGENCY's
        // timezone, and only states that actually hold a slot. Counting
        // `queued_at` would count work that is not yet available to apply to,
        // and the server's date is the wrong day boundary for an offshore bench.
        const { rows: capRows } = await query(
            `SELECT p.daily_cap,
                    (SELECT COUNT(*)::int
                       FROM queue_items q
                       JOIN lkp_queue_statuses st ON st.id = q.status_id
                       JOIN organizations o ON o.id = q.organization_id
                      WHERE q.consultant_id = $1
                        AND q.became_ready_at IS NOT NULL
                        AND (q.became_ready_at AT TIME ZONE COALESCE(o.timezone, $2))::date
                          = (now() AT TIME ZONE COALESCE(o.timezone, $2))::date
                        AND st.name IN ('READY','FILLING','PARKED_UNKNOWN',
                                        'AWAITING_REVIEW','SUBMITTED')) AS used_today
               FROM consultant_profiles p WHERE p.user_id = $1`,
            [req.params.id, process.env.APP_TIMEZONE ?? 'UTC'],
        );

        return res.json({
            queue: queue.rows,
            awaitingCap: held.rows,
            statusFilter: wantAll ? 'ALL' : (statuses ?? []).join(','),
            cap: capRows[0] ?? { daily_cap: 0, used_today: 0 },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PATCH /api/management/discovery/sources/:id — ORG_ADMIN only.
 *
 * Two quite different switches share this route, and the audit description says
 * which one was thrown:
 *
 *   PROVIDER  turning it on is the moment this system starts reaching out to
 *             the network and spending API credits. Deliberate and audited.
 *   PORTAL    an attribution filter. Turning one off makes the pipeline discard
 *             postings from that board at ingest; it contacts nobody.
 */
export const updateSource = async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT id, name, label, is_enabled, fetch_mode FROM lkp_job_sources WHERE id = $1',
            [req.params.id],
        );
        const source = rows[0];
        if (!source) return res.status(404).json({ error: 'Source not found.' });

        if (source.fetch_mode === 'MANUAL' || source.fetch_mode === 'CSV') {
            return res.status(409).json({
                error: 'Manual and CSV sources are never fetched, so they cannot be enabled.',
            });
        }

        const isProvider = source.fetch_mode === 'PROVIDER';

        // max_pages is the provider's page depth. On a portal row it would mean
        // nothing, and silently accepting it would suggest otherwise.
        if (req.body.maxPages !== undefined && !isProvider) {
            return res.status(409).json({
                error: 'Page depth belongs to the search provider, not to an individual board.',
            });
        }

        // ── the two switches write to two different places ────────────
        //
        // A PROVIDER is something this agency pays for, so enabling it — and
        // its pacing, depth and health — belongs to THIS agency's row. Writing
        // it to the shared lookup would switch the provider on for every tenant
        // on the installation and bill them for it.
        //
        // A PORTAL is an attribution filter over results everyone receives, so
        // it stays on the global row.
        let previous = source.is_enabled;

        if (isProvider) {
            const { rows: existing } = await query(
                `SELECT id, is_enabled FROM organization_providers
                  WHERE organization_id = $1 AND source_id = $2`,
                [req.user.orgId, source.id],
            );
            if (existing.length === 0) {
                return res.status(404).json({
                    error: 'This provider is not set up for your organisation.',
                });
            }
            previous = existing[0].is_enabled;

            await query(
                `UPDATE organization_providers
                    SET is_enabled    = COALESCE($1, is_enabled),
                        rate_limit_ms = COALESCE($2, rate_limit_ms),
                        max_pages     = COALESCE($3, max_pages),
                        -- switching a provider back on clears the old failure
                        -- streak, so health reflects the new attempt rather
                        -- than the outage that caused it to be turned off
                        consecutive_failures = CASE WHEN $1 IS TRUE THEN 0 ELSE consecutive_failures END,
                        last_error = CASE WHEN $1 IS TRUE THEN NULL ELSE last_error END
                  WHERE id = $4`,
                [req.body.isEnabled ?? null, req.body.rateLimitMs ?? null,
                    req.body.maxPages ?? null, existing[0].id],
            );
        } else {
            await query(
                `UPDATE lkp_job_sources
                    SET is_enabled    = COALESCE($1, is_enabled),
                        rate_limit_ms = COALESCE($2, rate_limit_ms)
                  WHERE id = $3`,
                [req.body.isEnabled ?? null, req.body.rateLimitMs ?? null, source.id],
            );
        }

        if (req.body.isEnabled !== undefined && req.body.isEnabled !== previous) {
            logAction({
                orgId: req.user.orgId, module: 'discovery',
                action: req.body.isEnabled ? 'Enabled Source' : 'Disabled Source',
                entityType: 'JobSource', entityId: String(source.id), entityName: source.label,
                performedBy: req.user.id, performedByRole: req.user.role,
                description: isProvider
                    ? `${req.body.isEnabled ? 'Switched on' : 'Switched off'} the search `
                        + `provider "${source.label}" — ${req.body.isEnabled
                            ? 'discovery runs will now call the API and spend credits'
                            : 'discovery runs will fetch nothing'}`
                    : `${req.body.isEnabled ? 'Started' : 'Stopped'} accepting postings `
                        + `from "${source.label}"`,
                ipAddress: req.ip,
            }).catch(() => {});
        }

        return res.json({ message: 'Source updated.' });
    } catch (err) {
        return next(err);
    }
};
