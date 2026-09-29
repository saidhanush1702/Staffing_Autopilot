/**
 * ── BUILDING A RESUME FROM THE PROFILE ────────────────────────────────
 *
 * The PROFILE-mode counterpart to services/resumeParse.js.
 *
 * `resumeParse` takes an uploaded file, spends a model call turning it into
 * structure, and caches the result. This takes rows that are ALREADY
 * structured and assembles them — no model call, no cache, no parse failure,
 * and nothing that can be unreadable.
 *
 * ── WHY IT RETURNS THE SAME SHAPE ─────────────────────────────────────
 *
 * Exactly the shape resumeParse returns: `{ ok, document: { sections, rawText } }`,
 * where `sections` satisfies config/resumeSchema.js. That is the whole point.
 * Tailoring, the fabrication check, the ATS scorer, the renderer and the
 * review gate are all untouched — swapping the source is one branch in the
 * handler, not a second pipeline.
 *
 * ── WHY rawText MATTERS MORE HERE THAN IT LOOKS ───────────────────────
 *
 * It is the baseline the fabrication check compares against. In BASE_RESUME
 * mode that baseline is text extracted from a PDF, with whatever the extractor
 * got wrong baked into it. Here it is generated from the fields themselves, so
 * "is this claim in the original?" is asked against data the consultant
 * actually entered. The check gets stricter without a line of its own changing.
 */
import { query } from '../db.js';
import { flattenResumeText } from '../config/resumeSchema.js';
import { getTemplate } from '../config/resumeTemplates.js';
import { projectPointPool } from '../config/resumeLayout.js';

/**
 * The least a profile needs before a resume can be built from it.
 *
 * Deliberately not "every field filled in". A fresher with no employment
 * history is not an incomplete profile, they are a fresher — that is what the
 * entry-level template exists for. What cannot be worked around is having
 * nothing to say at all.
 */
export const profileGaps = (parts) => {
    const gaps = [];
    if (!parts.name) gaps.push('full name');
    if ((parts.skills ?? []).length === 0) gaps.push('at least one skill');

    const hasSubstance = (parts.experience ?? []).length > 0
        || (parts.projects ?? []).length > 0
        || (parts.education ?? []).length > 0;
    if (!hasSubstance) {
        gaps.push('at least one of: work experience, a project, or education');
    }
    return gaps;
};

/** Group a flat skill list into the categories the resume prints. */
const groupSkills = (skills) => {
    const byCategory = new Map();
    for (const s of skills) {
        // A custom skill has no category. "Other" is honest and keeps it on the
        // page; dropping it would quietly lose something the consultant chose
        // to claim.
        const key = s.category ?? 'Other';
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key).push(s.name);
    }
    return [...byCategory.entries()].map(([category, items]) => ({ category, items }));
};

/**
 * What a project says, as the bullet points a resume prints.
 *
 * ── WHY A PROJECT USED TO COME OUT AS A TITLE AND A YEAR ──────────────
 *
 * Only `name` and a packed one-line description were carried across. The
 * `bullets` column was used only when somebody had typed points in — and
 * people mostly write a paragraph, or nothing — while `tech_used` was never
 * read at all. So a project the consultant had described in a paragraph and
 * built with five technologies printed as its name and its dates.
 *
 * Everything the profile knows goes in now, and nothing it does not:
 *   1. the points the consultant wrote, in their own words
 *   2. the sentences of the description, each as a point of its own
 *   3. the technologies, as one line — which is also what an applicant
 *      tracking system is scanning a project for
 *
 * The full list is returned; tailoring reorders it and the renderer keeps
 * three or four (config/resumeLayout.js). Trimming here would take away the
 * choice of which points suit this job.
 */
const projectPoints = (row) => {
    const points = [...projectPointPool({
        bullets: Array.isArray(row.bullets) ? row.bullets : [],
        description: row.description,
    })];

    const tech = (Array.isArray(row.tech_used) ? row.tech_used : [])
        .map((t) => String(t ?? '').trim()).filter(Boolean);
    if (tech.length > 0) points.push(`Technologies used: ${tech.join(', ')}`);

    return points;
};

