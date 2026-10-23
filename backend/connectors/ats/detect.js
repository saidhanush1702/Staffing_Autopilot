/**
 * ── "PASTE A CAREERS LINK" → WHICH SYSTEM, WHICH BOARD ────────────────
 *
 * An operator should not have to know that Greenhouse calls it a "board token"
 * and Workday needs a tenant, a shard and a site. They paste the URL they see
 * in their browser; this works out the rest.
 *
 *   https://boards.greenhouse.io/stripe                      → GREENHOUSE  stripe
 *   https://job-boards.greenhouse.io/embed/job_board?for=x   → GREENHOUSE  x
 *   https://jobs.lever.co/palantir/6ed76ce8-…                → LEVER       palantir
 *   https://jobs.eu.lever.co/acme                            → LEVER       acme  (EU host)
 *   https://jobs.ashbyhq.com/Ramp                            → ASHBY       Ramp
 *   https://nvidia.wd5.myworkdayjobs.com/en-US/Site/job/…    → WORKDAY     nvidia.wd5/Site
 *   https://careers.smartrecruiters.com/BoschGroup           → SMARTRECRUITERS BoschGroup
 *   greenhouse:stripe   lever:palantir   workday:nvidia.wd5/NVIDIAExternalCareerSite
 *
 * The same function also reads the URLs ALREADY in job_postings, which is how
 * the registry gets its first boards for free (services/atsDiscover.js).
 *
 * Case: Greenhouse and Lever slugs are lower-cased (they are case-insensitive
 * and a mixed-case duplicate would defeat the unique key). Ashby and
 * SmartRecruiters identifiers are kept as written — SmartRecruiters is
 * case-sensitive in practice ("BoschGroup" works, "boschgroup" returns 0).
 */

const clean = (s) => {
    try { return decodeURIComponent(String(s)).trim(); } catch { return String(s).trim(); }
};

/** Path segments, minus empties. */
const segments = (url) => url.pathname.split('/').filter(Boolean).map(clean);

const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

/** @returns {{ family, key, config, companyHint }|null} */
export const detectBoard = (input) => {
    const raw = String(input ?? '').trim();
    if (!raw) return null;

    // family:key shorthand
    const short = /^(greenhouse|lever|ashby|smartrecruiters|workday)\s*:\s*(.+)$/i.exec(raw);
    if (short) {
        const family = short[1].toUpperCase();
        const key = short[2].trim();
        if (family === 'WORKDAY') return parseWorkdayShorthand(key);
        return { family, key: canonical(family, key), config: {}, companyHint: null };
    }

    let url;
    try { url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    const host = url.hostname.toLowerCase();
    const seg = segments(url);

    /* Greenhouse */
    if (/(^|\.)greenhouse\.io$/.test(host)) {
        if (host.startsWith('boards-api.')) {
            const i = seg.indexOf('boards');
            return seg[i + 1] ? mk('GREENHOUSE', seg[i + 1]) : null;
        }
        const forParam = url.searchParams.get('for');
        if (forParam) return mk('GREENHOUSE', forParam);
        if (seg[0] && seg[0] !== 'embed') return mk('GREENHOUSE', seg[0]);
        return null;
    }

    /* Lever */
    if (/(^|\.)lever\.co$/.test(host)) {
        const eu = host.includes('.eu.');
        if (host.startsWith('api.')) {
            const i = seg.indexOf('postings');
            return seg[i + 1] ? mk('LEVER', seg[i + 1], eu ? { host: 'api.eu.lever.co' } : {}) : null;
        }
        return seg[0] ? mk('LEVER', seg[0], eu ? { host: 'api.eu.lever.co' } : {}) : null;
    }

    /* Ashby */
    if (/(^|\.)ashbyhq\.com$/.test(host)) {
        if (host.startsWith('api.')) {
            const i = seg.indexOf('job-board');
            return seg[i + 1] ? mk('ASHBY', seg[i + 1]) : null;
        }
        return seg[0] ? mk('ASHBY', seg[0]) : null;
    }

    /* SmartRecruiters */
    if (/(^|\.)smartrecruiters\.com$/.test(host)) {
        if (host.startsWith('api.')) {
            const i = seg.indexOf('companies');
            return seg[i + 1] ? mk('SMARTRECRUITERS', seg[i + 1]) : null;
        }
        return seg[0] ? mk('SMARTRECRUITERS', seg[0]) : null;
    }

    /* Workday: {tenant}.wd{N}.myworkdayjobs.com/[locale/]{site} */
    const wd = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
    if (wd) {
        const [, tenant, shard] = wd;
        const parts = seg[0] && LOCALE.test(seg[0]) ? seg.slice(1) : seg;
        const site = parts[0];
        if (!site || site === 'wday') return null;
        return {
            family: 'WORKDAY',
            key: `${tenant}.${shard}/${site}`,
            config: { host, tenant, shard, site },
            companyHint: tenant,
        };
    }

    return null;
};

const canonical = (family, key) => (family === 'GREENHOUSE' || family === 'LEVER' ? key.toLowerCase() : key);

const mk = (family, key, config = {}) => ({
    family, key: canonical(family, clean(key)), config, companyHint: clean(key),
});

const parseWorkdayShorthand = (value) => {
    // nvidia.wd5/NVIDIAExternalCareerSite
    const m = /^([a-z0-9-]+)\.(wd\d+)\/([^/\s]+)$/i.exec(value);
    if (!m) return null;
    const [, tenant, shard, site] = m;
    return {
        family: 'WORKDAY',
        key: `${tenant.toLowerCase()}.${shard.toLowerCase()}/${site}`,
        config: { host: `${tenant.toLowerCase()}.${shard.toLowerCase()}.myworkdayjobs.com`, tenant: tenant.toLowerCase(), shard: shard.toLowerCase(), site },
        companyHint: tenant,
    };
};

/**
 * Rebuild the Workday config from a stored board_key, for rows created before
 * a config existed or edited by hand. 'nvidia.wd5/Site' → { host, tenant, … }.
 */
export const workdayConfigFromKey = (key) => parseWorkdayShorthand(key)?.config ?? null;
