/**
 * ── JOBSPIPE SEARCH API — the PULL door ───────────────────────────────
 *
 * The third ingestion path, and the only JobsPipe one that works on the Free
 * Tier.
 *
 *   discovery cycle   PULLS from SerpApi. Pays per page. Finds what Google
 *                     Jobs has indexed, which lags publication.
 *   jobspipe webhook  is PUSHED to. Needs a PAID plan, so it cannot be
 *                     trialled — see controllers/jobspipeListener.js.
 *   this              PULLS from JobsPipe. Free Tier, and therefore the only
 *                     way to answer "are these jobs fresher than SerpApi's"
 *                     before anybody pays for the push feed.
 *
 * ── THE CONTRACT THIS IS WRITTEN AGAINST ──────────────────────────────
 *
 * Taken from JobsPipe's own published SDK (`jobspipe` 0.1.0 on PyPI —
 * `_client.py` and `resources/jobs.py`), NOT inferred from the shape this
 * pipeline would like to receive. That distinction is the whole reason this
 * file can be trusted where the webhook adapter's ACCEPTED_PATHS cannot:
 *
 *   POST https://api.jobspipe.dev/v1/jobs/search
 *   Authorization: Bearer jp_live_…
 *
 *   → { metadata: { total_results, truncated_results, next_cursor, … },
 *       data: [ Job, … ] }
 *
 * Every name in FILTERS below is copied from the SDK's `_build_body`.
 *
 * ── CREDITS ARE THE BINDING CONSTRAINT, NOT RATE ──────────────────────
 *
 * 1 credit = 1 REQUEST. Not one job — one request. A call returning a hundred
 * jobs and a call returning none cost exactly the same, and the Free Tier is
 * 100 credits a MONTH, which is roughly three a day.
 *
 * That inverts the usual advice. With SerpApi the guidance is "ask for less";
 * here it is "ask for as much as the plan allows per call, and call rarely",
 * because the page size is free and the call is not. Hence JOBSPIPE_PAGE_SIZE
 * defaulting high while JOBSPIPE_POLL_CRON defaults to six-hourly rather than
 * the discovery cycle's fifteen minutes.
 *
 * Nothing here retries a plain 4xx: a retry on a rejected request is a second
 * credit spent to be told "no" twice.
 */
import 'dotenv/config';

export const SEARCH_PATH = '/v1/jobs/search';

/**
 * Every filter the API accepts, from the SDK's `_build_body`.
 *
 * Checked against rather than trusted to the caller, so a typo — the kind that
 * silently widens a search and returns the whole feed instead of this week's
 * React roles — is caught before a credit is spent on it.
 */
export const FILTERS = [
    'limit', 'offset', 'page', 'include_total_results',
    'job_title_or', 'job_title_not',
    'description_or', 'description_not',
    'employment_type_or', 'source_or',
    'job_country_code_or', 'job_country_code_not',
    'posted_at_max_age_days', 'posted_at_gte', 'posted_at_lte',
    'company_name_or', 'company_name_partial_match_or',
    'job_seniority_or', 'remote',
    'job_id_or', 'job_ids',
];

/** Transient statuses worth a retry. 429 included; any other 4xx is not. */
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

const cfg = () => ({
    key: process.env.JOBSPIPE_API_KEY ?? '',
    baseUrl: (process.env.JOBSPIPE_BASE_URL ?? 'https://api.jobspipe.dev').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.JOBSPIPE_TIMEOUT_MS ?? 60_000),
});

/** True when a key is present, so callers skip cleanly instead of throwing. */
export const isConfigured = () => Boolean(cfg().key);

/**
 * Never let the key reach a log, an error message or the event store.
 *
 * The same rule the SerpApi connector follows: a key in a stack trace is a key
 * in whatever aggregates the stack traces.
 */
export const redact = (text) => {
    const { key } = cfg();
    if (text === null || text === undefined) return text;
    const s = String(text);
    return key ? s.replaceAll(key, 'jp_live_***REDACTED***') : s;
};

/** Refuse unknown filters before a credit is spent on a misspelling. */
export const validateFilters = (filters) => {
    const unknown = Object.keys(filters).filter((k) => !FILTERS.includes(k));
    if (unknown.length) {
        throw new Error(
            `Unknown JobsPipe filter(s): ${unknown.join(', ')}. `
            + `Accepted: ${FILTERS.join(', ')}`,
        );
    }
    return filters;
};

/**
 * One search request. ONE CREDIT — more if it retries.
 *
 * @param   {object} filters   any subset of FILTERS
 * @param   {object} [opts]    { maxRetries, onAttempt }
 * @returns {{ metadata, data, requests, status }}
 *          `requests` is how many credits the call actually spent, retries
 *          included, because a retried request is a second credit and the
 *          trial's arithmetic has to account for it.
 */
export const searchJobs = async (filters = {}, { maxRetries = 2, onAttempt = null } = {}) => {
    const { key, baseUrl, timeoutMs } = cfg();
    if (!key) throw new Error('JOBSPIPE_API_KEY is not set.');

    validateFilters(filters);

    // Drop nulls exactly as the SDK does: absent means "no filter", which is
    // not the same thing to the API as an explicit null.
    const body = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v !== null && v !== undefined),
    );

    let requests = 0;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        requests += 1;
        onAttempt?.({ attempt, requests });

        try {
            const res = await fetch(`${baseUrl}${SEARCH_PATH}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'smartapply/1.0 (+jobspipe-trial)',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const text = await res.text();

            if (!res.ok) {
                // A 4xx that is not 429 will fail identically forever, and
                // spending a second credit to confirm that is the one thing a
                // 100-a-month plan cannot afford.
                if (!RETRY_STATUS.has(res.status)) {
                    throw new Error(`JobsPipe ${res.status}: ${redact(text).slice(0, 400)}`);
                }
                lastError = new Error(`JobsPipe ${res.status}: ${redact(text).slice(0, 200)}`);

                if (attempt < maxRetries) {
                    // Honour Retry-After when the server sends one — it knows
                    // better than our backoff curve does.
                    const after = Number(res.headers.get('retry-after'));
                    const delay = Number.isFinite(after) && after > 0
                        ? Math.min(after * 1000, 8000)
                        : Math.min(500 * 2 ** attempt, 8000) * (1 + Math.random() * 0.25);
                    await new Promise((r) => { setTimeout(r, delay); });
                    continue;
                }
                throw lastError;
            }

            let json;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`JobsPipe returned non-JSON: ${redact(text).slice(0, 200)}`);
            }

            return {
                metadata: json.metadata ?? {},
                data: Array.isArray(json.data) ? json.data : [],
                requests,
                status: res.status,
            };
        } catch (err) {
            if (err.name === 'AbortError') {
                lastError = new Error(`JobsPipe timed out after ${timeoutMs}ms`);
                if (attempt < maxRetries) continue;
                throw lastError;
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    throw lastError ?? new Error('JobsPipe request failed.');
};
