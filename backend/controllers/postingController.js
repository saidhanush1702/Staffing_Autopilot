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
    maxPages: Joi.number().integer().min(1).max(20),
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

        const [queue, held] = await Promise.all([
            query(
                `SELECT q.id, q.is_overlap, q.queued_at, q.skip_reason, q.park_reason,
                        st.name AS status_name, st.label AS status_label,
                        p.id AS posting_id, p.company, p.title, p.location_text,
                        p.is_remote, p.source_url,
                        p.pay_min, p.pay_max, p.pay_unit,
                        m.score, m.reason,
                        v.version_no AS criteria_version_no,
                        src.label AS source_label
                   FROM queue_items q
                   JOIN lkp_queue_statuses st ON st.id = q.status_id
                   JOIN job_postings p ON p.id = q.posting_id
              LEFT JOIN job_matches m ON m.id = q.match_id
              LEFT JOIN search_criteria_versions v ON v.id = m.criteria_version_id
              LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
                  WHERE q.consultant_id = $1 AND q.organization_id = $2
                  ORDER BY q.queued_at DESC`,
                [req.params.id, req.user.orgId],
            ),
            // Matched but over the daily cap. Shown so a recruiter can see that
            // work is waiting rather than assuming discovery found nothing.
            query(
                `SELECT m.id, m.score, m.reason, m.matched_at,
                        p.company, p.title, p.location_text, p.source_url
                   FROM job_matches m
                   JOIN job_postings p ON p.id = m.posting_id
                  WHERE m.consultant_id = $1 AND m.organization_id = $2
                    AND m.status IN ('HELD', 'PENDING')
                  ORDER BY m.score DESC
                  LIMIT 50`,
                [req.params.id, req.user.orgId],
            ),
        ]);

        const { rows: capRows } = await query(
            `SELECT p.daily_cap,
                    (SELECT COUNT(*)::int FROM queue_items q
                      WHERE q.consultant_id = $1 AND q.queued_at::date = CURRENT_DATE) AS used_today
               FROM consultant_profiles p WHERE p.user_id = $1`,
            [req.params.id],
        );

        return res.json({
            queue: queue.rows,
            held: held.rows,
            cap: capRows[0] ?? { daily_cap: 0, used_today: 0 },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PATCH /api/management/discovery/sources/:id — ORG_ADMIN only.
 *
 * Enabling a board is the moment this system starts reaching out to the open
 * web, so it is a deliberate, audited act rather than a config file nobody
 * reads.
 */
export const updateSource = async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT id, name, label, is_enabled FROM lkp_job_sources WHERE id = $1',
            [req.params.id],
        );
        const source = rows[0];
        if (!source) return res.status(404).json({ error: 'Source not found.' });

        if (source.name === 'MANUAL' || source.name === 'CSV') {
            return res.status(409).json({
                error: 'Manual and CSV sources are never fetched, so they cannot be enabled.',
            });
        }

        await query(
            `UPDATE lkp_job_sources
                SET is_enabled    = COALESCE($1, is_enabled),
                    rate_limit_ms = COALESCE($2, rate_limit_ms),
                    max_pages     = COALESCE($3, max_pages),
                    -- turning a board back on clears the old failure streak so
                    -- health reflects the new attempt, not the last outage
                    consecutive_failures = CASE WHEN $1 IS TRUE THEN 0 ELSE consecutive_failures END,
                    last_error = CASE WHEN $1 IS TRUE THEN NULL ELSE last_error END
              WHERE id = $4`,
            [req.body.isEnabled ?? null, req.body.rateLimitMs ?? null,
                req.body.maxPages ?? null, source.id],
        );

        if (req.body.isEnabled !== undefined && req.body.isEnabled !== source.is_enabled) {
            logAction({
                orgId: req.user.orgId, module: 'discovery',
                action: req.body.isEnabled ? 'Enabled Source' : 'Disabled Source',
                entityType: 'JobSource', entityId: String(source.id), entityName: source.label,
                performedBy: req.user.id, performedByRole: req.user.role,
                description: `${req.body.isEnabled ? 'Enabled' : 'Disabled'} job board "${source.label}"`,
                ipAddress: req.ip,
            }).catch(() => {});
        }

        return res.json({ message: 'Source updated.' });
    } catch (err) {
        return next(err);
    }
};
