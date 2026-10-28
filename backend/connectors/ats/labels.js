/**
 * ── EMPLOYMENT-TYPE LABELS → lkp_work_types ───────────────────────────
 *
 * Each ATS words the engagement differently — Lever "EE Full-Time" and
 * "Fixed-Term", Ashby "FullTime", SmartRecruiters "part-time", Workday
 * "Full time". One regex pass maps all of them onto the five names
 * `lkp_work_types` actually has: CONTRACT, FULL_TIME, PART_TIME, C2C, W2.
 *
 * Returns null for anything else — including internships, which have no row.
 * `scoreMatch` subtracts 10 for a mismatch, so a wrong label actively pushes a
 * job away from the people it suits; a missing one scores neutrally.
 *
 * Order matters. "contract" is tested before "full-time" because "Full-time
 * contract" is a contract.
 */
export const workTypeFromLabel = (label) => {
    const t = String(label ?? '').toLowerCase().replace(/[_]/g, ' ');
    if (!t.trim()) return null;
    if (/\b(intern|internship|apprentice|trainee|co-?op)\b/.test(t)) return null;
    if (/\bc2c\b|corp[- ]to[- ]corp/.test(t)) return 'C2C';
    if (/\bw-?2\b/.test(t)) return 'W2';
    if (/contract|temp|fixed[- ]?term|freelance|casual/.test(t)) return 'CONTRACT';
    if (/part[- ]?time/.test(t)) return 'PART_TIME';
    if (/full[- ]?time|permanent|regular/.test(t)) return 'FULL_TIME';
    return null;
};
