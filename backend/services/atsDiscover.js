/**
 * ── GROWING THE REGISTRY ──────────────────────────────────────────────
 *
 * The mirror is only as wide as its list of employer boards, so the list has to
 * come from somewhere other than a person typing URLs. Two sources, both
 * already in the database or one request away:
 *
 *   1. MINE THE POSTINGS WE HOLD. Some `job_postings.source_url` values already
 *      point at an ATS (boards.greenhouse.io/accenturefederalservices/…,
 *      jobs.lever.co/modeln/…). Measured on the dev database: ~3% of postings.
 *      Free, and every hit is a board we KNOW exists.
 *
 *   2. GUESS FROM COMPANY NAMES. The other ~97% are aggregator links, but the
 *      posting still names its employer. Greenhouse, Lever and Ashby address a
 *      board by a slug that is usually the company name squashed together, and a
 *      wrong guess is a cheap 404. A 200 with jobs in it is the evidence.
 *
 * ── HOW MUCH TO TRUST A GUESS ─────────────────────────────────────────
 *
 * Not equally. Greenhouse will tell us the board's display name, so a guess is
 * VERIFIED when that name matches the company. Lever and Ashby will not, so a
 * hit there only proves SOME company owns that slug — "apex" is not necessarily
 * Apex Staffing. Those come back `verified: false` with sample job titles, and a
 * person decides. Nothing here ever writes to the registry; it only proposes.
 */
import { query } from '../db.js';
import { detectBoard } from '../connectors/ats/detect.js';
import { adapterFor } from '../connectors/ats/index.js';
import { normaliseCompany } from '../config/fingerprint.js';

const GUESSABLE = ['GREENHOUSE', 'LEVER', 'ASHBY'];

/** Corporate-form tokens: dropped from the END of a name for the full-name slug. */
const ENTITY_SUFFIX = new Set([
    'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'plc', 'pvt', 'private',
]);

/** Generic words dropped everywhere for the shorter slug. */
const GENERIC = new Set([
    ...ENTITY_SUFFIX, 'technologies', 'technology', 'solutions', 'systems', 'group', 'holdings',
    'services', 'consulting', 'consultancy', 'staffing', 'global', 'international',
]);

/**
 * 'Accenture Federal Services, LLC' →
 *   ['accenturefederalservices', 'accenture-federal-services',
 *    'accenturefederal', 'accenture-federal']
 */
export const slugCandidates = (company) => {
    const words = String(company ?? '')
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w && w !== 'the');
    if (words.length === 0) return [];

    // "Accenture Federal Services, LLC": the board is almost always
    // accenturefederalservices — the entity suffix is dropped, the rest kept.
    const base = [...words];
    while (base.length > 1 && ENTITY_SUFFIX.has(base[base.length - 1])) base.pop();
    const core = base.filter((w) => !GENERIC.has(w));
    const variants = [base, core.length ? core : base];

    const out = [];
    for (const v of variants) {
        out.push(v.join(''), v.join('-'));
    }
    return [...new Set(out)].filter((s) => s.length >= 3 && s.length <= 60).slice(0, 4);
};

/* ── 1. mine the postings we already hold ─────────────────────────────── */

const mostCommon = (values) => {
    const tally = new Map();
    for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};

const registeredKeys = async (orgId) => {
    const { rows } = await query(
        `SELECT f.name AS family, b.board_key, b.company_name
           FROM ats_boards b JOIN lkp_ats_families f ON f.id = b.family_id
          WHERE b.organization_id = $1`,
        [orgId],
    );
    return {
        keys: new Set(rows.map((r) => `${r.family}|${r.board_key}`)),
        companies: new Set(rows.map((r) => normaliseCompany(r.company_name)).filter(Boolean)),
    };
};

/**
 * Boards implied by postings already in the pool, minus those already registered.
 * @returns {Promise<Array<{ family, key, input, companyName, postings, sampleUrl }>>}
 */
