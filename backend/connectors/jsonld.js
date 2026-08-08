/**
 * ── JSON-LD JobPosting EXTRACTION ─────────────────────────────────────
 *
 * The single most important decision in this connector layer.
 *
 * Every major job board embeds schema.org/JobPosting as JSON-LD, because that
 * is how Google Jobs indexes them. It is STRUCTURED DATA THE BOARD PUBLISHES
 * ON PURPOSE for machines to read — company, title, location, salary,
 * employment type, description, posting date, all named fields.
 *
 * Parsing that instead of scraping the rendered markup buys three things:
 *
 *   1. NO HTML PARSER DEPENDENCY. Finding <script type="application/ld+json">
 *      is a regex; the contents are JSON. No cheerio, no jsdom, nothing to
 *      install or keep patched.
 *   2. STABILITY. Boards redesign their pages constantly and their CSS classes
 *      with them. The JSON-LD block barely changes, because changing it breaks
 *      their own search ranking.
 *   3. HONEST FIELDS. `hiringOrganization.name` is unambiguous in a way that
 *      "the third <span> in the header" never is.
 *
 * When a page carries no JSON-LD, the connector falls back to its own
 * selectors — but that is the exception, and it is where breakage will live.
 */

/** Every JSON-LD block on the page, parsed, bad ones skipped. */
export const extractJsonLdBlocks = (html) => {
    const blocks = [];
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

    let m = re.exec(html);
    while (m !== null) {
        const raw = m[1].trim()
            // Some boards emit HTML-escaped JSON inside the script tag.
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&');
        try {
            blocks.push(JSON.parse(raw));
        } catch {
            // One malformed block must not lose the others on the page.
        }
        m = re.exec(html);
    }
    return blocks;
};

/**
 * Walk a JSON-LD value and yield every JobPosting node inside it.
 *
 * Recursive because boards wrap them differently: a bare object, an array, an
 * `@graph`, or an `ItemList` of `itemListElement`. Chasing each shape
 * separately is how you miss the one a board switches to next month.
 */
const collectJobPostings = (node, found = []) => {
    if (!node || typeof node !== 'object') return found;

    if (Array.isArray(node)) {
        for (const item of node) collectJobPostings(item, found);
        return found;
    }

    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes('JobPosting')) found.push(node);

    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) {
        if (node[key]) collectJobPostings(node[key], found);
    }
    return found;
};

export const findJobPostings = (html) =>
    extractJsonLdBlocks(html).flatMap((block) => collectJobPostings(block));

/* ── field readers ────────────────────────────────────────────────────── */
//
// Each tolerates the several shapes schema.org permits, because boards use all
// of them and a reader that assumes one shape silently returns null on the
// others.

const text = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v.trim() || null;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return text(v[0]);
    if (typeof v === 'object') return text(v.name ?? v['@value'] ?? v.value);
    return null;
};

/**
 * Strip tags and decode the handful of entities that actually show up.
 * Exported because RSS descriptions arrive as escaped HTML too — see feed.js.
 */
