/**
 * ── THE SKILLS VOCABULARY ─────────────────────────────────────────────
 *
 * One place that decides what counts as "the same skill", so a consultant
 * claiming React and a job asking for ReactJS meet in the middle.
 *
 * ── WHY slugify IS THE WHOLE DESIGN ───────────────────────────────────
 *
 * Everything keys on the slug. The display name keeps whatever spelling looks
 * right on a resume — "PostgreSQL", "Node.js", "C++" — and the slug is what
 * lookups, uniqueness and matching all go through.
 *
 * It MUST stay byte-identical to the copy in db/seeds/007_skills_seed.js. The
 * seed writes the keys this file reads, and two subtly different definitions
 * of "the same skill" would silently split the vocabulary in half — which is
 * precisely the failure the table exists to prevent. It is duplicated rather
 * than imported because a seed importing runtime config is a circular
 * dependency waiting to happen, and the function is four lines.
 */
import { query } from '../db.js';

/** `+` `#` and `.` survive — they are the difference between C, C++ and C#. */
export const slugify = (name) => String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9+#.]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Autocomplete.
 *
 * Ranked by how often the skill appears in real job postings, then by how
 * early the match falls in the name. A consultant typing "java" should be
 * offered Java before JavaScript only if employers ask for Java more often —
 * which is a fact the posting pool knows and a hand-ordered list does not.
 *
 * Aliases are searched too, so "k8s" finds Kubernetes.
 */
export const searchSkills = async (term, limit = 12) => {
    const slug = slugify(term);
    if (slug.length < 1) {
        // An empty box still offers something useful: the skills this market
        // asks for most.
        const { rows } = await query(
            `SELECT id, name, category FROM lkp_skills
              WHERE is_active ORDER BY posting_hits DESC, name LIMIT $1`,
            [limit],
        );
        return rows;
    }

    const { rows } = await query(
        `SELECT DISTINCT ON (s.id) s.id, s.name, s.category, s.posting_hits,
                CASE WHEN s.slug = $1 THEN 0
                     WHEN s.slug LIKE $1 || '%' THEN 1
                     WHEN a.alias = $1 THEN 1
                     WHEN a.alias LIKE $1 || '%' THEN 2
                     ELSE 3 END AS rank
           FROM lkp_skills s
      LEFT JOIN lkp_skill_aliases a ON a.skill_id = s.id
          WHERE s.is_active
            AND (s.slug LIKE '%' || $1 || '%' OR a.alias LIKE '%' || $1 || '%')
          ORDER BY s.id, rank`,
        [slug],
    );

    return rows
        .sort((x, y) => x.rank - y.rank
            || y.posting_hits - x.posting_hits
            || x.name.localeCompare(y.name))
        .slice(0, limit)
        .map(({ rank, ...rest }) => rest);
};

/**
 * Resolve a typed skill to a row, creating it if it is genuinely new.
 *
 * ── WHY TYPED SKILLS ARE KEPT RATHER THAN REFUSED ─────────────────────
 *
 * The seeded list will never be complete, and a consultant who genuinely uses
 * something we have not heard of should not have to lie about it or leave it
 * out. A new row is marked CUSTOM so it is distinguishable from the curated
 * vocabulary, and the alias check runs first so "k8s" resolves to the existing
 * Kubernetes rather than founding a rival entry.
 *
 * @returns {{id, name, created}}
 */
export const resolveSkill = async (name) => {
    const clean = String(name ?? '').trim().slice(0, 120);
    if (!clean) return null;
    const slug = slugify(clean);
    if (!slug) return null;

    const { rows: exact } = await query(
        `SELECT s.id, s.name FROM lkp_skills s
      LEFT JOIN lkp_skill_aliases a ON a.skill_id = s.id
         WHERE s.slug = $1 OR a.alias = $1
         LIMIT 1`,
        [slug],
    );
    if (exact.length > 0) return { ...exact[0], created: false };

    const { rows } = await query(
        `INSERT INTO lkp_skills (name, slug, origin) VALUES ($1,$2,'CUSTOM')
         -- A race between two consultants adding the same new skill resolves
         -- to one row rather than failing somebody's profile save.
         ON CONFLICT (slug) DO UPDATE SET is_active = TRUE
         RETURNING id, name`,
        [clean, slug],
    );
    return { ...rows[0], created: true };
};

