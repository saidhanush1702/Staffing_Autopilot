/**
 * ── A LIST ITEM → THE POSTING SHAPE THE EXISTING PIPELINE CONSUMES ────
 *
 * Returns exactly what `searchJobToPosting` (JobsPipe) and `jobResultToPosting`
 * (SerpApi) return — `{ source, portalType, originBoard, posting }` — so
 * `ingestAdapted`, `upsertPosting`, `fingerprintPosting` and `evaluate` are
 * reused untouched, and a job found here and the same job found by another
 * door collapse onto ONE fingerprint (R-15).
 *
 * ── WHAT IS DIFFERENT FROM THE OTHER DOORS ────────────────────────────
 *
 * Everything an aggregator has to GUESS, this door KNOWS:
 *
 *   portalType   the family. A Greenhouse board's jobs are Greenhouse
 *                applications. `detectPortalType(url)` would get it wrong for
 *                any employer that serves its board from its own domain —
 *                Stripe's absolute_url is stripe.com/jobs/search?gh_jid=…,
 *                which a host test calls COMPANY_SITE.
 *   originBoard  the family, lower-case, in the same vocabulary migration 046
 *                already uses for JobsPipe ('greenhouse', 'lever', 'ashby').
 *   sourceUrl    the employer's own page for the job, not an aggregator's
 *                tracking redirect.
 *
 * ── THE COMPANY NAME IS THE FRAGILE PART ──────────────────────────────
 *
 * R-15 fingerprints company + title + location, normalised. "Accenture Federal
 * Services" and "accenturefederalservices" are two companies to it, so a job
 * this door found and the same job SerpApi found would be two postings. The
 * registry's company name therefore wins over anything the payload says, and
 * the humanised board key is only the last resort.
 */
import {
    tidy, cleanTitle, sanitiseUrl, looksRemote, humaniseKey,
} from './shared.js';

export const SOURCE_NAME = 'ATS_DIRECT';

/**
 * @param {object} board   the ats_boards row (board_key, company_name, config)
 * @param {object} item    a normalised list item, optionally merged with its detail
 * @param {object} family  the adapter ({ portalType, originBoard })
 * @param {Date}   [now]
 * @returns {{ source, portalType, originBoard, posting, extId }|null}
 */
export const toAdapted = (board, item, family, now = new Date()) => {
    const company = tidy(board.company_name) ?? tidy(item.companyName) ?? humaniseKey(board.board_key);
    const title = cleanTitle(item.title);
    if (!company || !title) return null;

    // The employer's own page first; the apply form second. Neither is a
    // redirect through a tracker, which is the point of reading the origin.
    const sourceUrl = sanitiseUrl(item.sourceUrl) ?? sanitiseUrl(item.applyUrl);
    if (!sourceUrl) return null;

    const locationText = tidy(item.locationText);
    const isRemote = item.remote ?? looksRemote(locationText, title);

    return {
        source: SOURCE_NAME,
        portalType: family.portalType,
        originBoard: family.originBoard,
        extId: item.extId,
        posting: {
            company,
            title,
            // 'Anywhere' on a remote role with no place named, for the same
            // reason the JobsPipe adapter does it: the fingerprint includes
            // location and an empty one would collide with every other remote
            // job at the company with the same title.
            locationText: locationText ?? (isRemote ? 'Anywhere' : null),
            isRemote,
            description: item.description ?? null,
            sourceUrl,
            workType: item.workType ?? null,
            payMin: item.pay?.min ?? null,
            payMax: item.pay?.max ?? null,
            payUnit: item.pay?.unit ?? null,
            payCurrency: item.pay?.currency ?? null,
            // When the employer says it was published; failing that, now — the
            // moment it appeared is the honest answer for a job that is new to
            // us, and `posted_at` drives ageing, so null would never age out.
            postedAt: item.publishedAt ?? now.toISOString(),
            providerJobId: `${family.originBoard}:${item.extId}`.slice(0, 200),
        },
    };
};
