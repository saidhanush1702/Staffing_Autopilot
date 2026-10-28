/**
 * ── THE ONE HTTP CLIENT THE ATS MIRROR USES ───────────────────────────
 *
 * Every request the mirror makes to an employer's career system goes through
 * `httpRequest`, so there is exactly one place that decides what a polite,
 * bounded, cache-aware request looks like:
 *
 *   · it identifies itself. An anonymous scraper is the kind that gets blocked;
 *     a named one with a contact is one a vendor can write to instead.
 *   · it has a timeout. Lever answered one of our probes in 17 seconds. A poll
 *     that can hang forever is a worker that is gone forever.
 *   · it sends If-None-Match when it has an ETag. Measured live against
 *     Greenhouse, Lever, Ashby and SmartRecruiters: HTTP 304, 0 bytes. That is
 *     what makes minute-level polling affordable — an unchanged board is a
 *     header exchange, not a 13 MB download (Ashby's OpenAI board is 13 MB).
 *   · it classifies failure. "This board does not exist" and "this host is
 *     having a bad minute" demand opposite reactions, so they are different
 *     error kinds rather than one string.
 *
 * `httpRequest` takes an injectable `fetchImpl`, which is how the whole mirror
 * is tested against a local stub server and recorded fixtures with no network.
 */

export const USER_AGENT = process.env.ATS_USER_AGENT
    ?? 'MolinaATSMirror/1.0 (job-board mirror for a staffing agency; ops@molinatek.com)';

export const TIMEOUT_MS = Number(process.env.ATS_TIMEOUT_MS ?? 30_000);

/** Refuse to buffer more than this. The largest real board seen was 13 MB. */
export const MAX_BYTES = Number(process.env.ATS_MAX_BYTES ?? 40 * 1024 * 1024);

/**
 * kind:
 *   NOT_FOUND  the system says there is no such board (404/410). Not retried
 *              hot — after a few in a row the board is parked.
 *   ERROR      anything else: 429, 5xx, timeout, network, unparseable. Retried
 *              with backoff.
 */
export class AtsHttpError extends Error {
    constructor(message, { kind = 'ERROR', status = null, retryAfterS = null } = {}) {
        super(message);
        this.name = 'AtsHttpError';
        this.kind = kind;
        this.status = status;
        this.retryAfterS = retryAfterS;
    }
}

const parseRetryAfter = (value) => {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds, 3600));
    const when = Date.parse(value);
    return Number.isNaN(when) ? null : Math.max(0, Math.min((when - Date.now()) / 1000, 3600));
};

export const hostOf = (url) => {
    try { return new URL(url).host.toLowerCase(); } catch { return ''; }
};

/**
 * @returns {Promise<{ status, notModified, etag, bytes, text, headers }>}
 * @throws {AtsHttpError}
 */
export const httpRequest = async (url, {
    method = 'GET',
    headers = {},
    body = null,
    etag = null,
    timeoutMs = TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
} = {}) => {
    const sent = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...headers,
    };
    if (etag) sent['If-None-Match'] = etag;
    if (body !== null && !sent['Content-Type']) sent['Content-Type'] = 'application/json';

    let res;
    try {
        res = await fetchImpl(url, {
            method,
            headers: sent,
            body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
        });
    } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        throw new AtsHttpError(
            timedOut ? `Timed out after ${timeoutMs}ms (${hostOf(url)})`
                : `Network error reaching ${hostOf(url)}: ${err?.cause?.code ?? err?.message ?? 'unknown'}`,
            { kind: 'ERROR' },
        );
    }

    const status = res.status;
    const outHeaders = {
        etag: res.headers.get('etag'),
        cacheControl: res.headers.get('cache-control'),
    };

    if (status === 304) {
        return { status, notModified: true, etag, bytes: 0, text: '', headers: outHeaders };
    }

    if (status === 404 || status === 410) {
        throw new AtsHttpError(`Not found (HTTP ${status}) at ${hostOf(url)}`, { kind: 'NOT_FOUND', status });
    }

    if (status < 200 || status >= 300) {
        throw new AtsHttpError(
            `HTTP ${status} from ${hostOf(url)}`,
            { kind: 'ERROR', status, retryAfterS: parseRetryAfter(res.headers.get('retry-after')) },
        );
    }

    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_BYTES) {
        throw new AtsHttpError(`Response from ${hostOf(url)} is ${bytes} bytes; limit is ${MAX_BYTES}`, { kind: 'ERROR', status });
    }

    return { status, notModified: false, etag: outHeaders.etag, bytes, text, headers: outHeaders };
};

/**
 * `httpRequest` + JSON.parse, with the parse failure classified like any other.
 *
 * `as: 'text'` skips the parse and hands back `res.text` — for the two families
 * that do not speak JSON everywhere (Personio's XML feed, Breezy's job page).
 */
export const httpJson = async (url, opts = {}) => {
    const { as = 'json', ...rest } = opts;
    const res = await httpRequest(url, rest);
    if (res.notModified || as === 'text') return { ...res, json: null };
    try {
        return { ...res, json: JSON.parse(res.text) };
    } catch {
        throw new AtsHttpError(`Unparseable JSON from ${hostOf(url)} (${res.bytes} bytes)`, { kind: 'ERROR', status: res.status });
    }
};

/* ── politeness ───────────────────────────────────────────────────────── */

/**
 * Caps how hard we lean on anybody.
 *
 *   perHost   concurrent requests to ONE host. Every Greenhouse board shares
 *             boards-api.greenhouse.io, so this is the number that decides
 *             whether we are a good neighbour to Greenhouse, not to Stripe.
 *   gapMs     minimum spacing between request STARTS to one host.
 *   total     concurrent requests overall, so one slow family cannot starve
 *             the rest.
 */
export const createLimiter = ({
    perHost = Number(process.env.ATS_PER_HOST ?? 3),
    gapMs = Number(process.env.ATS_HOST_GAP_MS ?? 150),
    total = Number(process.env.ATS_CONCURRENCY ?? 12),
} = {}) => {
    const hosts = new Map();      // host -> { active, lastStart, waiters: [] }
    let active = 0;
    const globalWaiters = [];

    const hostState = (host) => {
        if (!hosts.has(host)) hosts.set(host, { active: 0, lastStart: 0 });
        return hosts.get(host);
    };

    const acquireGlobal = () => new Promise((resolve) => {
        if (active < total) { active += 1; resolve(); } else { globalWaiters.push(resolve); }
    });
    const releaseGlobal = () => {
        const next = globalWaiters.shift();
        if (next) next(); else active -= 1;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Run `fn` under the host's and the global cap. */
    const run = async (host, fn) => {
        await acquireGlobal();
        const state = hostState(host);
        try {
            // Wait for a host slot. Polling a counter is plenty at this scale
            // and avoids a second queue to get wrong.
            while (state.active >= perHost) await sleep(10);
            state.active += 1;
            try {
                const wait = state.lastStart + gapMs - Date.now();
                if (wait > 0) await sleep(wait);
                state.lastStart = Date.now();
                return await fn();
            } finally {
                state.active -= 1;
            }
        } finally {
            releaseGlobal();
        }
    };

    return { run, stats: () => ({ active, hosts: hosts.size }) };
};
