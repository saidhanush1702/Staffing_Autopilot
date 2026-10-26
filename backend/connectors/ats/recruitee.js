/**
 * ── RECRUITEE ─────────────────────────────────────────────────────────
 *
 *   list    GET https://{slug}.recruitee.com/api/offers/
 *
 * Public, no key, and the list carries everything: description, requirements,
 * `published_at`, the employer's own page and apply link. No detail request.
 * Verified live against bunq (21 offers, 620 KB). The response has NO ETag
 * (Cache-Control: max-age=0, must-revalidate), so "nothing changed" is decided
 * the way Workday's is: by hashing the ids and comparing with last time.
 *
 * `published_at` looks like "2026-10-15 09:31:36 UTC" — an exact instant, but
 * not ISO, so it is normalised before it is trusted.
 */
import {
    htmlToText, isoOrNull, tidy, normalisePay, looksRemote, sha256,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;

/** '2026-10-15 09:31:36 UTC' → ISO, or null. */
export const recruiteeTime = (raw, now) => {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*UTC|Z)?$/.exec(String(raw ?? '').trim());
    return m ? isoOrNull(`${m[1]}T${m[2]}Z`, now) : null;
};

export const payFromSalary = (s) => {
    if (!s || typeof s !== 'object') return null;
    const period = String(s.period ?? '').toLowerCase();
    const unit = /hour/.test(period) ? 'HOURLY' : (/year|annual/.test(period) ? 'ANNUAL' : null);
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    return unit ? normalisePay({ min: num(s.min), max: num(s.max), unit, currency: s.currency }) : null;
};

export default {
    family: 'RECRUITEE',
    portalType: 'RECRUITEE',
    originBoard: 'recruitee',

    async fetchList(board, ctx) {
        const res = await ctx.http(`https://${enc(board.board_key)}.recruitee.com/api/offers/`);
        const offers = res.json?.offers;
        if (!Array.isArray(offers)) throw new Error('Recruitee response has no offers array.');

        const live = offers.filter((o) => !o.status || o.status === 'published');
        const listHash = sha256(live.map((o) => String(o.id)).sort().join('|'));
        if (ctx.prevHash && ctx.prevHash === listHash) {
            return { notModified: true, listHash, bytes: res.bytes, status: res.status };
        }

        const items = live.map((o) => {
            const loc = tidy(o.location) ?? ([o.city, o.country].filter(Boolean).join(', ') || null);
            return {
                extId: String(o.id),
                title: o.title,
                locationText: loc,
                publishedAt: recruiteeTime(o.published_at, ctx.now),
                companyName: tidy(o.company_name),
                sourceUrl: o.careers_url,
                applyUrl: o.careers_apply_url,
                remote: o.remote === true ? true : (o.on_site === true ? false : looksRemote(loc)),
                workType: workTypeFromLabel(o.employment_type_code),
                pay: payFromSalary(o.salary),
                description: [htmlToText(o.description), htmlToText(o.requirements)].filter(Boolean).join('\n\n') || null,
                needsDetail: false,
                raw: {
                    id: o.id, slug: o.slug, title: o.title, location: o.location,
                    published_at: o.published_at, department: o.department,
                    employment_type_code: o.employment_type_code,
                },
            };
        });

        return {
            items, complete: true, total: items.length,
            listHash, etag: null, bytes: res.bytes, status: res.status,
        };
    },
};
