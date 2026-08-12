/**
 * ── THE SEARCH PROVIDER ───────────────────────────────────────────────
 *
 * The only file in the codebase that makes an outbound request for jobs.
 *
 * Phase 5 v1 crawled five job boards directly. Four of them refuse every HTTP
 * client — LinkedIn by a site-wide robots.txt, Wellfound and TheLadders by
 * Cloudflare, and the two that answered did so through a sitemap and an RSS
 * feed that were never search indexes. That approach is gone. We now buy
 * Google's index of those same boards through a documented, paid API.
 *
 * ── WHAT THIS FILE IS RESPONSIBLE FOR ─────────────────────────────────
 *
 *   · building the request               · walking pages by next_page_token
 *   · retrying 429 and 5xx with backoff  · a hard ceiling on calls per run
 *   · keeping the API key out of storage · never throwing
 *
 * ── WHAT IT IS DELIBERATELY NOT RESPONSIBLE FOR ───────────────────────
 *
 * Interpreting a job. It hands back `jobs_results` entries exactly as the
 * vendor sent them; googleJobs.js turns those into postings. That seam is the
 * whole reason a provider swap is a one-file change: this half is shaped like
 * the vendor, the other half is shaped like Google Jobs.
 */

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read afresh on every call rather than captured at import.
 *
 * Tests set process.env and expect it to take effect, and the discovery
 * scheduler outlives any single configuration. A module-level constant would
 * freeze whatever was in .env the moment the process booted.
 */
/**
 * How recently a job must have been posted to be worth asking for.
 *
 * Google's own filter vocabulary, and the finest granularity it offers is a
 * day — `today` is 24 hours, not "since the last run". There is no shorter
 * window available at any price, from any reseller, because Google does not
 * expose one.
 *
 * `3days` is the recommended default rather than `today`: Google's index lags
 * the boards by hours, and a job posted at 23:50 that Google indexes at 00:30
 * is invisible to a `today` filter run at 00:00 the next day. The margin costs
 * nothing — de-duplication collapses the overlap — and it closes that hole.
 *
 * Empty disables the filter entirely, which is strictly worse: page one then
 * fills with whatever ranks best, which is usually a month-old listing we
 * already hold, and the credit buys nothing.
 */
const DATE_POSTED = new Set(['today', '3days', 'week', 'month']);

export const providerConfig = () => {
    const datePosted = (process.env.DISCOVERY_DATE_POSTED ?? '3days').trim().toLowerCase();
    return {
        name: 'SERPAPI',
        label: 'Google Jobs (SerpApi)',
        baseUrl: process.env.SERPAPI_BASE_URL ?? 'https://serpapi.com/search.json',
        apiKey: process.env.SERPAPI_KEY ?? '',
        timeoutMs: num(process.env.SERPAPI_TIMEOUT_MS, 20_000),
        gl: process.env.DISCOVERY_GL ?? 'us',
        hl: process.env.DISCOVERY_HL ?? 'en',
        // An unrecognised value is dropped rather than sent: Google ignores a
        // malformed chip silently, which would look like a working filter
        // returning suspiciously old jobs.
        datePosted: DATE_POSTED.has(datePosted) ? datePosted : null,
        maxQueries: num(process.env.DISCOVERY_MAX_QUERIES, 6),
        maxPages: num(process.env.DISCOVERY_MAX_PAGES, 2),
        maxCallsPerRun: num(process.env.DISCOVERY_MAX_CALLS_PER_RUN, 20),
    };
};

export const isConfigured = () => providerConfig().apiKey.trim().length > 0;

const MAX_RETRIES = 2;
const MAX_BODY_BYTES = 2_000_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The request URL is written to job_source_payloads, which operators can read
 * through the UI. The key must not travel with it.
 *
 * Rebuilding the URL from parts rather than regex-replacing it means a key that
 * arrives under an unexpected parameter name is still caught.
 */
export const redactUrl = (url) => {
    try {
        const u = new URL(url);
        for (const key of ['api_key', 'apikey', 'key', 'token']) {
            if (u.searchParams.has(key)) u.searchParams.set(key, '***');
        }
        return u.toString();
    } catch {
        return String(url).replace(/([?&](?:api_)?key=)[^&]*/gi, '$1***');
    }
};

const buildUrl = ({ q, location, nextPageToken }, cfg) => {
    const u = new URL(cfg.baseUrl);
    u.searchParams.set('engine', 'google_jobs');
    u.searchParams.set('q', q);
    if (location) u.searchParams.set('location', location);
    u.searchParams.set('gl', cfg.gl);
    u.searchParams.set('hl', cfg.hl);
    // Recency. This does NOT reduce the credit cost of a call — billing is per
    // request, not per result — but it decides what those credits buy. Without
    // it, page one is whatever Google ranks highest, which in a mature pool is
    // mostly postings we already hold.
    if (cfg.datePosted) u.searchParams.set('chips', `date_posted:${cfg.datePosted}`);
    // Offset pagination (`start`) was discontinued by Google. Pages are walked
    // with the token the previous response handed back.
    if (nextPageToken) u.searchParams.set('next_page_token', nextPageToken);
    u.searchParams.set('api_key', cfg.apiKey);
    return u.toString();
};

