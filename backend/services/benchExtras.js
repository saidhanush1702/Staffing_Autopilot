/**
 * ── WHAT v2 NEEDS TO KNOW ABOUT EACH CONSULTANT ───────────────────────
 *
 * v1 matched from the criteria alone. v2 also reads the person: the skills they
 * listed, how long they have worked, whether they would relocate, their work
 * authorization — and which matcher their organisation has chosen.
 *
 * Loaded here, once per bench, and attached to `criteria` so the matcher stays
 * a pure function and the three doors that call it needed no change.
 *
 * ── TOLERANT OF AN UN-MIGRATED DATABASE ───────────────────────────────
 *
 * Migration 060 adds `organizations.matcher_version` and
 * `search_criteria_versions.open_to_relocate`. Code that reads a column which
 * is not there turns every webhook delivery into a 500, so each column is
 * checked for once and, if absent, treated as its default (matcher v1, will not
 * relocate). A deploy that runs before the migration therefore keeps matching
 * exactly as it did.
 */
import { query } from '../db.js';
import { totalYears } from '../config/applicationProfile.js';
import { canonicalOf } from '../config/skillGraph.js';

const present = new Map();
export const hasColumn = async (table, column) => {
    const key = `${table}.${column}`;
    if (!present.has(key)) {
        const { rows } = await query(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            [table, column],
        );
        present.set(key, rows.length > 0);
    }
    return present.get(key);
};

/** Forget what was learned about the schema. For the test that migrates mid-run. */
export const resetColumnCache = () => present.clear();

/**
 * @param bench  the array `loadMatchableConsultants` is about to return
 * @returns the same array, with each `criteria` filled in
 */
export const attachMatcherInputs = async (orgId, bench) => {
    if (bench.length === 0) return bench;

    let matcherVersion = 1;
    if (await hasColumn('organizations', 'matcher_version')) {
        const { rows } = await query('SELECT matcher_version FROM organizations WHERE id = $1', [orgId]);
        matcherVersion = rows[0]?.matcher_version ?? 1;
    }
    const relocateColumn = await hasColumn('search_criteria_versions', 'open_to_relocate');

    for (const c of bench) {
        const [skills, experience, profile, radii, relocate] = await Promise.all([
            query(`SELECT s.name, cs.years FROM consultant_skills cs
                     JOIN lkp_skills s ON s.id = cs.skill_id
                    WHERE cs.consultant_id = $1 ORDER BY cs.position`, [c.id]),
            query(`SELECT start_date, end_date, is_current FROM consultant_experience
                    WHERE consultant_id = $1 AND organization_id = $2`, [c.id, orgId]),
            query(`SELECT w.name AS work_auth FROM consultant_profiles p
                LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
                    WHERE p.user_id = $1`, [c.id]),
            query(`SELECT radius_miles FROM search_criteria_locations
                    WHERE version_id = $1 ORDER BY position`, [c.versionId]),
            relocateColumn
                ? query('SELECT open_to_relocate FROM search_criteria_versions WHERE id = $1', [c.versionId])
                : Promise.resolve({ rows: [] }),
        ]);

        c.criteria.matcherVersion = matcherVersion;
        c.criteria.skills = skills.rows.map((s) => ({
            name: s.name,
            canonical: canonicalOf(s.name),
            years: s.years === null ? null : Number(s.years),
        }));
        c.criteria.totalYears = totalYears(experience.rows);
        c.criteria.workAuth = profile.rows[0]?.work_auth ?? null;
        c.criteria.openToRelocate = Boolean(relocate.rows[0]?.open_to_relocate);
        c.criteria.locations = c.criteria.locations.map((l, i) => ({
            ...l, radiusMiles: radii.rows[i]?.radius_miles ?? null,
        }));
    }
    return bench;
};
