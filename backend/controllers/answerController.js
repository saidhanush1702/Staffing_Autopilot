/**
 * Answer bank — propose / review / approve. Phase 4.
 *
 *   consultant answers an unknown question  → PENDING, unusable
 *   routing by CATEGORY                     → GENERAL   → assigned recruiter
 *                                             SALARY    → ORG_ADMIN only (R-07)
 *                                             WORK_AUTH → ORG_ADMIN only (R-07)
 *   reviewer decides                        → approve / correct+approve / reject
 *   APPROVED answers enter the bank         → only now may a form be filled
 *
 * Answers are APPEND-ONLY. A re-answer writes a new revision and supersedes the
 * old one; both texts are kept when a reviewer corrects, so the record can
 * always say who wrote what.
 *
 * The two-person rule (R-06) is checked here even though consultants have no
 * approval endpoint. Structural guarantees that rest on "there is currently no
 * route" stop being guarantees the moment somebody adds a route, and this is
 * exactly the rule nobody would think to re-test.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../db.js';
import { canAccessConsultant, getAssignedConsultantIds } from '../utils/scope.js';
import { readPaging, pageResult } from '../utils/pagination.js';
import { logAction } from './auditLogController.js';

/* ── validation ──────────────────────────────────────────────────────── */

export const submitAnswerSchema = Joi.object({
    questionId: Joi.string().guid({ version: 'uuidv4' }).required(),
    answerText: Joi.string().trim().min(1).max(4000).required()
        .messages({ 'string.empty': 'An answer cannot be blank.' }),
});

export const reviewAnswerSchema = Joi.object({
    decision: Joi.string().valid('APPROVE', 'REJECT').required(),

    // Present only for "correct and approve". Absent means approve as-is.
    correctedText: Joi.string().trim().min(1).max(4000).allow(null),

    // Mandatory on reject — a rejection the consultant cannot act on is just a
    // dead end. Enforced here rather than in the handler so the message is
    // specific.
    note: Joi.when('decision', {
        is: 'REJECT',
        then: Joi.string().trim().min(1).max(500).required()
            .messages({ 'any.required': 'A rejection needs a note explaining what to change.' }),
        otherwise: Joi.string().trim().max(500).allow('', null),
    }),
});

/* ── shared loading ──────────────────────────────────────────────────── */

const statusIds = async () => {
    const { rows } = await query('SELECT id, name FROM lkp_answer_statuses');
    return Object.fromEntries(rows.map((r) => [r.name, r.id]));
};

/**
 * May this actor decide THIS answer?
 *
 * Two independent gates, both server-side:
 *   1. scope   — ORG_ADMIN anywhere in the org, RECRUITER only their assigned
 *   2. routing — a category with requires_owner_approval is ORG_ADMIN only,
 *                which is R-07
 *
 * Returns a reason rather than a bare boolean so the caller can answer 403 with
 * something the UI can show, instead of a generic refusal.
 */
const reviewPermission = (actor, answer) => {
    if (answer.requires_owner_approval && actor.role !== 'ORG_ADMIN') {
        return {
            allowed: false,
            status: 403,
            message: `${answer.category_label} answers are approved by an organization admin.`,
        };
    }
    // R-06. Today unreachable — consultants cannot reach this endpoint at all —
    // but the check costs one comparison and survives a future route.
    if (answer.answered_by === actor.id) {
        return {
            allowed: false,
            status: 403,
            message: 'You cannot approve an answer you wrote yourself.',
        };
    }
    return { allowed: true };
};

/** One current answer row, with everything the review path needs to decide. */
const loadAnswerForReview = async (orgId, answerId) => {
    const { rows } = await query(
        `SELECT a.id, a.consultant_id, a.question_id, a.revision_no, a.is_current,
                a.proposed_text, a.answered_by,
                s.name AS status_name,
                q.question_text,
                c.name AS category_name, c.label AS category_label,
                c.requires_owner_approval,
                u.name AS consultant_name, u.employment_status
           FROM answers a
           JOIN lkp_answer_statuses s ON s.id = a.status_id
           JOIN questions q  ON q.id = a.question_id
           JOIN lkp_question_categories c ON c.id = q.category_id
           JOIN users u ON u.id = a.consultant_id
          WHERE a.id = $1 AND a.organization_id = $2`,
        [answerId, orgId],
    );
    return rows[0] ?? null;
};

