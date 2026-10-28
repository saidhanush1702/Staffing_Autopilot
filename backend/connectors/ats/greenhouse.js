/**
 * ── GREENHOUSE ────────────────────────────────────────────────────────
 *
 *   list    GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 *   detail  GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}
 *
 * Public, no key. Verified live against Stripe (725 jobs, 450 KB) and Airbnb:
 *
 *   · the LIST already carries `first_published` (a real timestamp, to the
 *     second) and `company_name`, so a new job's publication time and
 *     employer are known without a second request. `?content=true` would add
 *     the description but turns Stripe's 450 KB into several MB, on every poll.
 *   · so the list is read WITHOUT content and the description is fetched per
 *     NEW job only.
 *   · the response has an ETag; a conditional re-request returned 304, 0 bytes.
 *   · `content` is HTML that was entity-ESCAPED ("&lt;p&gt;") — see
 *     shared.htmlToText.
 *   · `updated_at` changes whenever the employer edits a job, so it is NOT a
 *     publication time and is never used as one. New is decided by id.
 */
import {
    htmlToText, isoOrNull, tidy, looksRemote, workTypeFromTitle,
} from './shared.js';

const API = 'https://boards-api.greenhouse.io/v1/boards';
const enc = encodeURIComponent;

/** Greenhouse stores some structured answers as custom "metadata" on a job. */
const metaValue = (metadata, nameRe) => {
    const hit = (Array.isArray(metadata) ? metadata : []).find((m) => nameRe.test(m?.name ?? ''));
    const v = hit?.value;
    return typeof v === 'string' ? v : null;
};

const slimListItem = (j) => ({
    id: j.id, internal_job_id: j.internal_job_id, requisition_id: j.requisition_id,
    updated_at: j.updated_at, first_published: j.first_published,
});

export default {
    family: 'GREENHOUSE',
    portalType: 'GREENHOUSE',
    originBoard: 'greenhouse',

    async fetchList(board, ctx) {
        const res = await ctx.http(`${API}/${enc(board.board_key)}/jobs`, { etag: ctx.etag });
        if (res.notModified) return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };

        const jobs = res.json?.jobs;
        if (!Array.isArray(jobs)) throw new Error('Greenhouse response has no jobs array.');

        const items = jobs.map((j) => {
            const workplace = metaValue(j.metadata, /workplace|work (type|arrangement)/i);
            return {
                extId: String(j.id),
                title: j.title,
                locationText: j.location?.name ?? null,
                publishedAt: isoOrNull(j.first_published, ctx.now),
                companyName: tidy(j.company_name),
                // absolute_url is the employer's own page for the job — often
                // their domain with ?gh_jid=, which embeds the Greenhouse form.
                sourceUrl: j.absolute_url,
                applyUrl: `https://job-boards.greenhouse.io/${enc(board.board_key)}/jobs/${j.id}`,
                remote: workplace ? /remote/i.test(workplace) : looksRemote(j.location?.name),
                workType: workTypeFromTitle(j.title),
                needsDetail: true,
                raw: slimListItem(j),
            };
        });

        return {
            items, complete: true, total: res.json?.meta?.total ?? items.length,
            etag: res.etag, bytes: res.bytes, status: res.status,
        };
    },

    async fetchDetail(board, item, ctx) {
        const res = await ctx.http(`${API}/${enc(board.board_key)}/jobs/${enc(item.extId)}`);
        const j = res.json ?? {};
        return {
            description: htmlToText(j.content, { escaped: true }),
            publishedAt: isoOrNull(j.first_published, ctx.now) ?? item.publishedAt,
            locationText: j.location?.name ?? item.locationText,
            companyName: tidy(j.company_name) ?? item.companyName,
            sourceUrl: j.absolute_url ?? item.sourceUrl,
            raw: { ...item.raw, detail: j },
        };
    },
};
