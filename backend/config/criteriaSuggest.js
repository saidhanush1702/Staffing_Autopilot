/**
 * ── A STARTING POINT FOR A CONSULTANT'S SEARCH CRITERIA ───────────────
 *
 * Almost every consultant has no active criteria, and a consultant with none is
 * invisible to the matcher: it fails closed, on purpose. Asking a recruiter to
 * type fifty terms for fifty people is why the bench stayed empty.
 *
 * This builds a PROPOSAL from what the system already holds about the person —
 * the titles they have worked under, the skills they listed, where they live.
 * It is pure: no database, so every rule is testable, and the caller decides
 * whether to show it, save it as a version, or throw it away.
 *
 * ── WHAT IT WILL NOT DO ───────────────────────────────────────────────
 *
 *   · Invent. Every term traces to a field the consultant (or their recruiter)
 *     filled in; `basis` says which, so the proposal can be explained.
 *   · Choose pay. A minimum rate is a business decision, left empty.
 *   · Choose remote. "Anywhere" widens the net enormously, so it is an explicit
 *     option, not a default.
 *   · Activate anything. A proposal saved as a version is still PAUSED until a
 *     person switches it on (see matchingController.bootstrap).
 */
import { normalise, isEmpty } from './criteriaSchema.js';

/**
 * A skill that, on its own, says what role someone is looking for. Lowercase
 * and matched whole, against names with the punctuation kept ("Node.js").
 */
const SKILL_TITLES = [
    [['react', 'react.js', 'reactjs'], 'React Developer'],
    [['angular', 'angularjs'], 'Angular Developer'],
    [['vue', 'vue.js'], 'Vue Developer'],
    [['node', 'node.js', 'nodejs', 'express'], 'Node.js Developer'],
    [['python', 'django', 'flask', 'fastapi'], 'Python Developer'],
    [['java', 'spring', 'spring boot'], 'Java Developer'],
    [['.net', 'c#', 'asp.net'], '.NET Developer'],
    [['docker', 'kubernetes', 'terraform', 'jenkins', 'ci/cd', 'cicd', 'devops'], 'DevOps Engineer'],
    [['aws', 'azure', 'gcp', 'google cloud'], 'Cloud Engineer'],
    [['react native', 'flutter', 'swift', 'kotlin'], 'Mobile Developer'],
];

/** Skills too generic to be a search keyword. */
const TOO_GENERIC = new Set(['git', 'github', 'jira', 'agile', 'scrum', 'office', 'excel', 'communication']);

const MAX_TITLES = 8;
const MAX_DERIVED_TITLES = 3;
const MAX_KEYWORDS = 8;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => clean(s).toLowerCase();

/**
 * @param input {
 *   experience: [{ title, is_current }]   newest first, as the profile orders them
 *   skills:     [{ name }]                the consultant's own order
 *   city, state
 * }
 * @param options { includeRemote }
 * @returns {{ criteria, basis, usable }}
 *   `usable` is false when the proposal says nothing positive — the matcher
 *   would ignore it, so saving it would only look like progress.
 */
export const suggestCriteria = (input = {}, { includeRemote = false } = {}) => {
    const experience = input.experience ?? [];
    const skills = (input.skills ?? []).map((s) => clean(s.name)).filter(Boolean);
    const basis = { titles: [], derivedTitles: [], keywords: [], location: null };

    /* ── titles ──────────────────────────────────────────────────── */
    // The current role first: it is the strongest statement of what someone
    // does, and the matcher reads earlier titles as higher priority.
    const ordered = [...experience].sort((a, b) => Number(Boolean(b.is_current)) - Number(Boolean(a.is_current)));
    const titles = [];
    const seen = new Set();
    for (const e of ordered) {
        const t = clean(e.title);
        if (!t || seen.has(key(t))) continue;
        seen.add(key(t));
        titles.push(t);
        basis.titles.push(t);
    }

    // Roles the skills point at, for the consultant whose recorded titles are
    // vague ("Consultant") or absent. Only ones not already covered.
    const skillKeys = new Set(skills.map(key));
    let derived = 0;
    for (const [names, title] of SKILL_TITLES) {
        if (derived >= MAX_DERIVED_TITLES) break;
        if (!names.some((n) => skillKeys.has(n))) continue;
        if (seen.has(key(title))) continue;
        seen.add(key(title));
        titles.push(title);
        basis.derivedTitles.push(title);
        derived += 1;
    }

    /* ── keywords ────────────────────────────────────────────────── */
    const keywords = skills
        .filter((s) => !TOO_GENERIC.has(key(s)))
        .slice(0, MAX_KEYWORDS);
    basis.keywords = keywords;

    /* ── locations ───────────────────────────────────────────────── */
    const locations = [];
    const city = clean(input.city);
    const state = clean(input.state);
    if (city || state) {
        // The schema wants a city for an on-site row; a state alone is not a
        // place anyone can be matched against yet.
        if (city) {
            locations.push({ city, state: state || null, workMode: 'ONSITE', radiusMiles: null });
            basis.location = [city, state].filter(Boolean).join(', ');
        }
    }
    if (includeRemote) locations.push({ city: null, state: null, workMode: 'REMOTE', radiusMiles: null });

    const criteria = normalise({
        jobTitles: titles.slice(0, MAX_TITLES),
        keywordsInclude: keywords,
        keywordsExclude: [],
        excludedCompanies: [],
        locations,
        workTypeIds: [],
        minPay: { amount: null, unit: null, currency: 'USD' },
    });

    return { criteria, basis, usable: !isEmpty(criteria) };
};
