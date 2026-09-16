/**
 * ── THE CONSULTANT'S CAREER RECORD ────────────────────────────────────
 *
 * Create, edit, reorder and delete the rows a resume is built from:
 * education, work experience, projects, certifications and skills.
 *
 * ── WHY THESE ARE SELF-SERVICE ────────────────────────────────────────
 *
 * Every other change a consultant makes to their profile goes through a
 * recruiter, field by field. These do not, and that is deliberate.
 *
 * The fields that keep their approval — legal name, phone, work authorisation,
 * the consent flag — are ones where the agency carries the consequence of a
 * wrong answer. A consultant's own degree, their own projects and their own
 * certifications are not in that category: they are that person's history,
 * they are the thing an interviewer will ask them about, and routing forty of
 * them through an approval queue would mean onboarding stalls on somebody
 * else's inbox while the bench sits idle.
 *
 * The no-fabrication check is what guards the output, and it guards it far
 * better here than approval would: it compares the generated resume against
 * these rows, so a claim that is not in them cannot survive to a PDF.
 *
 * ── WHY ONE TABLE-DRIVEN CONTROLLER AND NOT FOUR ──────────────────────
 *
 * The four section types differ only in their columns. Written out
 * individually they would be four near-identical files that drift apart — one
 * gets a scope check the others miss, one forgets to stamp organization_id.
 * Declaring the differences as data means the scope check, the ownership check
 * and the audit trail are written once and cannot disagree between sections.
 */
import Joi from 'joi';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { resolveSkill, searchSkills, consultantSkills } from '../config/skills.js';
import { profileResumeReadiness } from '../services/profileResume.js';
import { logAction } from './auditLogController.js';

const text = (max) => Joi.string().trim().max(max).allow('', null).default(null);
const bullets = Joi.array().items(Joi.string().trim().max(2000)).max(20).default([]);

/**
 * Each section: its table, the columns a caller may write, and the shape they
 * must satisfy. Nothing outside this registry reaches the database.
 */
const SECTIONS = {
    education: {
        table: 'consultant_education',
        label: 'education',
        columns: ['level', 'institution', 'board', 'degree', 'field_of_study', 'location',
            'start_year', 'end_year', 'is_current', 'score', 'score_type', 'details'],
        schema: Joi.object({
            level: Joi.string().valid('SECONDARY', 'SENIOR_SECONDARY', 'DIPLOMA',
                'BACHELORS', 'MASTERS', 'DOCTORATE', 'OTHER').default('BACHELORS'),
            institution: Joi.string().trim().min(1).max(255).required(),
            board: text(255),
            degree: text(255),
            field_of_study: text(255),
            location: text(255),
            start_year: Joi.number().integer().min(1950).max(2100).allow(null).default(null),
            end_year: Joi.number().integer().min(1950).max(2100).allow(null).default(null),
            is_current: Joi.boolean().default(false),
            // Free text on purpose: "8.7 CGPA", "76.4%" and "3.8/4.0" are all
            // real answers, and a numeric column would make one market wrong.
            score: text(40),
            score_type: Joi.string().valid('PERCENTAGE', 'CGPA', 'GPA', 'GRADE')
                .allow(null).default(null),
            details: text(1000),
        }),
    },

    experience: {
        table: 'consultant_experience',
        label: 'work experience',
        columns: ['company', 'title', 'location', 'employment_type',
            'start_date', 'end_date', 'is_current', 'bullets', 'tech_used'],
        jsonColumns: ['bullets', 'tech_used'],
        schema: Joi.object({
            company: Joi.string().trim().min(1).max(255).required(),
            title: Joi.string().trim().min(1).max(255).required(),
            location: text(255),
            employment_type: text(30),
            // Kept as the consultant wrote them. Parsing "Mar 2021" into a date
            // invents a precision they never gave.
            start_date: text(40),
            end_date: text(40),
            is_current: Joi.boolean().default(false),
            bullets,
            tech_used: Joi.array().items(Joi.string().trim().max(120)).max(40).default([]),
        }),
    },

    projects: {
        table: 'consultant_projects',
        label: 'projects',
        columns: ['name', 'description', 'duration', 'team_size', 'role',
            'deployed_url', 'repo_url', 'bullets', 'tech_used'],
        jsonColumns: ['bullets', 'tech_used'],
        schema: Joi.object({
            name: Joi.string().trim().min(1).max(255).required(),
            description: text(2000),
            duration: text(80),
            team_size: Joi.number().integer().min(1).max(10000).allow(null).default(null),
            role: text(255),
            deployed_url: Joi.string().trim().uri().max(500).allow('', null).default(null),
            repo_url: Joi.string().trim().uri().max(500).allow('', null).default(null),
            bullets,
            tech_used: Joi.array().items(Joi.string().trim().max(120)).max(40).default([]),
        }),
    },

    certifications: {
        table: 'consultant_certifications',
        label: 'certifications and achievements',
        columns: ['kind', 'name', 'issuer', 'issued_on', 'expires_on',
            'credential_id', 'credential_url', 'details'],
        schema: Joi.object({
            kind: Joi.string().valid('CERTIFICATION', 'COURSE', 'AWARD', 'PARTICIPATION')
                .default('CERTIFICATION'),
            name: Joi.string().trim().min(1).max(255).required(),
            issuer: text(255),
            issued_on: text(40),
            expires_on: text(40),
            credential_id: text(255),
            credential_url: Joi.string().trim().uri().max(500).allow('', null).default(null),
            details: text(1000),
        }),
    },
};

