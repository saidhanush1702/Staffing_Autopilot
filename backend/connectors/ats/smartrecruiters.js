/**
 * ── SMARTRECRUITERS ───────────────────────────────────────────────────
 *
 *   list    GET https://api.smartrecruiters.com/v1/companies/{id}/postings
 *               ?limit=100&offset=N
 *   detail  GET https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
 *
 * Public, no key. Verified live (Equinox 744 postings, BoschGroup 5,096):
 *
 *   · the company identifier is case-sensitive and not guessable —
 *     "Visa" returned 0, "BoschGroup" returned 5,096 — so it comes from the
 *     employer's careers URL, never from a company name.
 *   · NEWEST FIRST by `releasedDate`, with an ETag. So an unchanged board is a
 *     304, and a changed one needs only the top of the list: read pages until
 *     one contains a job we already hold, then stop. That read is PARTIAL, so
 *     `complete` is false and absence from it never closes a job.
 *   · `releasedDate` is a full timestamp (millisecond precision), so latency is
 *     measurable to the second.
 *   · the list has no description; the detail request supplies the sections.
 */
import { htmlToText, isoOrNull, tidy } from './shared.js';
import { workTypeFromLabel } from './labels.js';

const API = 'https://api.smartrecruiters.com/v1/companies';
const PAGE = 100;
const DEFAULT_MAX_PAGES = 3;
const enc = encodeURIComponent;

/** The sections that describe the JOB; the company blurb is boilerplate. */
const SECTIONS = ['jobDescription', 'qualifications', 'additionalInformation'];

export default {
    family: 'SMARTRECRUITERS',
    portalType: 'SMARTRECRUITERS',
    originBoard: 'smartrecruiters',

    async fetchList(board, ctx) {
        const known = ctx.knownIds ?? new Set();
        const maxPages = ctx.maxPages ?? DEFAULT_MAX_PAGES;

        const collected = [];
        let total = 0;
        let bytes = 0;
        let etag = null;
        let stoppedEarly = false;

        for (let page = 0; page < maxPages; page += 1) {
            const url = `${API}/${enc(board.board_key)}/postings?limit=${PAGE}&offset=${page * PAGE}`;
            // The ETag belongs to page one's URL; deeper pages are never conditional.
            const res = await ctx.http(url, { etag: page === 0 ? ctx.etag : null });

            if (page === 0 && res.notModified) {
                return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };
            }

            const content = res.json?.content;
            if (!Array.isArray(content)) throw new Error('SmartRecruiters response has no content array.');

            bytes += res.bytes ?? 0;
            if (page === 0) { total = Number(res.json?.totalFound) || content.length; etag = res.etag; }
            if (content.length === 0) break;

            collected.push(...content);

            if (!ctx.isBootstrap && content.some((p) => known.has(String(p.id)))) {
                stoppedEarly = true;
                break;
            }
            if (collected.length >= total) break;
        }

        const items = collected
            // Only postings anyone can see.
            .filter((p) => !p.visibility || p.visibility === 'PUBLIC')
            .map((p) => {
                const loc = p.location ?? {};
                return {
                    extId: String(p.id),
                    title: p.name,
                    locationText: tidy(loc.fullLocation) ?? ([loc.city, loc.region].filter(Boolean).join(', ') || null),
                    publishedAt: isoOrNull(p.releasedDate, ctx.now),
                    companyName: tidy(p.company?.name),
                    // Redirects to the slugged page; replaced by postingUrl once
                    // the detail request has run.
                    sourceUrl: `https://jobs.smartrecruiters.com/${enc(p.company?.identifier ?? board.board_key)}/${p.id}`,
                    applyUrl: null,
                    remote: loc.remote === true ? true : undefined,
                    workType: workTypeFromLabel(p.typeOfEmployment?.id ?? p.typeOfEmployment?.label),
                    needsDetail: true,
                    raw: {
                        id: p.id, name: p.name, releasedDate: p.releasedDate, refNumber: p.refNumber,
                        location: p.location, typeOfEmployment: p.typeOfEmployment, department: p.department,
                    },
                };
            });

        return {
            items, complete: !stoppedEarly && collected.length >= total,
            total, etag, bytes, status: 200,
        };
    },

    async fetchDetail(board, item, ctx) {
        const res = await ctx.http(`${API}/${enc(board.board_key)}/postings/${enc(item.extId)}`);
        const j = res.json ?? {};
        const sections = j.jobAd?.sections ?? {};
        const description = SECTIONS
            .map((k) => htmlToText(sections[k]?.text))
            .filter(Boolean)
            .join('\n\n') || null;

        return {
            description,
            sourceUrl: j.postingUrl ?? item.sourceUrl,
            applyUrl: j.applyUrl ?? item.applyUrl,
            raw: { ...item.raw, detail: { postingUrl: j.postingUrl, applyUrl: j.applyUrl, jobAd: j.jobAd } },
        };
    },
};