/**
 * One HTTP call. Returns a result object for every outcome — an operational
 * failure is data here, not an exception, because a provider hiccup must not
 * abort a discovery run that still has matching work to do.
 */
const callOnce = async (url, cfg) => {
    let lastReason = 'Unknown error';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (attempt > 0) await sleep(2000 * (2 ** (attempt - 1)));   // 2s, 4s

        try {
            const res = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(cfg.timeoutMs),
            });

            const text = (await res.text()).slice(0, MAX_BODY_BYTES);

            // Worth another try: throttled, or briefly broken at their end.
            if (res.status === 429 || res.status >= 500) {
                lastReason = `HTTP ${res.status}`;
                continue;
            }

            let body = null;
            try {
                body = JSON.parse(text);
            } catch {
                return {
                    ok: false, status: res.status, raw: text,
                    reason: 'Provider returned a non-JSON response',
                };
            }

            // SerpApi reports a bad key or a malformed query in the body, often
            // with a 200. Status alone would call that a success and store an
            // empty result set as though the index were empty.
            if (body.error) {
                return { ok: false, status: res.status, raw: text, reason: String(body.error).slice(0, 300) };
            }
            if (!res.ok) {
                return { ok: false, status: res.status, raw: text, reason: `HTTP ${res.status}` };
            }

            return { ok: true, status: res.status, raw: text, body };
        } catch (err) {
            lastReason = err.name === 'TimeoutError' ? 'Timed out' : err.message;
        }
    }

    return { ok: false, status: null, raw: null, reason: lastReason };
};

/**
 * A run's dealings with the provider, with the credit budget attached.
 *
 * The budget lives on the session rather than on each query because it is a
 * property of the RUN: six search terms that each independently respect a
 * two-page limit still cost twelve credits, and it is the twelve that shows up
 * on the invoice. One misconfigured cycle emptying a month's quota is the
 * failure this prevents.
 */
export const createSession = ({ maxCalls, maxPages, pacingMs = 0 } = {}) => {
    const cfg = providerConfig();
    const budget = Math.max(1, maxCalls ?? cfg.maxCallsPerRun);
    const pages = Math.max(1, maxPages ?? cfg.maxPages);

    let calls = 0;
    let exhausted = false;

    return {
        get calls() { return calls; },
        get budgetExhausted() { return exhausted; },
        config: cfg,

        /**
         * One search term, yielded a page at a time.
         *
         * ── WHY A GENERATOR AND NOT A RETURNED ARRAY ──────────────────
         *
         * The old version fetched every page up front and handed back the lot.
         * That meant page two was always bought, even when page one had already
         * shown that this search has nothing new — and page two is exactly as
         * expensive as page one.
         *
         * Only the caller can tell whether a page was worth buying, because
         * "new" means "not already in the database" and this module has no
         * database. So it yields, the caller de-duplicates, and the caller
         * decides whether to ask for more by continuing the loop or breaking
         * out of it. Breaking out is what saves the credit.
         *
         * @yields {{ pageNo, results, payload, error }}
         */
        async *pages({ q, location }) {
            let token = null;

            for (let page = 0; page < pages; page += 1) {
                if (calls >= budget) {
                    exhausted = true;
                    return;
                }
                if (page > 0 && pacingMs > 0) await sleep(pacingMs);

                const url = buildUrl({ q, location, nextPageToken: token }, cfg);
                const safeUrl = redactUrl(url);

                calls += 1;
                const res = await callOnce(url, cfg);

                const results = res.ok ? (res.body.jobs_results ?? []) : [];
                const payload = {
                    url: safeUrl,
                    status: res.status,
                    contentType: 'application/json',
                    // A call that yielded nothing is the one worth keeping: it
                    // is how a drifted adapter or a changed contract is
                    // diagnosed later. A page that worked needs no forensics.
                    body: results.length === 0 ? res.raw : null,
                    bytes: res.raw ? res.raw.length : 0,
                    found: results.length,
                };

                if (!res.ok) {
                    // Yield the failure so the caller still retains the payload,
                    // then stop: the next page needs a token this call never
                    // returned.
                    yield { pageNo: page + 1, results: [], payload, error: `"${q}" page ${page + 1}: ${res.reason}` };
                    return;
                }

                yield { pageNo: page + 1, results, payload, error: null };

                token = res.body.serpapi_pagination?.next_page_token ?? null;
                if (!token) return;      // end of results — not an error
            }
        },
    };
};

export const __test = { buildUrl, redactUrl };
