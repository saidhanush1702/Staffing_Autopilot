/**
 * ── GETTING CONSULTANTS ONTO THE BENCH, AND SEEING WHO IS NOT ─────────
 *
 * The matcher only ever considers a consultant who has an ACTIVE criteria set
 * with something positive in it. On the live data that was one consultant in
 * fifty-seven, so most jobs had nobody to go to no matter how good the scoring
 * was. Three endpoints here deal with that, and none of them loosens the
 * matcher's fail-closed rule:
 *
 *   GET  …/consultants/:id/criteria/suggestion   a proposal built from the profile
 *   POST …/criteria/bootstrap                    save proposals as versions
 *   GET  …/matching/bench                        who can receive jobs, and why not
 *   POST …/consultants/:id/criteria/rematch      check the pool for one person now
 *
 * ── A PROPOSAL IS NOT AN ACTIVATION ───────────────────────────────────
 *
 * Bootstrapping saves the proposal as an ordinary, attributed version and, by
 * default, leaves it PAUSED. Switching a consultant on is an explicit choice
 * (`activate: true`), because it starts spending their application budget.
 */
import { query, withTransaction } from '../db.js';
import { canAccessConsultant, getAssignedConsultantIds } from '../utils/scope.js';
import { suggestCriteria } from '../config/criteriaSuggest.js';
import { hasPositiveSignal } from '../config/jobMatcher.js';
import { ensureCriteriaRow, writeVersion } from './criteriaController.js';
import { rematchConsultant } from '../services/rematch.js';
import { acceptSuggestion, dismissSuggestion } from '../services/matchLinker.js';
import { hasColumn } from '../services/benchExtras.js';
import { promoteToReady } from './discoveryController.js';
import { logAction } from './auditLogController.js';

/** What a proposal is built from. */
export const loadSuggestionInput = async (orgId, consultantId) => {
    const [{ rows: base }, { rows: experience }, { rows: skills }] = await Promise.all([
        query('SELECT city, state FROM consultant_profiles WHERE user_id = $1 AND organization_id = $2',
            [consultantId, orgId]),
        query(`SELECT title, is_current FROM consultant_experience
                WHERE consultant_id = $1 AND organization_id = $2 ORDER BY position, created_at`,
        [consultantId, orgId]),
        query(`SELECT s.name FROM consultant_skills cs JOIN lkp_skills s ON s.id = cs.skill_id
                WHERE cs.consultant_id = $1 ORDER BY cs.position, s.name`, [consultantId]),
    ]);
    return { city: base[0]?.city, state: base[0]?.state, experience, skills };
};

/** Consultant ids this caller may act on. ORG_ADMIN: all; RECRUITER: assigned. */
const scopeIds = async (user) => {
    if (user.role === 'RECRUITER') return getAssignedConsultantIds(user.orgId, user.id);
    const { rows } = await query(
        `SELECT id FROM users WHERE organization_id = $1 AND role = 'CONSULTANT'`, [user.orgId],
    );
    return rows.map((r) => r.id);
};

/** GET /api/management/consultants/:id/criteria/suggestion?remote=1 */
export const getSuggestion = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }
        const input = await loadSuggestionInput(req.user.orgId, req.params.id);
        const { criteria, basis, usable } = suggestCriteria(input, {
            includeRemote: req.query.remote === '1' || req.query.remote === 'true',
        });
        return res.json({ usable, criteria, basis });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/criteria/bootstrap
 * body: { consultantIds?: string[], activate?: boolean, includeRemote?: boolean, rematch?: boolean }
 *
 * Only consultants with NO criteria yet are touched. A set somebody wrote is
 * never overwritten by a guess.
 */
