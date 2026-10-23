/**
 * ── ASHBY ─────────────────────────────────────────────────────────────
 *
 *   list    GET https://api.ashbyhq.com/posting-api/job-board/{name}
 *               ?includeCompensation=true
 *
 * Public, no key; the list carries everything (description, `publishedAt`,
 * apply link, compensation). Verified live against Ramp (170 jobs) and OpenAI
 * (a 13 MB response — ETag support is not optional at that size).
 *
 * ⚠ Ashby serves this from a CDN with `Cache-Control: public, max-age=60`. A
 * poll faster than every 60 seconds re-reads the same cached bytes, so the
 * family's floor in lkp_ats_families is 60.
 *
 * Compensation arrives as typed components. Only a `Salary` component with a
 * YEAR or HOUR interval becomes pay; equity, commission and bonus are not pay
 * in the sense `minPay` compares, and a MONTH interval is dropped rather than
 * multiplied by twelve.
 */
import { isoOrNull, tidy, normalisePay } from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;

export const payFromCompensation = (comp) => {
    const parts = Array.isArray(comp?.summaryComponents) ? comp.summaryComponents : [];
    const salaries = parts.filter((c) => c?.compensationType === 'Salary'
        && (c.minValue != null || c.maxValue != null));
    if (salaries.length === 0) return null;

    // A posting can list the same role in several currencies. Take USD when
    // there is one — this is a US staffing agency — and otherwise only accept
    // an unambiguous single entry.
    const usd = salaries.filter((c) => c.currencyCode === 'USD');
    const chosen = usd.length === 1 ? usd[0] : (salaries.length === 1 ? salaries[0] : null);
    if (!chosen) return null;

    const interval = String(chosen.interval ?? '').toUpperCase();
    const unit = /^1\s*YEAR$/.test(interval) ? 'ANNUAL' : (/^1\s*HOUR$/.test(interval) ? 'HOURLY' : null);
    return unit
        ? normalisePay({ min: chosen.minValue, max: chosen.maxValue, unit, currency: chosen.currencyCode })
        : null;
};

export default {
    family: 'ASHBY',
    portalType: 'ASHBY',
    originBoard: 'ashby',

    async fetchList(board, ctx) {
        const res = await ctx.http(
            `https://api.ashbyhq.com/posting-api/job-board/${enc(board.board_key)}?includeCompensation=true`,
            { etag: ctx.etag },
        );
        if (res.notModified) return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };

        const jobs = res.json?.jobs;
        if (!Array.isArray(jobs)) throw new Error('Ashby response has no jobs array.');

        const items = jobs
            // isListed:false is a posting that exists but is not public.
            .filter((j) => j?.isListed !== false)
            .map((j) => {
                const workplace = String(j.workplaceType ?? '').toLowerCase();
                // workplaceType is the employer's own statement of the role;
                // isRemote is true whenever ANY secondary location is remote —
                // measured on Ramp, 140 of 153 "Hybrid" jobs carry isRemote:true.
                // Trusting the flag would show hybrid-NYC roles as remote.
                const remote = workplace ? workplace === 'remote' : j.isRemote === true;
                return {
                    extId: String(j.id),
                    title: j.title,
                    locationText: tidy(j.location) ?? (remote ? 'Remote' : null),
                    publishedAt: isoOrNull(j.publishedAt, ctx.now),
                    sourceUrl: j.jobUrl,
                    applyUrl: j.applyUrl,
                    remote,
                    workType: workTypeFromLabel(j.employmentType),
                    pay: payFromCompensation(j.compensation),
                    description: tidy(j.descriptionPlain) ? j.descriptionPlain.trim() : null,
                    needsDetail: false,
                    raw: j,
                };
            });

        return {
            items, complete: true, total: items.length,
            etag: res.etag, bytes: res.bytes, status: res.status,
        };
    },
};
