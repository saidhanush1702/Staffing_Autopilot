/**
 * ── CONTACTS, READ BY THREE DIFFERENT KINDS OF USER ───────────────────
 *
 * An owner, a recruiter and a consultant all get to see the hiring contact for
 * a job — through different routes, with different scope, and with every read
 * written to the audit log.
 *
 * ── WHY A CONSULTANT SEES CONTACTS AT ALL ─────────────────────────────
 *
 * Because it is their application. The person who applied is the person who
 * follows up, and telling them "we know who to email but you may not" makes the
 * feature theatre. What they do NOT get is the store: a consultant asks about
 * ONE job and receives the contacts for that job, and there is no route through
 * which they can enumerate everybody the agency has ever found.
 *
 * ── WHY THERE IS NO EXPORT ENDPOINT ───────────────────────────────────
 *
 * This is a table of real people's work email addresses and phone numbers, and
 * a "download all as CSV" button is the difference between a contact store and
 * a leaked list. The absence of that route is a deliberate control, not a
 * feature nobody got round to. Search is paginated, every page view is audited,
 * and the audit trail is only meaningful because there is no single call that
 * makes all of it at once.
 *
 * ── WHY EVERY READ IS AUDITED, INCLUDING THE UNINTERESTING ONES ───────
 *
 * "Who looked at this person's details, and when" is the question that gets
 * asked after something has already gone wrong. It cannot be answered
 * retrospectively, so it is recorded prospectively, on reads that will almost
 * always turn out to be nobody doing anything unusual.
 */
import Joi from 'joi';
import { query } from '../db.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { canAccessConsultant } from '../utils/scope.js';
import { logAction } from './auditLogController.js';
import { discoverContacts, providerState } from '../services/contactDiscovery.js';

const MODULE = 'contacts';

export const dncSchema = Joi.object({
    reason: Joi.string().trim().max(500).allow('', null).default(null),
    undo: Joi.boolean().default(false),
});

export const providerSettingsSchema = Joi.object({
    isEnabled: Joi.boolean(),
    monthlyBudget: Joi.number().integer().min(0).max(100_000),
    rateLimitMs: Joi.number().integer().min(0).max(60_000),
}).min(1);

/* ── shared shaping ────────────────────────────────────────────────── */

/**
 * The columns a contact is shown as.
 *
 * Written out rather than `SELECT *` because `SELECT *` is how a column added
 * later — an internal note, a provider's raw payload — silently becomes
 * something a consultant can read.
 */
const CONTACT_COLUMNS = `
    c.id, c.full_name, c.first_name, c.last_name, c.title, c.seniority,
    c.company, c.company_domain, c.location, c.linkedin_url,
    c.email, c.email_status, c.email_source, c.email_pulled_at,
    c.phone, c.phone_source, c.phone_pulled_at,
    c.provider, c.do_not_contact, c.dnc_reason, c.created_at, c.updated_at`;

/**
 * Contacts attached to one posting.
 *
 * `do_not_contact` rows are returned rather than hidden, and that is
 * deliberate: a recruiter looking for this person's address needs to see that
 * somebody has already asked us to stop, otherwise they will simply go and find
 * the address another way.
 */
const contactsForPosting = async (orgId, postingId) => {
    const { rows } = await query(
        `SELECT ${CONTACT_COLUMNS},
                l.link_reason, l.rank, l.linked_at
           FROM contact_links l
           JOIN contacts c ON c.id = l.contact_id
          WHERE l.organization_id = $1 AND l.posting_id = $2
          ORDER BY l.rank, l.linked_at`,
        [orgId, postingId],
    );
    return rows;
};

const audit = (req, action, description, entityId = null) => logAction({
    orgId: req.user?.orgId ?? req.device?.orgId,
    module: MODULE,
    action,
    entityType: 'contact',
    entityId,
    performedBy: req.user?.id ?? req.device?.consultantId,
    performedByRole: req.user?.role ?? 'CONSULTANT',
    description,
    ipAddress: req.ip,
});

/* ── the store ─────────────────────────────────────────────────────── */

