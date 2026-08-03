/**
 * CONSULTANT self-service portal.
 *
 * Every query filters by req.user.id — never by an id from the URL or body.
 * A consultant can only ever see themselves.
 *
 * NOTE: `GET /api/portal/me` lives in profileController.myProfile, because it
 * has to return the live profile, the pending change request, and the last
 * review outcome together. This file holds only what is unrelated to that.
 */
import { query } from '../db.js';

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
