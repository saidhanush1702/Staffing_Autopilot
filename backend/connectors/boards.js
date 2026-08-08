/**
 * ── THE FIVE JOB BOARDS ───────────────────────────────────────────────
 *
 * One entry per board. Each is small on purpose: the shared work lives in
 * http.js (politeness) and jsonld.js (extraction), so a board definition is
 * only the three things that genuinely differ between them —
 *
 *   searchUrl(query)   how to ask this board for jobs
 *   linkPattern        how to spot a job-detail link in a results page
 *   portalType         which application system the job ends up on
 *
 * Adding a sixth board is one object in this file. That is the whole point of
 * keeping the fetch and parse layers ignorant of which board they are serving.
 *
 * ── TWO-PASS STRATEGY ─────────────────────────────────────────────────
 *
 * Search-results pages usually carry little or no JSON-LD; job DETAIL pages
 * almost always carry a full JobPosting block. So each board is worked in two
 * passes:
 *
 *   1. fetch the search page, harvest detail links
 *   2. fetch each detail page, parse its JSON-LD
 *
 * Pass 2 is capped per run (`maxDetailPages`) so one broad query cannot turn
 * into hundreds of requests at a board that never agreed to that.
 *
 * ── ON RELIABILITY ────────────────────────────────────────────────────
 *
 * These boards actively discourage automated access, and LinkedIn in
 * particular will often answer a bot with a login wall or a challenge page
 * rather than a posting. That is not a bug in this code and it cannot be
 * fixed here — it is why every connector reports health, why failures are
 * per-board rather than fatal, and why manual entry and CSV import stay
 * first-class. Expect coverage to vary by board and to change over time.
 */
import { politeFetch, isAllowedByRobots } from './http.js';
import { parsePageJobPostings } from './jsonld.js';
import { parseFeed, feedItemToCommonShape } from './feed.js';

/** Absolute, de-duplicated detail links found in a results page. */
const harvestLinks = (html, { origin, linkPattern, limit }) => {
    const seen = new Set();
    const out = [];

    const hrefRe = /href=["']([^"']+)["']/gi;
    let m = hrefRe.exec(html);
    while (m !== null && out.length < limit) {
        const href = m[1];
        if (linkPattern.test(href)) {
            let absolute;
            try {
                absolute = new URL(href, origin).toString().split('#')[0];
            } catch {
                absolute = null;
            }
            if (absolute && !seen.has(absolute)) {
                seen.add(absolute);
                out.push(absolute);
            }
        }
        m = hrefRe.exec(html);
    }
    return out;
};

