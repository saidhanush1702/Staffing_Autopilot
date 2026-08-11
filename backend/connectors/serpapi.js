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
export const providerConfig = () => ({
    name: 'SERPAPI',
    label: 'Google Jobs (SerpApi)',
    baseUrl: process.env.SERPAPI_BASE_URL ?? 'https://serpapi.com/search.json',
    apiKey: process.env.SERPAPI_KEY ?? '',
    timeoutMs: num(process.env.SERPAPI_TIMEOUT_MS, 20_000),
    gl: process.env.DISCOVERY_GL ?? 'us',
    hl: process.env.DISCOVERY_HL ?? 'en',
    maxQueries: num(process.env.DISCOVERY_MAX_QUERIES, 6),
    maxPages: num(process.env.DISCOVERY_MAX_PAGES, 2),
    maxCallsPerRun: num(process.env.DISCOVERY_MAX_CALLS_PER_RUN, 20),
});

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
         * One search term, walked to `pages` deep or until the budget runs out.
         *
         * @returns {{ results, payloads, errors, pagesFetched }}
         *   results  — raw jobs_results entries, in the order Google ranked them
         *   payloads — one per call, URL already redacted, for retention
         */
        async search({ q, location }) {
            const out = { results: [], payloads: [], errors: [], pagesFetched: 0 };
            let token = null;

            for (let page = 0; page < pages; page += 1) {
                if (calls >= budget) {
                    exhausted = true;
                    break;
                }
                if (page > 0 && pacingMs > 0) await sleep(pacingMs);

                const url = buildUrl({ q, location, nextPageToken: token }, cfg);
                const safeUrl = redactUrl(url);

                calls += 1;
                const res = await callOnce(url, cfg);

                const found = res.ok ? (res.body.jobs_results ?? []).length : 0;
                out.payloads.push({
                    url: safeUrl,
                    status: res.status,
                    contentType: 'application/json',
                    // A call that yielded nothing is the one worth keeping: it
                    // is how a drifted adapter or a changed contract is
                    // diagnosed later. A page that worked needs no forensics.
                    body: found === 0 ? res.raw : null,
                    bytes: res.raw ? res.raw.length : 0,
                    found,
                });

                if (!res.ok) {
                    out.errors.push(`"${q}" page ${page + 1}: ${res.reason}`);
                    break;      // the next page needs a token this call never returned
                }

                out.pagesFetched += 1;
                out.results.push(...(res.body.jobs_results ?? []));

                token = res.body.serpapi_pagination?.next_page_token ?? null;
                if (!token) break;      // end of results — not an error
            }

            return out;
        },
    };
};

export const __test = { buildUrl, redactUrl };
