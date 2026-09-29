/**
 * ── HOW THIS AGENCY BUILDS RESUMES ────────────────────────────────────
 *
 * Two settings, both owned by the ORG_ADMIN:
 *
 *   resume_source    BASE_RESUME — tailor the file the consultant uploaded
 *                    PROFILE     — build from their structured profile
 *   resume_template  which of the three layouts the agency prints
 *
 * ── WHY THIS IS A SETTING AND NOT A MIGRATION ─────────────────────────
 *
 * Profile-built resumes are better on every axis that matters — nothing is
 * unparseable, the fabrication check compares against fields rather than
 * extracted text, and the layout is chosen for how applicant tracking systems
 * read rather than inherited from whatever the consultant happened to use.
 *
 * But an agency mid-pilot, with consultants who have uploaded resumes and no
 * profiles filled in, would have every application drop to NOT_TAILORED the
 * morning it switched. So the default stays BASE_RESUME and moving is a
 * decision somebody makes when their bench is ready — which is what the
 * readiness count below exists to tell them.
 */
import Joi from 'joi';
import { query } from '../db.js';
import { templateOptions, TEMPLATE_NAMES, DEFAULT_TEMPLATE } from '../config/resumeTemplates.js';
import { logAction } from './auditLogController.js';

export const resumeSettingsSchema = Joi.object({
    resumeSource: Joi.string().valid('BASE_RESUME', 'PROFILE'),
    resumeTemplate: Joi.string().valid(...TEMPLATE_NAMES),
}).min(1);

/**
 * GET /api/management/resume-settings
 *
 * The current settings, the templates available, and — the part that makes
 * this screen worth having — how many consultants could actually produce a
 * resume from their profile today.
 *
 * Without that number, switching to PROFILE mode is a guess. With it, an admin
 * can see "4 of 12 ready" and know exactly what switching would cost them.
 */
export const getResumeSettings = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT resume_source, resume_template FROM organizations WHERE id = $1`,
            [req.user.orgId],
        );
        const org = rows[0] ?? {};

        // Mirrors profileGaps() in services/profileResume.js: a name, at least
        // one skill, and at least one of experience / projects / education.
        // Expressed in SQL here because asking per consultant would be one
        // round trip each for a number shown on a dashboard.
        const { rows: readiness } = await query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (
                    WHERE u.name IS NOT NULL
                      AND EXISTS (SELECT 1 FROM consultant_skills s WHERE s.consultant_id = u.id)
                      AND (   EXISTS (SELECT 1 FROM consultant_experience e WHERE e.consultant_id = u.id)
                           OR EXISTS (SELECT 1 FROM consultant_projects  p WHERE p.consultant_id = u.id)
                           OR EXISTS (SELECT 1 FROM consultant_education d WHERE d.consultant_id = u.id))
                )::int AS ready,
                COUNT(*) FILTER (WHERE cp.base_resume_artifact_id IS NOT NULL)::int AS with_base_resume
               FROM users u
          LEFT JOIN consultant_profiles cp ON cp.user_id = u.id
              WHERE u.organization_id = $1
                AND u.role = 'CONSULTANT'
                AND u.employment_status = 'ACTIVE'`,
            [req.user.orgId],
        );

        return res.json({
            resumeSource: org.resume_source ?? 'BASE_RESUME',
            resumeTemplate: org.resume_template ?? DEFAULT_TEMPLATE,
            templates: templateOptions(),
            readiness: readiness[0] ?? { total: 0, ready: 0, with_base_resume: 0 },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * PATCH /api/management/resume-settings — ORG_ADMIN only.
 *
 * Audited, because it changes what goes out under every consultant's name and
 * "when did our resumes start looking different?" is a question somebody will
 * ask months later.
 *
 * Note what this deliberately does NOT do: it does not re-tailor anything that
 * already exists. A resume that has been generated, reviewed or sent stays as
 * it was — rewriting history to match a setting changed afterwards would make
 * the audit trail describe a document nobody ever sent.
 */
export const updateResumeSettings = async (req, res, next) => {
    try {
        const { rows: before } = await query(
            'SELECT resume_source, resume_template FROM organizations WHERE id = $1',
            [req.user.orgId],
        );

        const { rows } = await query(
            `UPDATE organizations
                SET resume_source   = COALESCE($2, resume_source),
                    resume_template = COALESCE($3, resume_template)
              WHERE id = $1
              RETURNING resume_source, resume_template`,
            [req.user.orgId, req.body.resumeSource ?? null, req.body.resumeTemplate ?? null],
        );

        const now = rows[0];
        const changes = [];
        if (before[0]?.resume_source !== now.resume_source) {
            changes.push(`source ${before[0]?.resume_source} → ${now.resume_source}`);
        }
        if (before[0]?.resume_template !== now.resume_template) {
            changes.push(`template ${before[0]?.resume_template} → ${now.resume_template}`);
        }

        if (changes.length > 0) {
            logAction({
                orgId: req.user.orgId,
                module: 'resumes',
                action: 'Changed Resume Settings',
                entityType: 'Organization',
                entityId: req.user.orgId,
                performedBy: req.user.id,
                performedByRole: req.user.role,
                description: `Resume generation settings changed: ${changes.join('; ')}. `
                    + 'Existing resumes are unaffected; this applies to the next job prepared.',
                ipAddress: req.ip,
            }).catch(() => {});
        }

        return res.json({
            resumeSource: now.resume_source,
            resumeTemplate: now.resume_template,
            changed: changes,
        });
    } catch (err) {
        return next(err);
    }
};