const slug = (s) => String(s ?? '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const decode = (s) => String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#x2013;|&ndash;/g, '–').replace(/&#x2014;|&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();

const metaContent = (html, name) => {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const m = html.match(re);
    return m ? decode(m[1]) : null;
};

/**
 * ── HTML FALLBACK: BUILT IN ───────────────────────────────────────────
 *
 * Built In serves its job pages fine but carries NO JSON-LD and no embedded
 * JSON payload — the page is assembled client-side. What it does publish, for
 * search engines, is a meta description in a fixed sentence:
 *
 *   "{company} is hiring for a {title} in {location}. Find more details…"
 *
 * That single line contains all three fields the R-15 fingerprint needs, and
 * it exists for the same reason JSON-LD does: the site wants machines to read
 * it. Parsing it is far steadier than chasing CSS classes through a redesign.
 *
 * Returns null rather than a half-built posting when the sentence does not
 * match, so the caller quarantines it and somebody can look — a posting with a
 * guessed location would corrupt de-duplication silently.
 */
const parseBuiltInHtml = (html, url) => {
    const description = metaContent(html, 'description');
    if (!description) return null;

    const m = description.match(/^(.+?)\s+is hiring for an?\s+(.+?)\s+in\s+(.+?)\.\s/i);
    if (!m) return null;

    const [, company, title, locationText] = m;
    const remote = /\bremote\b/i.test(locationText) || /\bremote\b/i.test(title);

    return {
        company: decode(company),
        title: decode(title),
        locationText: decode(locationText),
        isRemote: remote,
        description: null,      // not present without rendering the page
        sourceUrl: url,
        workType: null,
        payMin: null,
        payMax: null,
        payUnit: null,
        payCurrency: null,
        postedAt: null,
    };
};

/**
 * ── FEED FALLBACK: CRUNCHBOARD ────────────────────────────────────────
 *
 * Every CrunchBoard HTML page answers 403 — search, detail, with our bot UA
 * and with a full Chrome header set alike. The RSS feed answers 200 to the
 * plain bot UA. So the feed is not a workaround here, it is the only door the
 * board leaves open, and it is one meant for machines.
 *
 * Feed titles follow "{title} at {company} ({location})". The greedy first
 * group is deliberate: it splits on the LAST " at ", so a role like
 * "Engineer at Scale at Acme (Remote)" keeps its own preposition.
 */
const parseCrunchBoardItem = (item) => {
    const withLocation = item.title.match(/^(.*)\s+at\s+(.+?)\s*\(([^()]*)\)\s*$/);
    const withoutLocation = item.title.match(/^(.*)\s+at\s+(.+?)\s*$/);
    const m = withLocation ?? withoutLocation;
    if (!m) return null;

    const title = m[1]?.trim();
    const company = m[2]?.trim();
    if (!title || !company) return null;

    return feedItemToCommonShape({
        title,
        company,
        locationText: m[3]?.trim() || null,
        item,
    });
};

/* ── Built In listing pages, from the sitemap it publishes ────────────── */

const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;
let builtInListings = { at: 0, urls: [] };

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'jobs', 'job', 'a', 'an', 'of', 'in']);
const tokenise = (s) => String(s ?? '').toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

/**
 * Built In's own robots.txt disallows `/jobs*?search=`, which is precisely the
 * query-string search URL this connector used to fetch. It also publishes
 * `job-board-sitemap.xml`: ~2,800 pre-built listing pages of the form
 * `/jobs/remote/{city}/{category}/{skill}` — an invitation to crawl exactly
 * what the search URL was being used for.
 *
 * So we pick the listing pages closest to the query instead. Every candidate
 * is still put through isAllowedByRobots, because the sitemap lists a good
 * number of URLs that robots.txt separately disallows (`/jobs*seattle`,
 * `/jobs/*mid-level` and friends) — where the two disagree, the stricter
 * signal wins.
 */
const loadBuiltInListings = async (fetchOpts) => {
    if (Date.now() - builtInListings.at < SITEMAP_TTL_MS && builtInListings.urls.length > 0) {
        return builtInListings.urls;
    }
    const res = await politeFetch('https://builtin.com/job-board-sitemap.xml', fetchOpts);
    if (!res.ok) return builtInListings.urls;   // keep whatever we had

    const urls = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].trim())
        .filter((u) => u.includes('/jobs/'));

    builtInListings = { at: Date.now(), urls };
    return urls;
};

const builtInEntryUrls = async ({ q, l }, { fetchOpts, maxPages }) => {
    const wantRemote = /remote/i.test(l ?? '');
    const terms = tokenise(q);
    const placeTerms = wantRemote ? [] : tokenise(l);

    const scored = [];
    for (const url of await loadBuiltInListings(fetchOpts)) {
        const path = url.toLowerCase();
        let score = 0;
        for (const t of terms) if (path.includes(t)) score += 3;
        for (const t of placeTerms) if (path.includes(t)) score += 2;
        if (wantRemote && path.includes('/remote')) score += 4;
        if (score > 0) scored.push({ url, score });
    }

    scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length);

    const want = Math.max(1, Math.min(maxPages ?? 2, 5));
    const chosen = [];
    for (const { url } of scored) {
        if (chosen.length >= want) break;
        if (await isAllowedByRobots(url)) chosen.push(url);
    }

    // Nothing matched, or the sitemap was unreachable: the plain listing page
    // is permitted and still better than giving up on the board.
    if (chosen.length === 0 && await isAllowedByRobots('https://builtin.com/jobs')) {
        chosen.push('https://builtin.com/jobs');
    }
    return chosen;
};

