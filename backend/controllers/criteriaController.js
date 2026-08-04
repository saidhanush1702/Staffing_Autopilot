/**
 * Search criteria — WHAT a consultant is looking for. Phase 3.
 *
 * Owned by management. A consultant reads their own set and cannot change it
 * (R-23); a recruiter edits it for their assigned consultants (P-10); an
 * ORG_ADMIN edits it for anyone in the organisation.
 *
 * There is deliberately NO approval workflow here, unlike the Phase 2 profile
 * edits. A profile field is a fact about the consultant, so they assert it and
 * a reviewer checks it. Search criteria are a business decision about how to
 * spend the application budget — the consultant is not the author, so there is
 * nothing to approve. The safety net is versioning plus audit: every save is
 * attributable and every previous version stays readable.
 *
 * Versions are APPEND-ONLY. A save never edits a version; it writes a new one
 * and moves the current pointer. See migration 017 for why.
 */
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';
import {
    TERM_KINDS, normalise, fingerprint, describeDiff, EMPTY_CRITERIA,
} from '../config/criteriaSchema.js';

/* ── loading ──────────────────────────────────────────────────────────── */

/**
 * Confirm the caller may touch this consultant's criteria, and that the target
 * really is a consultant in their organisation.
 *
 * Returns 404 rather than 403 for a consultant outside the caller's scope, so
 * the response does not confirm that the id exists elsewhere on the platform.
 *
 * `forWrite` additionally refuses a TERMINATED consultant. It lives HERE rather
 * than in each handler because that is exactly how it went wrong the first
 * time: save and restore both carried the check, `toggle-active` did not, and
 * the one endpoint that decides whether the system acts on the criteria at all
 * was the one without a guard (ISSUES.md H-2). A new write path now has to opt
 * OUT of the rule rather than remember to opt in.
 *
 * Shape mirrors resolveManageableUser in utils/scope.js — `{ consultant }` or
 * `{ error: { status, message } }` — so the 404/409 distinction survives.
 */
const resolveConsultant = async (user, consultantId, { forWrite = false } = {}) => {
    const notFound = {
        error: { status: 404, message: 'Consultant not found in your organization.' },
    };

    const { rows } = await query(
        `SELECT id, name, organization_id, employment_status
           FROM users
          WHERE id = $1 AND role = 'CONSULTANT'`,
        [consultantId],
    );
    const consultant = rows[0];
    if (!consultant || consultant.organization_id !== user.orgId) return notFound;
    if (!(await canAccessConsultant(user, consultantId))) return notFound;

    if (forWrite && consultant.employment_status === 'TERMINATED') {
        return {
            error: {
                status: 409,
                message: 'This consultant has been terminated — their criteria cannot be changed.',
            },
        };
    }

    return { consultant };
};

/**
 * The parent row, created on first touch.
 *
 * Lazily rather than in createUser: it covers consultants that already existed
 * before Phase 3 without a backfill migration, and it keeps the Phase 2
 * principle that no read path ever meets a missing row. It starts PAUSED — a
 * consultant with no criteria must never receive every job on the internet.
 */
const ensureCriteriaRow = async (runner, orgId, consultantId, actorId) => {
    await runner(
        `INSERT INTO search_criteria (consultant_id, organization_id, is_active, created_by, updated_by)
         VALUES ($1, $2, FALSE, $3, $3)
         ON CONFLICT (consultant_id) DO NOTHING`,
        [consultantId, orgId, actorId],
    );
    const { rows } = await runner(
        `SELECT c.consultant_id, c.organization_id, c.is_active, c.paused_at,
                c.current_version_id, c.updated_at,
                v.version_no AS current_version_no
           FROM search_criteria c
      LEFT JOIN search_criteria_versions v ON v.id = c.current_version_id
          WHERE c.consultant_id = $1`,
        [consultantId],
    );
    return rows[0];
};

