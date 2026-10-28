/**
 * ── WORKDAY ───────────────────────────────────────────────────────────
 *
 *   list    POST https://{host}/wday/cxs/{tenant}/{site}/jobs
 *                body {"appliedFacets":{},"limit":20,"offset":N,"searchText":""}
 *   detail  GET  https://{host}/wday/cxs/{tenant}/{site}{externalPath}
 *
 * Workday publishes no API, but every career site is a single-page app over
 * this JSON, public and keyless. Verified live against NVIDIA. It is the
 * awkward family, and each awkwardness is handled here rather than leaked:
 *
 *   · NO ETag, `Cache-Control: no-store`. Every poll is a full request, so the
 *     family's floor is 5 minutes, and "unchanged" is decided by hashing the ids
 *     (`listHash`).
 *   · pages of 20, hard-capped — a larger `limit` is an HTTP 400.
 *   · `total` saturates at 2000 on large boards, so it is a size estimate.
 *   · NEWEST FIRST. That is what makes a partial read safe: new jobs are at the
 *     top, so a poll reads pages until it reaches one it already knows and
 *     stops. Because that is a PARTIAL read, `complete` is false and absence from
 *     it never counts as a job closing.
 *   · the list has no publication time, only "Posted Today / Yesterday / N Days
 *     Ago" — a DAY, not an instant. It is kept as `publishedDay` and never
 *     promoted to a timestamp, because a midnight guess would inflate every
 *     latency figure by up to 24 hours.
 *   · the list has no description; the detail request supplies it, plus
 *     `startDate` (an exact day) and the real location ("3 Locations" is all
 *     the list says, and as a fingerprint input that would merge distinct jobs).
 *
 * `hiringOrganization.name` is a legal entity ("2100 NVIDIA USA"), not the brand
 * — it is the company-name fallback only; the registry's name wins.
 */
import {
    htmlToText, dayOrNull, tidy, sha256, looksRemote,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const PAGE = 20;
const DEFAULT_MAX_PAGES = 5;

export const baseUrl = (board) => {
    const { host, tenant, site } = board.config ?? {};
    return `https://${host}/wday/cxs/${tenant}/${site}`;
};

/** "Posted Today" → today's date; "Posted 3 Days Ago" → 3 days earlier. */
export const postedOnToDay = (text, now = new Date()) => {
    const t = String(text ?? '').toLowerCase();
    const day = (offset) => {
        const d = new Date(now.getTime() - offset * 86_400_000);
        return d.toISOString().slice(0, 10);
    };
    if (/today/.test(t)) return day(0);
    if (/yesterday/.test(t)) return day(1);
    // "30+ Days Ago" means "at least 30" — not a date we can state.
    if (/\+/.test(t)) return null;
    const m = /(\d+)\s+day/.exec(t);
    return m ? day(Number(m[1])) : null;
};

const extIdOf = (p) => tidy(p?.bulletFields?.[0])
    ?? String(p?.externalPath ?? '').split('_').pop()
    ?? null;

export default {
    family: 'WORKDAY',
    portalType: 'WORKDAY',
    originBoard: 'workday',

    async fetchList(board, ctx) {
        const base = baseUrl(board);
        const maxPages = ctx.maxPages ?? DEFAULT_MAX_PAGES;
        const known = ctx.knownIds ?? new Set();

        const collected = [];
        let total = null;
        let bytes = 0;
        let stoppedEarly = false;

        for (let page = 0; page < maxPages; page += 1) {
            const res = await ctx.http(`${base}/jobs`, {
                method: 'POST',
                body: { appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText: '' },
            });
            const postings = Array.isArray(res.json?.jobPostings) ? res.json.jobPostings : null;
            if (!postings) throw new Error('Workday response has no jobPostings array.');

            bytes += res.bytes ?? 0;
            if (page === 0) total = Number(res.json?.total) || postings.length;
            if (postings.length === 0) break;

            collected.push(...postings);

            // Newest first, so a page made entirely of jobs we already hold means
            // everything older is also held. Not applied during the baseline
            // poll, which has nothing "known" to compare against.
            if (!ctx.isBootstrap && postings.every((p) => known.has(extIdOf(p)))) {
                stoppedEarly = true;
                break;
            }
            if (collected.length >= total) break;
        }

        const listHash = sha256(collected.map(extIdOf).join('|'));
        if (ctx.prevHash && ctx.prevHash === listHash) {
            return { notModified: true, listHash, bytes, status: 200 };
        }

        const items = collected.map((p) => {
            const publishedDay = postedOnToDay(p.postedOn, ctx.now);
            return {
                extId: extIdOf(p),
                title: p.title,
                locationText: tidy(p.locationsText),
                publishedAt: null,
                publishedDay,
                sourceUrl: `https://${board.config.host}/${board.config.site}${p.externalPath}`,
                applyUrl: null,
                needsDetail: true,
                raw: { title: p.title, externalPath: p.externalPath, postedOn: p.postedOn, bulletFields: p.bulletFields },
            };
        }).filter((i) => i.extId);

        return {
            items,
            complete: !stoppedEarly && collected.length >= total,
            total, listHash, etag: null, bytes, status: 200,
        };
    },

    async fetchDetail(board, item, ctx) {
        const res = await ctx.http(`${baseUrl(board)}${item.raw.externalPath}`);
        const info = res.json?.jobPostingInfo ?? {};
        const extra = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
        const location = tidy(info.location) ?? item.locationText;

        return {
            description: htmlToText(info.jobDescription),
            publishedDay: dayOrNull(info.startDate) ?? item.publishedDay,
            locationText: location,
            companyName: tidy(res.json?.hiringOrganization?.name),
            sourceUrl: info.externalUrl ?? item.sourceUrl,
            workType: workTypeFromLabel(info.timeType),
            remote: looksRemote(location, ...extra, item.title),
            raw: { ...item.raw, detail: info },
        };
    },
};