export const plain = (html) => {
    if (!html) return null;
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, ' ')
        // Removing an inline tag leaves a gap before the punctuation that
        // followed it — "Build <b>things</b>." would become "Build things .".
        .replace(/[ \t]+([.,;:!?)\]])/g, '$1')
        .replace(/([([])[ \t]+/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim() || null;
};

/** "Dallas, TX" from whichever nesting the board chose. */
const readLocation = (node) => {
    const loc = node.jobLocation;
    const first = Array.isArray(loc) ? loc[0] : loc;

    if (!first) {
        return node.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null;
    }
    if (typeof first === 'string') return first.trim() || null;

    const address = first.address ?? first;
    if (typeof address === 'string') return address.trim() || null;

    const parts = [
        text(address.addressLocality),
        text(address.addressRegion),
        text(address.addressCountry),
    ].filter(Boolean);

    return parts.length ? parts.slice(0, 2).join(', ') : null;
};

const isRemote = (node, locationText) => {
    if (node.jobLocationType === 'TELECOMMUTE') return true;
    if (node.applicantLocationRequirements && !node.jobLocation) return true;
    return /\bremote\b|\bwork from home\b|\banywhere\b/i.test(
        `${locationText ?? ''} ${text(node.title) ?? ''}`,
    );
};

/**
 * Advertised pay.
 *
 * Returns null unless BOTH an amount and a unit are present. A number without
 * its unit is worse than nothing here — the minimum-pay filter would compare
 * an hourly rate against an annual floor and silently drop good jobs.
 */
const readSalary = (node) => {
    const s = node.baseSalary ?? node.estimatedSalary;
    if (!s) return null;

    const value = Array.isArray(s) ? s[0]?.value ?? s[0] : s.value ?? s;
    if (!value || typeof value !== 'object') return null;

    const min = Number(value.minValue ?? value.value ?? NaN);
    const max = Number(value.maxValue ?? value.value ?? NaN);
    if (!Number.isFinite(min) && !Number.isFinite(max)) return null;

    const unitRaw = String(value.unitText ?? '').toUpperCase();
    const unit = unitRaw === 'HOUR' ? 'HOURLY'
        : (unitRaw === 'YEAR' || unitRaw === 'ANNUAL') ? 'ANNUAL'
            : null;
    if (!unit) return null;

    const currency = String(
        (Array.isArray(s) ? s[0]?.currency : s.currency) ?? value.currency ?? 'USD',
    ).toUpperCase().slice(0, 3);

    return {
        min: Number.isFinite(min) ? min : null,
        max: Number.isFinite(max) ? max : null,
        unit,
        currency,
    };
};

/** schema.org employmentType → our lkp_work_types names. */
const WORK_TYPE = {
    FULL_TIME: 'FULL_TIME',
    FULLTIME: 'FULL_TIME',
    PART_TIME: 'PART_TIME',
    PARTTIME: 'PART_TIME',
    CONTRACTOR: 'CONTRACT',
    CONTRACT: 'CONTRACT',
    TEMPORARY: 'CONTRACT',
};

const readWorkType = (node) => {
    const raw = node.employmentType;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) {
        const key = String(entry ?? '').toUpperCase().replace(/[\s-]/g, '_');
        if (WORK_TYPE[key]) return WORK_TYPE[key];
    }
    return null;
};

/**
 * One JSON-LD JobPosting → the shape every connector must produce.
 *
 * Returns null when company or title is missing. Those two are half the
 * de-duplication fingerprint, so a posting without them cannot be stored
 * without corrupting R-15.
 */
export const jobPostingToCommonShape = (node, { sourceUrl } = {}) => {
    const company = text(node.hiringOrganization) ?? text(node.hiringOrganization?.name);
    const title = text(node.title);
    if (!company || !title) return null;

    const locationText = readLocation(node);
    const salary = readSalary(node);

    let postedAt = null;
    if (node.datePosted) {
        const d = new Date(node.datePosted);
        if (!Number.isNaN(d.getTime())) postedAt = d.toISOString();
    }

    return {
        company,
        title,
        locationText,
        isRemote: isRemote(node, locationText),
        description: plain(node.description),
        sourceUrl: text(node.url) ?? sourceUrl ?? null,
        workType: readWorkType(node),
        payMin: salary?.min ?? null,
        payMax: salary?.max ?? null,
        payUnit: salary?.unit ?? null,
        payCurrency: salary?.currency ?? null,
        postedAt,
    };
};

/** Everything parseable on one page. The connectors' happy path. */
export const parsePageJobPostings = (html, sourceUrl) =>
    findJobPostings(html)
        .map((node) => jobPostingToCommonShape(node, { sourceUrl }))
        .filter(Boolean);

export const __test = { plain, readLocation, readSalary, readWorkType };
