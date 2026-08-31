/**
 * ── SHARED PLUMBING FOR EVERY MODEL PROVIDER ──────────────────────────
 *
 * The parts of "call a model over HTTP" that are identical no matter whose
 * model it is: a timeout, retry on the failures worth retrying, a body size
 * ceiling, and the rule that this layer NEVER THROWS.
 *
 * ── WHY NEVER THROW ───────────────────────────────────────────────────
 *
 * The same rule connectors/serpapi.js follows, for the same reason. A provider
 * outage is an ordinary Tuesday, and it must degrade into "this job was not
 * tailored, here is why" rather than into an exception that unwinds a worker
 * mid-transaction. Callers branch on `ok`, and there is no path where a 500
 * from a vendor becomes a 500 from us.
 *
 * ── WHY RAW HTTP AND NOT EACH VENDOR'S SDK ────────────────────────────
 *
 * The provider is deliberately undecided — Claude, Gemini, GPT, Qwen and
 * DeepSeek are all live options. Installing one vendor's SDK makes that vendor
 * the shape of the abstraction and every other one an adapter to it. Four small
 * fetch calls, one per dialect, keeps all of them equal, and adds no
 * dependencies to install, audit or keep current.
 */

const MAX_RETRIES = 2;
const MAX_BODY_BYTES = 8_000_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * A status worth trying again.
 *
 * 429 is rate limiting and 5xx is the provider having a bad minute — both pass.
 * 400, 401, 403 and 422 are us being wrong, and retrying a malformed request
 * just spends the same money twice for the same rejection.
 */
export const isRetryableStatus = (status) => status === 429 || status === 408 || status >= 500;

/** Milliseconds to wait before attempt `n`, honouring Retry-After when sent. */
const backoffMs = (attempt, retryAfterHeader) => {
    const header = Number(retryAfterHeader);
    if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
    return Math.min(1000 * 2 ** attempt, 20_000);
};

/**
 * POST JSON, retry what is worth retrying, and never throw.
 *
 * @returns {{ok: true, body: object}} | {{ok: false, error: string, status?: number, retryable: boolean}}
 */
export const postJson = async ({ url, headers, body, timeoutMs = 120_000 }) => {
    let lastError = 'The request was never attempted.';
    let lastStatus;
    let lastRetryable = true;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (attempt > 0) await sleep(backoffMs(attempt - 1, null));

        // A fresh controller per attempt: an aborted signal stays aborted, so
        // reusing one would make every retry fail instantly on the first
        // timeout — which looks exactly like a provider that is down.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const text = await res.text();

            if (text.length > MAX_BODY_BYTES) {
                return {
                    ok: false,
                    status: res.status,
                    retryable: false,
                    error: `The provider returned ${text.length} bytes, over the ${MAX_BODY_BYTES} ceiling.`,
                };
            }

            if (!res.ok) {
                lastStatus = res.status;
                lastRetryable = isRetryableStatus(res.status);
                // Providers put the useful part of an error in wildly different
                // places, so the raw text is kept and truncated rather than
                // parsed into a shape only one vendor uses.
                lastError = `HTTP ${res.status}: ${text.slice(0, 600)}`;
                if (!lastRetryable) break;
                continue;
            }

            try {
                return { ok: true, body: JSON.parse(text) };
            } catch {
                lastRetryable = false;
                lastError = `The provider returned a 200 that was not JSON: ${text.slice(0, 300)}`;
                break;
            }
        } catch (err) {
            // Abort, DNS failure, socket reset — all transient, all worth
            // another go.
            lastError = err.name === 'AbortError'
                ? `The request timed out after ${timeoutMs}ms.`
                : `Network error: ${err.message}`;
            lastRetryable = true;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        ok: false, error: lastError, status: lastStatus, retryable: lastRetryable,
    };
};

/**
 * Pull an object out of whatever the model actually returned.
 *
 * ── WHY THIS IS NEEDED AT ALL ─────────────────────────────────────────
 *
 * Every provider claims to support structured output and every one of them
 * honours it differently. Some return exactly the JSON asked for. Some wrap it
 * in a ```json fence. Some add a sentence of preamble first. A pipeline that
 * assumes the strict case works perfectly against one vendor and breaks on the
 * day the provider is switched — which, given the provider here is explicitly
 * undecided, is a day that will come.
 *
 * So: try strict, then a fence, then the first balanced object in the text.
 * Returns null when there is genuinely nothing parseable, which the caller
 * treats as a retryable failure rather than as a bad resume.
 */
export const extractJson = (text) => {
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    const trimmed = text.trim();

    // An OBJECT, specifically. Every stage asks for one, so a bare array or a
    // bare string is a wrong answer — and letting it through here means it
    // fails much later, in schema validation, with a far less obvious message.
    const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

    try {
        const direct = JSON.parse(trimmed);
        if (isObject(direct)) return direct;
    } catch { /* fall through to the looser attempts */ }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
        try {
            const parsed = JSON.parse(fenced[1].trim());
            if (isObject(parsed)) return parsed;
        } catch { /* fall through */ }
    }

    // Last resort: scan for the first balanced {...}, respecting strings so a
    // brace inside a bullet point does not end the object early.
    const start = trimmed.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i += 1) {
        const ch = trimmed[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(trimmed.slice(start, i + 1));
                    if (isObject(parsed)) return parsed;
                } catch { /* not valid after all */ }
                return null;
            }
        }
    }
    return null;
};

/** Read an environment variable fresh, so tests and reconfiguration take effect. */
export const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

export const numEnv = (name, fallback) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};
