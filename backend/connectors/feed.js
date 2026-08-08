/**
 * ── RSS / ATOM FEEDS ──────────────────────────────────────────────────
 *
 * The third way into a board, after JSON-LD and HTML.
 *
 * It earns its place because of a pattern worth knowing: a site can sit behind
 * Cloudflare and still serve its feed. CrunchBoard answers 403 to every HTML
 * page we ask for — search, detail, even with a full browser header set — but
 * returns its RSS feed with a plain 200 to our own bot User-Agent. Feeds are
 * published to be read by machines, and are routinely exempted from the bot
 * rules that guard the rest of a site.
 *
 * So when a board blocks HTML, look for the feed before concluding it needs a
 * browser. It is the cheapest, most stable, and most clearly-invited route
 * there is: no rendering, no fingerprinting, and a contract that changes far
 * less often than markup.
 *
 * The trade-off is depth. A feed is "the latest N jobs", not a searchable
 * index — filtering is ours to do afterwards, which is exactly what the R-16
 * pre-filter and the matcher already exist for.
 *
 * Parsing is done with regexes rather than an XML library, matching the choice
 * already made in jsonld.js: these are small, well-formed documents from a
 * generator, and the dependency is not worth it.
 */
import { plain } from './jsonld.js';

/** `<tag>value</tag>`, CDATA unwrapped, first match only. */
const tag = (xml, name) => {
    const m = xml.match(
        new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'),
    );
    if (!m) return null;
    const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    return raw.trim() || null;
};

/** Atom puts the URL in an attribute rather than the element body. */
const atomLink = (xml) => {
    // Prefer rel="alternate"; fall back to the first <link href=…>.
    const alt = xml.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        ?? xml.match(/<link\b[^>]*href=["']([^"']+)["']/i);
    return alt ? alt[1].trim() : null;
};

const ENTITIES = [
    [/&lt;/g, '<'], [/&gt;/g, '>'], [/&quot;/g, '"'],
    [/&#0?39;|&apos;/g, "'"],
    [/&#x2013;|&ndash;/g, '–'], [/&#x2014;|&mdash;/g, '—'],
    [/&nbsp;/g, ' '],
    // &amp; last, so "&amp;lt;" becomes "&lt;" and not "<".
    [/&amp;/g, '&'],
];

/** One pass of entity decoding, whitespace left exactly as it was. */
const unescapeOnce = (s) => (s == null
    ? null
    : ENTITIES.reduce((acc, [re, to]) => acc.replace(re, to), String(s)));

/** For single-line fields — decode, then flatten any wrapping in the XML. */
const decodeEntities = (s) => {
    const decoded = unescapeOnce(s);
    return decoded === null ? null : (decoded.replace(/\s+/g, ' ').trim() || null);
};

/**
 * Feed descriptions are HTML that has been escaped to survive XML, so they
 * arrive double-encoded: `&lt;p&gt;Terms &amp;amp; conditions&lt;/p&gt;`.
 *
 * Order matters and is easy to get backwards. `plain()` strips tags and then
 * decodes, which is right for real HTML — run on this it would find no tags to
 * strip and leave `<p>Terms &amp; conditions</p>` as visible text. Unescaping
 * one level FIRST turns it into real HTML, which plain() then handles as usual.
 */
const richText = (s) => plain(unescapeOnce(s));

const toDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Parse an RSS 2.0 or Atom document into plain items.
 *
 * @returns {Array<{title, link, description, publishedAt, guid}>}
 */
export const parseFeed = (xml) => {
    if (!xml || typeof xml !== 'string') return [];

    const blocks = [
        ...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
        ...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
    ].map((m) => m[1]);

    const items = [];
    for (const block of blocks) {
        const title = decodeEntities(tag(block, 'title'));
        const link = tag(block, 'link') ?? atomLink(block);
        if (!title || !link) continue;   // an item without both is unusable

        items.push({
            title,
            link: decodeEntities(link),
            description: richText(tag(block, 'description')
                ?? tag(block, 'summary')
                ?? tag(block, 'content')),
            publishedAt: toDate(tag(block, 'pubDate')
                ?? tag(block, 'published')
                ?? tag(block, 'updated')),
            guid: tag(block, 'guid') ?? tag(block, 'id') ?? null,
        });
    }
    return items;
};

/** The shape every connector hands back, so nothing downstream cares how it was found. */
export const feedItemToCommonShape = ({ title, company, locationText, item }) => ({
    company,
    title,
    locationText: locationText ?? null,
    isRemote: /\bremote\b|\bwork from home\b|\banywhere\b/i.test(
        `${locationText ?? ''} ${title ?? ''}`,
    ),
    description: item.description ?? null,
    sourceUrl: item.link,
    workType: null,
    payMin: null,
    payMax: null,
    payUnit: null,
    payCurrency: null,
    postedAt: item.publishedAt ?? null,
});

export const __test = { tag, decodeEntities, unescapeOnce, richText, atomLink };