export const bootstrap = async (req, res, next) => {
    try {
        const { activate = false, includeRemote = false, rematch = true } = req.body ?? {};
        const allowed = new Set(await scopeIds(req.user));
        const wanted = Array.isArray(req.body?.consultantIds)
            ? req.body.consultantIds.filter((id) => allowed.has(id))
            : [...allowed];

        const { rows: candidates } = wanted.length === 0 ? { rows: [] } : await query(
            `SELECT u.id, u.name, u.employment_status, sc.current_version_id
               FROM users u LEFT JOIN search_criteria sc ON sc.consultant_id = u.id
              WHERE u.id = ANY($1::char(36)[]) AND u.organization_id = $2 AND u.role = 'CONSULTANT'`,
            [wanted, req.user.orgId],
        );

        const results = [];
        for (const c of candidates) {
            const row = { consultantId: c.id, name: c.name };
            if (c.employment_status !== 'ACTIVE') { results.push({ ...row, outcome: 'SKIPPED', why: 'Not an active employee.' }); continue; }
            if (c.current_version_id) { results.push({ ...row, outcome: 'SKIPPED', why: 'Already has search criteria.' }); continue; }

            const input = await loadSuggestionInput(req.user.orgId, c.id);
            const { criteria, usable, basis } = suggestCriteria(input, { includeRemote });
            if (!usable) {
                results.push({ ...row, outcome: 'SKIPPED', why: 'Nothing in the profile to build criteria from (no titles, skills or city).' });
                continue;
            }

            await ensureCriteriaRow(query, req.user.orgId, c.id, req.user.id);
            const { versionNo } = await withTransaction((client) => writeVersion(client, {
                orgId: req.user.orgId,
                consultantId: c.id,
                actorId: req.user.id,
                data: criteria,
                changeNote: 'Drafted from the consultant’s profile',
            }));
            if (activate) {
                await query(
                    `UPDATE search_criteria SET is_active = TRUE, paused_at = NULL, paused_by = NULL,
                            updated_by = $2 WHERE consultant_id = $1`, [c.id, req.user.id],
                );
            }

            logAction({
                orgId: req.user.orgId,
                module: 'criteria',
                action: 'Drafted Search Criteria',
                entityType: 'SearchCriteria',
                entityId: c.id,
                entityName: c.name,
                performedBy: req.user.id,
                performedByRole: req.user.role,
                description: `Drafted v${versionNo} of "${c.name}" search criteria from their profile `
                    + `(${criteria.jobTitles.length} titles, ${criteria.keywordsInclude.length} keywords)`
                    + (activate ? ' and activated it' : ', left paused'),
                ipAddress: req.ip,
            }).catch(() => {});

            let linked = null;
            if (activate && rematch) {
                linked = await rematchConsultant({ orgId: req.user.orgId, consultantId: c.id, via: 'Drafted criteria' })
                    .catch(() => null);
            }
            results.push({
                ...row, outcome: activate ? 'ACTIVATED' : 'DRAFTED', versionNo, basis,
                titles: criteria.jobTitles, linked: linked?.linked ?? null,
            });
        }

        const count = (o) => results.filter((r) => r.outcome === o).length;
        return res.status(201).json({
            drafted: count('DRAFTED'), activated: count('ACTIVATED'), skipped: count('SKIPPED'), results,
        });
    } catch (err) {
        return next(err);
    }
};

/** Why a consultant can or cannot receive jobs. First reason that applies wins. */
export const benchReason = (c) => {
    if (c.employment_status !== 'ACTIVE') return { state: 'NOT_ACTIVE', fix: 'Not an active employee.' };
    if (c.is_paused) return { state: 'PROFILE_PAUSED', fix: 'Paused on their profile — resume them.' };
    if (!c.current_version_id) return { state: 'NOT_SET_UP', fix: 'No search criteria yet — draft them from the profile.' };
    if (!c.is_active) return { state: 'CRITERIA_PAUSED', fix: 'Criteria exist but are switched off.' };
    const positive = hasPositiveSignal({
        jobTitles: Array(c.n_titles), keywordsInclude: Array(c.n_include),
        locations: Array(c.n_locations), workTypeNames: Array(c.n_types),
        minPay: c.has_pay ? { amount: 1 } : null,
    });
    if (!positive) return { state: 'NOTHING_TO_LOOK_FOR', fix: 'Criteria only exclude things — add titles, keywords or a location.' };
    return { state: 'MATCHABLE', fix: null };
};