/**
 * GET /api/management/contacts
 *
 * Search, paginated, management only. `?q=` matches name, company or title;
 * `?company=` narrows to one employer.
 */
export const listContacts = async (req, res, next) => {
    try {
        const paging = readPaging(req);
        const q = String(req.query.q ?? '').trim();
        const company = String(req.query.company ?? '').trim();

        const { rows } = await query(
            `SELECT ${CONTACT_COLUMNS},
                    COUNT(*) OVER ()::int AS total_count,
                    (SELECT COUNT(*)::int FROM contact_links l
                      WHERE l.contact_id = c.id)               AS job_count,
                    (SELECT MAX(l.linked_at) FROM contact_links l
                      WHERE l.contact_id = c.id)               AS last_linked_at
               FROM contacts c
              WHERE c.organization_id = $1
                AND ($2 = '' OR c.full_name ILIKE '%' || $2 || '%'
                             OR c.company   ILIKE '%' || $2 || '%'
                             OR COALESCE(c.title, '') ILIKE '%' || $2 || '%')
                AND ($3 = '' OR c.company ILIKE '%' || $3 || '%')
              ORDER BY c.updated_at DESC
              LIMIT $4 OFFSET $5`,
            [req.user.orgId, q, company, paging.limit, paging.offset],
        );

        await audit(
            req,
            'Searched Contacts',
            `Viewed ${rows.length} contact(s)`
            + `${q ? ` matching "${q}"` : ''}${company ? ` at "${company}"` : ''}.`,
        );

        return res.json(pageResult(rows, paging));
    } catch (err) {
        return next(err);
    }
};

/* ── contacts for one job ──────────────────────────────────────────── */

/**
 * GET /api/management/queue/:id/contacts
 *
 * Recruiters are narrowed to their assigned consultants by the same
 * `canAccessConsultant` every other per-consultant route uses.
 */
export const queueItemContacts = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT q.id, q.posting_id, q.consultant_id, p.company, p.title
               FROM queue_items q
               JOIN job_postings p ON p.id = q.posting_id
              WHERE q.id = $1 AND q.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        if (!(await canAccessConsultant(req.user, item.consultant_id))) {
            return res.status(403).json({ error: 'That consultant is not assigned to you.' });
        }

        const contacts = await contactsForPosting(req.user.orgId, item.posting_id);
        await audit(
            req,
            'Viewed Job Contacts',
            `Viewed ${contacts.length} contact(s) for ${item.title} at ${item.company}.`,
        );

        return res.json({ contacts, job: { company: item.company, title: item.title } });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/applications/:id/contacts
 * GET /api/portal/applications/:id/contacts
 *
 * One application, its contacts. The consultant route resolves to the same
 * handler because the only difference is scope, and duplicating the handler to
 * express that would mean two places to fix a scope bug.
 */
