/**
 * ── WHAT GOES IN A FIELD ──────────────────────────────────────────────
 *
 * Pure string work: given a form field's visible label, what should be typed
 * into it? No browser, no network, no Playwright — so every matching decision
 * is unit-testable against real form wording without standing anything up.
 *
 * ── MATCHING IS DELIBERATELY TIGHT ────────────────────────────────────
 *
 * `normaliseQuestion` is a port of the hub's function, character for character,
 * so a key produced here is the same key the answer bank stores. If the two
 * ever disagree, the app parks items on questions that are already answered.
 *
 * Approved answers match on the WHOLE normalised question only. No stemming,
 * no synonyms, no edit distance. The asymmetry from the hub's comment applies
 * with more force here, because here it actually types:
 *
 *   too loose → an approved answer is reused for a question that only looked
 *               similar, and something untrue goes onto a real application
 *   too tight → the consultant answers the same question twice
 *
 * Profile fields are the one exception, and only for a short fixed list of
 * phrases that cannot mean anything else on a job application.
 */

const STOP_WORDS = new Set(['a', 'an', 'the', 'please', 'kindly']);

/** Port of the hub's normaliser. Must stay identical to it. */
const normaliseQuestion = (text) => String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .join(' ')
    .trim();

/**
 * Profile phrases. Every one of these is a whole normalised label, never a
 * substring: "state" must not fire on "what state of readiness".
 */
const PROFILE_KEYS = {
    fullName: ['name', 'full name', 'your name', 'legal name', 'full legal name',
        'candidate name', 'applicant name'],
    firstName: ['first name', 'given name', 'forename'],
    lastName: ['last name', 'surname', 'family name'],
    email: ['email', 'email address', 'e mail', 'e mail address', 'your email',
        'contact email'],
    phone: ['phone', 'phone number', 'mobile', 'mobile number', 'telephone',
        'telephone number', 'contact number', 'cell', 'cell phone'],
    city: ['city', 'town', 'city of residence', 'current city'],
    state: ['state', 'province', 'state province', 'region'],
    linkedin: ['linkedin', 'linkedin url', 'linkedin profile',
        'linkedin profile url', 'linkedin link'],
    workAuth: ['work authorization', 'work authorisation', 'work status',
        'employment authorization', 'employment authorisation',
        'authorization status', 'visa status'],
};

/** Split a full name once, so "Mary Jane Watson" keeps its middle name. */
const splitName = (full) => {
    const parts = String(full ?? '').trim().split(/\s+/);
    if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
};

/**
 * Everything the app is allowed to type, keyed for lookup.
 *
 * Profile values and approved answers are kept in SEPARATE maps rather than
 * merged, so the Q&A record can say which of the two a value came from. An
 * auditor asking "who approved this answer?" needs that distinction.
 */
const buildAnswerBook = ({ profile, approvedAnswers = [] } = {}) => {
    const p = profile ?? {};
    const { first, last } = splitName(p.name);

    const values = {
        fullName: p.name ?? null,
        firstName: first || null,
        lastName: last || null,
        email: p.email ?? null,
        phone: p.phone ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        linkedin: p.linkedin_url ?? null,
        workAuth: p.work_auth ?? null,
    };

    const profileByKey = new Map();
    for (const [field, phrases] of Object.entries(PROFILE_KEYS)) {
        if (!values[field]) continue;
        for (const phrase of phrases) profileByKey.set(phrase, values[field]);
    }

    const answersByKey = new Map();
    for (const a of approvedAnswers) {
        const key = normaliseQuestion(a.question_text);
        if (key && a.answer_text) {
            answersByKey.set(key, { text: a.answer_text, questionId: a.question_id });
        }
    }

    return { profileByKey, answersByKey };
};

/**
 * What belongs in the field with this label, if anything.
 *
 * Approved answers are consulted FIRST. A consultant who has answered "What is
 * your current city?" through the bank has had that answer reviewed by a second
 * person; the profile value has not been reviewed against this question. When
 * both could apply, the reviewed one wins.
 *
 * @returns {{value: string, source: 'ANSWER'|'PROFILE', questionId: string|null}|null}
 */
const resolveAnswer = (label, book) => {
    const key = normaliseQuestion(label);
    if (!key) return null;

    const approved = book.answersByKey.get(key);
    if (approved) {
        return { value: approved.text, source: 'ANSWER', questionId: approved.questionId };
    }

    const fromProfile = book.profileByKey.get(key);
    if (fromProfile) return { value: fromProfile, source: 'PROFILE', questionId: null };

    return null;
};

/** Does this answer mean yes? Used for checkboxes and yes/no radio groups. */
const isAffirmative = (value) => /^(yes|y|true|1|i agree|agree|checked)$/i
    .test(String(value ?? '').trim());

/**
 * Pick the option whose visible text matches the answer.
 *
 * Exact normalised match first, then a unique prefix match — "Yes" against
 * "Yes, I am authorized to work". Ambiguity returns null: two plausible options
 * is exactly when a machine should not be choosing.
 */
const chooseOption = (optionLabels, answer) => {
    const want = normaliseQuestion(answer);
    if (!want) return null;

    const normalised = optionLabels.map((t) => ({ text: t, key: normaliseQuestion(t) }));

    const exact = normalised.filter((o) => o.key === want);
    if (exact.length === 1) return exact[0].text;

    const starts = normalised.filter((o) => o.key.startsWith(`${want} `) || o.key === want);
    if (starts.length === 1) return starts[0].text;

    return null;
};

module.exports = {
    normaliseQuestion,
    buildAnswerBook,
    resolveAnswer,
    isAffirmative,
    chooseOption,
    splitName,
    PROFILE_KEYS,
};
