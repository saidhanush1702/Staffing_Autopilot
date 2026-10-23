/**
 * ── LEVER ─────────────────────────────────────────────────────────────
 *
 *   list    GET https://api.lever.co/v0/postings/{slug}?mode=json
 *           (EU-region accounts: api.eu.lever.co — chosen by board.config.host)
 *
 * Public, no key, and the list carries everything: description, requirements,
 * `createdAt` (epoch ms — the publication time), apply link, and sometimes pay.
 * No detail request. Verified live against Palantir (299 jobs, 5.8 MB — which is
 * why the ETag matters: a conditional re-request returned 304, 0 bytes).
 *
 * `salaryRange.interval` was observed as "per-year-salary". Hourly roles use a
 * "per-hour-…" interval; anything else (monthly, weekly) is dropped rather than
 * converted, because a converted figure is an invented one.
 */
import {
    plain, isoOrNull, tidy, normalisePay, looksRemote,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;

export const payFromRange = (range) => {
    if (!range || typeof range !== 'object') return null;
    const interval = String(range.interval ?? '').toLowerCase();
    let unit = null;
    if (/hour/.test(interval)) unit = 'HOURLY';
    else if (/year|annual/.test(interval)) unit = 'ANNUAL';
    return unit ? normalisePay({ min: range.min, max: range.max, unit, currency: range.currency }) : null;
};

/** Description + the "requirements"-style lists, as one block of text. */
const buildDescription = (p) => {
    const lists = (Array.isArray(p.lists) ? p.lists : [])
        .map((l) => [tidy(l.text), plain(l.content)].filter(Boolean).join('\n'))
        .filter(Boolean);
    return [tidy(p.descriptionPlain) ? p.descriptionPlain.trim() : plain(p.description), ...lists,
        p.additionalPlain?.trim() || plain(p.additional)]
        .filter(Boolean).join('\n\n') || null;
};

export default {
    family: 'LEVER',
    portalType: 'LEVER',
    originBoard: 'lever',

    async fetchList(board, ctx) {
        const host = board.config?.host ?? 'api.lever.co';
        const res = await ctx.http(`https://${host}/v0/postings/${enc(board.board_key)}?mode=json`, { etag: ctx.etag });
        if (res.notModified) return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };

        if (!Array.isArray(res.json)) throw new Error('Lever response is not an array.');

        const items = res.json.map((p) => {
            const loc = tidy(p.categories?.location)
                ?? (Array.isArray(p.categories?.allLocations) ? p.categories.allLocations.join('; ') : null);
            const workplace = String(p.workplaceType ?? '').toLowerCase();
            return {
                extId: String(p.id),
                title: p.text,
                locationText: loc,
                publishedAt: isoOrNull(p.createdAt, ctx.now),
                sourceUrl: p.hostedUrl,
                applyUrl: p.applyUrl,
                remote: workplace === 'remote' ? true : (workplace === 'onsite' ? false : looksRemote(loc)),
                workType: workTypeFromLabel(p.categories?.commitment),
                pay: payFromRange(p.salaryRange),
                description: buildDescription(p),
                needsDetail: false,
                raw: p,
            };
        });

        return {
            items, complete: true, total: items.length,
            etag: res.etag, bytes: res.bytes, status: res.status,
        };
    },
};