export const applicationContacts = async (req, res, next) => {
    try {
        const mine = req.user.role === 'CONSULTANT';

        const { rows } = await query(
            `SELECT a.id, a.posting_id, a.consultant_id, a.company, a.job_title
               FROM application_records a
              WHERE a.id = $1 AND a.organization_id = $2
                AND ($3::text IS NULL OR a.consultant_id = $3)`,
            [req.params.id, req.user.orgId, mine ? req.user.id : null],
        );
        const application = rows[0];
        if (!application) return res.status(404).json({ error: 'Application not found.' });

        if (!mine && !(await canAccessConsultant(req.user, application.consultant_id))) {
            return res.status(403).json({ error: 'That consultant is not assigned to you.' });
        }

        const contacts = await contactsForPosting(req.user.orgId, application.posting_id);
        await audit(
            req,
            'Viewed Application Contacts',
            `Viewed ${contacts.length} contact(s) for ${application.job_title} `
            + `at ${application.company}.`,
        );

        return res.json({
            contacts,
            job: { company: application.company, title: application.job_title },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/queue/:id/contacts
 *
 * The desktop app, authenticated as a machine bound to one consultant. Scoped
 * by `req.device.consultantId` rather than by a role check, because a device
 * identity IS a single consultant and there is no wider case to allow for.
 */
export const deviceQueueContacts = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT q.posting_id, p.company, p.title
               FROM queue_items q
               JOIN job_postings p ON p.id = q.posting_id
              WHERE q.id = $1
                AND q.organization_id = $2
                AND q.consultant_id   = $3`,
            [req.params.id, req.device.orgId, req.device.consultantId],
        );
        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        const contacts = await contactsForPosting(req.device.orgId, item.posting_id);
        await audit(
            req,
            'Viewed Job Contacts',
            `Desktop app viewed ${contacts.length} contact(s) for ${item.title} `
            + `at ${item.company}.`,
        );

        return res.json({ contacts });
    } catch (err) {
        return next(err);
    }
};

/* ── the manual lookup ─────────────────────────────────────────────── */

/**
 * POST /api/management/queue/:id/find-contact
 *
 * The escape hatch: a recruiter who wants the contact for one specific job
 * BEFORE the application goes out, and is willing to spend a credit on it.
 *
 * Synchronous, unlike the pipeline's version, because a person is waiting for
 * the answer and a job queued for fifteen seconds' time is not an answer. It is
 * exactly one job, which is what keeps this from being a way to bulk-enrich the
 * whole queue by clicking a hundred times.
 */
export const findContactNow = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT q.id, q.posting_id, q.consultant_id, p.company, p.title
               FROM queue_items q
               JOIN job_postings p ON p.id = q.posting_id
              WHERE q.id = $1 AND q.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        if (!(await canAccessConsultant(req.user, item.consultant_id))) {
            return res.status(403).json({ error: 'That consultant is not assigned to you.' });
        }

        const result = await discoverContacts({
            orgId: req.user.orgId,
            postingId: item.posting_id,
            queueItemId: item.id,
            manual: true,
        });

        await audit(
            req,
            'Requested Contact Lookup',
            `Manual lookup for ${item.title} at ${item.company}: ${result.note} `
            + `(${result.credits} credit(s), ${result.cacheHit ? 'from the store' : 'from the provider'}).`,
        );

        const contacts = await contactsForPosting(req.user.orgId, item.posting_id);

        // A provider that could not answer is reported as 502, not 500: the
        // request was fine, the upstream was not, and the difference matters to
        // whoever reads the log.
        return res.status(result.ok ? 200 : 502).json({
            ok: result.ok,
            note: result.note,
            step: result.step,
            credits: result.credits,
            cacheHit: result.cacheHit,
            contacts,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── do not contact ────────────────────────────────────────────────── */

/**
 * POST /api/management/contacts/:id/do-not-contact
 *
 * Sets the flag the waterfall obeys. Reversible — people ask to be removed and
 * later ask to be put back, and making that require a database console would
 * mean it is done in a database console.
 */
export const setDoNotContact = async (req, res, next) => {
    try {
        const { undo, reason } = req.body;

        const { rows } = await query(
            `UPDATE contacts
                SET do_not_contact = $3,
                    dnc_by     = CASE WHEN $3 THEN $4 ELSE NULL END,
                    dnc_at     = CASE WHEN $3 THEN now() ELSE NULL END,
                    dnc_reason = CASE WHEN $3 THEN $5 ELSE NULL END
              WHERE id = $1 AND organization_id = $2
          RETURNING id, full_name, company, do_not_contact`,
            [req.params.id, req.user.orgId, !undo, req.user.id, reason || null],
        );
        const contact = rows[0];
        if (!contact) return res.status(404).json({ error: 'Contact not found.' });

        await audit(
            req,
            contact.do_not_contact ? 'Marked Do Not Contact' : 'Cleared Do Not Contact',
            `${contact.full_name} at ${contact.company}`
            + `${reason ? `: ${reason}` : '.'}`,
            contact.id,
        );

        return res.json({ ok: true, contact });
    } catch (err) {
        return next(err);
    }
};

/* ── the provider's settings for this agency ──────────────────────── */

/**
 * PATCH /api/management/contacts/provider — ORG_ADMIN only.
 *
 * The switch that starts this agency spending Apollo credits, plus its
 * monthly ceiling and pacing. Apollo is registered with `fetch_mode =
 * 'ENRICHMENT'` (migration 045), not `PROVIDER`, so it is deliberately NOT
 * reachable through `PATCH /api/management/discovery/sources/:id` — that
 * route's non-PROVIDER branch writes to the GLOBAL `lkp_job_sources` row,
 * which would switch Apollo on for every tenant on the installation at once.
 * This route writes only `organization_providers`, the same per-agency row
 * `providerState` already reads, so "enabled" always means "enabled for one
 * agency" and nothing that shares this database is ever silently billed for
 * another tenant's decision.
 */
export const updateProviderSettings = async (req, res, next) => {
    try {
        const { isEnabled, monthlyBudget, rateLimitMs } = req.body;

        const { rows } = await query(
            `UPDATE organization_providers op
                SET is_enabled    = COALESCE($2, op.is_enabled),
                    monthly_budget = COALESCE($3, op.monthly_budget),
                    rate_limit_ms  = COALESCE($4, op.rate_limit_ms),
                    -- switching back on clears the old failure streak, so
                    -- health reflects the new attempt rather than whatever
                    -- outage caused it to be turned off last time.
                    consecutive_failures = CASE WHEN $2 IS TRUE THEN 0 ELSE op.consecutive_failures END,
                    last_error = CASE WHEN $2 IS TRUE THEN NULL ELSE op.last_error END
              WHERE op.organization_id = $1
                AND op.source_id = (SELECT id FROM lkp_job_sources WHERE name = 'APOLLO')
          RETURNING op.is_enabled, op.monthly_budget, op.rate_limit_ms`,
            [req.user.orgId, isEnabled ?? null, monthlyBudget ?? null, rateLimitMs ?? null],
        );
        const row = rows[0];
        if (!row) {
            return res.status(404).json({
                error: 'No Apollo provider row for this organisation. Run the migrations.',
            });
        }

        await audit(
            req,
            'Updated Contact Provider Settings',
            `Apollo: ${row.is_enabled ? 'on' : 'off'}, `
            + `budget ${row.monthly_budget} credits/month, `
            + `${row.rate_limit_ms}ms between calls.`,
        );

        return res.json({
            enabled: row.is_enabled,
            budget: row.monthly_budget,
            rateLimitMs: row.rate_limit_ms,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── cost ──────────────────────────────────────────────────────────── */

/**
 * GET /api/management/contacts/usage
 *
 * Credits spent this month against the ceiling, and how much of the work the
 * store did for free. The hit rate is the number that says whether reuse is
 * earning its complexity.
 */
export const contactUsage = async (req, res, next) => {
    try {
        const state = await providerState(req.user.orgId);

        const { rows } = await query(
            `SELECT COUNT(*)::int                                       AS lookups,
                    COUNT(*) FILTER (WHERE cache_hit)::int              AS store_hits,
                    COUNT(*) FILTER (WHERE error IS NOT NULL)::int      AS failures,
                    COALESCE(SUM(credits_used), 0)::int                 AS credits
               FROM contact_lookups
              WHERE organization_id = $1
                AND created_at >= date_trunc('month', now())`,
            [req.user.orgId],
        );
        const stats = rows[0];

        const { rows: totals } = await query(
            `SELECT COUNT(*)::int AS contacts,
                    COUNT(*) FILTER (WHERE do_not_contact)::int AS do_not_contact
               FROM contacts WHERE organization_id = $1`,
            [req.user.orgId],
        );

        return res.json({
            provider: {
                enabled: state.enabled,
                configured: state.configured,
                budget: state.budget,
                used: state.used,
                remaining: state.remaining,
                rateLimitMs: state.rateLimitMs,
            },
            month: {
                ...stats,
                storeHitRate: stats.lookups > 0
                    ? Math.round((stats.store_hits / stats.lookups) * 100)
                    : 0,
            },
            store: totals[0],
        });
    } catch (err) {
        return next(err);
    }
};
