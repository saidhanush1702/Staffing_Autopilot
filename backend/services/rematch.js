/**
 * ── RE-CHECKING THE POOL FOR ONE CONSULTANT, NOW ──────────────────────
 *
 * The scheduled discovery run already re-evaluates the newest active postings
 * against everyone on the bench, so a criteria change is picked up — at the
 * next run, which can be hours away. A recruiter who has just set a consultant
 * up expects to see their jobs now, not after the next cycle, and a consultant
 * who has just been activated is otherwise blind to everything that arrived
 * while they were not.
 *
 * So this evaluates the pool for ONE consultant, immediately, with the same
 * `evaluate()` every other door uses, and links what matches through the same
 * rows the listener writes (matchLinker.js).
 *
 * ── BOUNDED ON PURPOSE ────────────────────────────────────────────────
 *
 *   · only active postings, newest first, at most `limit` rows
 *   · only postings first seen in the last `days` days
 *   · matches are linked best-score first and at most `maxLinks` of them, so
 *     activating someone does not drop a month of backlog into their queue
 *
 * The rest are not lost: they stay in the pool for the next scheduled run.
 */
import { query } from '../db.js';
import { evaluate } from '../config/jobMatcher.js';
import { loadMatchableConsultants, promoteToReady } from '../controllers/discoveryController.js';
import { linkPosting, recordSuggestion } from './matchLinker.js';

const DEFAULTS = { days: 30, limit: 1000, maxLinks: 100, maxSuggestions: 200 };

export const rematchConsultant = async ({
    orgId, consultantId, days = DEFAULTS.days, limit = DEFAULTS.limit, maxLinks = DEFAULTS.maxLinks,
    maxSuggestions = DEFAULTS.maxSuggestions,
    via = 'Re-checked after criteria changed',
}) => {
    const out = {
        considered: 0, matched: 0, linked: 0, suggested: 0, skipped: null,
    };

    const [consultant] = await loadMatchableConsultants(orgId, { consultantId });
    if (!consultant) {
        // Not on the bench: criteria inactive, paused, or nothing to look for.
        out.skipped = 'This consultant is not matchable right now.';
        return out;
    }

    const { rows } = await query(
        `SELECT p.id, p.company, p.title, p.description, p.location_text, p.is_remote,
                p.pay_min, p.pay_max, p.pay_unit, w.name AS work_type_name,
                COALESCE(pt.is_automatable, FALSE) AS automatable
           FROM job_postings p
      LEFT JOIN lkp_work_types w ON w.id = p.work_type_id
      LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
          WHERE p.organization_id = $1
            AND p.is_active
            AND p.first_seen_at > now() - ($2 || ' days')::interval
          ORDER BY p.first_seen_at DESC
          LIMIT $3`,
        [orgId, String(days), limit],
    );

    const hits = [];
    const maybes = [];
    for (const row of rows) {
        out.considered += 1;
        const verdict = evaluate({
            company: row.company,
            title: row.title,
            description: row.description,
            locationText: row.location_text,
            isRemote: row.is_remote,
            payMin: row.pay_min == null ? null : Number(row.pay_min),
            payMax: row.pay_max == null ? null : Number(row.pay_max),
            payUnit: row.pay_unit,
        }, consultant.criteria, { workTypeName: row.work_type_name });
        if (verdict.matched) hits.push({ row, verdict });
        else if (verdict.bucket === 'SUGGEST') maybes.push({ row, verdict });
    }
    out.matched = hits.length;

    // The middle outcome: plausible, not certain. Best first, and bounded for
    // the same reason the links are.
    maybes.sort((a, b) => b.verdict.score - a.verdict.score);
    for (const { row, verdict } of maybes.slice(0, maxSuggestions)) {
        const s = await recordSuggestion({
            orgId, consultantId: consultant.id, versionId: consultant.versionId,
            postingId: row.id, verdict, via,
        });
        if (s.suggested) out.suggested += 1;
    }

    hits.sort((a, b) => b.verdict.score - a.verdict.score);
    for (const { row, verdict } of hits.slice(0, maxLinks)) {
        const res = await linkPosting({
            orgId,
            consultantId: consultant.id,
            versionId: consultant.versionId,
            postingId: row.id,
            automatable: row.automatable,
            verdict,
            via,
        });
        if (res.linked) out.linked += 1;
    }

    if (out.linked > 0) await promoteToReady(orgId);
    return out;
};