const yearRange = (start, end, isCurrent) => {
    if (isCurrent && start) return `${start} – Present`;
    if (start && end) return `${start} – ${end}`;
    return String(start ?? end ?? '') || null;
};

/** "8.7 CGPA" / "76.4%" — kept as the consultant wrote it. */
const scoreLine = (row) => {
    if (!row.score) return null;
    if (row.score_type === 'PERCENTAGE' && !String(row.score).includes('%')) return `${row.score}%`;
    if (row.score_type === 'CGPA' && !/cgpa/i.test(row.score)) return `${row.score} CGPA`;
    if (row.score_type === 'GPA' && !/gpa/i.test(row.score)) return `${row.score} GPA`;
    return String(row.score);
};

/**
 * Assemble everything this consultant has into one resume structure.
 *
 * Never throws. A profile with nothing in it is an ordinary outcome, reported
 * as `PROFILE_INCOMPLETE` so the handler can send the application out with the
 * base resume and a marker rather than failing it.
 *
 * @returns {{ok: true, document: {sections, rawText}, gaps: []}}
 *        | {{ok: false, reason: 'PROFILE_INCOMPLETE', error, gaps}}
 */
export const buildProfileResume = async ({ orgId, consultantId, templateName }) => {
    const template = getTemplate(templateName);

    const [who, skills, experience, projects, education, certifications] = await Promise.all([
        query(
            `SELECT u.name, u.email, p.phone, p.city, p.state,
                    p.linkedin_url, p.github_url, p.portfolio_url,
                    p.coding_profile_url, p.headline, p.summary
               FROM users u
          LEFT JOIN consultant_profiles p ON p.user_id = u.id
              WHERE u.id = $1 AND u.organization_id = $2`,
            [consultantId, orgId],
        ),
        query(
            `SELECT s.name, s.category, cs.years, cs.proficiency
               FROM consultant_skills cs JOIN lkp_skills s ON s.id = cs.skill_id
              WHERE cs.consultant_id = $1 ORDER BY cs.position, s.name`,
            [consultantId],
        ),
        query(
            `SELECT company, title, location, start_date, end_date, is_current,
                    bullets, tech_used
               FROM consultant_experience WHERE consultant_id = $1
              ORDER BY position, created_at`,
            [consultantId],
        ),
        query(
            `SELECT name, description, duration, team_size, role,
                    deployed_url, repo_url, bullets, tech_used
               FROM consultant_projects WHERE consultant_id = $1
              ORDER BY position, created_at`,
            [consultantId],
        ),
        query(
            `SELECT level, institution, board, degree, field_of_study, location,
                    start_year, end_year, is_current, score, score_type, details
               FROM consultant_education WHERE consultant_id = $1
              ORDER BY position, end_year DESC NULLS LAST`,
            [consultantId],
        ),
        query(
            `SELECT kind, name, issuer, issued_on, expires_on,
                    credential_id, credential_url, details
               FROM consultant_certifications WHERE consultant_id = $1
              ORDER BY position, created_at`,
            [consultantId],
        ),
    ]);

    const person = who.rows[0];
    if (!person) {
        return {
            ok: false,
            reason: 'PROFILE_INCOMPLETE',
            error: 'This consultant no longer exists.',
            gaps: ['the consultant record'],
        };
    }

    const parts = {
        name: person.name,
        skills: skills.rows,
        experience: experience.rows,
        projects: projects.rows,
        education: education.rows,
    };

    const gaps = profileGaps(parts);
    if (gaps.length > 0) {
        return {
            ok: false,
            reason: 'PROFILE_INCOMPLETE',
            error: `The profile is missing ${gaps.join(', ')}. `
                + 'The base resume was attached instead.',
            gaps,
        };
    }

    /* ── into the shape everything downstream already understands ──── */

    const sections = {
        contact: {
            name: person.name,
            email: person.email ?? null,
            phone: person.phone ?? null,
            location: [person.city, person.state].filter(Boolean).join(', ') || null,
            links: [
                person.linkedin_url, person.github_url,
                person.portfolio_url, person.coding_profile_url,
            ].filter(Boolean),
        },

        // The template decides the running order, and the renderer follows it.
        // This is what makes "keep the section order" true by construction
        // rather than by asking the model nicely.
        sectionOrder: template.sections,

        summary: person.summary ?? person.headline ?? null,

        skills: groupSkills(skills.rows),

        experience: experience.rows.map((r) => ({
            company: r.company,
            title: r.title,
            location: r.location,
            startDate: r.start_date,
            endDate: r.is_current ? 'Present' : r.end_date,
            bullets: Array.isArray(r.bullets) ? r.bullets.filter(Boolean) : [],
        })),

        projects: projects.rows.map((r) => ({
            name: r.name,
            // Printed right-aligned on the project's own line, the same as an
            // employment date — kept OUT of the meta line below so it is not
            // said twice.
            when: r.duration,
            // The facts ABOUT a project that are not what it does — who was on
            // it, what the person's role was, where it lives — as the one
            // meta line under its name.
            description: [
                r.role ? `Role: ${r.role}` : null,
                r.team_size ? `Team of ${r.team_size}` : null,
                r.deployed_url ? `Live: ${r.deployed_url}` : null,
                r.repo_url ? `Code: ${r.repo_url}` : null,
            ].filter(Boolean).join(' · ') || null,
            bullets: projectPoints(r),
        })),

        education: education.rows.map((r) => ({
            institution: r.institution,
            // The degree ALONE. `degreeLine` used to fold the field into it
            // here, and the field was then passed again beside it, so the
            // renderer printed "B.Tech in Computer Science and Engineering,
            // Computer Science and Engineering" — the same words twice.
            degree: r.degree ?? r.level,
            field: r.field_of_study,
            startDate: r.start_year ? String(r.start_year) : null,
            endDate: r.is_current ? 'Present' : (r.end_year ? String(r.end_year) : null),
            details: [r.board, scoreLine(r), r.details].filter(Boolean).join(' · ') || null,
        })),

        certifications: certifications.rows.map((r) => ({
            name: r.name,
            issuer: r.issuer,
            date: r.issued_on,
        })),

        additional: [],
    };

    // Anything that is not a certification proper — a course, an award, a
    // participation — is real and belongs on the page, but printing it under a
    // heading that says CERTIFICATIONS would overstate it.
    const extras = certifications.rows.filter((r) => r.kind !== 'CERTIFICATION');
    if (extras.length > 0) {
        sections.certifications = certifications.rows
            .filter((r) => r.kind === 'CERTIFICATION')
            .map((r) => ({ name: r.name, issuer: r.issuer, date: r.issued_on }));

        sections.additional.push({
            heading: 'Achievements and courses',
            items: extras.map((r) => [
                r.name, r.issuer, r.issued_on,
            ].filter(Boolean).join(' — ')),
        });
    }

    return {
        ok: true,
        gaps: [],
        document: {
            id: null,               // nothing to cache — these are live rows
            sections,
            // The fabrication baseline, generated from the fields themselves.
            rawText: flattenResumeText(sections),
        },
        template,
    };
};

/**
 * What is missing, for a screen.
 *
 * Shares profileGaps with the builder above so the badge a consultant reads
 * and the decision the pipeline makes can never disagree — the usual way that
 * goes wrong is two functions that mean almost the same thing.
 */
export const profileResumeReadiness = async ({ orgId, consultantId }) => {
    const built = await buildProfileResume({ orgId, consultantId });
    return {
        ready: built.ok,
        gaps: built.gaps ?? [],
        reason: built.ok ? null : built.error,
    };
};
