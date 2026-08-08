/**
 * ── MATCHING A POSTING TO A CONSULTANT ────────────────────────────────
 *
 * Answers the only question this phase exists to answer: *which consultant is
 * this job useful for?*
 *
 * Input is a Phase 3 criteria version — titles, include/exclude keywords,
 * locations with work modes, work types, a minimum-pay floor, excluded
 * companies. Pure function, no database, so it is unit-testable against real
 * postings.
 *
 * ── THREE STAGES, IN THIS ORDER ───────────────────────────────────────
 *
 *   1. HARD FILTERS   excluded company, excluded keyword. Never a soft signal —
 *                     a hit here means no, regardless of how well the rest fits.
 *   2. PRE-FILTER     title + location only (R-16). Cheap, and the stage that
 *                     drops most of the volume. Anything expensive must run
 *                     after this, which is the whole reason R-16 exists.
 *   3. SCORE          include keywords, work type, pay, remote fit. Produces a
 *                     0-100 score and a human-readable reason.
 *
 * The reason string matters as much as the score: "why did this match?" is a
 * question a recruiter will ask about a specific job months later, and a bare
 * number cannot answer it.
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whole-word containment, so "go" does not match "golang". */
const hasWord = (haystack, needle) => {
    const n = norm(needle);
    if (!n) return false;
    return new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
        .test(haystack);
};

/** Loose containment, for multi-word titles where word order varies. */
const titleOverlap = (postingTitle, criteriaTitle) => {
    const words = norm(criteriaTitle).split(' ').filter((w) => w.length > 2);
    if (words.length === 0) return 0;
    const hit = words.filter((w) => hasWord(postingTitle, w)).length;
    return hit / words.length;
};

/* ── stage 1: hard filters ────────────────────────────────────────────── */

export const hardFilter = (posting, criteria) => {
    const company = norm(posting.company);
    for (const excluded of criteria.excludedCompanies ?? []) {
        // Substring, not whole-word: "Acme" must block "Acme Staffing LLC".
        if (company.includes(norm(excluded))) {
            return { pass: false, reason: `Excluded company: ${excluded}` };
        }
    }

    const haystack = `${norm(posting.title)} ${norm(posting.description)}`;
    for (const excluded of criteria.keywordsExclude ?? []) {
        if (hasWord(haystack, excluded)) {
            return { pass: false, reason: `Excluded keyword: ${excluded}` };
        }
    }

    return { pass: true };
};

/* ── stage 2: the cheap pre-filter (R-16) ─────────────────────────────── */

/**
 * Title and location only. No description scan, no scoring.
 *
 * A criteria set with no titles passes everything through — the consultant has
 * not said what they want, so this stage has nothing to filter on and the
 * scoring stage decides.
 */
export const preFilter = (posting, criteria) => {
    const titles = criteria.jobTitles ?? [];
    if (titles.length > 0) {
        const best = Math.max(...titles.map((t) => titleOverlap(posting.title, t)));
        // Half the significant words of some wanted title must appear.
        if (best < 0.5) return { pass: false, reason: 'Title does not match' };
    }

    const locations = criteria.locations ?? [];
    if (locations.length > 0) {
        const wantsRemote = locations.some((l) => l.workMode === 'REMOTE');
        if (posting.isRemote && wantsRemote) return { pass: true };

        const postingLocation = norm(posting.locationText);
        const cityHit = locations.some((l) => l.city && postingLocation.includes(norm(l.city)));
        const stateHit = locations.some((l) => l.state && postingLocation.includes(norm(l.state)));

        if (!cityHit && !stateHit && !(posting.isRemote && wantsRemote)) {
            return { pass: false, reason: 'Location does not match' };
        }
    }

    return { pass: true };
};

/* ── stage 3: score ───────────────────────────────────────────────────── */

/**
 * 0-100, with the reasons that produced it.
 *
 * Weights are deliberately blunt and legible rather than tuned. There is no
 * real posting data to tune against yet, and a fabricated weighting that looks
 * precise would be worse than one that is obviously a starting point.
 */
