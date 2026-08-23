/**
 * ── THE DESKTOP APP'S API ─────────────────────────────────────────────
 *
 * Everything the consultant's machine is allowed to do, and nothing else.
 *
 * ── WHAT THIS SURFACE DELIBERATELY CANNOT DO ──────────────────────────
 *
 * · It cannot see another consultant. Every query is scoped to
 *   `req.device.consultantId`, which comes from the token, never from the URL.
 * · It cannot edit criteria, approve an answer, or change a profile.
 * · It cannot move a queue item to a state the machine forbids — every write
 *   goes through `checkTransition`, the same guard the portal uses.
 * · It cannot edit or delete an application record. It can create one, once,
 *   per queue item.
 *
 * ── R-02 IS THE POINT ─────────────────────────────────────────────────
 *
 * "The final submit click is made by a human consultant, never by the machine."
 * The app fills a form and stops at AWAITING_REVIEW. `submitted` records what a
 * person has already sent; it does not cause a submission.
 */
import fs from 'node:fs';
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { checkTransition } from '../config/queueStates.js';
import { normaliseQuestion } from '../config/questionNormaliser.js';
import { findOrCreateQuestion } from './questionController.js';
import { hashToken, newToken, newActivationCode } from '../middleware/verifyDevice.js';
import { logAction } from './auditLogController.js';
import { resolveStoredPath } from '../utils/upload.js';
import { recordBlockers, outstandingForConsultant, releaseAnswered } from '../config/blockers.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';

/* ── schemas ──────────────────────────────────────────────────────────── */

export const activateSchema = Joi.object({
    activationCode: Joi.string().max(64).required(),
    machineFingerprint: Joi.string().max(128).required(),
    machineLabel: Joi.string().max(120).allow('', null),
    appVersion: Joi.string().max(32).allow('', null),
});

export const reportSchema = Joi.object({
    reason: Joi.string().max(500).allow('', null),
    // Present on `parked` — what the form asked that we could not answer.
    unknownQuestions: Joi.array().max(50).items(Joi.object({
        questionText: Joi.string().max(2000).required(),
        fieldType: Joi.string().max(30).allow('', null),
    })),
    // Present on `submitted` — the exact form, as filled.
    qa: Joi.array().max(200).items(Joi.object({
        questionText: Joi.string().max(2000).required(),
        answerText: Joi.string().max(5000).allow('', null),
        fieldType: Joi.string().max(30).allow('', null),
        questionId: Joi.string().guid({ version: 'uuidv4' }).allow(null),
    })),
    submissionMethod: Joi.string().valid('DESKTOP_BOT', 'DESKTOP_ASSISTED'),
    // What the board showed after submitting. Kept because "the click happened"
    // and "the board confirmed it landed" are different claims, and the record
    // should say which one it is.
    notes: Joi.string().max(500).allow('', null),
});

export const boardStatusSchema = Joi.object({
    board: Joi.string().max(40).required(),
    state: Joi.string().valid('OK', 'SESSION_EXPIRED', 'BOT_CHECK').required(),
    detail: Joi.string().max(255).allow('', null),
});

/* ── activation ───────────────────────────────────────────────────────── */

/**
 * POST /api/device/activate — the only unauthenticated device route.
 *
 * Trades the one-time code for a device token, and binds it to this machine.
 * The token is returned exactly once and never stored in recoverable form.
 */