/** GET /api/management/matching/bench */
export const bench = async (req, res, next) => {
    try {
        const ids = await scopeIds(req.user);
        const { rows } = ids.length === 0 ? { rows: [] } : await query(
            `SELECT u.id, u.name, u.employment_status, p.is_paused,
                    sc.is_active, sc.current_version_id,
                    (SELECT COUNT(*)::int FROM search_criteria_terms t WHERE t.version_id = sc.current_version_id AND t.kind = 'JOB_TITLE') AS n_titles,
                    (SELECT COUNT(*)::int FROM search_criteria_terms t WHERE t.version_id = sc.current_version_id AND t.kind = 'KEYWORD_INCLUDE') AS n_include,
                    (SELECT COUNT(*)::int FROM search_criteria_locations l WHERE l.version_id = sc.current_version_id) AS n_locations,
                    (SELECT COUNT(*)::int FROM search_criteria_work_types w WHERE w.version_id = sc.current_version_id) AS n_types,
                    (SELECT v.min_pay_amount IS NOT NULL FROM search_criteria_versions v WHERE v.id = sc.current_version_id) AS has_pay,
                    (SELECT COUNT(*)::int FROM queue_items q WHERE q.consultant_id = u.id) AS queue_items
               FROM users u
          LEFT JOIN consultant_profiles p ON p.user_id = u.id
          LEFT JOIN search_criteria sc ON sc.consultant_id = u.id
              WHERE u.id = ANY($1::char(36)[]) AND u.organization_id = $2 AND u.role = 'CONSULTANT'
              ORDER BY u.name`,
            [ids, req.user.orgId],
        );

        const consultants = rows.map((c) => ({
            id: c.id, name: c.name, queueItems: c.queue_items, ...benchReason(c),
        }));
        const summary = {};
        for (const c of consultants) summary[c.state] = (summary[c.state] ?? 0) + 1;
        return res.json({
            total: consultants.length,
            matchable: summary.MATCHABLE ?? 0,
            summary,
            consultants,
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/consultants/:id/criteria/rematch */
export const rematch = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }
        const out = await rematchConsultant({
            orgId: req.user.orgId, consultantId: req.params.id, via: 'Re-checked on request',
        });
        return res.json(out);
    } catch (err) {
        return next(err);
    }
};

/* ── the middle outcome: suggestions for a recruiter ──────────────────── */

/**
 * GET /api/management/matching/suggestions?limit=40
 *
 * One row per JOB, with the best few consultants for it — the question a
 * recruiter is actually asking ("who could take this?"), not one row per
 * (job, person) pair, which would list the same posting five times.
 */
export const listSuggestions = async (req, res, next) => {
    try {
        const ids = await scopeIds(req.user);
        if (ids.length === 0) return res.json({ total: 0, suggestions: [] });
        const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200);

        const { rows } = await query(
            `SELECT m.id AS match_id, m.consultant_id, u.name AS consultant_name, m.score, m.reason,
                    p.id AS posting_id, p.company, p.title, p.location_text, p.is_remote,
                    p.source_url, p.first_seen_at
               FROM job_matches m
               JOIN job_postings p ON p.id = m.posting_id
               JOIN users u ON u.id = m.consultant_id
              WHERE m.organization_id = $1 AND m.status = 'SUGGESTED' AND p.is_active
                AND m.consultant_id = ANY($2::char(36)[])
              ORDER BY m.score DESC, m.matched_at DESC
              LIMIT 2000`,
            [req.user.orgId, ids],
        );

        const byPosting = new Map();
        for (const r of rows) {
            if (!byPosting.has(r.posting_id)) {
                byPosting.set(r.posting_id, {
                    postingId: r.posting_id,
                    company: r.company,
                    title: r.title,
                    location: r.location_text,
                    remote: r.is_remote,
                    url: r.source_url,
                    firstSeenAt: r.first_seen_at,
                    candidates: [],
                });
            }
            const entry = byPosting.get(r.posting_id);
            if (entry.candidates.length < 3) {
                entry.candidates.push({
                    matchId: r.match_id,
                    consultantId: r.consultant_id,
                    consultantName: r.consultant_name,
                    score: r.score,
                    reason: r.reason,
                });
            }
        }
        const suggestions = [...byPosting.values()]
            .sort((a, b) => b.candidates[0].score - a.candidates[0].score)
            .slice(0, limit);
        return res.json({ total: byPosting.size, suggestions });
    } catch (err) {
        return next(err);
    }
};