/** Expand one version into the shape the client and the diff engine use. */
const expandVersion = async (versionId) => {
    if (!versionId) return null;

    const [head, terms, locations, workTypes] = await Promise.all([
        query(
            `SELECT v.id, v.version_no, v.is_current, v.change_note, v.created_at,
                    v.min_pay_amount, v.min_pay_unit, v.min_pay_currency,
                    u.name AS created_by_name, u.role AS created_by_role
               FROM search_criteria_versions v
          LEFT JOIN users u ON u.id = v.created_by
              WHERE v.id = $1`,
            [versionId],
        ),
        query(
            'SELECT kind, value FROM search_criteria_terms WHERE version_id = $1 ORDER BY kind, position',
            [versionId],
        ),
        query(
            `SELECT city, state, work_mode, radius_miles
               FROM search_criteria_locations WHERE version_id = $1 ORDER BY position`,
            [versionId],
        ),
        query(
            'SELECT work_type_id FROM search_criteria_work_types WHERE version_id = $1 ORDER BY work_type_id',
            [versionId],
        ),
    ]);

    const v = head.rows[0];
    if (!v) return null;

    const byKind = (kind) => terms.rows.filter((t) => t.kind === kind).map((t) => t.value);

    return {
        id: v.id,
        versionNo: v.version_no,
        isCurrent: v.is_current,
        changeNote: v.change_note,
        createdAt: v.created_at,
        createdByName: v.created_by_name,
        createdByRole: v.created_by_role,

        jobTitles: byKind(TERM_KINDS.jobTitles),
        keywordsInclude: byKind(TERM_KINDS.keywordsInclude),
        keywordsExclude: byKind(TERM_KINDS.keywordsExclude),
        excludedCompanies: byKind(TERM_KINDS.excludedCompanies),
        locations: locations.rows.map((l) => ({
            city: l.city,
            state: l.state,
            workMode: l.work_mode,
            radiusMiles: l.radius_miles,
        })),
        workTypeIds: workTypes.rows.map((w) => w.work_type_id),
        // NUMERIC arrives from pg as a string; the client should not have to
        // know that.
        minPay: {
            amount: v.min_pay_amount === null ? null : Number(v.min_pay_amount),
            unit: v.min_pay_unit,
            currency: v.min_pay_currency,
        },
    };
};

/** The whole payload for one consultant: parent state + current version. */
const buildPayload = async (parent, consultant) => {
    const version = await expandVersion(parent.current_version_id);
    return {
        consultant: {
            id: consultant.id,
            name: consultant.name,
            employmentStatus: consultant.employment_status,
        },
        criteria: {
            isActive: parent.is_active,
            pausedAt: parent.paused_at,
            // `configured` distinguishes "never set up" from "set up, paused".
            // They mean different things to a recruiter working their bench.
            configured: parent.current_version_id !== null,
            currentVersionNo: parent.current_version_no ?? null,
            updatedAt: parent.updated_at,
        },
        version: version ?? { ...EMPTY_CRITERIA, id: null, versionNo: 0, isCurrent: true },
    };
};

/* ── writing ──────────────────────────────────────────────────────────── */

/**
 * Write a new version and point the parent at it. Caller supplies an already
 * normalised set.
 *
 * All of it in ONE transaction, matching the Phase 2 rule that a change and
 * its consequences never come apart: a half-written version must never be
 * reachable through the current pointer.
 */
