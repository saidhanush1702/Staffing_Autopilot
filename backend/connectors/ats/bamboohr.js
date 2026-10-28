/**
 * ── BAMBOOHR ──────────────────────────────────────────────────────────
 *
 *   list    GET https://{slug}.bamboohr.com/careers/list
 *   detail  GET https://{slug}.bamboohr.com/careers/{id}/detail
 *
 * Public, no key. Verified live against Brightfin (1 job). The list is thin —
 * id, title, department, place — with NO date and no description, so a second
 * request is made for NEW jobs: the detail has the description and
 * `datePosted`, a calendar DAY (kept as `publishedDay`; no latency figure).
 *
 * Responses are `Cache-Control: no-store` with no ETag, so "nothing changed"
 * is decided by hashing the ids.
 *
 * A slug that does not exist is answered with a 302 to bamboohr.com's marketing
 * site, which the HTTP client follows to an HTML page — so it surfaces as an
 * unparseable response (an ERROR, retried with back-off), not as NOT_FOUND.
 */
import {
    htmlToText, dayOrNull, tidy, looksRemote, sha256,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;
const base = (board) => `https://${enc(board.board_key)}.bamboohr.com/careers`;

const placeOf = (p) => {
    const a = p.atsLocation ?? {};
    const l = p.location ?? {};
    return [a.city ?? l.city, a.state ?? l.state, a.country].map(tidy).filter(Boolean).join(', ') || null;
};

export default {
    family: 'BAMBOOHR',
    portalType: 'BAMBOOHR',
    originBoard: 'bamboohr',

    async fetchList(board, ctx) {
        const res = await ctx.http(`${base(board)}/list`);
        const result = res.json?.result;
        if (!Array.isArray(result)) throw new Error('BambooHR response has no result array.');

        const listHash = sha256(result.map((p) => String(p.id)).sort().join('|'));
        if (ctx.prevHash && ctx.prevHash === listHash) {
            return { notModified: true, listHash, bytes: res.bytes, status: res.status };
        }

        const items = result.map((p) => {
            const loc = placeOf(p);
            return {
                extId: String(p.id),
                title: p.jobOpeningName,
                locationText: loc,
                publishedAt: null,
                sourceUrl: `${base(board)}/${enc(p.id)}`,
                applyUrl: null,
                remote: p.isRemote === true ? true : looksRemote(loc, p.jobOpeningName),
                workType: workTypeFromLabel(p.employmentType ?? p.employmentStatusLabel),
                needsDetail: true,
                raw: {
                    id: p.id, jobOpeningName: p.jobOpeningName, departmentLabel: p.departmentLabel,
                    employmentStatusLabel: p.employmentStatusLabel, atsLocation: p.atsLocation,
                },
            };
        });

        return {
            items, complete: true, total: items.length,
            listHash, etag: null, bytes: res.bytes, status: res.status,
        };
    },

    async fetchDetail(board, item, ctx) {
        const res = await ctx.http(`${base(board)}/${enc(item.extId)}/detail`);
        const jo = res.json?.result?.jobOpening ?? {};
        return {
            description: htmlToText(jo.description),
            publishedDay: dayOrNull(jo.datePosted),
            sourceUrl: jo.jobOpeningShareUrl ?? item.sourceUrl,
            raw: { ...item.raw, detail: { datePosted: jo.datePosted, jobOpeningStatus: jo.jobOpeningStatus } },
        };
    },
};