/** Load a suggestion this caller may act on, or answer 404. */
const ownedSuggestion = async (req, res) => {
    const { rows } = await query(
        `SELECT m.id, m.consultant_id, m.status FROM job_matches m
          WHERE m.id = $1 AND m.organization_id = $2`,
        [req.params.matchId, req.user.orgId],
    );
    const m = rows[0];
    if (!m || !(await canAccessConsultant(req.user, m.consultant_id))) {
        res.status(404).json({ error: 'Suggestion not found.' });
        return null;
    }
    return m;
};

/** POST /api/management/matching/suggestions/:matchId/accept */
export const acceptSuggestionRoute = async (req, res, next) => {
    try {
        const m = await ownedSuggestion(req, res);
        if (!m) return undefined;
        const { rows } = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const out = await acceptSuggestion({ orgId: req.user.orgId, matchId: m.id, actorName: rows[0]?.name });
        if (!out.linked) return res.status(409).json({ error: out.reason ?? 'Could not link it.' });
        await promoteToReady(req.user.orgId);

        logAction({
            orgId: req.user.orgId,
            module: 'matching',
            action: 'Linked Suggested Job',
            entityType: 'JobMatch',
            entityId: m.id,
            entityName: null,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: 'Linked a suggested job to a consultant',
            ipAddress: req.ip,
        }).catch(() => {});
        return res.status(201).json({ linked: true, itemId: out.itemId });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/matching/suggestions/:matchId/dismiss  { note? } */
export const dismissSuggestionRoute = async (req, res, next) => {
    try {
        const m = await ownedSuggestion(req, res);
        if (!m) return undefined;
        const { rows } = await query('SELECT name FROM users WHERE id = $1', [req.user.id]);
        const out = await dismissSuggestion({
            orgId: req.user.orgId,
            matchId: m.id,
            actorName: rows[0]?.name,
            note: String(req.body?.note ?? '').slice(0, 120) || null,
        });
        if (!out.dismissed) return res.status(409).json({ error: 'That suggestion was already handled.' });
        return res.json({ dismissed: true });
    } catch (err) {
        return next(err);
    }
};

/* ── which matcher an organisation runs ───────────────────────────────── */

/** GET /api/management/matching/settings */
export const getMatchingSettings = async (req, res, next) => {
    try {
        if (!(await hasColumn('organizations', 'matcher_version'))) {
            return res.json({ version: 1, available: false, note: 'Matching v2 needs migration 060.' });
        }
        const { rows } = await query('SELECT matcher_version FROM organizations WHERE id = $1', [req.user.orgId]);
        return res.json({ version: rows[0]?.matcher_version ?? 1, available: true });
    } catch (err) {
        return next(err);
    }
};

/** PUT /api/management/matching/settings  { version: 1 | 2 }  — ORG_ADMIN */
export const putMatchingSettings = async (req, res, next) => {
    try {
        const version = Number(req.body?.version);
        if (![1, 2].includes(version)) return res.status(422).json({ error: 'version must be 1 or 2.' });
        if (!(await hasColumn('organizations', 'matcher_version'))) {
            return res.status(409).json({ error: 'Matching v2 needs migration 060 to be applied first.' });
        }
        await query('UPDATE organizations SET matcher_version = $2 WHERE id = $1', [req.user.orgId, version]);
        logAction({
            orgId: req.user.orgId,
            module: 'matching',
            action: 'Changed Matcher Version',
            entityType: 'Organization',
            entityId: req.user.orgId,
            entityName: 'matching',
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Switched job matching to v${version}`,
            ipAddress: req.ip,
        }).catch(() => {});
        return res.json({ version });
    } catch (err) {
        return next(err);
    }
};
