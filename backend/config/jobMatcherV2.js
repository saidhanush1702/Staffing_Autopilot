/**
 * ── MATCHING v2 ───────────────────────────────────────────────────────
 *
 * Same question as v1 — *which consultant is this job useful for?* — answered
 * from what the person can DO rather than from the words in a title.
 *
 *   1  hard filters       excluded company / keyword                (v1's, shared)
 *   2  relevance floor    no skill overlap AND no shared role family → drop early
 *   3  score              skills coverage 50 · role family 25 · level 10
 *                         · location 10 · work type & pay 5
 *   4  bucket             AUTO (queue it) · SUGGEST (a recruiter looks) · DROP
 *
 * Every number comes with a reason a recruiter can read, because "why did this
 * match?" gets asked about a specific job months later.
 *
 * ── PURE ──────────────────────────────────────────────────────────────
 *
 * No database. Everything it needs about the consultant arrives on `criteria`
 * (`criteria.skills`, `criteria.totalYears`, …), loaded once per bench by
 * `loadMatchableConsultants`. That is what makes it testable against real
 * postings, and what lets one function serve the webhook, the poller, the ATS
 * mirror and the re-match identically.
 *
 * (jobMatcher.js and this file import each other. Neither uses the other at
 * load time, only inside a function, so the cycle is harmless — and keeping
 * v1's primitives where they are means v1 is not touched by v2 at all.)
 */
import {
    hardFilter, hasPositiveSignal, norm,
} from './jobMatcher.js';
import {
    canonicalOf, extractSkills, expandSkills, coverage, jobSkills, CONCEPTS,
    familiesOf, levelOf, levelFromYears, labelOf,
} from './skillGraph.js';
import { locationFit } from './locations.js';
import { eligibility } from './eligibility.js';

/** Scores at or above this go straight to the consultant's queue. */
export const AUTO_THRESHOLD = 75;
/** Between this and AUTO a recruiter sees it as a suggestion; below, it is dropped. */
export const SUGGEST_THRESHOLD = 55;

const WEIGHT = {
    coverage: 50, family: 25, level: 10, location: 10, misc: 5,
};

/**
 * The consultant's skills as canonical names, plus the literal names the graph
 * does not know ("Elixir" is still a skill they claimed).
 */
const heldSkills = (criteria) => {
    const names = [
        ...(criteria.skills ?? []).map((s) => (typeof s === 'string' ? s : s.name)),
        // Search keywords are things they said they want to work with.
        ...(criteria.keywordsInclude ?? []),
    ].filter(Boolean);

    const canon = new Set();
    const literal = [];
    for (const name of names) {
        const c = canonicalOf(name) ?? extractSkills(name)[0] ?? null;
        if (c) canon.add(c);
        else literal.push(norm(name));
    }
    return { canon: [...canon], literal: [...new Set(literal)] };
};

