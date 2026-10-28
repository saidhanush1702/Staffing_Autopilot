/**
 * ── WORKABLE ──────────────────────────────────────────────────────────
 *
 *   list    POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
 *   detail  GET  https://apply.workable.com/api/v2/accounts/{slug}/jobs/{shortcode}
 *
 * Public, no key. Verified live against Hugging Face (6 jobs). The list has
 * title, place, type and a publication DATE but no description, so a second
 * request is made for NEW jobs only. `published` arrives as a midnight
 * timestamp ("2026-09-21T00:00:00.000Z") — that is a day, not an instant, so it
 * is kept as `publishedDay` and never produces a latency figure.
 *
 * No ETag on the list, so "nothing changed" is decided by hashing the ids.
 * Workable does not state the company name anywhere in the list; the registry
 * must supply it.
 *
 * Paging: a `nextPage` token in the response is followed up to `maxPages`.
 * That token was NOT seen live (no account measured was larger than one page),
 * so the loop refuses to trust it blindly — a page that adds no new job ends
 * the read and the result is marked incomplete.
 */
import {
    htmlToText, dayOrNull, tidy, looksRemote, sha256,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;
const DEFAULT_MAX_PAGES = 5;
const EMPTY_QUERY = { query: '', location: [], department: [], worktype: [], remote: [] };

const TYPE_LABEL = { full: 'full-time', part: 'part-time', contract: 'contract', temp: 'temporary' };

const locationOf = (loc) => {
    if (!loc || typeof loc !== 'object') return null;
    return [loc.city, loc.region, loc.country].map(tidy).filter(Boolean).join(', ') || null;
};

export default {
    family: 'WORKABLE',
    portalType: 'WORKABLE',
    originBoard: 'workable',

    async fetchList(board, ctx) {
        const slug = enc(board.board_key);
        const maxPages = ctx.maxPages ?? DEFAULT_MAX_PAGES;

        const byId = new Map();
        let token = null;
        let bytes = 0;
        let total = null;
        let moreUnread = false;

        for (let page = 0; page < maxPages; page += 1) {
            const body = token ? { ...EMPTY_QUERY, token } : EMPTY_QUERY;
            const res = await ctx.http(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
                method: 'POST', body,
            });
            const results = res.json?.results;
            if (!Array.isArray(results)) throw new Error('Workable response has no results array.');
            bytes += res.bytes ?? 0;
            if (page === 0) total = Number(res.json?.total) || results.length;

            const before = byId.size;
            for (const r of results) if (r.shortcode) byId.set(r.shortcode, r);

            const next = res.json?.nextPage ?? null;
            if (!next) break;
            if (byId.size === before) { moreUnread = true; break; }   // token did not advance
            token = next;
            if (page === maxPages - 1) moreUnread = true;
        }

        const live = [...byId.values()].filter((r) => (!r.state || r.state === 'published') && !r.isInternal);
        const listHash = sha256(live.map((r) => r.shortcode).sort().join('|'));
        if (ctx.prevHash && ctx.prevHash === listHash) {
            return { notModified: true, listHash, bytes, status: 200 };
        }

        const items = live.map((r) => {
            const loc = locationOf(r.location);
            return {
                extId: r.shortcode,
                title: r.title,
                locationText: loc,
                publishedAt: null,
                publishedDay: dayOrNull(r.published),
                sourceUrl: `https://apply.workable.com/${slug}/j/${enc(r.shortcode)}/`,
                applyUrl: `https://apply.workable.com/${slug}/j/${enc(r.shortcode)}/apply/`,
                remote: r.remote === true || r.workplace === 'remote' ? true
                    : (r.workplace === 'on_site' ? false : looksRemote(loc)),
                workType: workTypeFromLabel(TYPE_LABEL[r.type] ?? r.type),
                needsDetail: true,
                raw: {
                    id: r.id, shortcode: r.shortcode, title: r.title, location: r.location,
                    published: r.published, type: r.type, workplace: r.workplace, department: r.department,
                },
            };
        });

        return {
            items, complete: !moreUnread && byId.size >= (total ?? 0),
            total: total ?? items.length, listHash, etag: null, bytes, status: 200,
        };
    },

    async fetchDetail(board, item, ctx) {
        const slug = enc(board.board_key);
        const res = await ctx.http(`https://apply.workable.com/api/v2/accounts/${slug}/jobs/${enc(item.extId)}`);
        const j = res.json ?? {};
        const description = [j.description, j.requirements, j.benefits]
            .map((h) => htmlToText(h)).filter(Boolean).join('\n\n') || null;
        return {
            description,
            publishedDay: dayOrNull(j.published) ?? item.publishedDay,
            raw: { ...item.raw, detail: { published: j.published, type: j.type, workplace: j.workplace } },
        };
    },
};