export const activate = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT d.id, d.consultant_id, d.organization_id, d.activation_expires,
                    d.activated_at, d.revoked_at, u.name, u.employment_status
               FROM devices d
               JOIN users u ON u.id = d.consultant_id
              WHERE d.activation_hash = $1`,
            [hashToken(req.body.activationCode.trim().toUpperCase())],
        );

        const device = rows[0];
        // One message for every failure mode. Distinguishing "no such code"
        // from "expired" would let someone probe for valid codes.
        const refuse = () => res.status(400).json({
            error: 'That activation code is not valid. Ask your administrator for a new one.',
        });

        if (!device || device.revoked_at) return refuse();
        if (device.activated_at) return refuse();
        if (new Date(device.activation_expires) < new Date()) return refuse();
        if (device.employment_status !== 'ACTIVE') return refuse();

        const token = newToken();

        await query(
            `UPDATE devices
                SET device_token_hash = $2,
                    machine_fingerprint = $3,
                    machine_label = $4,
                    app_version = $5,
                    activated_at = now(),
                    last_seen_at = now(),
                    -- the code is spent: burning it here means a second
                    -- activation attempt with the same code finds nothing
                    activation_hash = $6
              WHERE id = $1`,
            [device.id, hashToken(token), req.body.machineFingerprint,
                req.body.machineLabel || null, req.body.appVersion || null,
                hashToken(`spent:${device.id}`)],
        );

        logAction({
            orgId: device.organization_id,
            module: 'devices',
            action: 'Activated Device',
            entityType: 'Device',
            entityId: device.id,
            entityName: req.body.machineLabel || 'desktop app',
            performedBy: device.consultant_id,
            performedByRole: 'CONSULTANT',
            description: `Activated the desktop app on "${req.body.machineLabel || 'an unnamed machine'}"`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            // Shown once. There is no route that returns it again.
            deviceToken: token,
            consultant: { id: device.consultant_id, name: device.name },
        });
    } catch (err) {
        return next(err);
    }
};

/* ── the working surface ──────────────────────────────────────────────── */

/**
 * GET /api/device/heartbeat
 *
 * Liveness, and the channel through which settings reach the app. Reaching
 * this at all proves the device is still valid — `verifyDevice` would have
 * refused otherwise — so the app treats any 401 here as "wipe and reset".
 */
export const heartbeat = async (req, res, next) => {
    try {
        const { consultantId, orgId, id: deviceId } = req.device;

        // ── NO DAILY CAP ──────────────────────────────────────────────
        //
        // There used to be one, reported here and enforced again in the app.
        // It is gone by decision: every matched job now goes straight to the
        // desktop app or to the consultant, and nothing is held back.
        //
        // `is_paused` is what remains, and it is the better control anyway —
        // it says "this person applies to nothing right now", which is an
        // actual state somebody wants, rather than a number to tune.
        const [{ rows: capRows }, { rows: boards }] = await Promise.all([
            query(
                'SELECT p.is_paused FROM consultant_profiles p WHERE p.user_id = $1',
                [consultantId],
            ),
            query(
                `SELECT board, state, paused_until FROM device_board_status
                  WHERE device_id = $1 AND paused_until > now()`,
                [deviceId],
            ),
        ]);

        const profile = capRows[0] ?? {};

        // How many questions are holding applications up. Carried on the
        // heartbeat so the app can badge it without a second call every minute.
        const { rows: blocked } = await query(
            `SELECT COUNT(DISTINCT b.question_id)::int AS n
               FROM queue_item_blockers b
               JOIN queue_items q ON q.id = b.queue_item_id
              WHERE q.consultant_id = $1
                AND NOT EXISTS (
                    SELECT 1 FROM answers a
                      JOIN lkp_answer_statuses s ON s.id = a.status_id
                     WHERE a.question_id = b.question_id
                       AND a.consultant_id = $1
                       AND a.is_current AND s.name = 'APPROVED'
                       AND a.approved_text IS NOT NULL
                )`,
            [consultantId],
        );

        return res.json({
            ok: true,
            serverTime: new Date().toISOString(),
            outstandingQuestions: blocked[0].n,
            // A paused consultant's app should do nothing at all.
            paused: profile.is_paused ?? false,
            pausedBoards: boards.map((b) => ({
                board: b.board, state: b.state, until: b.paused_until,
            })),
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/queue
 *
 * Only READY items, only this consultant, only the BOT lane. The HUMAN lane
 * belongs to the portal — sending it here would put the same job in front of
 * the consultant twice with no indication of which one to act on.
 */
export const deviceQueue = async (req, res, next) => {
    try {
        const { consultantId, orgId } = req.device;

        const { rows } = await query(
            `SELECT q.id, q.channel, q.is_overlap, q.queued_at, q.became_ready_at,
                    st.name AS status,
                    p.company, p.title, p.location_text, p.source_url,
                    p.pay_min, p.pay_max, p.pay_unit,
                    pt.name AS portal, src.name AS board,
                    m.score, m.reason
               FROM queue_items q
               JOIN lkp_queue_statuses st ON st.id = q.status_id
               JOIN job_postings p ON p.id = q.posting_id
          LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
          LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
          LEFT JOIN job_matches m ON m.id = q.match_id
              WHERE q.consultant_id = $1
                AND q.organization_id = $2
                AND q.channel = 'BOT'
                AND st.name IN ('READY', 'FILLING')
                -- not already leased by somebody else, or the lease lapsed
                AND (q.leased_by IS NULL OR q.leased_by = $3 OR q.leased_until < now())
              ORDER BY COALESCE(m.score, 0) DESC, q.became_ready_at ASC
              LIMIT 25`,
            [consultantId, orgId, req.device.id],
        );

        // Approved answers, per item rather than the whole bank — the hub sends
        // only what the work in front of the app needs.
        const { rows: answers } = await query(
            `SELECT a.id, a.approved_text AS answer_text,
                    q.question_text, q.id AS question_id,
                    c.name AS category
               FROM answers a
               JOIN questions q ON q.id = a.question_id
          LEFT JOIN lkp_question_categories c ON c.id = q.category_id
               JOIN lkp_answer_statuses s ON s.id = a.status_id
              WHERE a.consultant_id = $1
                AND a.organization_id = $2
                -- Only the live revision, and only the reviewed wording. An
                -- answer is superseded by editing it, and the device must never
                -- type a draft (proposed_text) that nobody has approved.
                AND a.is_current
                AND s.name = 'APPROVED'
                AND a.approved_text IS NOT NULL`,
            [consultantId, orgId],
        );

        // The consultant's own details, so the filler has something to type.
        // Sent with the queue rather than fetched separately: the app needs
        // both or neither, and one round trip cannot half-succeed.
        const { rows: profile } = await query(
            `SELECT u.name, u.email, p.phone, p.city, p.state, p.linkedin_url,
                    w.name AS work_auth, p.base_resume_artifact_id
               FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
          LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [consultantId, orgId],
        );

        return res.json({
            items: rows,
            approvedAnswers: answers,
            profile: profile[0] ?? null,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── moving an item ───────────────────────────────────────────────────── */

/** Load an item the device is allowed to touch, with its current state. */
const loadOwnedItem = async (deviceCtx, itemId) => {
    const { rows } = await query(
        `SELECT q.id, q.status_id, q.channel, q.leased_by, q.leased_until,
                q.posting_id, q.consultant_id,
                st.name AS status,
                p.company, p.title, p.source_url,
                pt.label AS portal_label
           FROM queue_items q
           JOIN lkp_queue_statuses st ON st.id = q.status_id
           JOIN job_postings p ON p.id = q.posting_id
      LEFT JOIN lkp_portal_types pt ON pt.id = p.portal_type_id
          WHERE q.id = $1 AND q.consultant_id = $2 AND q.organization_id = $3`,
        [itemId, deviceCtx.consultantId, deviceCtx.orgId],
    );
    return rows[0] ?? null;
};

const statusIdFor = async (name) => {
    const { rows } = await query('SELECT id FROM lkp_queue_statuses WHERE name = $1', [name]);
    return rows[0]?.id ?? null;
};

/**
 * Move an item, through the shared guard, recording the transition.
 *
 * Every device write funnels through here so the app cannot reach a state the
 * portal would refuse. The lease is checked too: an item whose lease expired
 * and was picked up by the sweeper is no longer this device's to move.
 */
const moveItem = async (req, res, toState, { reason, extra = {} } = {}) => {
    const item = await loadOwnedItem(req.device, req.params.id);
    if (!item) return res.status(404).json({ error: 'Queue item not found.' });

    if (item.leased_by && item.leased_by !== req.device.id
        && item.leased_until && new Date(item.leased_until) > new Date()) {
        return res.status(409).json({ error: 'This item is being worked by another device.' });
    }

    const verdict = checkTransition(item.status, toState, { reason });
    if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

    const toId = await statusIdFor(toState);

    await withTransaction(async (client) => {
        await client.query(
            `UPDATE queue_items
                SET status_id = $2,
                    leased_by = $3, leased_until = $4,
                    park_reason = COALESCE($5, park_reason),
                    skip_reason = COALESCE($6, skip_reason),
                    parked_question_id = COALESCE($7, parked_question_id),
                    became_ready_at = COALESCE($8, became_ready_at),
                    updated_at = now()
              WHERE id = $1`,
            [item.id, toId,
                extra.leasedBy ?? null, extra.leasedUntil ?? null,
                toState === 'PARKED_UNKNOWN' ? (reason ?? null) : null,
                toState === 'SKIPPED' ? (reason ?? null) : null,
                extra.parkedQuestionId ?? null,
                extra.becameReadyAt ?? null],
        );
        await client.query(
            `INSERT INTO queue_item_transitions
                (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuidv4(), req.device.orgId, item.id, item.status_id, toId,
                reason ?? `Reported by the desktop app: ${toState}`],
        );
    });

    return res.json({ ok: true, status: toState });
};

/**
 * POST /api/device/queue/:id/lease — claim an item to work on.
 *
 * The lease has an expiry rather than being a plain in-progress flag, because a
 * flag has no way back from a crashed app: that item would be locked forever.
 * The maintenance sweeper returns lapsed leases to READY.
 */
export const leaseItem = async (req, res, next) => {
    try {
        const { rows } = await query(
            'SELECT lease_expiry_minutes FROM organizations WHERE id = $1',
            [req.device.orgId],
        );
        const minutes = rows[0]?.lease_expiry_minutes ?? 30;
        const until = new Date(Date.now() + minutes * 60_000);

        return await moveItem(req, res, 'FILLING', {
            reason: 'Picked up by the desktop app',
            extra: { leasedBy: req.device.id, leasedUntil: until },
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/device/queue/:id/filled — the form is filled, waiting on a human. */
export const reportFilled = async (req, res, next) => {
    try {
        return await moveItem(req, res, 'AWAITING_REVIEW', {
            reason: 'Form filled — waiting for the consultant to review and submit',
            extra: { leasedBy: null, leasedUntil: null },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/device/queue/:id/parked — a question with no approved answer.
 *
 * The unknowns are recorded against the consultant so they appear in the Phase
 * 4 inbox. Approving one releases every item parked on that question.
 */
export const reportParked = async (req, res, next) => {
    try {
        const unknowns = req.body.unknownQuestions ?? [];
        if (unknowns.length === 0) {
            return res.status(422).json({ error: 'Parking an item requires at least one unknown question.' });
        }

        // Which job asked, so the consultant knows why a question appeared.
        const item = await loadOwnedItem(req.device, req.params.id);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        // ── EVERY UNKNOWN GOES INTO THE BANK ──────────────────────────
        //
        // This used to look the first question up and discard the rest. Nothing
        // was ever created, so a form asking six things produced no entry
        // anywhere, "My Answers" stayed empty, and the parked item could never
        // be released — the application was stuck permanently with no way for
        // anyone to unstick it.
        //
        // Now each one is added to the bank if it is new, matched to the
        // existing entry if it is not, and raised against THIS consultant so it
        // appears on their screen. Categorisation is the same classifier the
        // rest of the system uses, so a question about pay still lands in the
        // owner-approval queue rather than a recruiter's (R-07).
        const asked = [];
        for (const u of unknowns.slice(0, 20)) {
            const text = String(u.questionText ?? '').trim();
            if (!text) continue;

            const { question } = await findOrCreateQuestion(
                req.device.orgId, req.device.consultantId,
                { questionText: text, appliesToAll: false },
            );

            await query(
                `INSERT INTO consultant_questions
                    (id, organization_id, consultant_id, question_id, source, source_note, created_by)
                 VALUES ($1,$2,$3,$4,'FORM',$5,$6)
                 ON CONFLICT (consultant_id, question_id) DO NOTHING`,
                [uuidv4(), req.device.orgId, req.device.consultantId, question.id,
                    `Asked by ${item?.company ?? 'an application form'}`.slice(0, 255),
                    req.device.consultantId],
            );
            asked.push(question);
        }

        if (asked.length === 0) {
            return res.status(422).json({ error: 'None of those questions had any text.' });
        }

        // The application waits on EVERY one of them. Parking on just the first
        // meant approving it released the item, which retried, hit the second,
        // and parked again — one round trip per question on the same job.
        await withTransaction(async (client) => {
            await recordBlockers(client, {
                orgId: req.device.orgId,
                itemId: req.params.id,
                asked: asked.map((question, i) => ({
                    questionId: question.id,
                    askedAs: unknowns[i]?.questionText ?? question.question_text,
                    fieldType: unknowns[i]?.fieldType ?? null,
                    required: unknowns[i]?.required !== false,
                })),
            });
        });

        const summary = unknowns.length === 1
            ? `Waiting on an answer to: ${unknowns[0].questionText.slice(0, 360)}`
            : `Waiting on ${unknowns.length} answers, starting with: `
              + `${unknowns[0].questionText.slice(0, 330)}`;

        return await moveItem(req, res, 'PARKED_UNKNOWN', {
            reason: summary,
            extra: { parkedQuestionId: asked[0].id, leasedBy: null, leasedUntil: null },
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/device/queue/:id/skipped — reason required by the state machine. */
export const reportSkipped = async (req, res, next) => {
    try {
        return await moveItem(req, res, 'SKIPPED', {
            reason: req.body.reason,
            extra: { leasedBy: null, leasedUntil: null },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/device/queue/:id/reclassify — this job is not automatable after all.
 *
 * A LinkedIn job cannot be told apart from an external redirect by its apply
 * link; only opening it reveals whether Easy Apply is available. When it is
 * not, the item moves to the HUMAN lane and back to READY so the consultant
 * picks it up in the portal instead. Nothing is lost — the job simply changes
 * hands.
 */
export const reclassify = async (req, res, next) => {
    try {
        const item = await loadOwnedItem(req.device, req.params.id);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        const verdict = checkTransition(item.status, 'READY');
        if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

        const readyId = await statusIdFor('READY');

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE queue_items
                    SET channel = 'HUMAN', status_id = $2,
                        leased_by = NULL, leased_until = NULL, updated_at = now()
                  WHERE id = $1`,
                [item.id, readyId],
            );
            await client.query(
                `INSERT INTO queue_item_transitions
                    (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [uuidv4(), req.device.orgId, item.id, item.status_id, readyId,
                    req.body.reason || 'Not automatable — moved to the consultant'],
            );
        });

        return res.json({ ok: true, status: 'READY', channel: 'HUMAN' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/device/queue/:id/submitted
 *
 * Records what the CONSULTANT has already sent. R-02: the app never submits.
 *
 * The state change and the permanent record are written in one transaction, so
 * neither can exist without the other — a SUBMITTED item with no record would
 * be an application nobody can account for.
 */
export const reportSubmitted = async (req, res, next) => {
    try {
        const item = await loadOwnedItem(req.device, req.params.id);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        const verdict = checkTransition(item.status, 'SUBMITTED');
        if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.error });

        // The app retries on a dropped connection, so a second report of the
        // same submission must not create a second record. The unique index on
        // queue_item_id is the real guarantee; this is the readable answer.
        const { rows: already } = await query(
            'SELECT id FROM application_records WHERE queue_item_id = $1',
            [item.id],
        );
        if (already.length > 0) {
            return res.json({ ok: true, applicationId: already[0].id, duplicate: true });
        }

        const submittedId = await statusIdFor('SUBMITTED');
        const applicationId = uuidv4();

        await withTransaction(async (client) => {
            await client.query(
                `UPDATE queue_items
                    SET status_id = $2, leased_by = NULL, leased_until = NULL, updated_at = now()
                  WHERE id = $1`,
                [item.id, submittedId],
            );
            await client.query(
                `INSERT INTO queue_item_transitions
                    (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [uuidv4(), req.device.orgId, item.id, item.status_id, submittedId,
                    'Submitted by the consultant'],
            );

            await client.query(
                `INSERT INTO application_records
                    (id, organization_id, consultant_id, posting_id, queue_item_id,
                     status_id, submission_method_id, company, job_title, job_url,
                     portal_label, device_id, notes)
                 VALUES ($1,$2,$3,$4,$5,
                     (SELECT id FROM lkp_application_statuses WHERE name = 'SUBMITTED'),
                     (SELECT id FROM lkp_submission_methods WHERE name = $6),
                     $7,$8,$9,$10,$11,$12)`,
                [applicationId, req.device.orgId, req.device.consultantId, item.posting_id,
                    item.id, req.body.submissionMethod || 'DESKTOP_BOT',
                    item.company, item.title, item.source_url,
                    item.portal_label, req.device.id, req.body.notes ?? null],
            );

            // The exact form, in order, as the employer worded it.
            const qa = req.body.qa ?? [];
            for (let i = 0; i < qa.length; i += 1) {
                await client.query(
                    `INSERT INTO application_qa
                        (id, organization_id, application_id, position,
                         question_text, answer_text, field_type, question_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [uuidv4(), req.device.orgId, applicationId, i,
                        qa[i].questionText, qa[i].answerText ?? null,
                        qa[i].fieldType ?? null, qa[i].questionId ?? null],
                );
            }
        });

        return res.status(201).json({ ok: true, applicationId });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/device/board-status
 *
 * R-22: a bot-check on LinkedIn stops that board for the rest of the day. The
 * pause is stored here rather than only in the app so it survives a restart and
 * so the stall is visible on the recruiter and owner dashboards — a consultant
 * quietly applying to nothing for a week is the failure this prevents.
 */
export const reportBoardStatus = async (req, res, next) => {
    try {
        const { board, state, detail } = req.body;

        let pausedUntil = null;
        if (state === 'BOT_CHECK') {
            // End of the agency's day, not the server's.
            const { rows } = await query(
                `SELECT (date_trunc('day', now() AT TIME ZONE COALESCE(timezone, 'UTC'))
                         + interval '1 day') AT TIME ZONE COALESCE(timezone, 'UTC') AS eod
                   FROM organizations WHERE id = $1`,
                [req.device.orgId],
            );
            pausedUntil = rows[0]?.eod ?? null;
        } else if (state === 'SESSION_EXPIRED') {
            // Until the consultant signs in again, which the app reports as OK.
            pausedUntil = new Date(Date.now() + 365 * 86_400_000);
        }

        await query(
            `INSERT INTO device_board_status
                (id, organization_id, device_id, board, state, paused_until, detail, reported_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             ON CONFLICT (device_id, board) DO UPDATE
                SET state = EXCLUDED.state,
                    paused_until = EXCLUDED.paused_until,
                    detail = EXCLUDED.detail,
                    reported_at = now()`,
            [uuidv4(), req.device.orgId, req.device.id, board, state, pausedUntil, detail || null],
        );

        return res.json({ ok: true, pausedUntil });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/queue/:id/resume — the resume for ONE job.
 *
 * Spec §6: "Resumes are delivered per job, never in bulk. Every delivery is
 * logged with time, person, and machine." So this is keyed on the queue item
 * rather than on the consultant: there is no route that hands a device a
 * resume without naming the job it is for, and every hit writes an audit row
 * carrying the device id.
 *
 * A tailored resume is used when one exists, and the base resume otherwise.
 * That fallback is what lets the app work before AI tailoring is built, and it
 * stays correct afterwards.
 */
export const deviceResume = async (req, res, next) => {
    try {
        const item = await loadOwnedItem(req.device, req.params.id);
        if (!item) return res.status(404).json({ error: 'Queue item not found.' });

        const { rows } = await query(
            `SELECT r.id, r.stored_name, r.original_name, r.mime_type, r.kind
               FROM queue_items q
               JOIN consultant_profiles p ON p.user_id = q.consultant_id
               JOIN resume_artifacts r
                 ON r.id = COALESCE(q.tailored_resume_artifact_id,
                                    p.base_resume_artifact_id)
              WHERE q.id = $1 AND q.organization_id = $2`,
            [item.id, req.device.orgId],
        );
        const artifact = rows[0];
        if (!artifact) {
            return res.status(404).json({
                error: 'This consultant has no resume on file, so nothing can be attached.',
            });
        }

        const absolutePath = resolveStoredPath(req.device.orgId, artifact.stored_name);
        if (!fs.existsSync(absolutePath)) {
            return res.status(410).json({ error: 'The stored file is missing from disk.' });
        }

        logAction({
            orgId: req.device.orgId, module: 'resumes', action: 'Sent Resume',
            entityType: 'ResumeArtifact', entityId: artifact.id,
            entityName: artifact.original_name,
            performedBy: req.device.consultantId, performedByRole: 'CONSULTANT',
            description: `Delivered the ${artifact.kind} resume to the desktop app `
                + `for ${item.company} — ${item.title} (device ${req.device.id})`,
            ipAddress: req.ip,
        }).catch(() => {});

        res.setHeader('Content-Type', artifact.mime_type);
        res.setHeader('Content-Disposition',
            `attachment; filename="${artifact.original_name.replace(/"/g, '')}"`);
        return fs.createReadStream(absolutePath).pipe(res);
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/applications — what this consultant has already applied to.
 *
 * The desktop app holds a filled application only until it is submitted, then
 * drops it. Without this the app could show "waiting on you" and nothing else:
 * a consultant could not see, from the tool that did the work, what it had
 * actually achieved for them.
 *
 * Grouped by board on the way out, because that is the question being asked —
 * "what went to LinkedIn?" — rather than one flat list the app would have to
 * regroup itself.
 */
export const deviceApplications = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT a.id, a.company, a.job_title, a.job_url, a.portal_label,
                    a.submitted_at,
                    s.label AS status_label,
                    m.name AS submitted_via,
                    src.name AS board,
                    (SELECT COUNT(*)::int FROM application_qa q
                      WHERE q.application_id = a.id) AS answer_count
               FROM application_records a
               JOIN lkp_application_statuses s ON s.id = a.status_id
               JOIN lkp_submission_methods m ON m.id = a.submission_method_id
          LEFT JOIN job_postings p ON p.id = a.posting_id
          LEFT JOIN lkp_job_sources src ON src.id = p.first_source_id
              WHERE a.consultant_id = $1 AND a.organization_id = $2
              ORDER BY a.submitted_at DESC
              LIMIT 200`,
            [req.device.consultantId, req.device.orgId],
        );

        const byBoard = {};
        for (const r of rows) {
            // `portal_label` is where the form lived; the board is where the
            // job was found. For anything the app worked they are the same, and
            // where the source is unknown the portal is the better answer than
            // dropping the row into "OTHER".
            const key = r.board ?? r.portal_label ?? 'OTHER';
            (byBoard[key] ??= []).push(r);
        }

        return res.json({ applications: rows, byBoard });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/questions — what this consultant still has to answer.
 *
 * Only questions with an application actually waiting on them. The bank holds
 * plenty a consultant could answer one day; these are the ones costing them a
 * job right now, ordered by how many applications each unblocks.
 */
export const deviceQuestions = async (req, res, next) => {
    try {
        const rows = await outstandingForConsultant(req.device.orgId, req.device.consultantId);
        return res.json({ questions: rows });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/device/answers — the whole answer bank, as the app will use it.
 *
 * Not just the outstanding ones: everything this consultant has answered, which
 * is exactly what gets typed into their applications. Somebody who suspects an
 * application said the wrong thing needs to be able to look, and the tool that
 * did the typing is the obvious place to look in.
 */
export const deviceAnswers = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT qu.id AS question_id, qu.question_text,
                    a.approved_text AS answer_text,
                    a.revision_no, a.answered_at,
                    c.name AS category, c.label AS category_label
               FROM answers a
               JOIN questions qu ON qu.id = a.question_id
               JOIN lkp_answer_statuses s ON s.id = a.status_id
          LEFT JOIN lkp_question_categories c ON c.id = qu.category_id
              WHERE a.consultant_id = $1
                AND a.organization_id = $2
                AND a.is_current
                AND s.name = 'APPROVED'
                AND a.approved_text IS NOT NULL
              ORDER BY qu.question_text`,
            [req.device.consultantId, req.device.orgId],
        );
        return res.json({ answers: rows });
    } catch (err) {
        return next(err);
    }
};

export const deviceAnswerSchema = Joi.object({
    answerText: Joi.string().max(5000).required(),
});

/**
 * POST /api/device/questions/:id/answer — the consultant answers, and it counts.
 *
 * ── WHY THIS NEEDS NO REVIEW ──────────────────────────────────────────
 *
 * Job-form answers used to sit as PENDING until a second person approved them,
 * which is the right rule for something a recruiter writes on somebody else's
 * behalf. It is the wrong rule here: this is the consultant answering a
 * question about themselves — their notice period, their rate, their years with
 * a tool — in order to send their own application.
 *
 * Waiting for approval meant the job could close before the answer cleared. The
 * owner's decision is that these are usable the moment they are given, so they
 * are written APPROVED with the consultant recorded as both author and
 * approver. Nothing pretends a second person looked at it.
 *
 * PROFILE changes are untouched and still reviewed — those alter what every
 * future application says, which is a different thing from answering one form.
 */
export const deviceAnswerQuestion = async (req, res, next) => {
    try {
        const { rows: question } = await query(
            `SELECT q.id, q.question_text
               FROM questions q
              WHERE q.id = $1 AND q.organization_id = $2`,
            [req.params.id, req.device.orgId],
        );
        if (question.length === 0) {
            return res.status(404).json({ error: 'That question is not in your answer bank.' });
        }

        const text = req.body.answerText.trim();
        if (!text) return res.status(422).json({ error: 'An answer cannot be blank.' });

        await withTransaction(async (client) => {
            // Supersede whatever was there. Answers are revisions, never edits:
            // an application already sent must keep the wording it was sent with.
            await client.query(
                `UPDATE answers
                    SET is_current = false,
                        status_id = (SELECT id FROM lkp_answer_statuses WHERE name = 'SUPERSEDED'),
                        updated_at = now()
                  WHERE consultant_id = $1 AND question_id = $2 AND is_current`,
                [req.device.consultantId, req.params.id],
            );

            const { rows: prev } = await client.query(
                `SELECT COALESCE(MAX(revision_no), 0) AS n FROM answers
                  WHERE consultant_id = $1 AND question_id = $2`,
                [req.device.consultantId, req.params.id],
            );

            await client.query(
                `INSERT INTO answers
                    (id, organization_id, consultant_id, question_id, revision_no,
                     is_current, proposed_text, approved_text, status_id,
                     answered_by, answered_at, reviewed_by, reviewed_at, review_note)
                 VALUES ($1,$2,$3,$4,$5,true,$6,$6,
                     (SELECT id FROM lkp_answer_statuses WHERE name = 'APPROVED'),
                     $3, now(), $3, now(),
                     'Answered by the consultant in the desktop app')`,
                [uuidv4(), req.device.orgId, req.device.consultantId, req.params.id,
                    Number(prev[0].n) + 1, text],
            );
        });

        // Anything now fully answered goes straight back into the queue.
        const released = await releaseAnswered(req.device.orgId, req.device.consultantId);

        logAction({
            orgId: req.device.orgId, module: 'answers', action: 'Answered Question',
            entityType: 'Question', entityId: req.params.id,
            entityName: question[0].question_text.slice(0, 200),
            performedBy: req.device.consultantId, performedByRole: 'CONSULTANT',
            description: `Answered "${question[0].question_text.slice(0, 120)}" in the `
                + `desktop app${released ? `, releasing ${released} application(s)` : ''}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ ok: true, released });
    } catch (err) {
        return next(err);
    }
};

/* ── owner-side: issuing and revoking access ──────────────────────────── */

export const issueDeviceSchema = Joi.object({
    consultantId: Joi.string().guid({ version: 'uuidv4' }).required(),
    expiresInHours: Joi.number().integer().min(1).max(168).default(48),
});

/**
 * POST /api/management/devices — ORG_ADMIN only.
 *
 * Issues a one-time activation code. R-21 and the owner's own instruction:
 * only the owner grants access, one token per consultant per machine.
 *
 * Issuing revokes whatever that consultant had before, inside one transaction.
 * Two live devices would both pull the same queue and both apply — which the
 * employer sees as one person applying twice.
 */
export const issueDevice = async (req, res, next) => {
    try {
        const { rows: target } = await query(
            `SELECT id, name, employment_status FROM users
              WHERE id = $1 AND organization_id = $2 AND role = 'CONSULTANT'`,
            [req.body.consultantId, req.user.orgId],
        );
        if (target.length === 0) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }
        if (target[0].employment_status !== 'ACTIVE') {
            return res.status(409).json({
                error: 'Only an active consultant can be given desktop app access.',
            });
        }

        const code = newActivationCode();
        const sealed = encryptPassword(code);
        const deviceId = uuidv4();
        const expires = new Date(Date.now() + (req.body.expiresInHours ?? 48) * 3_600_000);

        await withTransaction(async (client) => {
            // The partial unique indexes allow exactly one live and one pending
            // device per consultant, so the old ones have to go first.
            await client.query(
                `UPDATE devices
                    SET revoked_at = now(), revoked_by = $1,
                        revoke_reason = 'Replaced by a newly issued device'
                  WHERE consultant_id = $2 AND revoked_at IS NULL`,
                [req.user.id, req.body.consultantId],
            );
            await client.query(
                `INSERT INTO devices
                    (id, organization_id, consultant_id, activation_hash,
                     activation_enc, activation_iv, activation_tag,
                     activation_expires, issued_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [deviceId, req.user.orgId, req.body.consultantId,
                    // The hash is what activation is checked against. The
                    // ciphertext beside it exists only so an admin can be shown
                    // the code again, and is never used to authenticate.
                    hashToken(code), sealed.enc, sealed.iv, sealed.tag,
                    expires, req.user.id],
            );
        });

        logAction({
            orgId: req.user.orgId, module: 'devices', action: 'Issued Device Access',
            entityType: 'Device', entityId: deviceId, entityName: target[0].name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Issued a desktop app activation code to ${target[0].name}, `
                + `valid until ${expires.toISOString()}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            // Shown once, to the admin, to hand over. Never retrievable again.
            activationCode: code,
            expiresAt: expires.toISOString(),
            consultant: { id: target[0].id, name: target[0].name },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * DELETE /api/management/devices/:id — ORG_ADMIN only.
 *
 * R-21's "kills the app immediately". There is no push channel: the device's
 * next call fails, which is at most a heartbeat away, and the app wipes its
 * local state on any 401.
 */
export const revokeDevice = async (req, res, next) => {
    try {
        const { rows } = await query(
            `UPDATE devices d
                SET revoked_at = now(), revoked_by = $1, revoke_reason = $2
               FROM users u
              WHERE d.id = $3 AND d.organization_id = $4
                AND d.revoked_at IS NULL AND u.id = d.consultant_id
              RETURNING d.id, u.name`,
            [req.user.id, req.body?.reason || 'Revoked by an administrator',
                req.params.id, req.user.orgId],
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Device not found, or already revoked.' });
        }

        logAction({
            orgId: req.user.orgId, module: 'devices', action: 'Revoked Device Access',
            entityType: 'Device', entityId: req.params.id, entityName: rows[0].name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Revoked desktop app access for ${rows[0].name}. `
                + 'The app stops on its next call.',
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Device access revoked.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * GET /api/management/devices/:id/activation-code — ORG_ADMIN only.
 *
 * Shows an issued code again, the same way a user's password can be shown
 * again. The owner's decision: an admin who loses the message they pasted a
 * code into should not have to reissue, because reissuing revokes the device
 * the consultant may already be using.
 *
 * ── WHAT THIS ENDPOINT IS HONEST ABOUT ────────────────────────────────
 *
 * An activation code is single-use. Once a device has activated, the code no
 * longer activates anything — so this returns the code together with whether it
 * is still usable, rather than handing back a dead string that looks live. An
 * admin reading "already used" knows to reissue; an admin reading a code with
 * no context would send it to a consultant and wonder why it failed.
 *
 * Every reveal is audited, for the same reason viewing a password is: reading a
 * credential is an event somebody may later need to account for.
 */
export const revealActivationCode = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT d.id, d.activation_enc, d.activation_iv, d.activation_tag,
                    d.activation_expires, d.activated_at, d.revoked_at,
                    u.name AS consultant_name
               FROM devices d
               JOIN users u ON u.id = d.consultant_id
              WHERE d.id = $1 AND d.organization_id = $2`,
            [req.params.id, req.user.orgId],
        );
        const device = rows[0];
        if (!device) return res.status(404).json({ error: 'Device not found.' });

        // Devices issued before migration 034 have a hash and no ciphertext.
        // Their codes are genuinely gone, and saying so is better than a 500.
        if (!device.activation_enc) {
            return res.status(409).json({
                error: 'This code was issued before codes could be shown again, '
                    + 'so it cannot be recovered. Issue a new one.',
            });
        }

        let activationCode;
        try {
            activationCode = decryptPassword({
                enc: device.activation_enc,
                iv: device.activation_iv,
                tag: device.activation_tag,
            });
        } catch {
            return res.status(409).json({
                error: 'The code could not be decrypted. The encryption key may have '
                    + 'changed since it was issued.',
            });
        }

        const expired = new Date(device.activation_expires) < new Date();
        const usable = !device.activated_at && !device.revoked_at && !expired;

        logAction({
            orgId: req.user.orgId, module: 'devices', action: 'Viewed Activation Code',
            entityType: 'Device', entityId: device.id, entityName: device.consultant_name,
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Viewed the desktop app activation code for ${device.consultant_name}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            activationCode,
            consultant: { name: device.consultant_name },
            expiresAt: device.activation_expires,
            usable,
            // Why it is not usable, in the words the screen will show.
            state: device.revoked_at ? 'REVOKED'
                : device.activated_at ? 'ALREADY_USED'
                    : expired ? 'EXPIRED' : 'USABLE',
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/devices — who has the app, and is it alive. */
export const listDevices = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT d.id, d.consultant_id, u.name AS consultant_name,
                    d.machine_label, d.app_version,
                    d.activated_at, d.activation_expires, d.last_seen_at,
                    d.revoked_at, d.revoke_reason,
                    iss.name AS issued_by_name,
                    CASE
                        WHEN d.revoked_at IS NOT NULL              THEN 'REVOKED'
                        WHEN d.activated_at IS NULL
                             AND d.activation_expires < now()      THEN 'EXPIRED'
                        WHEN d.activated_at IS NULL                THEN 'PENDING'
                        WHEN d.last_seen_at > now() - interval '10 minutes' THEN 'ONLINE'
                        ELSE 'IDLE'
                    END AS state,
                    (SELECT json_agg(json_build_object(
                        'board', b.board, 'state', b.state, 'until', b.paused_until))
                       FROM device_board_status b
                      WHERE b.device_id = d.id AND b.state <> 'OK') AS stalled_boards
               FROM devices d
               JOIN users u ON u.id = d.consultant_id
          LEFT JOIN users iss ON iss.id = d.issued_by
              WHERE d.organization_id = $1
              ORDER BY d.revoked_at NULLS FIRST, u.name`,
            [req.user.orgId],
        );
        return res.json({ devices: rows });
    } catch (err) {
        return next(err);
    }
};
