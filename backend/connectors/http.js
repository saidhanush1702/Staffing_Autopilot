/**
 * ── THE POLITE FETCHER ────────────────────────────────────────────────
 *
 * Every outbound request in Phase 5 goes through here. Nothing else in the
 * codebase calls `fetch()` against a job board directly, so the rules below
 * are impossible for a connector to forget:
 *
 *   · one request at a time per host, with a per-board delay
 *   · robots.txt honoured, fetched once and cached
 *   · a User-Agent that says who we are and how to complain
 *   · exponential backoff on 429 and 5xx, then give up rather than hammer
 *   · a hard timeout, so one slow board cannot stall the whole run
 *
 * These exist to keep the boards' operators from blocking the accounts this
 * system depends on. A blocked account is a worse outage than a slow crawl.
 */

const CONTACT = process.env.SCRAPER_CONTACT ?? 'admin@smartapply.local';
const USER_AGENT = process.env.SCRAPER_USER_AGENT
    ?? `SmartApplyBot/1.0 (+${CONTACT})`;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;   // 2 MB — enough to re-parse, not an archive
const MAX_RETRIES = 2;

/** Per-host serialisation. Two requests to one board never overlap. */
const hostQueues = new Map();
const robotsCache = new Map();

const hostOf = (url) => { try { return new URL(url).host; } catch { return 'invalid'; } };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `fn` after the previous call for this host has finished AND the board's
 * delay has elapsed. Chaining onto the host's promise is what serialises it —
 * a counter would still let two callers through at once.
 */
const throttled = (host, delayMs, fn) => {
    const previous = hostQueues.get(host) ?? Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(async () => {
            await sleep(delayMs);
            return fn();
        });
    // Store a settled-either-way promise so one failure cannot wedge the host.
    hostQueues.set(host, next.catch(() => {}));
    return next;
};

/* ── robots.txt ───────────────────────────────────────────────────────── */

/**
 * robots.txt, following RFC 9309.
 *
 * The first version of this was a prefix match over Disallow lines, which was
 * wrong in three ways that all showed up against real boards:
 *
 *   · `Allow:` was ignored completely. A board that blocks a directory and
 *     then re-permits part of it (Built In publishes 39 such rules) was
 *     over-blocked, so we skipped pages we were welcome to read.
 *   · `*` and `$` were compared as literal characters, so a rule like
 *     `/jobs/*​/tracker` matched no real path and we would happily crawl
 *     exactly what the board asked us to leave alone. Under-blocking is the
 *     serious direction of this bug — it is the one that gets an IP banned.
 *   · Rules from every group whose token matched were merged together. A
 *     specific group is meant to REPLACE the `*` group, not add to it.
 *
 * Grouping rule: consecutive `User-agent:` lines share one set of rules, so
 * they are collected together rather than starting a new group each time.
 */
const parseRobots = (text) => {
    const groups = [];
    let current = null;
    let lastLineWasAgent = false;

    for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        if (!line) continue;

        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();

        if (key === 'user-agent') {
            if (!current || !lastLineWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastLineWasAgent = true;
            continue;
        }

        lastLineWasAgent = false;
        if (current && (key === 'allow' || key === 'disallow')) {
            current.rules.push({ allow: key === 'allow', pattern: value });
        }
    }
    return groups;
};

/** The product token is what a robots group names — not the whole UA string. */
const productToken = () => USER_AGENT.split('/')[0].trim().toLowerCase();

/**
 * The one group that applies to us: the most specific token match, or the
 * merged `*` groups when nothing names us directly.
 */
const selectRules = (groups) => {
    const token = productToken();
    let best = null;
    const star = [];

    for (const group of groups) {
        for (const agent of group.agents) {
            if (agent === '*') {
                star.push(...group.rules);
            } else if (token === agent || token.startsWith(agent)) {
                if (!best || agent.length > best.length) {
                    best = { length: agent.length, rules: group.rules };
                }
            }
        }
    }
    return best ? best.rules : star;
};

