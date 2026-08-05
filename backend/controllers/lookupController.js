/**
 * GET /api/lookups
 * Every lookup table in ONE call, for any authenticated user.
 * The client fetches this once at login and caches it.
 */
import { query } from '../db.js';

export const getLookups = async (req, res, next) => {
    try {
        const [
            genders, userStatuses, workAuth, roles, workTypes,
            answerStatuses, questionCategories,
        ] = await Promise.all([
            query('SELECT id, name FROM lkp_genders ORDER BY id'),
            query('SELECT id, name, label FROM lkp_user_statuses ORDER BY id'),
            query('SELECT id, name FROM lkp_work_auth_statuses ORDER BY id'),
            query('SELECT id, name, label FROM lkp_roles ORDER BY id'),
            query('SELECT id, name, label FROM lkp_work_types ORDER BY id'),
            query('SELECT id, name, label FROM lkp_answer_statuses ORDER BY id'),
            query(`SELECT id, name, label, requires_owner_approval, description
                     FROM lkp_question_categories ORDER BY id`),
        ]);

        return res.json({
            genders: genders.rows,
            userStatuses: userStatuses.rows,
            workAuthStatuses: workAuth.rows,
            roles: roles.rows,
            workTypes: workTypes.rows,
            answerStatuses: answerStatuses.rows,
            questionCategories: questionCategories.rows,
        });
    } catch (err) {
        return next(err);
    }
};
