/**
 * ── THE DESKTOP DOWNLOAD, SERVED BY US ────────────────────────────────
 *
 * The portal used to call GitHub's API straight from every consultant's
 * browser. That endpoint allows 60 requests an hour per IP, so an office
 * behind one address could lock itself out of the download page. This asks
 * GitHub once per cache window instead, and everyone shares the answer.
 *
 * Public on purpose: it returns only what is already a public release.
 */
import { parseVersion } from '../utils/semver.js';

const REPO = process.env.DESKTOP_RELEASE_REPO || 'saidhanush1702/Staffing_Autopilot';
const TTL_MS = 10 * 60_000;
// "Nothing published yet" is re-checked quickly, so the first release shows up
// within a minute instead of waiting out the full window.
const UNRELEASED_TTL_MS = 60_000;

let cache = { at: 0, body: null };

const pick = (assets, ext) => {
    const a = (assets ?? []).find((x) => x.name?.toLowerCase().endsWith(ext));
    return a ? { name: a.name, url: a.browser_download_url, size: a.size } : null;
};

/** Pure, so it can be tested without the network. */
export const shapeRelease = (release) => {
    const windows = pick(release.assets, '.exe');
    const mac = pick(release.assets, '.dmg');
    if (!windows && !mac) return { status: 'unreleased' };
    const version = String(release.tag_name ?? '').replace(/^(desktop-)?v/, '');
    return {
        status: 'ready',
        version: parseVersion(version) ? version : release.tag_name,
        publishedAt: release.published_at,
        windows,
        mac,
    };
};

export const latestDesktopRelease = async (_req, res) => {
    const ttl = cache.body?.status === 'ready' ? TTL_MS : UNRELEASED_TTL_MS;
    if (cache.body && Date.now() - cache.at < ttl) return res.json(cache.body);

    try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'smartapply-hub' },
            signal: AbortSignal.timeout(8000),
        });
        if (r.status === 404) {
            cache = { at: Date.now(), body: { status: 'unreleased' } };
            return res.json(cache.body);
        }
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        cache = { at: Date.now(), body: shapeRelease(await r.json()) };
        return res.json(cache.body);
    } catch {
        // Serve a stale answer rather than break the download page on a
        // GitHub blip; only fail when there is nothing at all to show.
        if (cache.body) return res.json(cache.body);
        return res.status(502).json({ status: 'error' });
    }
};