/* ── consultant: what am I being asked, and what have I said ─────────── */

/**
 * GET /api/portal/questions
 *
 * Outstanding = a question that applies to me and has no current answer.
 * "Applies to me" means org-wide (`applies_to_all`) or raised at me
 * specifically via consultant_questions.
 */
export const myQuestions = async (req, res, next) => {
    try {
        const { id: consultantId, orgId } = req.user;

        const { rows: outstanding } = await query(
            `SELECT q.id, q.question_text,
                    c.name AS category_name, c.label AS category_label,
                    c.requires_owner_approval,
                    cq.source, cq.source_note
               FROM questions q
               JOIN lkp_question_categories c ON c.id = q.category_id
          LEFT JOIN consultant_questions cq
                 ON cq.question_id = q.id AND cq.consultant_id = $1
              WHERE q.organization_id = $2
                AND q.is_active
                AND (q.applies_to_all OR cq.id IS NOT NULL)
                AND NOT EXISTS (
                    SELECT 1 FROM answers a
                     WHERE a.question_id = q.id
                       AND a.consultant_id = $1
                       AND a.is_current)
              ORDER BY c.requires_owner_approval, q.question_text`,
            [consultantId, orgId],
        );

        const { rows: answered } = await query(
            `SELECT a.id, a.revision_no, a.proposed_text, a.approved_text,
                    a.was_corrected, a.answered_at, a.reviewed_at, a.review_note,
                    s.name AS status_name, s.label AS status_label,
                    q.id AS question_id, q.question_text,
                    c.label AS category_label, c.requires_owner_approval,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role
               FROM answers a
               JOIN lkp_answer_statuses s ON s.id = a.status_id
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_question_categories c ON c.id = q.category_id
          LEFT JOIN users rev ON rev.id = a.reviewed_by
              WHERE a.consultant_id = $1 AND a.organization_id = $2 AND a.is_current
              ORDER BY s.name, q.question_text`,
            [consultantId, orgId],
        );

        return res.json({ outstanding, answers: answered });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/portal/answers/count — sidebar badge: how many are unanswered. */
export const myOutstandingCount = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT COUNT(*)::int AS outstanding
               FROM questions q
          LEFT JOIN consultant_questions cq
                 ON cq.question_id = q.id AND cq.consultant_id = $1
              WHERE q.organization_id = $2 AND q.is_active
                AND (q.applies_to_all OR cq.id IS NOT NULL)
                AND NOT EXISTS (
                    SELECT 1 FROM answers a
                     WHERE a.question_id = q.id AND a.consultant_id = $1 AND a.is_current)`,
            [req.user.id, req.user.orgId],
        );
        return res.json({ outstanding: rows[0].outstanding });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/portal/answers
 *
 * Submit or revise. A revision supersedes the previous row rather than editing
 * it — the old wording, its reviewer and its verdict all stay readable.
 */
export const submitAnswer = async (req, res, next) => {
    try {
        const { id: consultantId, orgId } = req.user;
        const { questionId, answerText } = req.body;

        const { rows: qRows } = await query(
            `SELECT q.id, q.question_text, q.applies_to_all,
                    c.label AS category_label
               FROM questions q
               JOIN lkp_question_categories c ON c.id = q.category_id
          LEFT JOIN consultant_questions cq
                 ON cq.question_id = q.id AND cq.consultant_id = $1
              WHERE q.id = $2 AND q.organization_id = $3 AND q.is_active
                AND (q.applies_to_all OR cq.id IS NOT NULL)`,
            [consultantId, questionId, orgId],
        );
        const question = qRows[0];
        if (!question) {
            return res.status(404).json({ error: 'That question was not asked of you.' });
        }

        const status = await statusIds();

        const { rows: currentRows } = await query(
            `SELECT a.id, a.revision_no, a.proposed_text, s.name AS status_name
               FROM answers a
               JOIN lkp_answer_statuses s ON s.id = a.status_id
              WHERE a.consultant_id = $1 AND a.question_id = $2 AND a.is_current`,
            [consultantId, questionId],
        );
        const current = currentRows[0];

        // Re-submitting identical text would mint a revision that says nothing,
        // exactly as an unchanged criteria save would.
        if (current && current.proposed_text.trim() === answerText.trim()
            && current.status_name === 'PENDING') {
            return res.status(409).json({
                error: 'That is the same answer you already submitted.',
            });
        }

        const revisionNo = (current?.revision_no ?? 0) + 1;
        const answerId = uuidv4();

        await withTransaction(async (client) => {
            if (current) {
                await client.query(
                    `UPDATE answers
                        SET is_current = FALSE, status_id = $1
                      WHERE id = $2`,
                    [status.SUPERSEDED, current.id],
                );
            }
            await client.query(
                `INSERT INTO answers
                    (id, organization_id, consultant_id, question_id, revision_no,
                     is_current, proposed_text, status_id, answered_by)
                 VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$3)`,
                [answerId, orgId, consultantId, questionId, revisionNo,
                    answerText, status.PENDING],
            );
        });

        logAction({
            orgId, module: 'answers', action: 'Submitted Answer',
            entityType: 'Answer', entityId: answerId,
            entityName: question.question_text.slice(0, 200),
            performedBy: consultantId, performedByRole: 'CONSULTANT',
            description: `Answered "${question.question_text}"`
                + (revisionNo > 1 ? ` (revision ${revisionNo})` : '')
                + ` — awaiting ${question.category_label} approval`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({
            message: 'Answer submitted for approval.',
            answerId,
            revisionNo,
        });
    } catch (err) {
        return next(err);
    }
};

/* ── reviewer: the approval inbox ────────────────────────────────────── */

/**
 * GET /api/management/answers
 *
 * A recruiter sees every pending answer for their assigned consultants —
 * INCLUDING the sensitive ones, which arrive flagged `canReview: false`. That
 * is deliberate and is what R-07 asks for: visible but not actionable, so the
 * recruiter knows the item exists and who it is waiting on rather than
 * wondering why their consultant is stuck.
 */
export const listAnswersForReview = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const statusFilter = req.query.status ?? 'PENDING';
        const paging = readPaging(req);

        const assigned = role === 'RECRUITER'
            ? await getAssignedConsultantIds(orgId, userId)
            : null;

        // An empty assignment list must mean "sees nothing", never "no filter".
        if (assigned && assigned.length === 0) {
            return res.json(pageResult([], paging));
        }

        const { rows } = await query(
            `SELECT COUNT(*) OVER () AS total_count,
                    a.id, a.revision_no, a.proposed_text, a.approved_text,
                    a.was_corrected, a.answered_at, a.reviewed_at, a.review_note,
                    a.answered_by,
                    s.name AS status_name, s.label AS status_label,
                    q.id AS question_id, q.question_text, q.normalised_key,
                    c.name AS category_name, c.label AS category_label,
                    c.requires_owner_approval,
                    u.name AS consultant_name, u.employment_status,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role
               FROM answers a
               JOIN lkp_answer_statuses s ON s.id = a.status_id
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_question_categories c ON c.id = q.category_id
               JOIN users u ON u.id = a.consultant_id
          LEFT JOIN users rev ON rev.id = a.reviewed_by
              WHERE a.organization_id = $1
                AND a.is_current
                AND ($2::text = 'ALL' OR s.name = $2)
                AND ($3::text[] IS NULL OR a.consultant_id = ANY($3::text[]))
              ORDER BY a.answered_at ASC
              LIMIT $4 OFFSET $5`,
            [orgId, statusFilter, assigned, paging.limit, paging.offset],
        );

        // `total_count` rides along on each row and is stripped by pageResult,
        // which is where the total comes from — so it must survive this map.
        const items = rows.map((r) => {
            const { allowed, message } = reviewPermission(req.user, {
                requires_owner_approval: r.requires_owner_approval,
                category_label: r.category_label,
                answered_by: r.answered_by,
            });
            return {
                total_count: r.total_count,
                id: r.id,
                revisionNo: r.revision_no,
                proposedText: r.proposed_text,
                approvedText: r.approved_text,
                wasCorrected: r.was_corrected,
                answeredAt: r.answered_at,
                reviewedAt: r.reviewed_at,
                reviewNote: r.review_note,
                status: r.status_name,
                statusLabel: r.status_label,
                questionId: r.question_id,
                questionText: r.question_text,
                // Drives similar-question grouping in the inbox. Each item is
                // still approved and audited individually.
                groupKey: r.normalised_key,
                category: r.category_name,
                categoryLabel: r.category_label,
                requiresOwnerApproval: r.requires_owner_approval,
                consultantName: r.consultant_name,
                consultantEmploymentStatus: r.employment_status,
                reviewedByName: r.reviewed_by_name,
                reviewedByRole: r.reviewed_by_role,
                canReview: allowed,
                lockedReason: allowed ? null : message,
            };
        });

        return res.json(pageResult(items, paging));
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/answers/count — sidebar badge, actionable items only. */
export const pendingAnswerCount = async (req, res, next) => {
    try {
        const { orgId, role, id: userId } = req.user;
        const assigned = role === 'RECRUITER'
            ? await getAssignedConsultantIds(orgId, userId)
            : null;

        if (assigned && assigned.length === 0) return res.json({ pending: 0, locked: 0 });

        // Split, because a recruiter's badge must count only what THEY can act
        // on. Including locked sensitive items would send them to an inbox
        // where nothing is clickable.
        const { rows } = await query(
            `SELECT
                COUNT(*) FILTER (WHERE NOT c.requires_owner_approval OR $4)::int AS actionable,
                COUNT(*) FILTER (WHERE c.requires_owner_approval AND NOT $4)::int AS locked
               FROM answers a
               JOIN lkp_answer_statuses s ON s.id = a.status_id
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_question_categories c ON c.id = q.category_id
              WHERE a.organization_id = $1
                AND a.is_current AND s.name = 'PENDING'
                AND ($2::text[] IS NULL OR a.consultant_id = ANY($2::text[]))
                AND a.answered_by <> $3`,
            [orgId, assigned, userId, role === 'ORG_ADMIN'],
        );

        return res.json({ pending: rows[0].actionable, locked: rows[0].locked });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/answers/:id/review
 * Approve as-is, correct and approve, or reject with a note.
 */
export const reviewAnswer = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { decision, correctedText, note } = req.body;

        const answer = await loadAnswerForReview(orgId, req.params.id);
        if (!answer) return res.status(404).json({ error: 'Answer not found.' });

        if (!(await canAccessConsultant(req.user, answer.consultant_id))) {
            return res.status(404).json({ error: 'Answer not found.' });
        }
        if (!answer.is_current) {
            return res.status(409).json({ error: 'That answer has been superseded by a newer one.' });
        }
        if (answer.status_name !== 'PENDING') {
            return res.status(409).json({ error: `That answer is already ${answer.status_name.toLowerCase()}.` });
        }
        if (answer.employment_status === 'TERMINATED') {
            return res.status(409).json({
                error: 'This consultant has been terminated — their answers cannot be approved.',
            });
        }

        const gate = reviewPermission(req.user, answer);
        if (!gate.allowed) return res.status(gate.status).json({ error: gate.message });

        const status = await statusIds();
        const approving = decision === 'APPROVE';
        const corrected = approving && !!correctedText
            && correctedText.trim() !== answer.proposed_text.trim();
        const finalText = approving
            ? (corrected ? correctedText.trim() : answer.proposed_text)
            : null;

        await query(
            `UPDATE answers
                SET status_id = $1, approved_text = $2, was_corrected = $3,
                    reviewed_by = $4, reviewed_at = now(), review_note = $5
              WHERE id = $6`,
            [
                approving ? status.APPROVED : status.REJECTED,
                finalText, corrected, req.user.id, note || null, answer.id,
            ],
        );

        // ── release anything parked on this question ──────────────────
        //
        // Closes the loop the answer bank was built for: the desktop app hits a
        // question it cannot answer, parks the application, and the consultant
        // answers it. The moment a reviewer approves that answer, every item
        // that consultant had parked on the same question becomes workable
        // again — without anyone having to notice and re-queue it by hand.
        //
        // Matched on `parked_question_id`, a real foreign key. Matching on the
        // reason text would strand items the day somebody reworded a question.
        let released = 0;
        if (approving) {
            const { rows: unparked } = await query(
                `UPDATE queue_items q
                    SET status_id = (SELECT id FROM lkp_queue_statuses WHERE name = 'READY'),
                        parked_question_id = NULL,
                        park_reason = NULL,
                        updated_at = now()
                  WHERE q.consultant_id = $1
                    AND q.organization_id = $2
                    AND q.parked_question_id = $3
                    AND q.status_id = (SELECT id FROM lkp_queue_statuses
                                        WHERE name = 'PARKED_UNKNOWN')
                  RETURNING q.id`,
                [answer.consultant_id, orgId, answer.question_id],
            );
            released = unparked.length;

            for (const item of unparked) {
                await query(
                    `INSERT INTO queue_item_transitions
                        (id, organization_id, queue_item_id, from_status_id, to_status_id,
                         reason, performed_by)
                     VALUES ($1,$2,$3,
                        (SELECT id FROM lkp_queue_statuses WHERE name = 'PARKED_UNKNOWN'),
                        (SELECT id FROM lkp_queue_statuses WHERE name = 'READY'),
                        $4,$5)`,
                    [uuidv4(), orgId, item.id,
                        'The missing answer was approved', req.user.id],
                ).catch(() => {});
            }
        }

        logAction({
            orgId, module: 'answers',
            action: approving ? 'Approved Answer' : 'Rejected Answer',
            entityType: 'Answer', entityId: answer.id,
            entityName: answer.question_text.slice(0, 200),
            performedBy: req.user.id, performedByRole: req.user.role,
            // Before/after text in the description, so the audit row answers
            // "what exactly was approved" without a second lookup.
            description: approving
                ? `Approved ${answer.consultant_name}'s answer to "${answer.question_text}"`
                    + (corrected
                        ? ` — CORRECTED from "${answer.proposed_text}" to "${finalText}"`
                        : ` — "${finalText}"`)
                : `Rejected ${answer.consultant_name}'s answer to "${answer.question_text}"`
                    + ` — "${answer.proposed_text}" — ${note}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({
            message: approving
                ? (corrected ? 'Corrected and approved.' : 'Approved.')
                    + (released > 0
                        ? ` ${released} parked application${released === 1 ? '' : 's'} released.`
                        : '')
                : 'Rejected.',
            status: approving ? 'APPROVED' : 'REJECTED',
            // So the reviewer sees that approving an answer did something
            // beyond the answer itself.
            releasedItems: released,
            wasCorrected: corrected,
        });
    } catch (err) {
        return next(err);
    }
};

/** GET /api/management/consultants/:id/answers — one consultant's bank. */
export const listConsultantAnswers = async (req, res, next) => {
    try {
        if (!(await canAccessConsultant(req.user, req.params.id))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }

        const { rows } = await query(
            `SELECT a.id, a.revision_no, a.proposed_text, a.approved_text,
                    a.was_corrected, a.answered_at, a.reviewed_at, a.review_note,
                    s.name AS status_name, s.label AS status_label,
                    q.question_text,
                    c.label AS category_label, c.requires_owner_approval,
                    rev.name AS reviewed_by_name, rev.role AS reviewed_by_role
               FROM answers a
               JOIN lkp_answer_statuses s ON s.id = a.status_id
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_question_categories c ON c.id = q.category_id
          LEFT JOIN users rev ON rev.id = a.reviewed_by
              WHERE a.consultant_id = $1 AND a.organization_id = $2 AND a.is_current
              ORDER BY s.name, q.question_text`,
            [req.params.id, req.user.orgId],
        );

        return res.json({ answers: rows });
    } catch (err) {
        return next(err);
    }
};
