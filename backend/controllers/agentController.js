/**
 * ── THE AGENT'S SIDE OF THE HUB ───────────────────────────────────────
 *
 * The form-filling agent runs on the consultant's machine, because that is
 * where the signed-in browser is. Its model calls come through here, because
 * this is where the API key, the budget and the ledger are. Three device routes:
 *
 *   start   may the agent try this job?  opens a run, returns its limits
 *   step    here is the page; what next? one model call, one validated action
 *   finish  how it ended
 *
 * ── WHERE THE LIMITS ARE ENFORCED ─────────────────────────────────────
 *
 * Here, not on the desktop. The per-job call cap, the per-job dollar cap and
 * the organisation's monthly budget are all checked before every step. A bug
 * in the desktop loop can waste a turn; it cannot overspend, because the hub
 * refuses the call that would.
 *
 * ── AND WHAT THE DESKTOP IS NOT TRUSTED WITH ──────────────────────────
 *
 * The answer catalogue is built HERE, from the database, every turn. The
 * desktop sends a description of a page and nothing else the model reads as a
 * fact about the consultant, so a tampered client cannot put words in the
 * consultant's mouth by editing what it sends.
 */
import Joi from 'joi';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import {
    callModel, isAvailable, unavailableReason, spendThisPeriod,
} from '../connectors/llm/index.js';
import { stageConfig } from '../config/llmModels.js';
import {
    AGENT_ACTION_SCHEMA, AGENT_SYSTEM_PROMPT, AGENT_PROMPT_VERSION, AGENT_MODES,
    buildCatalogue, buildTurnInput, validateAction,
} from '../config/agentProtocol.js';
import { logAction } from './auditLogController.js';

/* ── schemas ──────────────────────────────────────────────────────────── */

export const agentStartSchema = Joi.object({
    entry: Joi.string().valid('RECIPE_FAILED', 'NO_RECIPE').required(),
    host: Joi.string().max(255).allow('', null),
    trigger: Joi.string().max(500).allow('', null),
});

export const agentStepSchema = Joi.object({
    // A page description. Its shape belongs to the desktop and changes with
    // it; the hub only forwards it, so it is bounded rather than modelled.
    observation: Joi.object().unknown(true).required(),
    history: Joi.array().max(60).items(Joi.object({
        n: Joi.number().integer().min(0).max(1000),
        action: Joi.string().max(30).allow(''),
        ref: Joi.string().max(60).allow(''),
        source: Joi.string().max(80).allow(''),
        result: Joi.string().max(400).allow(''),
    }).unknown(true)).default([]),
    lastResult: Joi.string().max(500).allow('', null),
});

export const agentFinishSchema = Joi.object({
    outcome: Joi.string().max(30).required(),
    detail: Joi.string().max(500).allow('', null),
    actions: Joi.number().integer().min(0).max(10_000).default(0),
    refusedActions: Joi.number().integer().min(0).max(10_000).default(0),
});

export const agentSettingsSchema = Joi.object({
    mode: Joi.string().valid(...AGENT_MODES),
    jobCapUsd: Joi.number().min(0.01).max(10),
    maxModelCalls: Joi.number().integer().min(3).max(100),
}).min(1);

/* ── helpers ──────────────────────────────────────────────────────────── */

const orgAgentSettings = async (orgId) => {
    const { rows } = await query(
        `SELECT agent_mode, agent_job_cap_usd::float8 AS job_cap,
                agent_max_model_calls AS max_calls
           FROM organizations WHERE id = $1`,
        [orgId],
    );
    return rows[0] ?? { agent_mode: 'OFF', job_cap: 0.5, max_calls: 25 };
};

/**
 * Everything the consultant can say, read fresh from the database.
 *
 * The same filter the device queue uses: only the live revision of an APPROVED
 * answer, never a draft nobody has reviewed.
 */
export const catalogueFor = async ({ consultantId, orgId }) => {
    const [{ rows: answers }, { rows: profile }] = await Promise.all([
        query(
            `SELECT q.id AS question_id, q.question_text, a.approved_text AS answer_text
               FROM answers a
               JOIN questions q ON q.id = a.question_id
               JOIN lkp_answer_statuses s ON s.id = a.status_id
              WHERE a.consultant_id = $1
                AND a.organization_id = $2
                AND a.is_current
                AND s.name = 'APPROVED'
                AND a.approved_text IS NOT NULL`,
            [consultantId, orgId],
        ),
        query(
            `SELECT u.name, u.email, p.phone, p.city, p.state, p.linkedin_url,
                    w.name AS work_auth, p.base_resume_artifact_id
               FROM consultant_profiles p
               JOIN users u ON u.id = p.user_id
          LEFT JOIN lkp_work_auth_statuses w ON w.id = p.work_auth_status_id
              WHERE p.user_id = $1 AND p.organization_id = $2`,
            [consultantId, orgId],
        ),
    ]);

    const me = profile[0] ?? {};
    return buildCatalogue({
        profile: me,
        answers,
        hasResume: Boolean(me.base_resume_artifact_id),
    });
};