/** Literal skills the posting mentions, so an unknown skill can still match itself. */
const literalHits = (literal, text) => literal.filter((l) => l.length > 2
    && new RegExp(`(^|[^a-z0-9])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(text));

const wordOverlap = (a, b) => {
    const words = norm(b).split(' ').filter((w) => w.length > 2);
    if (words.length === 0) return 0;
    return words.filter((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i').test(norm(a))).length / words.length;
};

/* ── the parts of the score ───────────────────────────────────────────── */

/** Role family and title: do they do this kind of work? */
export const familyScore = (posting, criteria, jobSkillList, held) => {
    const jobFamilies = familiesOf(posting.title, jobSkillList);
    const wanted = criteria.jobTitles ?? [];
    const mine = new Set();
    for (const t of wanted) for (const f of familiesOf(t, [])) mine.add(f);
    for (const f of familiesOf('', held)) mine.add(f);

    const shared = [...jobFamilies].filter((f) => mine.has(f));
    const bestWords = wanted.length ? Math.max(...wanted.map((t) => wordOverlap(posting.title, t))) : 0;

    // A shared family is the strong signal. A near-identical title is as good,
    // whatever family words it does or does not contain ("Account Manager").
    if (shared.length > 0 || bestWords >= 0.8) {
        return { points: WEIGHT.family, shared, why: shared.length ? `role: ${shared.join('/')}` : 'title matches' };
    }
    if (bestWords >= 0.5) return { points: Math.round(WEIGHT.family * 0.4), shared, why: 'title partly matches' };
    return { points: 0, shared, why: null };
};

/** Level: a senior is not sent junior roles, and the reverse. Unknown is neutral. */
export const levelScore = (posting, criteria) => {
    const job = levelOf(posting.title);
    const me = criteria.level ?? levelFromYears(criteria.totalYears);
    if (job === null || me === null || me === undefined) return { points: Math.round(WEIGHT.level * 0.7), why: null };
    const gap = Math.abs(job - me);
    if (gap === 0) return { points: WEIGHT.level, why: 'level fits' };
    if (gap === 1) return { points: Math.round(WEIGHT.level * 0.6), why: 'level one step off' };
    return { points: 0, why: `level mismatch (job ${job}, consultant ${me})` };
};

/**
 * Location, by the rule in locations.js: feasible, near, remote or willing to
 * move all count. Only on-site/hybrid elsewhere, for someone who will not move,
 * is a rejection.
 */
export const locationScore = (posting, criteria) => {
    const fit = locationFit(posting, criteria);
    return {
        points: Math.round(fit.points), pass: fit.pass, why: fit.why, mode: fit.mode, cap: Boolean(fit.cap),
    };
};

/** Work type and pay: small, and mostly a tie-breaker. */
export const miscScore = (posting, criteria, workTypeName) => {
    let points = 3;
    const why = [];
    const types = criteria.workTypeNames ?? [];
    if (types.length > 0 && workTypeName) {
        if (types.includes(workTypeName)) { points += 2; why.push(`work type: ${workTypeName}`); }
        else { points -= 5; why.push(`work type mismatch (${workTypeName})`); }
    }
    // Pay below the floor is a deal-breaker now, decided in eligibility.js.
    return { points: Math.max(-10, Math.min(WEIGHT.misc, points)), why: why.join('; ') || null };
};

/* ── the whole decision ───────────────────────────────────────────────── */

const bucketOf = (score) => (score >= AUTO_THRESHOLD ? 'AUTO' : score >= SUGGEST_THRESHOLD ? 'SUGGEST' : 'DROP');

/**
 * @returns {{ matched, bucket, stage, score, reason, detail }}
 *   `matched` means AUTO — the same meaning v1's has for the doors that read it.
 *   SUGGEST jobs are `matched: false` with `bucket: 'SUGGEST'`.
 */
export const evaluateV2 = (posting, criteria, options = {}) => {
    const drop = (stage, reason) => ({
        matched: false, bucket: 'DROP', stage, score: 0, reason, detail: null,
    });

    // Fail closed, exactly as v1: a set that says nothing positive matches nothing.
    if (!hasPositiveSignal(criteria)) return drop('hard', 'Criteria describe nothing to look for');

    const hard = hardFilter(posting, criteria);
    if (!hard.pass) return drop('hard', hard.reason);

    // Deal-breakers the posting states outright (citizens only, W2 only, pay
    // below their floor). Softer concerns come back as CAP and are applied to
    // the bucket below.
    const elig = eligibility(posting, criteria);
    if (elig.verdict === 'DROP') return drop('hard', elig.reasons.join('; '));

    /* skills */
    const mine = heldSkills(criteria);
    const held = expandSkills(mine.canon);
    const text = `${posting.title ?? ''}\n${posting.description ?? ''}`;
    const job = jobSkills({ title: posting.title, description: posting.description });
    const lit = literalHits(mine.literal, norm(text));
    const weights = new Map(job.weights);
    for (const l of lit) weights.set(`lit:${l}`, 2);
    const jobWithLiterals = {
        required: [...job.required, ...lit.map((l) => `lit:${l}`)],
        preferred: job.preferred,
        weights,
    };
    for (const l of lit) held.set(`lit:${l}`, { credit: 1, via: l, kind: 'HAS' });
    const cov = coverage(jobWithLiterals, held);

    /* role family */
    const fam = familyScore(posting, criteria, job.required, mine.canon);

    // Cheapest rejection first: nothing in common at all.
    if ((cov.ratio ?? 0) === 0 && fam.points === 0) {
        return drop('prefilter', 'No skill or role overlap');
    }

    const covPoints = cov.ratio === null ? Math.round(WEIGHT.coverage * 0.3) : Math.round(WEIGHT.coverage * cov.ratio);
    const lvl = levelScore(posting, criteria);
    const loc = locationScore(posting, criteria);
    if (!loc.pass) return drop('prefilter', loc.why);
    const misc = miscScore(posting, criteria, options.workTypeName);

    const score = Math.max(0, Math.min(100,
        covPoints + fam.points + lvl.points + loc.points + misc.points));

    const parts = [];
    if (cov.matched.length) {
        parts.push('skills: ' + cov.matched.slice(0, 6).map((m) => (m.kind === 'HAS'
            ? `${labelOf(m.skill.replace(/^lit:/, ''))} ✔`
            : `${labelOf(m.skill)} ≈ via ${labelOf(m.via)}`)).join(', '));
    }
    const lacking = cov.missing.filter((m) => m.required).slice(0, 3);
    if (lacking.length) parts.push(`missing: ${lacking.map((m) => labelOf(m.skill.replace(/^lit:/, ''))).join(', ')}`);
    for (const w of [fam.why, lvl.why, loc.why, misc.why]) if (w) parts.push(w);

    // A role that needs them to move is never queued on its own, however well
    // the skills fit: "open to relocate" means a person should ask, not that
    // every job in another country goes straight into their list.
    const needsMove = loc.mode === 'RELOCATE';
    // A tool the TITLE names that they do not have ("PHP Full Stack Developer",
    // ".NET / React") is a role to ask about, however well the rest fits.
    const titleGaps = cov.missing.filter((m) => (weights.get(m.skill) ?? 0) >= 3
        && !CONCEPTS.has(m.skill) && !m.skill.startsWith('lit:'));
    if (titleGaps.length) parts.push(`check: the title asks for ${titleGaps.map((m) => labelOf(m.skill)).join(', ')}`);
    const needsLook = elig.verdict === 'CAP' || Boolean(loc.cap) || titleGaps.length > 0;
    const bucket = (needsMove || needsLook) && bucketOf(score) === 'AUTO' ? 'SUGGEST' : bucketOf(score);
    for (const r of elig.reasons) parts.push(`check: ${r}`);

    return {
        matched: bucket === 'AUTO',
        bucket,
        stage: 'score',
        score,
        reason: parts.join('; ') || 'no strong signals',
        detail: {
            coverage: cov.ratio,
            matched: cov.matched.map((m) => ({ skill: m.skill, credit: Number(m.credit.toFixed(2)), via: m.via, kind: m.kind })),
            missing: cov.missing.map((m) => m.skill),
            families: fam.shared,
            points: { coverage: covPoints, family: fam.points, level: lvl.points, location: loc.points, misc: misc.points },
        },
    };
};
