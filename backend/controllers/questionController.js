/**
 * The question bank — what the organisation asks its consultants. Phase 4.
 *
 * Questions are stored once per organisation, keyed by a normalised form of
 * their text, so one approved answer serves every form that asks the same
 * thing. See config/questionNormaliser.js for why that key is deliberately
 * conservative.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { canAccessConsultant } from '../utils/scope.js';
import { normaliseQuestion, resolveCategory } from '../config/questionNormaliser.js';
import { logAction } from './auditLogController.js';

export const createQuestionSchema = Joi.object({
    questionText: Joi.string().trim().min(5).max(500).required(),
    // Optional. Omitted means "let the classifier decide", which fails safe
    // toward owner approval — see questionNormaliser.resolveCategory.
    category: Joi.string().trim().max(40).allow(null),
    appliesToAll: Joi.boolean().default(false),
});

export const updateQuestionSchema = Joi.object({
    category: Joi.string().trim().max(40),
    isActive: Joi.boolean(),
    appliesToAll: Joi.boolean(),
}).min(1);

export const raiseQuestionSchema = Joi.object({
    questionText: Joi.string().trim().min(5).max(500).required(),
    category: Joi.string().trim().max(40).allow(null),
    note: Joi.string().trim().max(255).allow('', null),
});

const loadCategories = async () => {
    const { rows } = await query(
        'SELECT id, name, label, requires_owner_approval FROM lkp_question_categories ORDER BY id',
    );
    return rows;
};

/**
 * Find an existing question by its normalised key, or create it.
 *
 * Returns `{ question, created }`. Reusing the existing row is the whole point
 * of the bank: two recruiters raising the same question in different words
 * must land on ONE question, or every consultant answers it twice.
 */
