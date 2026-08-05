/**
 * ── QUESTION NORMALISATION AND CATEGORY CLASSIFICATION ────────────────
 *
 * Two small, pure functions that decide most of what the answer bank is worth:
 *
 *   normaliseQuestion()  →  are these two questions the SAME question?
 *   classifyQuestion()   →  who is allowed to approve the answer?
 *
 * Both are deliberately dull. They are pure string functions with no database
 * access precisely so they can be unit-tested against real form wording later
 * without standing anything up.
 */

/* ── normalisation ────────────────────────────────────────────────────── */

/**
 * Words that carry no meaning for matching. Kept SHORT on purpose — every word
 * removed is a chance for two genuinely different questions to collapse into
 * one. "Do you require sponsorship?" and "Do you have sponsorship?" must not
 * become the same key, so `require` and `have` are absent from this list.
 */
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'please', 'kindly',
]);

/**
 * The matching key for a question.
 *
 * Lowercase → strip punctuation → drop stop words → collapse whitespace.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: stemming, synonym expansion, edit
 * distance, embeddings. Two questions match only when they are textually the
 * same question.
 *
 * The asymmetry of the two failure modes is the whole argument:
 *
 *   too loose → an answer is reused for a question that only LOOKED similar,
 *               and the system submits something untrue on a real application
 *   too tight → the consultant answers the same question twice, and the bank
 *               carries a duplicate
 *
 * The second is an annoyance. The first puts words in someone's mouth on a job
 * application. So this errs tight, and fuzzy matching waits until there is real
 * form data to tune a threshold against — inventing one now, with zero real
 * questions in the database, would be guessing.
 */
export const normaliseQuestion = (text) => String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')                    // fold accents and odd unicode forms
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')         // punctuation is never meaningful here
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ')
    .trim();

/* ── classification ───────────────────────────────────────────────────── */

/**
 * Signals for the two owner-only categories from R-07.
 *
 * Word-boundary matched, so "rate" does not fire on "corporate" and "pay" does
 * not fire on "paypal".
 */
const SIGNALS = {
    SALARY: [
        'salary', 'compensation', 'pay', 'payrate', 'rate', 'wage', 'wages',
        'ctc', 'remuneration', 'stipend', 'bonus', 'hourly', 'annually',
        'expected pay', 'desired pay', 'billing',
    ],
    WORK_AUTH: [
        'sponsorship', 'sponsor', 'visa', 'authorized', 'authorised',
        'authorization', 'authorisation', 'citizen', 'citizenship',
        'green card', 'greencard', 'h1b', 'h 1b', 'ead', 'opt', 'cpt',
        'tn visa', 'immigration', 'right to work', 'work permit', 'eligible to work',
    ],
};

/**
 * Suggest a category for a question.
 *
 * ── WHY THE UNKNOWN CASE ROUTES TO THE OWNER ──────────────────────────
 *
 * When no signal fires, this returns `GENERAL` with `confident: false`, and the
 * caller files the question as owner-approval-required anyway.
 *
 * The two mistakes are not the same size:
 *
 *   a GENERAL question wrongly sent to the admin
 *       → one person spends thirty seconds on it
 *   a SALARY question wrongly marked GENERAL
 *       → a recruiter commits a rate on the consultant's behalf, which is
 *         exactly what R-07 exists to prevent
 *
 * So the default leans to the cheap error. A human can always recategorise
 * downward; nobody can un-commit a rate.
 *
 * @returns {{ category: string, confident: boolean, matched: string|null }}
 */
export const classifyQuestion = (text) => {
    const key = ` ${normaliseQuestion(text)} `;

    // `key` is padded with a space at both ends, and normalisation has already
    // reduced everything to space-separated words — so wrapping the signal in
    // spaces is a whole-word match. "rate" will not fire on "corporate".
    for (const [category, signals] of Object.entries(SIGNALS)) {
        const hit = signals.find((s) => key.includes(` ${s} `));
        if (hit) return { category, confident: true, matched: hit };
    }

    return { category: 'GENERAL', confident: false, matched: null };
};

/**
 * The category a NEW question should be filed under, given the classifier and
 * whatever a human explicitly chose.
 *
 * An explicit human choice always wins — the classifier is a suggestion, not an
 * authority. Only when nobody chose does the fail-safe apply.
 *
 * @param categories rows from lkp_question_categories
 * @param explicitName a category name a human picked, or null
 */
export const resolveCategory = (categories, text, explicitName = null) => {
    const byName = new Map(categories.map((c) => [c.name, c]));

    if (explicitName && byName.has(explicitName)) {
        return { row: byName.get(explicitName), auto: false };
    }

    const { category, confident } = classifyQuestion(text);

    if (confident && byName.has(category)) {
        return { row: byName.get(category), auto: true };
    }

    // Unsure. Prefer an explicit "needs a human to look" category if one is
    // seeded; otherwise fall back to any owner-only category rather than to
    // GENERAL, so an unclassified question never lands on a recruiter's desk
    // by default.
    const uncategorised = byName.get('UNCATEGORISED');
    if (uncategorised) return { row: uncategorised, auto: true };

    const ownerOnly = categories.find((c) => c.requires_owner_approval);
    return { row: ownerOnly ?? byName.get('GENERAL') ?? categories[0], auto: true };
};