/** `*` is any run of characters; a trailing `$` anchors the end of the path. */
const patternToRegex = (pattern) => {
    let body = pattern;
    let anchored = false;
    if (body.endsWith('$')) {
        anchored = true;
        body = body.slice(0, -1);
    }
    const escaped = body
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
};

/**
 * Longest matching pattern wins; Allow wins a tie. That tie-break is what
 * makes `Disallow: /jobs/` + `Allow: /jobs/` resolve as permission.
 */
const decide = (rules, path) => {
    let winner = null;

    for (const rule of rules) {
        // An empty `Disallow:` is the documented way to say "everything is
        // permitted" — it constrains nothing, so it never wins.
        if (!rule.pattern) continue;

        let re;
        try {
            re = patternToRegex(rule.pattern);
        } catch {
            continue;
        }
        if (!re.test(path)) continue;

        const length = rule.pattern.length;
        if (!winner || length > winner.length || (length === winner.length && rule.allow)) {
            winner = { allow: rule.allow, length };
        }
    }
    return winner ? winner.allow : true;
};

/**
 * Deliberately strict where it is unsure: only a 404 means "no rules", which
 * is the documented meaning of a missing robots file. Anything else — a 403,
 * a 5xx, a timeout — means the server is unhappy with us, and we treat that as
 * a refusal rather than assume permission. TheLadders answers 403 to its own
 * robots.txt, and this is why we correctly stay away.
 */
const loadRobots = async (origin) => {
    if (robotsCache.has(origin)) return robotsCache.get(origin);

    const REFUSE_ALL = [{ allow: false, pattern: '/' }];
    let rules = [];
    try {
        const res = await fetch(`${origin}/robots.txt`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
            rules = selectRules(parseRobots(await res.text()));
        } else if (res.status !== 404) {
            rules = REFUSE_ALL;
        }
    } catch {
        rules = REFUSE_ALL;
    }

    robotsCache.set(origin, rules);
    return rules;
};

export const isAllowedByRobots = async (url) => {
    const { origin, pathname, search } = new URL(url);
    const rules = await loadRobots(origin);
    return decide(rules, pathname + search);
};

/** Test seam — robots answers are cached for the life of the process. */
export const clearRobotsCache = () => robotsCache.clear();

/* ── the fetch itself ─────────────────────────────────────────────────── */

/**
 * Fetch one page politely.
 *
 * Never throws for an HTTP-level problem: it returns `{ ok: false, reason }`,
 * because a single board failing must not abort a discovery run (spec feature
 * 14). Only a programming error escapes.
 *
 * @returns {{ ok, status, body, contentType, bytes, url, reason? }}
 */
export const politeFetch = async (url, { rateLimitMs = 5000, respectRobots = true } = {}) => {
    const host = hostOf(url);

    if (respectRobots && !(await isAllowedByRobots(url))) {
        return { ok: false, url, status: null, reason: 'Disallowed by robots.txt' };
    }

    return throttled(host, rateLimitMs, async () => {
        let lastReason = 'Unknown error';

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
            if (attempt > 0) {
                // 2s, 4s, 8s … a board asking us to slow down gets that.
                await sleep(2000 * (2 ** (attempt - 1)));
            }
            try {
                const res = await fetch(url, {
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                    redirect: 'follow',
                    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
                });

                // Worth retrying: they are throttling us or briefly broken.
                if (res.status === 429 || res.status >= 500) {
                    lastReason = `HTTP ${res.status}`;
                    continue;
                }
                // Not worth retrying: 401/403 means blocked, 404 means gone.
                if (!res.ok) {
                    return { ok: false, url, status: res.status, reason: `HTTP ${res.status}` };
                }

                const text = await res.text();
                return {
                    ok: true,
                    url: res.url ?? url,
                    status: res.status,
                    contentType: res.headers.get('content-type') ?? '',
                    body: text.slice(0, MAX_BODY_BYTES),
                    bytes: text.length,
                };
            } catch (err) {
                lastReason = err.name === 'TimeoutError' ? 'Timed out' : err.message;
            }
        }

        return { ok: false, url, status: null, reason: lastReason };
    });
};