/**
 * The board definitions.
 *
 * `name` matches lkp_job_sources.name, which is where enablement and rate
 * limits live — this file holds no policy, only shape.
 *
 * `mode` is how the board is read:
 *   HTML  two-pass crawl, JSON-LD first (Built In)
 *   FEED  a single RSS/Atom document (CrunchBoard)
 *
 * `requiresBrowser` marks a board that no HTTP client can reach, whatever
 * headers it sends. Those are skipped with a reason rather than retried into a
 * wall — see the note on each.
 */
export const BOARDS = {
    LINKEDIN: {
        name: 'LINKEDIN',
        label: 'LinkedIn Jobs',
        origin: 'https://www.linkedin.com',
        portalType: 'LINKEDIN',
        mode: 'HTML',
        // The guest endpoint renders server-side and is the only LinkedIn
        // surface that answers without a session at all.
        searchUrl: ({ q, l }) =>
            'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search'
            + `?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(l ?? '')}&start=0`,
        linkPattern: /\/jobs\/view\/[^"']+/i,
        maxDetailPages: 10,
        // R-22: the most conservative treatment of any source. Slowest crawl,
        // fewest pages, and a full stop for the run on any challenge page.
        //
        // In practice it never gets that far. LinkedIn's robots.txt is a single
        // rule for `User-agent: *` — `Disallow: /` — so politeFetch refuses
        // before a request is made. That is the board working as intended, not
        // a bug to route around: it is a site-wide, explicit refusal, and an
        // auth wall sits behind it regardless.
        conservative: true,
    },

    WELLFOUND: {
        name: 'WELLFOUND',
        label: 'Wellfound',
        origin: 'https://wellfound.com',
        portalType: 'WELLFOUND',
        mode: 'HTML',
        searchUrl: ({ q, l }) =>
            `https://wellfound.com/role/r/${encodeURIComponent(slug(q))}`
            + (l ? `?location=${encodeURIComponent(l)}` : ''),
        linkPattern: /\/jobs\/\d+[^"']*/i,
        maxDetailPages: 15,
        // robots.txt permits these paths — the block is technical, not policy.
        // Cloudflare answers 403 to every HTTP client, including the sitemap
        // Wellfound declares in its own robots.txt. No feed is published.
        requiresBrowser: true,
        browserNote: 'Cloudflare refuses every plain HTTP request (403), including Wellfound\'s own declared sitemap. robots.txt permits these paths, so a rendered browser is the route — not a header change.',
    },

    BUILTIN: {
        name: 'BUILTIN',
        label: 'Built In',
        origin: 'https://builtin.com',
        portalType: 'BUILTIN',
        mode: 'HTML',
        // No searchUrl: `/jobs?search=` is disallowed by their robots.txt.
        // Entry pages come from the sitemap instead.
        entryUrls: builtInEntryUrls,
        linkPattern: /\/job\/[^"']+/i,
        maxDetailPages: 15,
        // Most detail pages carry JSON-LD; a minority do not, and fall back to
        // the meta description. See parseBuiltInHtml.
        parseHtml: parseBuiltInHtml,
    },

    THELADDERS: {
        name: 'THELADDERS',
        label: 'TheLadders',
        origin: 'https://www.theladders.com',
        portalType: 'THELADDERS',
        mode: 'HTML',
        searchUrl: ({ q, l }) =>
            `https://www.theladders.com/jobs/searchresults?keywords=${encodeURIComponent(q)}`
            + (l ? `&location=${encodeURIComponent(l)}` : ''),
        linkPattern: /\/job(-details)?\/[^"']+/i,
        maxDetailPages: 10,
        // Cloudflare answers 403 even to /robots.txt, so we cannot read their
        // rules at all. loadRobots fails closed on that, which is the correct
        // outcome: no readable policy means no crawling.
        requiresBrowser: true,
        browserNote: 'Cloudflare refuses every plain HTTP request (403) — including robots.txt itself, so their crawl policy cannot even be read. Needs a rendered browser.',
    },

    CRUNCHBOARD: {
        name: 'CRUNCHBOARD',
        label: 'CrunchBoard',
        origin: 'https://www.crunchboard.com',
        portalType: 'CRUNCHBOARD',
        // HTML is 403 across the board; the RSS feed is not. See feed.js.
        mode: 'FEED',
        // The feed ignores query parameters — it is "latest jobs", not a
        // search. Filtering is left to the R-16 pre-filter and the matcher,
        // which is where it belongs anyway.
        feedUrl: () => 'https://www.crunchboard.com/jobs.rss',
        parseFeedItem: parseCrunchBoardItem,
    },
};

/**
 * Login walls and bot challenges answer 200, so status alone cannot detect
 * them — the page has to be recognised by what it says.
 *
 * ── WHY THESE PATTERNS ARE SO SPECIFIC ────────────────────────────────
 *
 * This started as a list of bare words, `challenge` and `captcha` among them.
 * Both occur constantly in ordinary engineering job ads — a real Built In
 * posting reading "Solving complex architectural challenges" was classified as
 * a bot challenge, and because a challenge aborts the whole board for the run,
 * one such phrase truncated every Built In crawl after a handful of postings.
 *
 * The asymmetry decides the design. A false positive silently costs an entire
 * board; a false negative just means we parse an interstitial, find no
 * JobPosting, and quarantine it for someone to look at. So match only phrases
 * that belong to an interstitial and cannot plausibly appear in prose — titles
 * and stock wording, never a single word.
 */
const BLOCK_PATTERNS = [
    // Cloudflare, Akamai and friends announce themselves in the title.
    /<title[^>]*>[^<]*(just a moment|attention required|access denied|security check|are you a robot)/i,
    /checking your (?:browser|site) before accessing/i,
    /enable javascript and cookies to continue/i,
    /please verify you are a human/i,
    /unusual traffic from your computer network/i,
    /cf-browser-verification/i,
    // LinkedIn's guest wall.
    /\bauthwall\b/i,
    /sign in to continue to linkedin/i,
];

const looksBlocked = (html) => {
    const head = html.slice(0, 5000);
    return BLOCK_PATTERNS.some((re) => re.test(head));
};

/* ── feed boards ──────────────────────────────────────────────────────── */

const FEED_TTL_MS = 10 * 60 * 1000;
const feedCache = new Map();

/**
 * A feed has no query parameters to vary, so the orchestrator's loop over
 * queries would otherwise re-fetch the identical document N times in one run.
 * A short TTL collapses that to one request without the caller knowing.
 */
const cachedFeedFetch = async (url, fetchOpts) => {
    const hit = feedCache.get(url);
    if (hit && Date.now() - hit.at < FEED_TTL_MS) return hit.res;

    const res = await politeFetch(url, fetchOpts);
    if (res.ok) feedCache.set(url, { at: Date.now(), res });
    return res;
};

const runFeedBoard = async (board, query, fetchOpts, result) => {
    const url = board.feedUrl(query);
    const res = await cachedFeedFetch(url, fetchOpts);

    result.payloads.push({
        url,
        status: res.status,
        contentType: res.contentType,
        body: res.ok ? res.body : null,
        bytes: res.bytes ?? 0,
        found: 0,
    });

    if (!res.ok) {
        result.errors.push(`feed: ${res.reason}`);
        return result;
    }
    if (!/<(rss|feed)\b/i.test(res.body)) {
        // A 200 that is not a feed usually means a challenge page wearing a
        // feed's URL — worth flagging rather than silently finding nothing.
        result.errors.push('feed: response was not RSS or Atom');
        return result;
    }

    for (const item of parseFeed(res.body)) {
        const posting = board.parseFeedItem(item);
        if (posting) result.postings.push(posting);
    }
    result.payloads[0].found = result.postings.length;

    // An empty feed is a normal state — a board with no new jobs today is not
    // a broken board, so this is deliberately not an error.
    return result;
};

/* ── html boards ──────────────────────────────────────────────────────── */

const runHtmlBoard = async (board, query, fetchOpts, maxPages, result) => {
    const detailCap = Math.min(board.maxDetailPages, (maxPages ?? 2) * 8);

    // ── pass 1: the entry pages ───────────────────────────────────────
    // Most boards have exactly one search URL. Built In instead supplies a
    // handful of sitemap listing pages, because its search URL is disallowed.
    const entryUrls = board.entryUrls
        ? await board.entryUrls(query, { fetchOpts, maxPages })
        : [board.searchUrl(query)];

    if (entryUrls.length === 0) {
        result.errors.push('no permitted search pages for this query');
        return result;
    }

    const links = [];
    const seenLinks = new Set();

    for (const entryUrl of entryUrls) {
        const search = await politeFetch(entryUrl, fetchOpts);

        result.payloads.push({
            url: entryUrl,
            status: search.status,
            contentType: search.contentType,
            body: search.ok ? search.body : null,
            bytes: search.bytes ?? 0,
            found: 0,
        });

        if (!search.ok) {
            result.errors.push(`search page: ${search.reason}`);
            continue;
        }
        if (looksBlocked(search.body)) {
            // R-22 for LinkedIn, sensible for everyone: stop this board for the
            // run rather than trip the same wall repeatedly.
            result.blocked = true;
            result.errors.push('blocked: login wall or bot challenge');
            break;
        }

        // Some boards put full JSON-LD on the results page. Free postings, no
        // second request — always worth checking before crawling detail pages.
        const fromSearch = parsePageJobPostings(search.body, entryUrl);
        result.postings.push(...fromSearch);
        result.payloads[result.payloads.length - 1].found = fromSearch.length;

        for (const link of harvestLinks(search.body, {
            origin: board.origin,
            linkPattern: board.linkPattern,
            limit: detailCap,
        })) {
            if (links.length >= detailCap) break;
            if (seenLinks.has(link)) continue;
            seenLinks.add(link);
            links.push(link);
        }
        if (links.length >= detailCap) break;
    }

    // ── pass 2: detail pages ──────────────────────────────────────────
    for (const link of links) {
        const page = await politeFetch(link, fetchOpts);

        if (!page.ok) {
            result.errors.push(`${link}: ${page.reason}`);
            continue;
        }
        if (looksBlocked(page.body)) {
            result.blocked = true;
            result.errors.push('blocked partway through detail pages');
            break;
        }

        // JSON-LD first — it is the richest and steadiest source. Only when a
        // page carries none does the board's own HTML fallback get a turn.
        let postings = parsePageJobPostings(page.body, link);
        if (postings.length === 0 && board.parseHtml) {
            const fallback = board.parseHtml(page.body, link);
            if (fallback) postings = [fallback];
        }
        result.postings.push(...postings);
        result.payloads.push({
            url: link,
            status: page.status,
            contentType: page.contentType,
            // A page that yielded nothing is the interesting one to keep: it is
            // how a drifted parser is diagnosed later. A page that worked needs
            // no forensics.
            body: postings.length === 0 ? page.body : null,
            bytes: page.bytes ?? 0,
            found: postings.length,
        });
    }

    return result;
};

/**
 * Run one board for one query.
 *
 * Never throws. A board that fails returns its failure so the orchestrator can
 * record it and carry on with the others — spec feature 14.
 *
 * `skipped` is distinct from an error: it means the board was not attempted at
 * all because it cannot work over HTTP, so it should not be counted as a
 * transient failure that might clear up on the next cycle.
 *
 * @returns {{ board, postings, payloads, errors, blocked, skipped }}
 */
export const runBoard = async (board, query, { rateLimitMs, respectRobots, maxPages }) => {
    const result = {
        board: board.name,
        postings: [],
        payloads: [],
        errors: [],
        blocked: false,
        skipped: false,
    };

    const fetchOpts = { rateLimitMs, respectRobots };

    if (board.requiresBrowser) {
        result.skipped = true;
        result.errors.push(board.browserNote ?? 'Needs a rendered browser.');
        return result;
    }

    if (board.mode === 'FEED') {
        return runFeedBoard(board, query, fetchOpts, result);
    }
    return runHtmlBoard(board, query, fetchOpts, maxPages, result);
};

export const boardByName = (name) => BOARDS[String(name ?? '').toUpperCase()] ?? null;
export const allBoards = () => Object.values(BOARDS);
