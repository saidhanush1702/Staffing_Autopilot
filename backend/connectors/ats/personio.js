/**
 * ── PERSONIO ──────────────────────────────────────────────────────────
 *
 *   list    GET https://{slug}.jobs.personio.de/xml      (XML)
 *
 * Public, no key, and it honours If-None-Match (verified: a strong ETag). The
 * feed carries everything in one response — title, offices, department,
 * employment type, schedule, `createdAt` (an exact instant) and, where the
 * employer has written one, the description as CDATA sections.
 *
 * The XML is flat and machine-written, so it is read with a small tag scanner
 * rather than a dependency. Some accounts live on `.jobs.personio.com`; that
 * host is chosen by `board.config.host`.
 */
import {
    htmlToText, decodeEntities, isoOrNull, tidy, looksRemote,
} from './shared.js';
import { workTypeFromLabel } from './labels.js';

const enc = encodeURIComponent;

const unwrap = (s) => {
    const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s ?? '');
    return m ? m[1] : decodeEntities(s ?? '');
};

/** First `<tag>…</tag>` inside `block`, text-decoded. Null when absent/empty. */
const one = (block, tag) => {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
    return m ? (tidy(unwrap(m[1])) ?? null) : null;
};

const all = (block, tag) => [...block.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))]
    .map((m) => tidy(unwrap(m[1]))).filter(Boolean);

/** Every `<position>` of the feed as a plain object. Exported for the tests. */
export const parseFeed = (xml) => [...String(xml ?? '').matchAll(/<position>([\s\S]*?)<\/position>/g)]
    .map(([, block]) => {
        const sections = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map(([, d]) => {
            const value = /<value>([\s\S]*?)<\/value>/.exec(d)?.[1];
            return [one(d, 'name'), htmlToText(unwrap(value ?? ''))].filter(Boolean).join('\n');
        }).filter(Boolean);
        return {
            id: one(block, 'id'),
            subcompany: one(block, 'subcompany'),
            office: one(block, 'office'),
            additionalOffices: all(/<additionalOffices>([\s\S]*?)<\/additionalOffices>/.exec(block)?.[1] ?? '', 'office'),
            department: one(block, 'department'),
            name: one(block, 'name'),
            employmentType: one(block, 'employmentType'),
            schedule: one(block, 'schedule'),
            createdAt: one(block, 'createdAt'),
            description: sections.join('\n\n') || null,
        };
    });

export default {
    family: 'PERSONIO',
    portalType: 'PERSONIO',
    originBoard: 'personio',

    async fetchList(board, ctx) {
        const host = board.config?.host ?? `${enc(board.board_key)}.jobs.personio.de`;
        const res = await ctx.http(`https://${host}/xml`, {
            as: 'text', etag: ctx.etag, headers: { Accept: 'application/xml' },
        });
        if (res.notModified) return { notModified: true, etag: ctx.etag, bytes: 0, status: 304 };
        if (!/<workzag-jobs[\s>]/.test(res.text)) throw new Error('Personio response is not a job feed.');

        const items = parseFeed(res.text).filter((p) => p.id && p.name).map((p) => {
            const offices = [p.office, ...p.additionalOffices].filter(Boolean);
            const loc = [...new Set(offices)].join('; ') || null;
            const label = [p.schedule, p.employmentType].filter(Boolean).join(' ');
            return {
                extId: p.id,
                title: p.name,
                locationText: loc,
                publishedAt: isoOrNull(p.createdAt, ctx.now),
                companyName: p.subcompany,
                sourceUrl: `https://${host}/job/${enc(p.id)}`,
                applyUrl: `https://${host}/job/${enc(p.id)}?display=en#apply`,
                remote: looksRemote(loc, p.name),
                workType: workTypeFromLabel(label),
                description: p.description,
                needsDetail: false,
                raw: {
                    id: p.id, name: p.name, office: p.office, department: p.department,
                    employmentType: p.employmentType, schedule: p.schedule, createdAt: p.createdAt,
                },
            };
        });

        return {
            items, complete: true, total: items.length,
            etag: res.etag, bytes: res.bytes, status: res.status,
        };
    },
};