/**
 * Learn the vocabulary from job postings.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────
 *
 * The seeded list was written by a person and is already drifting. This counts
 * how often each known skill actually appears in the postings the system has
 * ingested, which does two useful things at once: it orders the autocomplete
 * by what employers are really asking for, and it surfaces the gap between the
 * seeded vocabulary and the market.
 *
 * Counting KNOWN skills rather than inventing new ones is deliberate. Pulling
 * arbitrary capitalised words out of job adverts produces "Responsibilities",
 * "Benefits" and every company name as skills, and a polluted vocabulary is
 * worse than a short one.
 *
 * ── WHY THE MATCHING IS NOT A SUBSTRING SEARCH ────────────────────────
 *
 * The first version of this used LIKE '%name%' and reported that "R" and "C"
 * each appeared in 500 postings and Scala in 286. None of that was true: "R"
 * matches inside every word containing the letter, "C" matches inside "CI/CD",
 * and "Scala" matches inside "scalable". A ranking built on those numbers
 * would offer a consultant the wrong suggestions in the wrong order, and it
 * would look plausible while doing it.
 *
 * So matches must sit on word boundaries. Two details make that work:
 *
 *   · the boundary class includes + # and . — otherwise "C" matches the "c" in
 *     "c++", and C and C++ become the same skill again.
 *   · one and two-character names are matched CASE-SENSITIVELY against the
 *     original text. "R" the language is written "R"; the "r" in "your" is
 *     not. Case is the only signal that separates them, and discarding it is
 *     what made the first version report nonsense.
 *
 * @returns the number of skills whose count changed
 */
export const learnFromPostings = async (orgId = null) => {
    const { rows } = await query(
        `WITH corpus AS (
            -- Original case kept: the short-name rule below depends on it.
            SELECT coalesce(p.title,'') || ' ' || coalesce(p.description,'') AS txt
              FROM job_postings p
             WHERE ($1::text IS NULL OR p.organization_id = $1)
               AND p.is_active
        ),
        patterns AS (
            SELECT s.id,
                   length(s.name) <= 2 AS short_name,
                   '(?<![A-Za-z0-9+#.])'
                     || regexp_replace(s.name, '([.^$*+?()\\[\\]{}|\\\\#-])', '\\\\\\1', 'g')
                     || '(?![A-Za-z0-9+#.])' AS pattern
              FROM lkp_skills s
             WHERE s.is_active
        ),
        counted AS (
            SELECT p.id,
                   (SELECT count(*) FROM corpus c
                     WHERE CASE WHEN p.short_name
                                THEN c.txt ~ p.pattern      -- case-sensitive
                                ELSE c.txt ~* p.pattern     -- case-insensitive
                           END)::int AS hits
              FROM patterns p
        )
        UPDATE lkp_skills s
           SET posting_hits = counted.hits
          FROM counted
         WHERE s.id = counted.id
           AND s.posting_hits IS DISTINCT FROM counted.hits
        RETURNING s.id`,
        [orgId],
    );
    return rows.length;
};

/** A consultant's skills, in their own order, ready for a resume. */
export const consultantSkills = async (consultantId) => {
    const { rows } = await query(
        `SELECT cs.skill_id, s.name, s.category, cs.years, cs.proficiency, cs.position
           FROM consultant_skills cs
           JOIN lkp_skills s ON s.id = cs.skill_id
          WHERE cs.consultant_id = $1
          ORDER BY cs.position, s.name`,
        [consultantId],
    );
    return rows;
};
