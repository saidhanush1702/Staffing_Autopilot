/**
 * ── WHO POSTED THIS JOB ───────────────────────────────────────────────
 *
 * A pure function over `job_postings.description`. No API call, no cost, no
 * database. It is step 1 of the contact waterfall precisely because it is free:
 * every name found here is an Apollo credit not spent.
 *
 * ── WHAT IT IS ACTUALLY FOR ───────────────────────────────────────────
 *
 * Boards differ, and they differ predictably. LinkedIn and Dice postings are
 * usually written by a named recruiter and say so — "Posted by Sarah Chen",
 * "Please send your resume to Mark". Greenhouse and Lever postings are written
 * by the company and name nobody. So this returns a name for roughly the boards
 * you would expect and null for the rest, and null is the ordinary answer, not
 * a failure — it is what routes the waterfall to its company-level fallback.
 *
 * ── WHY THE REJECTION LIST IS THE IMPORTANT HALF ──────────────────────
 *
 * The patterns are the easy part. The hard part is that "Contact: HR Team" and
 * "Contact: Sarah Chen" are the same sentence, and only one of them is a person.
 * Sending "HR Team" to a paid people-match endpoint costs a credit to be told
 * what we already knew, and — far worse — a fuzzy matcher may return SOMEBODY at
 * that company, which a recruiter then emails by name. A wrong contact is worse
 * than no contact, because no contact is obviously nothing and a wrong contact
 * looks like an answer.
 *
 * So the shape test is deliberately strict: two or three capitalised words that
 * look like a human name, and nothing on the generic list. It would rather miss
 * a real poster than invent one.
 */

/**
 * Words that make a "name" not a person.
 *
 * Matched as substrings of the whole lowercased candidate, because the generic
 * sender is spelled a dozen ways — "HR Team", "HR Dept", "the HR department" —
 * and the word that gives it away is the part they share.
 */
const GENERIC_TERMS = [
    'human resource', 'talent', 'recruit', 'recruiting', 'recruitment',
    'career', 'careers', 'hiring', 'staffing', 'personnel', 'people ops',
    'no-reply', 'noreply', 'do not reply', 'donotreply',
    'team', 'department', 'dept', 'desk', 'group', 'office', 'admin',
    'support', 'info', 'contact', 'sales', 'apply', 'application', 'jobs',
    'manager', 'director', 'coordinator', 'specialist', 'partner',
];

/** Tokens that mean the capitalised phrase is a company, not a human. */
const COMPANY_SUFFIXES = [
    'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'company', 'co',
    'gmbh', 'plc', 'llp', 'technologies', 'solutions', 'systems', 'services',
    'consulting', 'consultancy', 'labs', 'software', 'global', 'international',
    'hr',
];

/**
 * Words that look like names to a regex but never are.
 *
 * These appear capitalised mid-sentence often enough to slip through the shape
 * test — "Send Your Resume", "Equal Opportunity Employer" — and each one that
 * escapes becomes a paid lookup for a phrase.
 */
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'we', 'our', 'us', 'you', 'your', 'this', 'that',
    'send', 'email', 'please', 'apply', 'submit', 'resume', 'cv', 'position',
    'role', 'job', 'candidate', 'candidates', 'applicant', 'applicants',
    'equal', 'opportunity', 'employer', 'all', 'any', 'and', 'or', 'for',
    'with', 'at', 'to', 'from', 'via', 'through', 'about', 'more', 'details',
    'immediately', 'urgent', 'required', 'requirements', 'responsibilities',
    'qualifications', 'benefits', 'salary', 'location', 'remote', 'onsite',
    'hybrid', 'full', 'time', 'part', 'contract', 'permanent', 'client',
    'note', 'notes', 'regards', 'thanks', 'sincerely', 'best', 'cheers',
]);

/**
 * Two or three capitalised, name-shaped words.
 *
 * Deliberately bounded. An unbounded capture would happily swallow the rest of
 * the paragraph after "Contact", and the shape test downstream would then
 * reject a real name because a sentence came with it.
 *
 * The separator is spaces and tabs, NOT `\s`, so a name can never run across a
 * line break. `\s` matches newlines, which made a sign-off capture the name and
 * then the company underneath it — "John Smith Acme" — and made "Recruiter:
 * Priya Nair\nApply today" capture "Priya Nair Apply". A person's name is on one
 * line; the line ending is a real boundary and this is where it is honoured.
 */
const WORD_GAP = '[ \\t\\u00a0]+';
const NAME_WORD = "[A-Z][a-zA-Z'’\\-]{1,19}";
const NAME_CHARS = `${NAME_WORD}(?:${WORD_GAP}${NAME_WORD}){1,2}`;

/**
 * Make a literal keyword match in any case, WITHOUT the `i` flag.
 *
 * The flag would be the obvious way to do this and is the wrong one: it applies
 * to the whole pattern, including the `[A-Z]` that is supposed to mean "this
 * word is capitalised, so it might be a name". Under `i`, `[A-Z]` matches every
 * letter, the capture runs on past the name into the rest of the sentence
 * ("Alan Turing today"), and the shape test then rejects a name it should have
 * accepted. So the keywords are made case-tolerant one letter at a time and the
 * capitalisation rule stays real.
 */
