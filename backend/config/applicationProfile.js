/**
 * ── WHAT THE DESKTOP MAY TYPE ABOUT A CONSULTANT ──────────────────────
 *
 * One place that decides which facts about a consultant leave the hub for a
 * job application form, shared by the device queue (the recipes) and the agent
 * catalogue so the two can never offer different things.
 *
 * ── MINIMUM, NOT EVERYTHING ───────────────────────────────────────────
 *
 * Only what a form field can actually ask for. Resume bullets, summaries and
 * project text are left behind: they are long, they are not form answers, and
 * the less that crosses to the desktop the less there is to leak from it.
 *
 * ── NOTHING IS INVENTED ───────────────────────────────────────────────
 *
 * Every value is a column the consultant (or their recruiter) entered. The one
 * derived number, `total_years`, is the span between the earliest start year
 * and the latest end year of their own work history — it says so in its name
 * and is only offered when both ends exist.
 */
// Imported on first use so the pure helpers below can be tested without a database.
let queryFn = null;
const query = async (...args) => {
    if (!queryFn) ({ query: queryFn } = await import('../db.js'));
    return queryFn(...args);
};

/** Highest first. A form asking for "highest education" wants the top row. */
const LEVEL_RANK = {
    DOCTORATE: 6, MASTERS: 5, BACHELORS: 4, DIPLOMA: 3, SENIOR_SECONDARY: 2, SECONDARY: 1, OTHER: 0,
};

/** How a form words each level, so a dropdown option can match it. */
export const LEVEL_WORDS = {
    DOCTORATE: 'Doctorate',
    MASTERS: "Master's Degree",
    BACHELORS: "Bachelor's Degree",
    DIPLOMA: 'Diploma',
    SENIOR_SECONDARY: 'High School',
    SECONDARY: 'High School',
    OTHER: null,
};

/** A four-digit year from whatever the consultant wrote ("Mar 2021", "2021"). */
export const yearOf = (text) => {
    const m = String(text ?? '').match(/\b(19[5-9]\d|20\d{2})\b/);
    return m ? Number(m[1]) : null;
};

/**
 * Whole years between the first job's start and the last job's end.
 *
 * Null when the history does not support a number — no start years at all, or
 * nothing to say when it ended. A gap in the middle is not subtracted: the form
 * asks "how long since you started", and the consultant can correct the answer.
 */
export const totalYears = (experience = [], now = new Date().getFullYear()) => {
    const starts = experience.map((e) => yearOf(e.start_date)).filter(Boolean);
    if (starts.length === 0) return null;
    const ends = experience.map((e) => (e.is_current ? now : yearOf(e.end_date)));
    if (ends.some((e) => e === null)) return null;
    const span = Math.max(...ends) - Math.min(...starts);
    return span >= 0 && span <= 60 ? span : null;
};

/**
 * @returns the profile object the desktop's answer book reads
 */
export const applicationProfileFor = async ({ consultantId, orgId }) => {
    const [{ rows: base }, { rows: education }, { rows: experience }, { rows: skills }] = await Promise.all([
        query(
            `SELECT u.name, u.email, p.phone, p.city, p.state, p.linkedin_url,
                    p.github_url, p.portfolio_url, p.headline,
                    w.name AS work_auth, p.base_resume_artifact_id
               FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
          LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [consultantId, orgId],
        ),
        query(
            `SELECT level, institution, degree, field_of_study, end_year
               FROM consultant_education
              WHERE consultant_id = $1 AND organization_id = $2
              ORDER BY position, created_at`,
            [consultantId, orgId],
        ),
        query(
            `SELECT company, title, start_date, end_date, is_current
               FROM consultant_experience
              WHERE consultant_id = $1 AND organization_id = $2
              ORDER BY position, created_at`,
            [consultantId, orgId],
        ),
        query(
            `SELECT s.name, cs.years
               FROM consultant_skills cs
               JOIN lkp_skills s ON s.id = cs.skill_id
              WHERE cs.consultant_id = $1
              ORDER BY cs.position, s.name`,
            [consultantId],
        ),
    ]);

    const me = base[0];
    if (!me) return null;

    const top = [...education].sort(
        (a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0),
    )[0] ?? null;
    const current = experience.find((e) => e.is_current) ?? experience[0] ?? null;

    return {
        ...me,
        current_company: current?.company ?? null,
        current_title: current?.title ?? null,
        school: top?.institution ?? null,
        degree: top?.degree ?? null,
        field_of_study: top?.field_of_study ?? null,
        education_level: top ? (LEVEL_WORDS[top.level] ?? null) : null,
        graduation_year: top?.end_year ?? null,
        total_years: totalYears(experience),
        // Years are the consultant's own figure per skill; a skill with none
        // is still listed so a "do you know X" question can be answered yes.
        skills: skills.map((s) => ({
            name: s.name,
            years: s.years === null || s.years === undefined ? null : Number(s.years),
        })),
    };
};
