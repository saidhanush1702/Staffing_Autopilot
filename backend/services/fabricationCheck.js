/**
 * ── THE FABRICATION CHECK ─────────────────────────────────────────────
 *
 * Compares the tailored resume against the original and reports every claim the
 * original does not support.
 *
 * Two passes, and the cheap one runs first on purpose.
 *
 * ── PASS 1 · MECHANICAL, NO MODEL ─────────────────────────────────────
 *
 * The classic fabrication is an invented number. A resume says "improved
 * checkout performance"; the tailored version says "improved checkout
 * performance by 40%". The figure is plausible, it is the kind of thing that
 * gets someone an interview, and it is the kind of thing they will be asked to
 * substantiate. It is also trivially detectable: 40% is not in the original.
 *
 * The same holds for technology names. AWS, PostgreSQL, C#, .NET and Kubernetes
 * are all recognisable by shape, and asking "is this string in the original"
 * needs no intelligence at all.
 *
 * So both are done in code. It is free, it is deterministic, it catches the two
 * highest-consequence fabrications, and — unlike the model pass — it cannot
 * decide to be lenient today.
 *
 * ── PASS 2 · AN INDEPENDENT MODEL ─────────────────────────────────────
 *
 * Everything pass 1 cannot see: an overstated scope, an implied seniority, a
 * responsibility that grew in the retelling. Judgement, which is what a model
 * is for.
 *
 * It is given ONLY the two documents. Never the job description — see
 * config/tailoringRules.js for why that matters more than it looks.
 */
import { callModel } from '../connectors/llm/index.js';
import { flattenResumeText } from '../config/resumeSchema.js';
import { CHECK_SYSTEM, CHECK_JSON_SCHEMA, checkInstruction } from '../config/tailoringRules.js';

/* ── pass 1: what code can prove ───────────────────────────────────── */

/**
 * Numbers, in every form a resume writes them.
 *
 * Deliberately narrow. A bare "3" appears in dates, addresses and version
 * numbers and would flag constantly; a QUANTITY — a percentage, a multiplier,
 * a money amount, a counted noun — is what a fabricated metric looks like.
 */
const QUANTITY_PATTERNS = [
    /\b\d+(?:\.\d+)?\s*%/g,                                   // 40%, 99.9%
    /\b\d+(?:\.\d+)?\s*x\b/gi,                                // 3x, 2.5x
    /[$£€]\s?\d+(?:[.,]\d+)*\s*(?:[kmb]|million|billion)?/gi, // $1.2M
    /\b\d+(?:[.,]\d+)*\s*(?:k|m|bn?|million|billion|thousand)\b/gi,
    /\b\d+\+?\s*(?:years?|yrs?)\b/gi,                         // 8 years, 10+ yrs
    /\b\d[\d,]{2,}\b/g,                                       // 10,000  50000
    /\b\d+\s*(?:users?|customers?|clients?|engineers?|developers?|people|members?|teams?|records?|requests?|transactions?)\b/gi,
];

/**
 * Technology names, by shape rather than by dictionary.
 *
 * A dictionary goes stale the week it is written and misses whatever is new. A
 * shape does not: acronyms, dotted names, CamelCase and the punctuation-bearing
 * languages cover the overwhelming majority of real tools, and anything they
 * miss is still visible to the model pass.
 */