export const SECTION_NAMES = Object.keys(SECTIONS);

/** Body validation happens per section, so one middleware cannot cover them all. */
export const sectionSchemaFor = (name) => SECTIONS[name]?.schema ?? null;

/**
 * Validate the body against whichever section the path names.
 *
 * `middleware/validate.js` binds one schema at route-definition time, which
 * cannot work here — the schema is not known until the request names a
 * section. This is the same contract, resolved a moment later.
 *
 * It also fails CLOSED: an unknown section is a 404 before any handler runs,
 * so an unrecognised name can never reach the table lookup.
 */
export const validateSection = (req, res, next) => {
    const schema = sectionSchemaFor(req.params.section);
    if (!schema) {
        return res.status(404).json({ error: `Unknown profile section "${req.params.section}".` });
    }

    const { error, value } = schema.validate(req.body, {
        abortEarly: false, stripUnknown: true, convert: true,
    });
    if (error) {
        return res.status(422).json({
            error: 'Validation failed.',
            details: error.details.map((d) => ({
                field: d.path.join('.'),
                message: d.message.replace(/"/g, ''),
            })),
        });
    }

    req.body = value;
    return next();
};

export const reorderSchema = Joi.object({
    ids: Joi.array().items(Joi.string().max(36)).min(1).max(100).required(),
});

/**
 * The scalar profile fields that are resume CONTENT rather than identity.
 *
 * These join the sections above on the self-service side of the line. What
 * stays behind the approval flow is everything the agency is accountable for —
 * legal name, phone, work authorisation, the consent flag — because those are
 * the ones where a wrong answer lands on the agency, not on the consultant.
 * A GitHub link is not in that category.
 */
export const basicsSchema = Joi.object({
    headline: text(255),
    summary: Joi.string().trim().max(4000).allow('', null).default(null),
    github_url: text(255),
    portfolio_url: text(255),
    coding_profile_url: text(255),
}).min(1);

export const skillSchema = Joi.object({
    // Either an id from the autocomplete, or a name the consultant typed.
    skillId: Joi.number().integer().allow(null).default(null),
    name: Joi.string().trim().max(120).allow('', null).default(null),
    years: Joi.number().min(0).max(60).allow(null).default(null),
    proficiency: Joi.string().valid('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')
        .allow(null).default(null),
}).or('skillId', 'name');

/**
 * Whose record is being edited, and may this caller touch it?
 *
 * A consultant edits their own and nothing else. Management edits anyone they
 * can already reach — which for a recruiter means their assigned consultants
 * only, decided by canAccessConsultant rather than by the route.
 *
 * Returns null when the answer is no, and every caller turns that into a 404
 * rather than a 403: a 403 confirms the id exists, and existence is itself
 * information about another agency's people.
 */
const resolveTarget = async (req) => {
    if (req.user.role === 'CONSULTANT') return req.user.id;
    const target = req.params.consultantId;
    if (!target) return null;
    return (await canAccessConsultant(req.user, target)) ? target : null;
};

const sectionOr404 = (req, res) => {
    const section = SECTIONS[req.params.section];
    if (!section) {
        res.status(404).json({ error: `Unknown profile section "${req.params.section}".` });
        return null;
    }
    return section;
};

/* ── reading ───────────────────────────────────────────────────────── */

/** GET .../profile/:section */
export const listSection = async (req, res, next) => {
    try {
        const section = sectionOr404(req, res);
        if (!section) return undefined;

        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const { rows } = await query(
            `SELECT id, ${section.columns.join(', ')}, position, created_at
               FROM ${section.table}
              WHERE consultant_id = $1 AND organization_id = $2
              ORDER BY position, created_at`,
            [consultantId, req.user.orgId],
        );
        return res.json({ section: req.params.section, items: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET .../profile/full — every section at once.
 *
 * One round trip rather than six. The profile editor needs all of it to render
 * at all, and six sequential requests is six chances to show a half-built form.
 */
export const getFullProfile = async (req, res, next) => {
    try {
        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const out = {};
        for (const [name, section] of Object.entries(SECTIONS)) {
            const { rows } = await query(
                `SELECT id, ${section.columns.join(', ')}, position
                   FROM ${section.table}
                  WHERE consultant_id = $1 AND organization_id = $2
                  ORDER BY position, created_at`,
                [consultantId, req.user.orgId],
            );
            out[name] = rows;
        }
        out.skills = await consultantSkills(consultantId);

        const { rows: links } = await query(
            `SELECT p.github_url, p.portfolio_url, p.coding_profile_url,
                    p.headline, p.summary, p.linkedin_url, p.phone,
                    p.profile_completed_at, u.name, u.email
               FROM consultant_profiles p JOIN users u ON u.id = p.user_id
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [consultantId, req.user.orgId],
        );
        out.basics = links[0] ?? null;

        return res.json(out);
    } catch (err) {
        return next(err);
    }
};

/* ── writing ───────────────────────────────────────────────────────── */

/** POST .../profile/:section */
export const createRow = async (req, res, next) => {
    try {
        const section = sectionOr404(req, res);
        if (!section) return undefined;

        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const id = randomUUID();

        // Only the columns the caller actually supplied.
        //
        // Writing every column and passing null for the absent ones looks
        // equivalent and is not: a NOT NULL column with a DEFAULT — is_current,
        // for one — takes its default when omitted and raises when handed an
        // explicit null. Omitting them lets the schema's own defaults stand,
        // and stops this handler depending on the validator having run first
        // to avoid a 500.
        const cols = section.columns.filter((c) => req.body[c] !== undefined);
        const values = cols.map((c) => (section.jsonColumns?.includes(c)
            ? JSON.stringify(req.body[c] ?? [])
            : req.body[c]));

        if (cols.length === 0) {
            return res.status(422).json({ error: 'Nothing to save.' });
        }

        // New rows land at the end. The consultant reorders deliberately if
        // they want a different running order; guessing one for them would
        // silently rearrange a resume they had already arranged.
        const { rows: last } = await query(
            `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${section.table}
              WHERE consultant_id = $1`,
            [consultantId],
        );

        const placeholders = cols.map((c, i) => (section.jsonColumns?.includes(c)
            ? `$${i + 4}::jsonb` : `$${i + 4}`)).join(', ');

        const { rows } = await query(
            `INSERT INTO ${section.table}
                (id, organization_id, consultant_id, position, ${cols.join(', ')})
             VALUES ($1,$2,$3,$${cols.length + 4}, ${placeholders})
             -- The WHOLE row, not just the columns this call wrote: the
             -- caller is rendering an entry, not echoing a diff.
             RETURNING id, ${section.columns.join(', ')}, position`,
            [id, req.user.orgId, consultantId, ...values, last[0].next],
        );

        logAction({
            orgId: req.user.orgId,
            module: 'profiles',
            action: 'Added Profile Entry',
            entityType: 'ConsultantProfile',
            entityId: consultantId,
            entityName: rows[0].name ?? rows[0].institution ?? rows[0].company ?? req.params.section,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Added an entry to ${section.label}.`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json(rows[0]);
    } catch (err) {
        return next(err);
    }
};

/** PATCH .../profile/:section/:id */
export const updateRow = async (req, res, next) => {
    try {
        const section = sectionOr404(req, res);
        if (!section) return undefined;

        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        // Same rule as createRow: a column the caller did not mention keeps
        // what it had. An explicitly null one is cleared — null and undefined
        // mean different things here and are not collapsed.
        const cols = section.columns.filter((c) => req.body[c] !== undefined);
        if (cols.length === 0) {
            return res.status(422).json({ error: 'Nothing to change.' });
        }

        const sets = cols.map((c, i) => (section.jsonColumns?.includes(c)
            ? `${c} = $${i + 4}::jsonb` : `${c} = $${i + 4}`)).join(', ');
        const values = cols.map((c) => (section.jsonColumns?.includes(c)
            ? JSON.stringify(req.body[c] ?? [])
            : req.body[c]));

        // consultant_id is in the WHERE, not just the id: without it, a valid
        // row id from another consultant in the same agency would be editable.
        const { rows } = await query(
            `UPDATE ${section.table} SET ${sets}
              WHERE id = $1 AND consultant_id = $2 AND organization_id = $3
              RETURNING id, ${section.columns.join(', ')}, position`,
            [req.params.id, consultantId, req.user.orgId, ...values],
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

        return res.json(rows[0]);
    } catch (err) {
        return next(err);
    }
};

/** DELETE .../profile/:section/:id */
export const deleteRow = async (req, res, next) => {
    try {
        const section = sectionOr404(req, res);
        if (!section) return undefined;

        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const { rowCount } = await query(
            `DELETE FROM ${section.table}
              WHERE id = $1 AND consultant_id = $2 AND organization_id = $3`,
            [req.params.id, consultantId, req.user.orgId],
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Entry not found.' });

        logAction({
            orgId: req.user.orgId,
            module: 'profiles',
            action: 'Removed Profile Entry',
            entityType: 'ConsultantProfile',
            entityId: consultantId,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Removed an entry from ${section.label}.`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/**
 * PUT .../profile/:section/order
 *
 * The order matters: it is the order the resume prints in, and the order the
 * tailoring step starts from before it reorders for a specific job.
 */
export const reorderSection = async (req, res, next) => {
    try {
        const section = sectionOr404(req, res);
        if (!section) return undefined;

        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        await withTransaction(async (client) => {
            for (const [index, id] of req.body.ids.entries()) {
                await client.query(
                    `UPDATE ${section.table} SET position = $1
                      WHERE id = $2 AND consultant_id = $3 AND organization_id = $4`,
                    [index, id, consultantId, req.user.orgId],
                );
            }
        });
        return res.json({ ok: true, count: req.body.ids.length });
    } catch (err) {
        return next(err);
    }
};

/** PATCH .../profile-basics */
export const updateBasics = async (req, res, next) => {
    try {
        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const cols = ['headline', 'summary', 'github_url', 'portfolio_url', 'coding_profile_url'];
        // COALESCE against the incoming value, not the column: a field the
        // caller omitted keeps what it had, and a field they deliberately
        // cleared is set to null. Sending every column every time would wipe
        // whatever the form did not happen to render.
        const sets = cols.map((c, i) => `${c} = COALESCE($${i + 3}, ${c})`).join(', ');

        const { rows } = await query(
            `UPDATE consultant_profiles SET ${sets}
              WHERE user_id = $1 AND organization_id = $2
              RETURNING ${cols.join(', ')}`,
            [consultantId, req.user.orgId, ...cols.map((c) => (
                Object.hasOwn(req.body, c) ? (req.body[c] ?? '') : null
            ))],
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Profile not found.' });

        // '' was used above to mean "clear this"; it is stored as NULL so the
        // resume builder can simply skip empty fields.
        await query(
            `UPDATE consultant_profiles
                SET ${cols.map((c) => `${c} = NULLIF(btrim(${c}), '')`).join(', ')}
              WHERE user_id = $1`,
            [consultantId],
        );

        return res.json(rows[0]);
    } catch (err) {
        return next(err);
    }
};

/**
 * GET .../career/readiness
 *
 * Whether there is enough here to build a resume, and what is missing if not.
 *
 * Shares profileResumeReadiness with the pipeline rather than reimplementing
 * the rule, so the badge a consultant sees and the decision the tailoring step
 * makes can never disagree. Two functions that mean almost the same thing is
 * the usual way a "you're all set" banner ends up sitting above an application
 * that went out untailored.
 */
export const careerReadiness = async (req, res, next) => {
    try {
        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const state = await profileResumeReadiness({ orgId: req.user.orgId, consultantId });
        return res.json({
            ready: state.ready,
            gaps: state.gaps,
            // The badge shows a number, so it needs one.
            count: state.gaps.length,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── skills ────────────────────────────────────────────────────────── */

/**
 * GET /api/skills/search?q=
 *
 * Open to any signed-in user. The vocabulary is not tenant data — it is a list
 * of technology names — and scoping it per organisation would mean every
 * agency rebuilding the same list of what React is called.
 */
export const searchSkillsEndpoint = async (req, res, next) => {
    try {
        const items = await searchSkills(req.query.q ?? '', Math.min(Number(req.query.limit) || 12, 30));
        return res.json({ items });
    } catch (err) {
        return next(err);
    }
};

/** POST .../profile/skills */
export const addSkill = async (req, res, next) => {
    try {
        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        // An id from the autocomplete is taken as-is. A typed name goes through
        // resolveSkill, which checks aliases first — so somebody typing "k8s"
        // joins the existing Kubernetes rather than founding a rival entry.
        let skillId = req.body.skillId;
        if (!skillId) {
            const resolved = await resolveSkill(req.body.name);
            if (!resolved) return res.status(422).json({ error: 'That is not a usable skill name.' });
            skillId = resolved.id;
        }

        const { rows: last } = await query(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM consultant_skills WHERE consultant_id = $1',
            [consultantId],
        );

        const { rows } = await query(
            `INSERT INTO consultant_skills
                (id, organization_id, consultant_id, skill_id, years, proficiency, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             -- Adding a skill already claimed updates it rather than failing.
             -- The consultant meant "I know this", not "create a duplicate".
             ON CONFLICT (consultant_id, skill_id) DO UPDATE
                SET years = EXCLUDED.years, proficiency = EXCLUDED.proficiency
             RETURNING id, skill_id`,
            [randomUUID(), req.user.orgId, consultantId, skillId,
                req.body.years ?? null, req.body.proficiency ?? null, last[0].next],
        );

        const { rows: skill } = await query(
            'SELECT id, name, category FROM lkp_skills WHERE id = $1', [skillId],
        );
        return res.status(201).json({ ...rows[0], skill: skill[0] });
    } catch (err) {
        return next(err);
    }
};

/** DELETE .../profile/skills/:skillId */
export const removeSkill = async (req, res, next) => {
    try {
        const consultantId = await resolveTarget(req);
        if (!consultantId) return res.status(404).json({ error: 'Consultant not found.' });

        const { rowCount } = await query(
            `DELETE FROM consultant_skills
              WHERE consultant_id = $1 AND skill_id = $2 AND organization_id = $3`,
            [consultantId, req.params.skillId, req.user.orgId],
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Skill not found on this profile.' });
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};