const writeVersion = async (client, { orgId, consultantId, actorId, data, changeNote }) => {
    // Demote the outgoing version FIRST. uq_one_current_version_per_consultant
    // is a partial unique index, so two current rows cannot briefly coexist.
    await client.query(
        `UPDATE search_criteria_versions
            SET is_current = FALSE
          WHERE consultant_id = $1 AND is_current`,
        [consultantId],
    );

    const { rows: nextRows } = await client.query(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next
           FROM search_criteria_versions WHERE consultant_id = $1`,
        [consultantId],
    );
    const versionNo = nextRows[0].next;
    const versionId = uuidv4();

    await client.query(
        `INSERT INTO search_criteria_versions
            (id, organization_id, consultant_id, version_no, is_current,
             min_pay_amount, min_pay_unit, min_pay_currency, change_note, created_by)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9)`,
        [
            versionId, orgId, consultantId, versionNo,
            data.minPay.amount, data.minPay.unit, data.minPay.currency,
            changeNote || null, actorId,
        ],
    );

    for (const [key, kind] of Object.entries(TERM_KINDS)) {
        const values = data[key];
        for (let i = 0; i < values.length; i += 1) {
            await client.query(
                `INSERT INTO search_criteria_terms
                    (id, version_id, organization_id, kind, value, position)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [uuidv4(), versionId, orgId, kind, values[i], i],
            );
        }
    }

    for (let i = 0; i < data.locations.length; i += 1) {
        const l = data.locations[i];
        await client.query(
            `INSERT INTO search_criteria_locations
                (id, version_id, organization_id, city, state, work_mode, radius_miles, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [uuidv4(), versionId, orgId, l.city, l.state, l.workMode, l.radiusMiles, i],
        );
    }

    for (const workTypeId of data.workTypeIds) {
        await client.query(
            `INSERT INTO search_criteria_work_types (version_id, work_type_id, organization_id)
             VALUES ($1,$2,$3)`,
            [versionId, workTypeId, orgId],
        );
    }

    await client.query(
        `UPDATE search_criteria
            SET current_version_id = $1, updated_by = $2
          WHERE consultant_id = $3`,
        [versionId, actorId, consultantId],
    );

    return { versionId, versionNo };
};

/** Reject work type ids that are not in lkp_work_types. */
const assertWorkTypesExist = async (ids) => {
    if (ids.length === 0) return true;
    const { rows } = await query(
        'SELECT id FROM lkp_work_types WHERE id = ANY($1::int[])',
        [ids],
    );
    return rows.length === ids.length;
};

/* ── endpoints ────────────────────────────────────────────────────────── */

/** GET /api/management/consultants/:id/criteria */
export const getCriteria = async (req, res, next) => {
    try {
        const { consultant, error } = await resolveConsultant(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        const parent = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        return res.json(await buildPayload(parent, consultant));
    } catch (err) {
        return next(err);
    }
};

/**
 * PUT /api/management/consultants/:id/criteria
 * Saving creates a NEW version. Nothing is overwritten.
 */
export const saveCriteria = async (req, res, next) => {
    try {
        const { consultant, error } = await resolveConsultant(req.user, req.params.id, { forWrite: true });
        if (error) return res.status(error.status).json({ error: error.message });

        const data = normalise(req.body);
        if (!(await assertWorkTypesExist(data.workTypeIds))) {
            return res.status(422).json({ error: 'One or more work types are not recognised.' });
        }

        const parent = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        const currentVersion = await expandVersion(parent.current_version_id);
        const before = currentVersion ? normalise(currentVersion) : normalise(EMPTY_CRITERIA);

        // A save that changes nothing must not mint a version — otherwise the
        // history stops meaning "here is where something changed".
        if (fingerprint(before) === fingerprint(data)) {
            return res.status(409).json({
                error: 'Nothing has changed — this would create an identical version.',
            });
        }

        const { versionNo } = await withTransaction((client) => writeVersion(client, {
            orgId: req.user.orgId,
            consultantId: consultant.id,
            actorId: req.user.id,
            data,
            changeNote: req.body.changeNote,
        }));

        logAction({
            orgId: req.user.orgId,
            module: 'criteria',
            action: 'Updated Search Criteria',
            entityType: 'SearchCriteria',
            entityId: consultant.id,
            entityName: consultant.name,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Saved v${versionNo} of "${consultant.name}" search criteria — `
                + describeDiff(before, data)
                + (req.body.changeNote ? ` — ${req.body.changeNote}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        const fresh = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        return res.status(201).json({
            message: `Saved as version ${versionNo}.`,
            ...(await buildPayload(fresh, consultant)),
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/consultants/:id/criteria/toggle-active
 * Pausing does NOT fork a version — it is an operational state, not an edit.
 */
export const toggleCriteriaActive = async (req, res, next) => {
    try {
        // forWrite: activating discovery for a terminated consultant would have
        // Phase 5 generating job matches for an ex-employee.
        const { consultant, error } = await resolveConsultant(req.user, req.params.id, { forWrite: true });
        if (error) return res.status(error.status).json({ error: error.message });

        const parent = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        const { isActive, reason } = req.body;

        // Nothing to switch on. Refused rather than allowed-but-inert, because
        // an "Active" badge over an empty set would be a lie.
        if (isActive && !parent.current_version_id) {
            return res.status(409).json({
                error: 'Set up the search criteria before activating them.',
            });
        }
        if (parent.is_active === isActive) {
            return res.json({ message: 'No change.', isActive });
        }

        await query(
            `UPDATE search_criteria
                SET is_active = $1,
                    paused_at = CASE WHEN $1 THEN NULL ELSE now() END,
                    paused_by = CASE WHEN $1 THEN NULL ELSE $2::char(36) END,
                    updated_by = $2
              WHERE consultant_id = $3`,
            [isActive, req.user.id, consultant.id],
        );

        logAction({
            orgId: req.user.orgId,
            module: 'criteria',
            action: isActive ? 'Resumed Search Criteria' : 'Paused Search Criteria',
            entityType: 'SearchCriteria',
            entityId: consultant.id,
            entityName: consultant.name,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `${isActive ? 'Resumed' : 'Paused'} job discovery for "${consultant.name}"`
                + (reason ? ` — ${reason}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: isActive ? 'Criteria active.' : 'Criteria paused.', isActive });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/consultants/:id/criteria/versions */
export const listCriteriaVersions = async (req, res, next) => {
    try {
        const { consultant, error } = await resolveConsultant(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        const { rows } = await query(
            `SELECT v.id, v.version_no, v.is_current, v.change_note, v.created_at,
                    v.min_pay_amount, v.min_pay_unit, v.min_pay_currency,
                    u.name AS created_by_name, u.role AS created_by_role,
                    (SELECT COUNT(*)::int FROM search_criteria_terms t
                      WHERE t.version_id = v.id AND t.kind = 'JOB_TITLE')     AS title_count,
                    (SELECT COUNT(*)::int FROM search_criteria_terms t
                      WHERE t.version_id = v.id AND t.kind LIKE 'KEYWORD%')   AS keyword_count,
                    (SELECT COUNT(*)::int FROM search_criteria_locations l
                      WHERE l.version_id = v.id)                              AS location_count
               FROM search_criteria_versions v
          LEFT JOIN users u ON u.id = v.created_by
              WHERE v.consultant_id = $1 AND v.organization_id = $2
              ORDER BY v.version_no DESC`,
            [consultant.id, req.user.orgId],
        );

        return res.json({
            versions: rows.map((v) => ({
                id: v.id,
                versionNo: v.version_no,
                isCurrent: v.is_current,
                changeNote: v.change_note,
                createdAt: v.created_at,
                createdByName: v.created_by_name,
                createdByRole: v.created_by_role,
                titleCount: v.title_count,
                keywordCount: v.keyword_count,
                locationCount: v.location_count,
                minPay: {
                    amount: v.min_pay_amount === null ? null : Number(v.min_pay_amount),
                    unit: v.min_pay_unit,
                    currency: v.min_pay_currency,
                },
            })),
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/consultants/:id/criteria/versions/:versionId */
export const getCriteriaVersion = async (req, res, next) => {
    try {
        const { consultant, error } = await resolveConsultant(req.user, req.params.id);
        if (error) return res.status(error.status).json({ error: error.message });

        // Scoped to this consultant AND this org, so a version id from another
        // tenant cannot be read by guessing it.
        const { rows } = await query(
            `SELECT id FROM search_criteria_versions
              WHERE id = $1 AND consultant_id = $2 AND organization_id = $3`,
            [req.params.versionId, consultant.id, req.user.orgId],
        );
        if (!rows[0]) return res.status(404).json({ error: 'Version not found.' });

        return res.json({ version: await expandVersion(req.params.versionId) });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/consultants/:id/criteria/versions/:versionId/restore
 *
 * Copies an old version FORWARD as a new one rather than moving the pointer
 * back. History stays strictly append-only, and "we reverted to v2 on Tuesday"
 * stays visible as v5 instead of vanishing.
 */
export const restoreCriteriaVersion = async (req, res, next) => {
    try {
        const { consultant, error } = await resolveConsultant(req.user, req.params.id, { forWrite: true });
        if (error) return res.status(error.status).json({ error: error.message });

        const { rows } = await query(
            `SELECT id, version_no FROM search_criteria_versions
              WHERE id = $1 AND consultant_id = $2 AND organization_id = $3`,
            [req.params.versionId, consultant.id, req.user.orgId],
        );
        const source = rows[0];
        if (!source) return res.status(404).json({ error: 'Version not found.' });

        const data = normalise(await expandVersion(source.id));
        const parent = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        const currentVersion = await expandVersion(parent.current_version_id);
        const before = currentVersion ? normalise(currentVersion) : normalise(EMPTY_CRITERIA);

        if (fingerprint(before) === fingerprint(data)) {
            return res.status(409).json({
                error: `Version ${source.version_no} is already what is in force.`,
            });
        }

        const { versionNo } = await withTransaction((client) => writeVersion(client, {
            orgId: req.user.orgId,
            consultantId: consultant.id,
            actorId: req.user.id,
            data,
            changeNote: req.body?.changeNote
                || `Restored from version ${source.version_no}`,
        }));

        logAction({
            orgId: req.user.orgId,
            module: 'criteria',
            action: 'Updated Search Criteria',
            entityType: 'SearchCriteria',
            entityId: consultant.id,
            entityName: consultant.name,
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `Restored "${consultant.name}" search criteria from v${source.version_no}, `
                + `saved as v${versionNo}`,
            ipAddress: req.ip,
        }).catch(() => {});

        const fresh = await ensureCriteriaRow(query, req.user.orgId, consultant.id, req.user.id);
        return res.status(201).json({
            message: `Restored version ${source.version_no} as version ${versionNo}.`,
            ...(await buildPayload(fresh, consultant)),
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/portal/criteria — the consultant's own set, READ ONLY.
 *
 * There is no write counterpart anywhere in the API for this role. R-23 is
 * enforced by the absence of an endpoint, not by a hidden button.
 *
 * Takes no id parameter at all: the consultant is whoever the signed cookie
 * says they are.
 */
export const getMyCriteria = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT id, name, employment_status FROM users WHERE id = $1`,
            [req.user.id],
        );
        const me = rows[0];
        if (!me) return res.status(404).json({ error: 'Not found.' });

        const parent = await ensureCriteriaRow(query, req.user.orgId, req.user.id, req.user.id);
        return res.json(await buildPayload(parent, me));
    } catch (err) {
        return next(err);
    }
};
