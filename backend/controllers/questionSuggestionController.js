/**
 * ── "YOU HAVE ALREADY ANSWERED THIS, IN OTHER WORDS" ──────────────────
 *
 * The answer bank matches a form's question to an approved answer on the whole
 * normalised wording and nothing looser (see config/questionNormaliser.js and
 * the desktop's answers.js). That is the right rule for TYPING: a loose match
 * puts an answer on an application that was approved for a different question.
 *
 * It is also why a consultant answers "Years of experience with React" and is
 * then asked "How many years have you worked with React.js?" as if for the first
 * time. This endpoint closes that gap without loosening the rule: one model call
 * proposes which existing answer a new question is really asking for, and the
 * consultant accepts it or not. Nothing is answered here.
 *
 * ── WHY THE CONSULTANT CONFIRMS IT ONCE ───────────────────────────────
 *
 * Accepting a suggestion files it as the answer to the NEW wording, through the
 * same route as typing it. From then on the exact match finds it with no model
 * at all, so each rewording costs one call, once, ever.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import {
    callModel, stageStatus, spendThisPeriod,
} from '../connectors/llm/index.js';
import { normaliseQuestion } from '../config/questionNormaliser.js';
import { catalogueFor } from './agentController.js';

export const SUGGESTION_PROMPT_VERSION = 'match-2026-09-14.1';

export const questionSuggestionsSchema = Joi.object({
    questions: Joi.array().min(1).max(20).items(Joi.object({
        questionText: Joi.string().max(2000).required(),
        questionId: Joi.string().max(64).allow('', null),
    })).required(),
});

const MATCH_SYSTEM_PROMPT = `You match questions from job application forms to answers a consultant has already approved.

For each NEW question, find the approved answer whose question asks the same thing, even when it is worded differently.
- Same meaning only. "Years of experience with React?" matches "How many years have you worked with React.js?". "Do you have a driving licence?" does not match "Do you own a car?".
- A question about a different time, place, employer, skill or level is a different question.
- Only return matches you are confident about. A wrong match puts an untrue answer on a real job application, so when in doubt, leave the question out.`;

const MATCH_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['matches'],
    properties: {
        matches: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['question', 'answer', 'confidence'],
                properties: {
                    question: { type: 'string', description: 'The new question id, e.g. q2.' },
                    answer: { type: 'string', description: 'The approved answer id, e.g. a7.' },
                    confidence: { type: 'string', enum: ['high', 'medium'] },
                },
            },
        },
    },
};

/**
 * POST /api/device/questions/suggestions
 *
 * @returns { suggestions: [{ questionText, questionId, suggestedAnswer,
 *            fromQuestion, fromQuestionId, confidence }] }
 */
export const questionSuggestions = async (req, res, next) => {
    try {
        const { orgId, consultantId } = req.device;
        const none = (why) => res.json({ suggestions: [], unavailable: why ?? null });

        const matchStatus = await stageStatus(orgId, 'match');
        if (!matchStatus.available) return none(matchStatus.reason);
        if ((await spendThisPeriod(orgId)).exhausted) return none('This month’s AI budget is used up.');

        const catalogue = await catalogueFor(req.device);
        if (catalogue.aliases.size === 0) return none('There are no approved answers to match against.');

        // Anything the exact rule already answers needs no model.
        const { rows: bank } = await query(
            `SELECT q.id AS question_id, q.question_text, a.approved_text AS answer_text
               FROM answers a
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_answer_statuses s ON s.id = a.status_id
              WHERE a.consultant_id = $1 AND a.organization_id = $2
                AND a.is_current AND s.name = 'APPROVED' AND a.approved_text IS NOT NULL`,
            [consultantId, orgId],
        );
        const known = new Set(bank.map((b) => normaliseQuestion(b.question_text)));
        const byId = new Map(bank.map((b) => [b.question_id, b]));

        const asked = req.body.questions
            .filter((q) => !known.has(normaliseQuestion(q.questionText)));
        if (asked.length === 0) return none(null);

        const input = [
            'NEW QUESTIONS:',
            ...asked.map((q, i) => `[q${i + 1}] ${String(q.questionText).replace(/\s+/g, ' ').slice(0, 400)}`),
        ].join('\n');

        const started = Date.now();
        const reply = await callModel({
            orgId,
            stage: 'match',
            system: MATCH_SYSTEM_PROMPT,
            // The approved answers are the stable half, identical for every
            // call this consultant makes, so they sit in the cached prefix.
            cacheable: catalogue.text,
            input,
            schema: MATCH_SCHEMA,
            maxTokens: 1_024,
        });

        // Into the same ledger the budget is enforced against.
        await query(
            `INSERT INTO resume_tailoring_runs
                (id, organization_id, consultant_id, stage, provider, model, prompt_version,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 cost_usd, verdict, duration_ms, error)
             VALUES ($1,$2,$3,'match',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [uuidv4(), orgId, consultantId, reply.provider ?? null, reply.model ?? null,
                SUGGESTION_PROMPT_VERSION,
                reply.usage?.inputTokens ?? null, reply.usage?.outputTokens ?? null,
                reply.usage?.cacheReadTokens ?? null, reply.usage?.cacheWriteTokens ?? null,
                reply.ok ? reply.costUsd : (reply.costUsd || null),
                reply.ok ? 'CLEAN' : 'FAILED',
                reply.durationMs ?? (Date.now() - started),
                reply.ok ? null : String(reply.error ?? '').slice(0, 2000)],
        );

        if (!reply.ok) return none('The AI model could not be reached.');

        const suggestions = [];
        const seen = new Set();
        for (const m of reply.json?.matches ?? []) {
            const index = Number(String(m.question ?? '').replace(/^q/, '')) - 1;
            const q = asked[index];
            const answerQuestionId = catalogue.aliases.get(String(m.answer ?? ''));
            const from = answerQuestionId ? byId.get(answerQuestionId) : null;
            if (!q || !from || seen.has(index)) continue;
            if (!['high', 'medium'].includes(m.confidence)) continue;
            seen.add(index);
            suggestions.push({
                questionText: q.questionText,
                questionId: q.questionId || null,
                suggestedAnswer: from.answer_text,
                fromQuestion: from.question_text,
                fromQuestionId: from.question_id,
                confidence: m.confidence,
            });
        }

        return res.json({ suggestions });
    } catch (err) {
        return next(err);
    }
};