const ci = (literal) => literal.replace(
    /[a-z]/g,
    (c) => `[${c.toUpperCase()}${c}]`,
);

/**
 * The patterns, most trustworthy first.
 *
 * Order matters: the first pattern yielding a valid-looking name wins, so an
 * explicit "Posted by X" outranks a bare "Contact X", which outranks a sign-off
 * at the bottom of the advert.
 */
const PATTERNS = [
    // "Posted by Sarah Chen" · "Job posted by Sarah Chen, Technical Recruiter"
    new RegExp(`\\b${ci('posted')}\\s+${ci('by')}[:\\s]+(${NAME_CHARS})`),
    // "Recruiter: Sarah Chen" · "Hiring Manager - Sarah Chen"
    new RegExp(`\\b(?:${ci('recruiter')}|${ci('hiring')}\\s+${ci('manager')}|${ci('point')}\\s+${ci('of')}\\s+${ci('contact')}|${ci('poc')})\\s*[:\\-—]\\s*(${NAME_CHARS})`),
    // "Please contact Sarah Chen at ..." · "reach out to Sarah Chen"
    new RegExp(`\\b(?:${ci('contact')}|${ci('reach')}\\s+${ci('out')}\\s+${ci('to')}|${ci('speak')}\\s+(?:${ci('to')}|${ci('with')})|${ci('get')}\\s+${ci('in')}\\s+${ci('touch')}\\s+${ci('with')})\\s+(${NAME_CHARS})`),
    // "Send your resume to Sarah Chen"
    new RegExp(`\\b(?:${ci('send')}|${ci('forward')}|${ci('share')})\\s+(?:${ci('your')}\\s+)?(?:${ci('resume')}|${ci('cv')}|${ci('profile')}|${ci('details')})\\s+${ci('to')}\\s+(${NAME_CHARS})`),
    // "Contact: Sarah Chen" · "Contact Person: Sarah Chen"
    new RegExp(`\\b${ci('contact')}(?:\\s+${ci('person')}|\\s+${ci('name')})?\\s*[:\\-—]\\s*(${NAME_CHARS})`),
    // An email sign-off. Last, because a signature is often the company's.
    new RegExp(`\\b(?:${ci('regards')}|${ci('thanks')}|${ci('sincerely')}|${ci('best')})\\s*[,.]?\\s*\\n+\\s*(${NAME_CHARS})`),
];

/** Squash the whitespace a scraped description arrives with. */
const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Does this candidate look like a human being?
 *
 * Exported because the waterfall applies the same test to names arriving from
 * elsewhere — a manual entry, a provider's idea of a person — and two different
 * definitions of "is this a name" would eventually disagree.
 */
export const looksLikePersonName = (candidate) => {
    const name = tidy(candidate);
    if (name.length < 4 || name.length > 60) return false;

    const words = name.split(' ');
    if (words.length < 2 || words.length > 3) return false;

    const lower = name.toLowerCase();
    if (GENERIC_TERMS.some((term) => lower.includes(term))) return false;

    return words.every((word) => {
        const bare = word.toLowerCase().replace(/[^a-z]/g, '');
        if (bare.length < 2) return false;
        if (STOP_WORDS.has(bare)) return false;
        if (COMPANY_SUFFIXES.includes(bare)) return false;
        // Capitalised, and not SHOUTING — an all-caps run is a heading
        // ("SKILLS REQUIRED"), not a person.
        return /^[A-Z]/.test(word) && word !== word.toUpperCase();
    });
};

/**
 * Drop trailing words until what is left looks like a name.
 *
 * The capture is greedy — it takes three words when three are available —  and
 * the third is often the start of the next sentence rather than part of the
 * name: "Recruiter: Priya Nair Apply today" hands back "Priya Nair Apply".
 * Rejecting the whole candidate there loses a real name because of a word that
 * was never part of it, so the extra word is dropped and the rest re-tested.
 *
 * It only ever shortens, and the result still has to pass the full shape test,
 * so this cannot turn a non-name into a name.
 */
const trimToName = (candidate) => {
    let words = tidy(candidate).split(' ');

    while (words.length > 2 && !looksLikePersonName(words.join(' '))) {
        words = words.slice(0, -1);
    }

    const name = words.join(' ');
    return looksLikePersonName(name) ? name : null;
};

/**
 * The name of whoever posted a job, if the posting says.
 *
 * @param   description  job_postings.description, as scraped
 * @returns {{name: string, matchedBy: string}} | null
 *
 * `matchedBy` names the pattern that fired. It is recorded on the lookup row, so
 * that when a pattern starts producing rubbish it can be found and removed
 * rather than guessed at.
 */
export const extractPosterName = (description) => {
    const text = String(description ?? '');
    if (text.trim().length === 0) return null;

    for (let i = 0; i < PATTERNS.length; i += 1) {
        const match = text.match(PATTERNS[i]);
        if (!match) continue;

        const name = trimToName(match[1]);
        if (name) return { name, matchedBy: `pattern_${i}` };
    }
    return null;
};

export const __test = { GENERIC_TERMS, PATTERNS, STOP_WORDS };