export const scoreMatch = (posting, criteria, { workTypeName } = {}) => {
    const reasons = [];
    let score = 0;

    // Title — the strongest signal, so the largest share.
    const titles = criteria.jobTitles ?? [];
    if (titles.length > 0) {
        let bestIndex = -1;
        let best = 0;
        titles.forEach((t, i) => {
            const overlap = titleOverlap(posting.title, t);
            if (overlap > best) { best = overlap; bestIndex = i; }
        });
        if (best > 0) {
            // Earlier titles are higher priority (Phase 3 stores them ordered),
            // so a first-choice title outscores a fourth-choice one.
            const priority = 1 - (bestIndex / Math.max(titles.length, 1)) * 0.3;
            score += Math.round(40 * best * priority);
            reasons.push(`title ≈ "${titles[bestIndex]}"`);
        }
    } else {
        score += 20;   // no stated titles: neutral, not disqualifying
    }

    // Include keywords.
    const includes = criteria.keywordsInclude ?? [];
    if (includes.length > 0) {
        const haystack = `${norm(posting.title)} ${norm(posting.description)}`;
        const hits = includes.filter((k) => hasWord(haystack, k));
        if (hits.length > 0) {
            score += Math.round(25 * (hits.length / includes.length));
            reasons.push(`keywords: ${hits.slice(0, 4).join(', ')}`);
        }
    } else {
        score += 12;
    }

    // Location fit.
    const locations = criteria.locations ?? [];
    if (locations.length > 0) {
        const wantsRemote = locations.some((l) => l.workMode === 'REMOTE');
        if (posting.isRemote && wantsRemote) {
            score += 15;
            reasons.push('remote, as wanted');
        } else {
            const postingLocation = norm(posting.locationText);
            const hit = locations.find((l) => (l.city && postingLocation.includes(norm(l.city)))
                || (l.state && postingLocation.includes(norm(l.state))));
            if (hit) {
                score += 15;
                reasons.push(`location: ${[hit.city, hit.state].filter(Boolean).join(', ')}`);
            }
        }
    } else {
        score += 8;
    }

    // Work type, when the posting actually declares one.
    const wantedTypes = criteria.workTypeNames ?? [];
    if (wantedTypes.length > 0 && workTypeName) {
        if (wantedTypes.includes(workTypeName)) {
            score += 10;
            reasons.push(`work type: ${workTypeName}`);
        } else {
            score -= 10;
            reasons.push(`work type mismatch (${workTypeName})`);
        }
    }

    // Minimum pay — only when the posting states pay in the SAME unit.
    // Comparing an hourly rate against an annual floor is how good jobs get
    // silently dropped, so a unit mismatch scores nothing rather than guessing.
    const floor = criteria.minPay;
    if (floor?.amount != null && posting.payUnit && posting.payUnit === floor.unit) {
        const offered = posting.payMax ?? posting.payMin;
        if (offered != null) {
            if (offered >= Number(floor.amount)) {
                score += 10;
                reasons.push(`pay ${offered} ≥ ${floor.amount} ${floor.unit.toLowerCase()}`);
            } else {
                score -= 20;
                reasons.push(`pay ${offered} below ${floor.amount} ${floor.unit.toLowerCase()}`);
            }
        }
    }

    return {
        score: Math.max(0, Math.min(100, score)),
        reason: reasons.join('; ') || 'no strong signals',
    };
};

/** Below this a match is not worth a slot against a daily cap. */
export const MATCH_THRESHOLD = 40;

/**
 * Does this criteria set say anything POSITIVE about what is wanted?
 *
 * Exclusions alone do not count. "Not Acme, not unpaid" describes what to
 * avoid, not what to look for, and matching on it would send the consultant
 * every job that merely fails to be excluded.
 *
 * This is the fail-closed rule Phase 3 established at the database level —
 * criteria sets start paused, and an unconfigured set cannot be activated. The
 * check is repeated here because the matcher is the last gate before a job
 * reaches somebody, and the neutral scores awarded for absent criteria happen
 * to sum to exactly the threshold. Without this, an emptied-out set would
 * match every posting in the pool.
 */
export const hasPositiveSignal = (criteria) => (
    (criteria.jobTitles ?? []).length > 0
    || (criteria.keywordsInclude ?? []).length > 0
    || (criteria.locations ?? []).length > 0
    || (criteria.workTypeNames ?? []).length > 0
    || criteria.minPay?.amount != null
);

/**
 * The whole decision for one posting × one consultant.
 *
 * @returns {{ matched, stage, score, reason }}
 *   stage is where it stopped — 'hard' | 'prefilter' | 'score' — which is what
 *   makes the per-run drop-rate reporting R-16 asks for possible.
 */
export const evaluate = (posting, criteria, options = {}) => {
    // Fail closed. A consultant who has not said what they want receives
    // nothing, rather than everything.
    if (!hasPositiveSignal(criteria)) {
        return {
            matched: false,
            stage: 'hard',
            score: 0,
            reason: 'Criteria describe nothing to look for',
        };
    }

    const hard = hardFilter(posting, criteria);
    if (!hard.pass) return { matched: false, stage: 'hard', score: 0, reason: hard.reason };

    const pre = preFilter(posting, criteria);
    if (!pre.pass) return { matched: false, stage: 'prefilter', score: 0, reason: pre.reason };

    const { score, reason } = scoreMatch(posting, criteria, options);
    return { matched: score >= MATCH_THRESHOLD, stage: 'score', score, reason };
};