const findOrCreateQuestion = async (orgId, actorId, { questionText, category, appliesToAll }) => {
    const key = normaliseQuestion(questionText);

    const { rows: existing } = await query(
        `SELECT q.id, q.question_text, q.applies_to_all,
                c.name AS category_name, c.label AS category_label
           FROM questions q
           JOIN lkp_question_categories c ON c.id = q.category_id
          WHERE q.organization_id = $1 AND q.normalised_key = $2`,
        [orgId, key],
    );
    if (existing[0]) return { question: existing[0], created: false };

    const categories = await loadCategories();
    const { row: cat, auto } = resolveCategory(categories, questionText, category);

    const id = uuidv4();
    await query(
        `INSERT INTO questions
            (id, organization_id, question_text, normalised_key, category_id,
             applies_to_all, auto_categorised, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [id, orgId, questionText.trim(), key, cat.id, !!appliesToAll, auto, actorId],
    );

    return {
        question: {
            id,
            question_text: questionText.trim(),
            applies_to_all: !!appliesToAll,
            category_name: cat.name,
            category_label: cat.label,
        },
        created: true,
        autoCategorised: auto,
    };
};

/** GET /api/management/questions — the org's bank. */
export const listQuestions = async (req, res, next) => {
    try {
        const { rows } = await query(
            `SELECT q.id, q.question_text, q.applies_to_all, q.auto_categorised,
                    q.is_active, q.created_at,
                    c.name AS category_name, c.label AS category_label,
                    c.requires_owner_approval,
                    (SELECT COUNT(*)::int FROM answers a
                      WHERE a.question_id = q.id AND a.is_current) AS answer_count,
                    (SELECT COUNT(*)::int FROM answers a
                       JOIN lkp_answer_statuses s ON s.id = a.status_id
                      WHERE a.question_id = q.id AND a.is_current
                        AND s.name = 'APPROVED') AS approved_count
               FROM questions q
               JOIN lkp_question_categories c ON c.id = q.category_id
              WHERE q.organization_id = $1
              ORDER BY c.requires_owner_approval, q.question_text`,
            [req.user.orgId],
        );
        return res.json({ questions: rows });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/management/questions — ORG_ADMIN adds one to the bank. */
export const createQuestion = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const result = await findOrCreateQuestion(orgId, req.user.id, req.body);

        if (!result.created) {
            return res.status(409).json({
                error: 'That question is already in the bank.',
                question: result.question,
            });
        }

        logAction({
            orgId, module: 'answers', action: 'Added Question',
            entityType: 'Question', entityId: result.question.id,
            entityName: result.question.question_text.slice(0, 200),
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Added question "${result.question.question_text}"`
                + ` as ${result.question.category_label}`
                + (result.autoCategorised ? ' (categorised automatically)' : '')
                + (result.question.applies_to_all ? ', asked of every consultant' : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({ message: 'Question added.', question: result.question });
    } catch (err) {
        return next(err);
    }
};

/** PATCH /api/management/questions/:id — ORG_ADMIN recategorises or retires. */
export const updateQuestion = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const { rows } = await query(
            `SELECT q.id, q.question_text, c.name AS category_name
               FROM questions q
               JOIN lkp_question_categories c ON c.id = q.category_id
              WHERE q.id = $1 AND q.organization_id = $2`,
            [req.params.id, orgId],
        );
        const question = rows[0];
        if (!question) return res.status(404).json({ error: 'Question not found.' });

        const categories = await loadCategories();
        const target = req.body.category
            ? categories.find((c) => c.name === req.body.category)
            : null;
        if (req.body.category && !target) {
            return res.status(422).json({ error: 'Unknown question category.' });
        }

        await query(
            `UPDATE questions
                SET category_id = COALESCE($1, category_id),
                    is_active   = COALESCE($2, is_active),
                    applies_to_all = COALESCE($3, applies_to_all),
                    -- a human touched it, so it is no longer the classifier's guess
                    auto_categorised = CASE WHEN $1::int IS NULL THEN auto_categorised ELSE FALSE END,
                    updated_by = $4
              WHERE id = $5`,
            [target?.id ?? null, req.body.isActive ?? null,
                req.body.appliesToAll ?? null, req.user.id, question.id],
        );

        logAction({
            orgId, module: 'answers', action: 'Updated Question',
            entityType: 'Question', entityId: question.id,
            entityName: question.question_text.slice(0, 200),
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Updated question "${question.question_text}"`
                + (target ? ` — category ${question.category_name} → ${target.name}` : '')
                + (req.body.isActive === false ? ' — retired' : '')
                + (req.body.isActive === true ? ' — reactivated' : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.json({ message: 'Question updated.' });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/management/consultants/:id/questions
 * Raise a question at ONE consultant. Reuses the bank entry if it exists.
 */
export const raiseQuestionForConsultant = async (req, res, next) => {
    try {
        const { orgId } = req.user;
        const consultantId = req.params.id;

        if (!(await canAccessConsultant(req.user, consultantId))) {
            return res.status(404).json({ error: 'Consultant not found in your organization.' });
        }

        const { rows: uRows } = await query(
            `SELECT name, employment_status FROM users
              WHERE id = $1 AND organization_id = $2 AND role = 'CONSULTANT'`,
            [consultantId, orgId],
        );
        const consultant = uRows[0];
        if (!consultant) return res.status(404).json({ error: 'Consultant not found in your organization.' });
        if (consultant.employment_status === 'TERMINATED') {
            return res.status(409).json({
                error: 'This consultant has been terminated — no new questions can be raised.',
            });
        }

        const { question } = await findOrCreateQuestion(orgId, req.user.id, {
            questionText: req.body.questionText,
            category: req.body.category,
            appliesToAll: false,
        });

        // Already asked of this person, or already covered org-wide.
        const { rowCount } = await query(
            `INSERT INTO consultant_questions
                (id, organization_id, consultant_id, question_id, source, source_note, created_by)
             VALUES ($1,$2,$3,$4,'RECRUITER',$5,$6)
             ON CONFLICT (consultant_id, question_id) DO NOTHING`,
            [uuidv4(), orgId, consultantId, question.id, req.body.note || null, req.user.id],
        );
        if (rowCount === 0 && !question.applies_to_all) {
            return res.status(409).json({ error: 'That question has already been asked of this consultant.' });
        }

        logAction({
            orgId, module: 'answers', action: 'Added Question',
            entityType: 'Question', entityId: question.id,
            entityName: question.question_text.slice(0, 200),
            performedBy: req.user.id, performedByRole: req.user.role,
            description: `Raised "${question.question_text}" for ${consultant.name}`
                + (req.body.note ? ` — ${req.body.note}` : ''),
            ipAddress: req.ip,
        }).catch(() => {});

        return res.status(201).json({ message: 'Question raised.', question });
    } catch (err) {
        return next(err);
    }
};
