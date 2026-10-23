/**
 * ── THE ATS ADAPTER REGISTRY ──────────────────────────────────────────
 *
 * One adapter per career-system family, all with the same four-part contract:
 *
 *   fetchList(board, ctx)          → { items, complete, etag?, listHash?, bytes, status }
 *                                    or { notModified: true }
 *   fetchDetail(board, item, ctx)  → fields to merge onto an item (optional)
 *   family / portalType / originBoard   identity
 *
 * `ctx` is everything an adapter needs and nothing it could use to misbehave:
 *
 *   http(url, opts)   the ONLY way out. Injected, so tests run on fixtures and
 *                     production runs through the per-host politeness limiter.
 *   etag, prevHash    what we sent / saw last time, for conditional requests.
 *   knownIds          ids already held for this board, so newest-first families
 *                     can stop reading at the first page they recognise.
 *   isBootstrap       the first poll; "known" means nothing yet.
 *   maxPages, now
 *
 * Adding a family is one file here, one row in lkp_ats_families, and a branch
 * in detect.js. Nothing downstream changes.
 */
import greenhouse from './greenhouse.js';
import lever from './lever.js';
import ashby from './ashby.js';
import workday from './workday.js';
import smartrecruiters from './smartrecruiters.js';
import { workdayConfigFromKey } from './detect.js';

export const ADAPTERS = {
    GREENHOUSE: greenhouse,
    LEVER: lever,
    ASHBY: ashby,
    WORKDAY: workday,
    SMARTRECRUITERS: smartrecruiters,
};

export const FAMILY_NAMES = Object.keys(ADAPTERS);

export const adapterFor = (family) => {
    const adapter = ADAPTERS[family];
    if (!adapter) throw new Error(`No ATS adapter for family "${family}".`);
    return adapter;
};

/** A board row with the config Workday needs, rebuilt from its key if absent. */
export const withConfig = (board) => {
    if (board.family !== 'WORKDAY' || board.config?.host) return board;
    const config = workdayConfigFromKey(board.board_key);
    return config ? { ...board, config } : board;
};

/**
 * Read a board once and say what is there — WITHOUT writing anything.
 *
 * This is what "Verify" in the UI calls before a board is saved, and what
 * the discovery scan calls for each guessed slug. A 200 with a jobs array is
 * the proof that the address is real; the sample titles are the proof that it
 * is the right company.
 *
 * @returns {{ ok:true, total, sample:string[], companyName:string|null }}
 *        | {{ ok:false, notFound:boolean, error:string }}
 */
export const probeBoard = async (board, ctx) => {
    try {
        const adapter = adapterFor(board.family);
        const list = await adapter.fetchList(withConfig(board), {
            ...ctx, etag: null, prevHash: null, knownIds: new Set(), isBootstrap: true, maxPages: 1,
        });
        const items = list.items ?? [];
        // Prefer the newest few for the sample: that is what the mirror will see.
        const sample = items.slice(0, 5).map((i) => i.title).filter(Boolean);
        return {
            ok: true,
            total: list.total ?? items.length,
            sample,
            companyName: items.find((i) => i.companyName)?.companyName ?? null,
        };
    } catch (err) {
        return { ok: false, notFound: err?.kind === 'NOT_FOUND', error: err?.message ?? 'Unknown error' };
    }
};
