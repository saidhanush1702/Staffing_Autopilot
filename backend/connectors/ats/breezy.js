/**
 * ── BREEZY HR ─────────────────────────────────────────────────────────
 *
 *   list    GET https://{slug}.breezy.hr/json
 *   detail  GET https://{slug}.breezy.hr/p/{id}      (HTML — description only)
 *
 * Public, no key, and it honours If-None-Match (verified: the list carries a
 * weak ETag). The list has an exact `published_date`, the employer's page URL,
 * the company name and the place — but no description, so NEW jobs get one
 * extra request for the page, from which the `description` block is read.
 *
 * `salary` is free text ("$0.05 – $0.06 / hour"), so it is left alone: a unit
 * parsed out of prose is a guess, and a guessed pay unit survives into scoring.
 */
import {
    htmlToText, isoOrNull, tidy, looksRemote,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;

const placeOf = (loc) => {
    if (!loc || typeof loc !== 'object') return null;
    const name = (v) => (v && typeof v === 'object' ? (v.name ?? v.id) : v);
    return [tidy(loc.city), tidy(name(loc.state)), tidy(name(loc.country))].filter(Boolean).join(', ') || null;
};

/** The `<div class="description">` block of a Breezy job page, as text. */
export const descriptionFromPage = (html) => {
    const s = String(html ?? '');
    const start = s.indexOf('<div class="description">');
    if (start < 0) return null;
    const rest = s.slice(start + '<div class="description">'.length);
    const end = rest.indexOf('<div class="apply-container">');
    const block = end >= 0 ? rest.slice(0, end) : rest;
    return htmlToText(block.replace(/<\/div>\s*$/, ''));
};

export default {
    family: 'BREEZY',
    portalType: 'BREEZY',
    originBoard: 'breezy',

    async fetchList(board, ctx) {
        const res = await ctx.http(`https://${enc(board.board_key)}.breezy.hr/json`, { etag: ctx.etag });
        if (res.notModified) return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };
        if (!Array.isArray(res.json)) throw new Error('Breezy response is not an array.');

        const items = res.json
            .filter((p) => !p.state || p.state === 'published')
            .map((p) => {
                const loc = placeOf(p.location);
                return {
                    extId: String(p.id),
                    title: p.name,
                    locationText: loc,
                    publishedAt: isoOrNull(p.published_date, ctx.now),
                    companyName: tidy(p.company?.name),
                    sourceUrl: p.url,
                    applyUrl: p.url ? `${p.url.replace(/\/$/, '')}/apply` : null,
                    remote: p.location?.is_remote === true ? true : looksRemote(loc, p.name),
                    workType: workTypeFromLabel(p.type?.name ?? p.type?.id),
                    needsDetail: true,
                    raw: {
                        id: p.id, friendly_id: p.friendly_id, name: p.name, url: p.url,
                        published_date: p.published_date, type: p.type, department: p.department,
                    },
                };
            });

        return {
            items, complete: true, total: items.length,
            etag: res.etag, bytes: res.bytes, status: res.status,
        };
    },

    async fetchDetail(board, item, ctx) {
        const url = item.sourceUrl ?? `https://${enc(board.board_key)}.breezy.hr/p/${enc(item.extId)}`;
        const res = await ctx.http(url, { as: 'text', headers: { Accept: 'text/html' } });
        return { description: descriptionFromPage(res.text) };
    },
};
