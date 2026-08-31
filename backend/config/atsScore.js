/**
 * ── THE ATS SCORE ─────────────────────────────────────────────────────
 *
 * How much of a job description's vocabulary a resume actually contains,
 * expressed 0–100.
 *
 * ── WHY THIS IS CODE AND NOT A MODEL CALL ─────────────────────────────
 *
 * The obvious implementation is to ask the model that just wrote the resume how
 * good the resume is. It will say it is good. Every time, for every resume,
 * including the bad ones — and a number that is always high is not a
 * measurement, it is decoration.
 *
 * A keyword-coverage count is cruder, and it is honest. It computes the same
 * way for the base resume and the tailored one, so the DIFFERENCE between them
 * is meaningful even where the absolute number is arguable. That difference is
 * the only claim being made: "tailoring moved this from 41 to 68". It costs
 * nothing, cannot be gamed by the thing it is grading, and is the same number
 * tomorrow.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────
 *
 * It is not a prediction of what any particular applicant tracking system will
 * do. Those are closed, they differ, and several do not score at all. It is a
 * proxy for the one thing they demonstrably share: matching the words in the
 * posting.
 */

/**
 * Words carrying no signal. Ordinary English stopwords, plus the boilerplate
 * every posting repeats — "responsibilities", "equal opportunity", "benefits" —
 * which would otherwise dominate a frequency count and make every resume score
 * the same.
 */
const STOPWORDS = new Set([
    'a', 'about', 'above', 'across', 'after', 'against', 'all', 'also', 'am', 'an',
    'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being',
    'below', 'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing',
    'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
    'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if',
    'in', 'into', 'is', 'it', 'its', 'just', 'me', 'more', 'most', 'my', 'no',
    'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our',
    'out', 'over', 'own', 'per', 's', 'same', 'she', 'should', 'so', 'some',
    'such', 't', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
    'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
    'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
    'whom', 'why', 'will', 'with', 'would', 'you', 'your',

    // Posting boilerplate.
    'ability', 'applicants', 'apply', 'benefits', 'candidate', 'candidates',
    'company', 'compensation', 'description', 'employer', 'employment', 'equal',
    'experience', 'holidays', 'including', 'insurance', 'job', 'join', 'life',
    'looking', 'must', 'offer', 'opportunity', 'paid', 'plus', 'position',
    'preferred', 'qualifications', 'required', 'requirements', 'responsibilities',
    'role', 'salary', 'seeking', 'skills', 'team', 'time', 'vision', 'work',
    'working', 'years',
]);

/**
 * Section headings that mark the part of a posting that actually describes the
 * job. Terms found under one of these count double — a skill in the
 * requirements list matters more than the same word in a benefits paragraph.
 */
const WEIGHTED_HEADINGS = /\b(requirements?|qualifications?|skills?|must have|you have|what you.{0,10}bring|technical|stack|responsibilities|experience with)\b/i;

const WEIGHT_IN_REQUIREMENTS = 2;
const WEIGHT_IN_CRITERIA = 1.5;

/** Lowercase, strip punctuation, keep the characters real technology names use. */
const tokenise = (text) => String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[-./]+|[-./]+$/g, ''))
    .filter((w) => w.length >= 2 && w.length <= 40);

/**
 * Which slice of the posting each line belongs to.
 *
 * A single pass down the text: a heading switches the weight on, and it stays
 * on until the next heading. Crude, and it matches how postings are actually
 * laid out far better than trying to parse their structure.
 */
const weightedLines = (jobText) => {
    const lines = String(jobText ?? '').split('\n');
    const out = [];
    let weight = 1;

    for (const line of lines) {
        if (WEIGHTED_HEADINGS.test(line)) weight = WEIGHT_IN_REQUIREMENTS;
        else if (line.trim() === '') weight = Math.max(1, weight - 0.5);
        out.push({ text: line, weight });
    }
    return out;
};

/**
 * The keywords a job description is actually asking for, each with a weight.
 *
 * Single words and two-word phrases both count. Phrases matter: "machine
 * learning" and "unit testing" are single concepts, and scoring them as four
 * unrelated words credits a resume that mentions "learning" in an unrelated
 * sentence.
 *
 * @param jobText      the posting
 * @param criteriaTerms the consultant's own search criteria skills. A term the
 *   agency already decided this person is placed on is worth more than an
 *   incidental word, so it is weighted up.
 */
export const extractKeywords = (jobText, criteriaTerms = []) => {
    const weights = new Map();
    const criteria = new Set(
        criteriaTerms.map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    );

    const bump = (term, amount) => {
        if (!term || STOPWORDS.has(term)) return;
        if (/^\d+$/.test(term)) return;          // bare numbers are noise
        weights.set(term, (weights.get(term) ?? 0) + amount);
    };

    for (const { text, weight } of weightedLines(jobText)) {
        const words = tokenise(text);

        for (let i = 0; i < words.length; i += 1) {
            const word = words[i];
            bump(word, weight);

            if (i + 1 < words.length) {
                const next = words[i + 1];
                // A phrase is only interesting when neither half is a stopword;
                // "of experience" is not a skill.
                if (!STOPWORDS.has(word) && !STOPWORDS.has(next)) {
                    bump(`${word} ${next}`, weight * 1.2);
                }
            }
        }
    }

    for (const [term, weight] of weights) {
        if (criteria.has(term)) weights.set(term, weight * WEIGHT_IN_CRITERIA);
    }

    return weights;
};

/**
 * Score a resume against a job description.
 *
 * @returns {{score, matched, missing, totalKeywords}}
 *   `missing` is ordered by weight — the most important absent terms first,
 *   which is what makes the number actionable rather than merely a number.
 */
export const scoreResume = (resumeText, jobText, criteriaTerms = []) => {
    const keywords = extractKeywords(jobText, criteriaTerms);

    if (keywords.size === 0) {
        // A posting with no description is not a resume's fault. Zero would
        // read as "this resume is terrible"; null says "not measurable".
        return {
            score: null, matched: [], missing: [], totalKeywords: 0,
        };
    }

    const haystack = ` ${tokenise(resumeText).join(' ')} `;

    let hit = 0;
    let total = 0;
    const matched = [];
    const missing = [];

    for (const [term, weight] of keywords) {
        total += weight;
        // Padded, so "java" does not match inside "javascript" and "r" does not
        // match inside every word containing the letter.
        if (haystack.includes(` ${term} `)) {
            hit += weight;
            matched.push({ term, weight: Number(weight.toFixed(2)) });
        } else {
            missing.push({ term, weight: Number(weight.toFixed(2)) });
        }
    }

    missing.sort((a, b) => b.weight - a.weight);
    matched.sort((a, b) => b.weight - a.weight);

    return {
        score: Math.round((hit / total) * 100),
        matched: matched.slice(0, 40),
        missing: missing.slice(0, 40),
        totalKeywords: keywords.size,
    };
};

/**
 * The full text of a posting, as the scorer should see it.
 *
 * Title and company are included on purpose. A resume whose own job titles echo
 * the posting's title genuinely does match it better, and that is exactly the
 * kind of alignment tailoring is allowed to surface.
 */
export const postingText = (posting) => [
    posting?.title, posting?.company, posting?.description,
].filter(Boolean).join('\n');