const TECH_PATTERNS = [
    /\b[A-Z]{2,6}\b/g,                              // AWS, SQL, GCP, CI, REST
    /\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+\b/g, // Node.js, ASP.NET, socket.io
    /\b[A-Za-z]+(?:\+\+|#)\b/g,                     // C++, C#, F#
    /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g,       // PostgreSQL, TypeScript, MongoDB
];

/**
 * Ordinary capitalised words — Kubernetes, Docker, Terraform, Kafka, Jenkins —
 * which none of the shapes above match, because they are shaped exactly like
 * any other capitalised word.
 *
 * The catch is that a capitalised word STARTING a sentence or a bullet is
 * usually just a sentence starting: "Led the migration", "Designed the schema".
 * Flagging those would fire on almost every reworded bullet and make the whole
 * check unreadable.
 *
 * So this one requires the word to be preceded by another word on the same
 * line. A technology is named mid-sentence; a sentence's first word is not
 * evidence of anything.
 */
const MID_SENTENCE_CAPITALISED = /(?<=[a-z0-9,]\s)[A-Z][a-zA-Z0-9]{2,}\b/g;

/**
 * Acronyms that are ordinary English on a resume rather than technologies.
 *
 * Without this list every tailored resume flags on words like "AND" in a
 * capitalised heading, and a check that flags everything is a check nobody
 * reads.
 */
const NOT_TECHNOLOGY = new Set([
    'AND', 'THE', 'FOR', 'WITH', 'FROM', 'INTO', 'THAT', 'THIS', 'ALL', 'NEW',
    'USA', 'US', 'UK', 'EU', 'INC', 'LLC', 'LTD', 'CO', 'ST', 'AVE',
    'CV', 'PDF', 'AM', 'PM', 'ID', 'OK', 'TBD', 'ETC', 'EG', 'IE',
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]);

const findAll = (text, patterns) => {
    const found = new Set();
    for (const pattern of patterns) {
        for (const match of String(text ?? '').matchAll(pattern)) {
            const token = match[0].trim();
            if (token) found.add(token);
        }
    }
    return found;
};

/** Compare loosely enough that spacing and case are not fabrications. */
const canon = (s) => String(s).toLowerCase().replace(/[\s,]/g, '');

/**
 * Everything in the tailored text that code can prove is not in the base.
 *
 * @returns {Array<{claim, section, severity, reason, detectedBy}>}
 */
export const mechanicalFlags = (baseText, tailoredText) => {
    const flags = [];

    const baseCanon = canon(baseText);
    const baseWords = ` ${String(baseText).toLowerCase().replace(/[^a-z0-9+#. ]/g, ' ').replace(/\s+/g, ' ')} `;

    // ── numbers ──
    for (const quantity of findAll(tailoredText, QUANTITY_PATTERNS)) {
        if (baseCanon.includes(canon(quantity))) continue;
        flags.push({
            claim: quantity,
            section: null,
            severity: 'HIGH',
            detectedBy: 'RULE',
            reason: `The figure "${quantity}" does not appear anywhere in the base resume. `
                + 'A number the original did not state cannot be added.',
        });
    }

    // ── technologies ──
    for (const term of findAll(tailoredText, [...TECH_PATTERNS, MID_SENTENCE_CAPITALISED])) {
        if (NOT_TECHNOLOGY.has(term.toUpperCase())) continue;
        if (term.length < 2) continue;

        const needle = term.toLowerCase();
        // Substring, not word-boundary: the base may write "Node.js" where the
        // tailored version writes "Node", and that is a rewording rather than
        // an invention.
        if (baseWords.includes(needle) || baseCanon.includes(canon(term))) continue;

        flags.push({
            claim: term,
            section: null,
            severity: 'HIGH',
            detectedBy: 'RULE',
            reason: `"${term}" looks like a technology or qualification, and it does not `
                + 'appear in the base resume.',
        });
    }

    return flags;
};

/* ── pass 2: what needs judgement ──────────────────────────────────── */

/**
 * Run both passes.
 *
 * The mechanical pass runs first and unconditionally. The model pass runs after
 * and is allowed to fail: if the provider is down, the check degrades to
 * "everything code could prove" rather than to "nothing was checked". That is
 * recorded in `modelChecked` so a reviewer can see which of the two they got.
 *
 * Never throws.
 *
 * @returns {{ok, flags, modelChecked, provider, model, usage, costUsd, durationMs, error}}
 */
export const checkFabrication = async ({ baseText, tailoredResume, structural = [] }) => {
    const tailoredText = flattenResumeText(tailoredResume);

    const flags = mechanicalFlags(baseText, tailoredText);

    // Structural findings arrive already established — an invented employer, a
    // changed job title. They are facts, not opinions, so they enter at HIGH
    // and are labelled as their own kind of detection.
    for (const problem of structural) {
        flags.push({
            claim: problem,
            section: 'structure',
            severity: 'HIGH',
            detectedBy: 'STRUCTURE',
            reason: 'The tailored resume changed the shape of the consultant\'s history, '
                + 'which rewording is never allowed to do.',
        });
    }

    const res = await callModel({
        stage: 'check',
        system: CHECK_SYSTEM,
        // The base resume is the same bytes for every job this consultant has,
        // so it goes in the cacheable slot here exactly as it does when
        // tailoring.
        cacheable: `ORIGINAL RESUME\n===============\n${baseText}`,
        input: checkInstruction({ originalText: '(above)', adaptedText: tailoredText }),
        schema: CHECK_JSON_SCHEMA,
        maxTokens: 4000,
    });

    if (!res.ok) {
        return {
            ok: true,               // the CHECK still produced a usable answer
            modelChecked: false,
            flags,
            provider: res.provider,
            model: res.model,
            usage: res.usage ?? {},
            costUsd: res.costUsd ?? null,
            durationMs: res.durationMs,
            error: res.error,
        };
    }

    for (const flag of res.json?.flags ?? []) {
        const claim = String(flag?.claim ?? '').trim();
        if (!claim) continue;

        // The model re-reporting something the mechanical pass already caught
        // is common and correct. Recording it twice makes a reviewer read the
        // same finding twice.
        if (flags.some((f) => canon(f.claim) === canon(claim))) continue;

        flags.push({
            claim: claim.slice(0, 2000),
            section: flag.section ? String(flag.section).slice(0, 80) : null,
            severity: ['HIGH', 'MEDIUM', 'LOW'].includes(flag.severity) ? flag.severity : 'MEDIUM',
            detectedBy: 'MODEL',
            reason: flag.reason ? String(flag.reason).slice(0, 1000) : null,
        });
    }

    return {
        ok: true,
        modelChecked: true,
        flags,
        provider: res.provider,
        model: res.model,
        usage: res.usage,
        costUsd: res.costUsd,
        durationMs: res.durationMs,
        error: null,
    };
};
