/**
 * CONSULTANT self-service portal.
 *
 * Every query filters by req.user.id — never by an id from the URL or body.
 * A consultant can only ever see themselves.
 */
import { query } from '../db.js';

/** GET /api/portal/me */
export const myProfile = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT u.id, u.name, u.email, u.phone, u.role, u.is_active,
                    u.last_login_at, u.created_at,
                    o.name AS organization_name,
                    r.name AS recruiter_name, r.email AS recruiter_email,
                    a.effective_from AS assigned_since
               FROM users u
               JOIN organizations o ON o.id = u.organization_id
          LEFT JOIN assignments a
                 ON a.consultant_id = u.id AND a.effective_to IS NULL
          LEFT JOIN users r ON r.id = a.recruiter_id
              WHERE u.id = $1 AND u.organization_id = $2`,
            [req.user.id, req.user.orgId],
        );

        if (!rows[0]) return res.status(404).json({ error: 'Profile not found.' });
        return res.json({ profile: rows[0] });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/portal/dashboard
 * Placeholder counters — queue, applications and unknowns arrive in a later
 * phase. Present now so the portal shell has something real to render.
 */
export const myDashboard = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT r.name AS recruiter_name
               FROM assignments a
               JOIN users r ON r.id = a.recruiter_id
              WHERE a.consultant_id = $1
                AND a.organization_id = $2
                AND a.effective_to IS NULL`,
            [req.user.id, req.user.orgId],
        );

        return res.json({
            dashboard: {
                recruiterName: rows[0]?.recruiter_name ?? null,
                queuedJobs: 0,
                pendingAnswers: 0,
                applicationsSubmitted: 0,
            },
        });
    } catch (err) {
        return next(err);
    }
};