/** A run this device may act on, with the job it belongs to. */
const loadOwnedRun = async (device, runId) => {
    const { rows } = await query(
        `SELECT r.id, r.organization_id, r.queue_item_id, r.model_calls, r.shadow,
                r.cost_usd::float8 AS cost_usd, r.ended_at,
                p.company, p.title
           FROM agent_runs r
           JOIN queue_items q ON q.id = r.queue_item_id
           JOIN job_postings p ON p.id = q.posting_id
          WHERE r.id = $1
            AND r.organization_id = $2
            AND q.consultant_id = $3`,
        [runId, device.orgId, device.consultantId],
    );
    return rows[0] ?? null;
};

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;

/* ── device routes ────────────────────────────────────────────────────── */

/**
 * POST /api/device/queue/:id/agent/start
 *
 * A refusal is a 200 with `ok: false` rather than an error status: "the agent
 * is switched off" is an ordinary answer the desktop acts on by handing the job
 * over, not a failure to retry or report.
 */
export const agentStart = async (req, res, next) => {
    try {
        const { consultantId, orgId, id: deviceId } = req.device;

        const { rows: items } = await query(
            `SELECT q.id FROM queue_items q
              WHERE q.id = $1 AND q.consultant_id = $2 AND q.organization_id = $3`,
            [req.params.id, consultantId, orgId],
        );
        if (!items[0]) return res.status(404).json({ error: 'Queue item not found.' });

        const settings = await orgAgentSettings(orgId);
        if (settings.agent_mode === 'OFF') {
            return res.json({ ok: false, reason: 'The AI agent is switched off for this organisation.' });
        }
        if (!isAvailable('agent')) {
            return res.json({ ok: false, reason: unavailableReason('agent') });
        }

        const budget = await spendThisPeriod(orgId);
        if (budget.exhausted) {
            return res.json({ ok: false, reason: 'This month’s AI budget is used up.' });
        }

        const runId = uuidv4();
        const shadow = settings.agent_mode === 'SHADOW';
        await query(
            `INSERT INTO agent_runs
                (id, organization_id, queue_item_id, device_id, entry, trigger_detail,
                 host, shadow, prompt_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [runId, orgId, req.params.id, deviceId, req.body.entry,
                req.body.trigger || null, req.body.host || null, shadow, AGENT_PROMPT_VERSION],
        );

        return res.json({
            ok: true,
            runId,
            mode: settings.agent_mode,
            limits: {
                maxModelCalls: settings.max_calls,
                jobCapUsd: settings.job_cap,
            },
        });
    } catch (err) {
        return next(err);
    }
};

/**
 * POST /api/device/agent/runs/:runId/step
 *
 * @returns { ok: true, action, costUsd, remaining }
 *        | { ok: true, action: null, invalid }   the reply failed validation;
 *                                                the desktop feeds it back
 *        | { ok: false, stop, detail }           no more turns for this job
 */
export const agentStep = async (req, res, next) => {
    try {
        const run = await loadOwnedRun(req.device, req.params.runId);
        if (!run) return res.status(404).json({ error: 'Agent run not found.' });
        if (run.ended_at) return res.status(409).json({ error: 'This agent run has already finished.' });

        const settings = await orgAgentSettings(req.device.orgId);

        if (run.model_calls >= settings.max_calls) {
            return res.json({
                ok: false,
                stop: 'CAP',
                detail: `the AI agent used all ${settings.max_calls} of its turns for this job`,
            });
        }
        if (settings.job_cap > 0 && run.cost_usd >= settings.job_cap) {
            return res.json({
                ok: false,
                stop: 'CAP',
                detail: `the AI agent reached this job's ${money(settings.job_cap)} limit`,
            });
        }
        const budget = await spendThisPeriod(req.device.orgId);
        if (budget.exhausted) {
            return res.json({ ok: false, stop: 'BUDGET', detail: 'this month’s AI budget is used up' });
        }

        const catalogue = await catalogueFor(req.device);
        const input = buildTurnInput({
            job: { company: run.company, title: run.title },
            observation: req.body.observation,
            history: req.body.history ?? [],
            lastResult: req.body.lastResult ?? '',
            step: run.model_calls + 1,
            maxCalls: settings.max_calls,
        });

        const ask = () => callModel({
            stage: 'agent',
            system: AGENT_SYSTEM_PROMPT,
            cacheable: catalogue.text,
            input,
            schema: AGENT_ACTION_SCHEMA,
            maxTokens: 1_024,
        });

        let reply = await ask();
        let spent = reply.costUsd ?? 0;
        // One retry for a transient failure or a formatting wobble. Both are
        // billed, and both are recorded against the step below.
        if (!reply.ok && reply.retryable) {
            reply = await ask();
            spent += reply.costUsd ?? 0;
        }

        const verdict = reply.ok ? validateAction(reply.json, catalogue) : null;
        const priced = reply.ok ? reply.costUsd !== null : true;
        const costUsd = reply.ok && reply.costUsd === null ? null : spent;

        await query(
            `INSERT INTO agent_steps
                (id, run_id, organization_id, n, action, refused, last_result, page_url,
                 provider, model, input_tokens, output_tokens, cache_read_tokens,
                 cache_write_tokens, cost_usd, duration_ms, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [uuidv4(), run.id, req.device.orgId, run.model_calls + 1,
                verdict?.ok ? JSON.stringify(verdict.action) : null,
                verdict && !verdict.ok ? verdict.error.slice(0, 500) : null,
                (req.body.lastResult || '').slice(0, 500) || null,
                String(req.body.observation?.url ?? '').slice(0, 1000) || null,
                reply.provider ?? null, reply.model ?? null,
                reply.usage?.inputTokens ?? null, reply.usage?.outputTokens ?? null,
                reply.usage?.cacheReadTokens ?? null, reply.usage?.cacheWriteTokens ?? null,
                costUsd, reply.durationMs ?? null,
                reply.ok ? null : String(reply.error ?? '').slice(0, 2000)],
        );

        await query(
            `UPDATE agent_runs
                SET model_calls = model_calls + 1,
                    cost_usd = cost_usd + $2,
                    unpriced_calls = unpriced_calls + $3
              WHERE id = $1`,
            [run.id, spent, priced ? 0 : 1],
        );

        const remaining = {
            calls: Math.max(0, settings.max_calls - (run.model_calls + 1)),
            usd: Math.max(0, Number((settings.job_cap - (run.cost_usd + spent)).toFixed(6))),
        };

        if (!reply.ok) {
            return res.json({
                ok: false,
                stop: 'MODEL_ERROR',
                detail: `the AI model could not be reached: ${String(reply.error ?? '').slice(0, 200)}`,
            });
        }

        if (!verdict.ok) {
            return res.json({ ok: true, action: null, invalid: verdict.error, costUsd, remaining });
        }

        return res.json({
            ok: true, action: verdict.action, shadow: run.shadow, costUsd, remaining,
        });
    } catch (err) {
        return next(err);
    }
};

/** POST /api/device/agent/runs/:runId/finish */
export const agentFinish = async (req, res, next) => {
    try {
        const run = await loadOwnedRun(req.device, req.params.runId);
        if (!run) return res.status(404).json({ error: 'Agent run not found.' });

        await query(
            `UPDATE agent_runs
                SET outcome = $2, detail = $3, actions = $4, refused_actions = $5,
                    ended_at = COALESCE(ended_at, now())
              WHERE id = $1`,
            [run.id, req.body.outcome, req.body.detail || null,
                req.body.actions ?? 0, req.body.refusedActions ?? 0],
        );
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/* ── management ───────────────────────────────────────────────────────── */

/** GET /api/management/ai-agent */
export const getAgentSettings = async (req, res, next) => {
    try {
        const s = await orgAgentSettings(req.user.orgId);
        const { provider, model } = stageConfig('agent');
        return res.json({
            mode: s.agent_mode,
            jobCapUsd: s.job_cap,
            maxModelCalls: s.max_calls,
            available: isAvailable('agent'),
            unavailableReason: unavailableReason('agent'),
            provider,
            model,
        });
    } catch (err) {
        return next(err);
    }
};

/** PUT /api/management/ai-agent — organisation admins only. */
export const updateAgentSettings = async (req, res, next) => {
    try {
        const before = await orgAgentSettings(req.user.orgId);
        const mode = req.body.mode ?? before.agent_mode;
        const cap = req.body.jobCapUsd ?? before.job_cap;
        const calls = req.body.maxModelCalls ?? before.max_calls;

        await query(
            `UPDATE organizations
                SET agent_mode = $2, agent_job_cap_usd = $3, agent_max_model_calls = $4
              WHERE id = $1`,
            [req.user.orgId, mode, cap, calls],
        );

        logAction({
            orgId: req.user.orgId,
            module: 'ai',
            action: 'Changed AI Agent Settings',
            entityType: 'Organization',
            entityId: req.user.orgId,
            entityName: 'AI agent',
            performedBy: req.user.id,
            performedByRole: req.user.role,
            description: `AI agent ${before.agent_mode} → ${mode}, `
                + `cap ${money(before.job_cap)} → ${money(cap)}, turns ${before.max_calls} → ${calls}`,
            ipAddress: req.ip,
        }).catch(() => {});

        return getAgentSettings(req, res, next);
    } catch (err) {
        return next(err);
    }
};
