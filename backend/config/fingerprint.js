/**
 * ── POSTING DE-DUPLICATION (R-15) ─────────────────────────────────────
 *
 * R-15 fixes the fingerprint as **company + title + location**. This module
 * only decides how each of those three is normalised before hashing.
 *
 * ── WHY CONSERVATIVE NORMALISATION ────────────────────────────────────
 *
 * The two failure modes are not symmetrical, and both are bad:
 *
 *   too loose → two genuinely different jobs collapse into one, and a real
 *               opening is never surfaced to anybody. Invisible.
 *   too tight → the same job is queued twice and a consultant applies twice.
 *               Visible to the employer, and it burns a daily-cap slot.
 *
 * So: fold case, punctuation, whitespace and the noise words that boards add
 * to the SAME job ("(Remote)", "- Urgent Hiring", legal suffixes like Inc/LLC).
 * Do NOT stem, expand synonyms or fuzzy-match — "Senior React Developer" and
 * "React Developer" are different jobs and must stay different.
 *
 * `job_posting_sightings` is the safety net: every merge is inspectable after
 * the fact, so a bad fingerprint can be caught rather than silently eating
 * postings forever.
 */
import { createHash } from 'node:crypto';

/** Legal suffixes. One board writes "Acme, Inc." and the next writes "Acme". */
const COMPANY_SUFFIXES = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|technologies|technology|solutions|systems|group|holdings)\b/g;

/** Decoration boards bolt onto a title without changing which job it is. */
const TITLE_NOISE = [
    /\b(urgent(ly)?\s+)?hiring\b/g,
    /\b(immediate|immediately)\b/g,
    /\bapply\s+now\b/g,
    /\bw2\s+only\b/g,
    /\bnew\b(?=\s*$)/g,
    /\b(100%\s*)?remote\b/g,
    /\bonsite\b/g,
    /\bhybrid\b/g,
    /\bcontract\b/g,
    /\bfull[\s-]?time\b/g,
    /\bpart[\s-]?time\b/g,
];

/** Lowercase, strip accents and punctuation, collapse whitespace. */
const base = (value) => String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normaliseCompany = (value) => base(value)
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const normaliseTitle = (value) => {
    let out = base(value);
    for (const noise of TITLE_NOISE) out = out.replace(noise, ' ');
    return out.replace(/\s+/g, ' ').trim();
};

/**
 * Location, reduced to the part that identifies the job.
 *
 * Everything remote normalises to the single token `remote`, because "Remote",
 * "Remote - US" and "Anywhere" are the same place for de-duplication. Physical
 * locations keep city and region only — a country suffix appears
 * inconsistently between boards and would split one job in two.
 */
export const normaliseLocation = (value, isRemote = false) => {
    const cleaned = base(value);
    if (isRemote || !cleaned || /\b(remote|anywhere|work from home|wfh|telecommute)\b/.test(cleaned)) {
        return 'remote';
    }
    return cleaned.split(' ').slice(0, 4).join(' ');
};

/**
 * The fingerprint. Stable across runs and processes, which rules out any
 * hash seeded per-process.
 */
export const fingerprintPosting = ({ company, title, locationText, isRemote }) => {
    const parts = [
        normaliseCompany(company),
        normaliseTitle(title),
        normaliseLocation(locationText, isRemote),
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex');
};

/** Exposed so a run report can show WHY two postings merged. */
export const explainFingerprint = ({ company, title, locationText, isRemote }) => ({
    company: normaliseCompany(company),
    title: normaliseTitle(title),
    location: normaliseLocation(locationText, isRemote),
});