export const mineExistingPostings = async (orgId) => {
    const { rows } = await query(
        `SELECT source_url, company
           FROM job_postings
          WHERE organization_id = $1
            AND source_url ~* '(greenhouse\\.io|lever\\.co|ashbyhq\\.com|myworkdayjobs\\.com|smartrecruiters\\.com)'`,
        [orgId],
    );

    const found = new Map();
    for (const r of rows) {
        const d = detectBoard(r.source_url);
        if (!d) continue;
        const id = `${d.family}|${d.key}`;
        const entry = found.get(id) ?? { d, companies: [], urls: [] };
        entry.companies.push(r.company);
        entry.urls.push(r.source_url);
        found.set(id, entry);
    }

    const { keys } = await registeredKeys(orgId);
    return [...found.entries()]
        .filter(([id]) => !keys.has(id))
        .map(([, e]) => ({
            family: e.d.family,
            key: e.d.key,
            // The original URL, not a rebuilt one: it keeps a Lever EU host.
            input: e.urls[0],
            companyName: mostCommon(e.companies),
            postings: e.urls.length,
            sampleUrl: e.urls[0],
        }))
        .sort((a, b) => b.postings - a.postings || a.key.localeCompare(b.key));
};

/* ── 2. guess from company names ──────────────────────────────────────── */

/** How many distinct employers the pool names, for the progress bar. */
export const countCompanies = async (orgId) => {
    const { rows } = await query(
        'SELECT count(DISTINCT company)::int AS n FROM job_postings WHERE organization_id = $1',
        [orgId],
    );
    return rows[0].n;
};

const verifiedName = (boardName, company) => {
    const a = normaliseCompany(boardName);
    const b = normaliseCompany(company);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
};

/**
 * Probe one company across the guessable families.
 * @returns {Promise<Array<{ company, family, key, total, sample, boardName, verified }>>}
 */
export const guessCompany = async (company, ctx) => {
    const hits = [];
    const slugs = slugCandidates(company);

    for (const family of GUESSABLE) {
        for (const slug of slugs) {
            const board = { family, board_key: slug, config: {}, company_name: null };
            let list;
            try {
                list = await adapterFor(family).fetchList(board, {
                    ...ctx, etag: null, prevHash: null, knownIds: new Set(), isBootstrap: true, maxPages: 1,
                });
            } catch {
                continue;          // a 404 is the expected answer to most guesses
            }
            const items = list.items ?? [];
            if (items.length === 0) continue;

            let boardName = items.find((i) => i.companyName)?.companyName ?? null;
            if (family === 'GREENHOUSE' && !boardName) {
                try {
                    const meta = await ctx.http(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`);
                    boardName = meta.json?.name ?? null;
                } catch { /* the list already proved the board exists */ }
            }

            hits.push({
                company, family, key: slug,
                input: `${family.toLowerCase()}:${slug}`,
                total: list.total ?? items.length,
                sample: items.slice(0, 3).map((i) => i.title).filter(Boolean),
                boardName,
                verified: Boolean(boardName) && verifiedName(boardName, company),
            });
            break;                 // first slug that works wins for this family
        }
    }
    return hits;
};

/**
 * One batch of the company scan. The caller pages through with `offset` so the
 * HTTP request stays short; ~9 requests per company at the limiter's pace.
 *
 * Companies already covered by a registered board are skipped.
 */
export const guessBatch = async (orgId, { offset = 0, limit = 8, ctx }) => {
    const { companies: covered } = await registeredKeys(orgId);
    const { rows } = await query(
        `SELECT company, count(*)::int AS postings
           FROM job_postings
          WHERE organization_id = $1 AND length(btrim(company)) > 0
          GROUP BY company
          ORDER BY postings DESC, company
         OFFSET $2 LIMIT $3`,
        [orgId, offset, limit],
    );

    const results = [];
    for (const r of rows) {
        if (covered.has(normaliseCompany(r.company))) continue;
        const hits = await guessCompany(r.company, ctx);
        for (const h of hits) results.push({ ...h, postings: r.postings });
    }
    return { results, scanned: rows.length, nextOffset: offset + rows.length, done: rows.length < limit };
};
