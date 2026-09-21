/**
 * ── THE MODEL FACADE ──────────────────────────────────────────────────
 *
 * The only thing the rest of this codebase is allowed to call to reach a model.
 * Nothing outside connectors/llm/ imports an adapter, names a vendor, or knows
 * which one is configured.
 *
 * ── WHY IT IS BUILT THIS WAY ──────────────────────────────────────────
 *
 * The provider is NOT DECIDED. Claude, Gemini, GPT, Qwen and DeepSeek are all
 * still live options and the choice comes later. A pipeline written against one
 * vendor's request shape has to be rewritten when that choice lands; a pipeline
 * written against the four things every vendor can do does not.
 *
 * Those four things, and nothing else:
 *
 *   system      instructions. Stable across calls.
 *   cacheable   large stable content — the base resume, the rules. Sent as its
 *               own block so a provider with prompt caching can cache it.
 *   input       the volatile part — this job's description. Always last.
 *   schema      a JSON Schema for the answer.
 *
 * The ordering is load-bearing rather than stylistic. Prompt caching is a
 * PREFIX match everywhere it exists, so anything volatile placed early throws
 * away the cache for everything after it — and quietly triples the bill while
 * appearing to work perfectly.
 *
 * ── THE RETURN CONTRACT ───────────────────────────────────────────────
 *
 *   { ok: true,  provider, model, json, text, usage, costUsd, truncated }
 *   { ok: false, provider, model, error, retryable, costUsd: 0 }
 *
 * NEVER THROWS. A provider outage is an ordinary event that must degrade into a
 * marked, un-tailored, still-delivered application — not an exception that
 * unwinds a worker mid-transaction.
 */
import { query } from '../../db.js';
import {
    stageConfig, priceCall, isStageConfigured, envFallback,
} from '../../config/llmModels.js';
import { getOverride } from './settings.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as mock from './mock.js';

/**
 * provider name → adapter.
 *
 * Several names map to the OpenAI adapter on purpose: they all speak that
 * dialect, and the name is kept distinct so the cost ledger records which
 * vendor was actually billed rather than which wire format was used.
 */
const ADAPTERS = {
    anthropic,
    claude: anthropic,

    openai,
    deepseek: openai,
    qwen: openai,
    groq: openai,
    together: openai,
    openrouter: openai,
    ollama: openai,
    compatible: openai,

    gemini,
    google: gemini,

    mock,
};

export const adapterFor = (provider) => ADAPTERS[String(provider ?? '').toLowerCase()] ?? null;

export const knownProviders = () => Object.keys(ADAPTERS);

/**
 * Why a provider/model pair cannot be used, in words a dashboard can show, or
 * null when it can.
 *
 * Takes the pair rather than a stage so the same rules answer for a primary, a
 * fallback and a candidate an administrator is about to test.
 */
const reasonFor = (provider, model, label) => {
    if (!provider) {
        return `No model provider is configured. Set LLM_PROVIDER (or LLM_${String(label).toUpperCase()}_PROVIDER).`;
    }
    const adapter = adapterFor(provider);
    if (!adapter) {
        return `Unknown model provider "${provider}". Known: ${knownProviders().join(', ')}.`;
    }
    if (!model) {
        return `No model named for the ${label} stage. Set LLM_MODEL or LLM_${String(label).toUpperCase()}_MODEL.`;
    }
    if (!adapter.isConfigured()) {
        return `The ${provider} provider has no API key in the environment.`;
    }
    return null;
};

/**
 * Is the given stage usable right now — provider named, adapter known, key set?
 *
 * Environment only. This is the check that predates per-organisation settings and
 * it is kept for callers with no organisation to ask about; anything that has an
 * orgId should use `stageStatus`, which sees the overrides.
 */
export const isAvailable = (stage) => {
    if (!isStageConfigured(stage)) return false;
    const { provider } = stageConfig(stage);
    const adapter = adapterFor(provider);
    return Boolean(adapter?.isConfigured());
};

/** Why a stage is unavailable (environment only), or null when it is available. */
export const unavailableReason = (stage) => {
    const { provider, model } = stageConfig(stage);
    return reasonFor(provider, model, stage);
};

/**
 * What a stage will actually run with for one organisation.
 *
 * Layered: the organisation's override wins field by field, then the server's
 * environment. `temperature`, `maxOutputTokens` and `timeoutMs` stay null when
 * nobody chose a value, and null means "send nothing" / "use the caller's own
 * default" rather than a number of ours.
 */
export const resolveStage = async (orgId, stage) => {
    const base = stageConfig(stage);
    const o = await getOverride(orgId, stage);

    const provider = (o?.provider ?? base.provider ?? '').toLowerCase();
    const model = o?.provider ? o.model : base.model;

    let fallback = null;
    if (o?.fallbackProvider && o?.fallbackModel) {
        fallback = { provider: o.fallbackProvider.toLowerCase(), model: o.fallbackModel };
    } else {
        fallback = envFallback(stage, { provider, model });
    }

    return {
        stage,
        provider,
        model,
        temperature: o?.temperature ?? null,
        maxOutputTokens: o?.maxOutputTokens ?? null,
        timeoutMs: o?.timeoutMs ?? null,
        fallback,
        // What the organisation chose, versus what it inherited — the settings
        // screen shows the difference.
        customised: Boolean(o),
    };
};

/**
 * The organisation-aware version of isAvailable/unavailableReason, in one call.
 *
 * A stage is available when its primary works OR its fallback does: a missing key
 * on the main provider is not "switched off" if there is a working backup. It is
 * off only when the stage has no provider at all, which is how an organisation
 * that never set AI up keeps the feature quietly disabled.
 */
export const stageStatus = async (orgId, stage) => {
    const cfg = await resolveStage(orgId, stage);
    const primaryReason = reasonFor(cfg.provider, cfg.model, stage);
    const fbReason = cfg.fallback
        ? reasonFor(cfg.fallback.provider, cfg.fallback.model, `${stage} fallback`)
        : 'No fallback model is set.';

    const primaryOk = primaryReason === null;
    const fallbackOk = Boolean(cfg.fallback) && fbReason === null;
    const off = !cfg.provider;

    return {
        config: cfg,
        available: !off && (primaryOk || fallbackOk),
        reason: (off || !(primaryOk || fallbackOk)) ? primaryReason : null,
        primaryReason,
        fallbackReason: cfg.fallback ? fbReason : null,
    };
};

/* ── the money ceiling ─────────────────────────────────────────────── */

/**
 * Spend so far in the organisation's current budget window, in USD.
 *
 * Rows whose cost is NULL — a model the pricing table does not know — are
 * counted as zero here but reported separately, because a budget that silently
 * treats "unknown" as "free" is a budget that never fires. The caller surfaces
 * `unpriced` so an operator can see that the number understates reality.
 */
export const spendThisPeriod = async (orgId) => {
    // Two ledgers, one ceiling. Resume tailoring and the form-filling agent
    // draw on the same monthly budget, so a busy agent month is visible as
    // less tailoring headroom rather than as a second bill nobody set.
    const { rows } = await query(
        `WITH o AS (
             SELECT id, ai_monthly_budget_usd,
                    CASE WHEN EXTRACT(DAY FROM now()) >= ai_spend_reset_day
                         THEN date_trunc('month', now())
                         ELSE date_trunc('month', now()) - interval '1 month'
                    END + (ai_spend_reset_day - 1) * interval '1 day' AS since
               FROM organizations
              WHERE id = $1
         ),
         spend AS (
             SELECT r.cost_usd
               FROM resume_tailoring_runs r, o
              WHERE r.organization_id = o.id AND r.created_at >= o.since
             UNION ALL
             SELECT s.cost_usd
               FROM agent_steps s, o
              WHERE s.organization_id = o.id AND s.created_at >= o.since
         )
         SELECT COALESCE((SELECT SUM(cost_usd) FROM spend), 0)::float8        AS spent,
                (SELECT COUNT(*) FROM spend WHERE cost_usd IS NULL)::int      AS unpriced,
                o.ai_monthly_budget_usd::float8                               AS budget
           FROM o`,
        [orgId],
    );

    const row = rows[0] ?? { spent: 0, unpriced: 0, budget: 0 };
    return {
        spent: row.spent ?? 0,
        budget: row.budget ?? 0,
        unpriced: row.unpriced ?? 0,
        remaining: Math.max(0, (row.budget ?? 0) - (row.spent ?? 0)),
        exhausted: (row.budget ?? 0) > 0 && (row.spent ?? 0) >= (row.budget ?? 0),
    };
};

/* ── the call itself ───────────────────────────────────────────────── */

/**
 * One attempt against one provider/model. Validates the answer and prices it.
 * Everything that can go wrong comes back as { ok: false, ... } — never a throw.
 */
const attempt = async ({
    stage, label, provider, model, system, cacheable, input, schema,
    maxTokens, temperature, timeoutMs,
}) => {
    const reason = reasonFor(provider, model, label ?? stage);
    if (reason) {
        return {
            ok: false, provider, model, error: reason, retryable: false, costUsd: 0,
        };
    }

    const adapter = adapterFor(provider);
    const started = Date.now();
    // `stage` is passed through so an adapter can vary by it. No real provider
    // needs it — it exists for the mock, which has to answer three structurally
    // different questions and would otherwise have to guess which one it was
    // being asked.
    const res = await adapter.call({
        stage, model, system, cacheable, input, schema, maxTokens, temperature, timeoutMs,
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
        return {
            ok: false,
            provider,
            model,
            error: res.error,
            // An adapter that does not say is assumed retryable: a transient
            // failure treated as permanent loses a job that would have worked,
            // which is the more expensive mistake of the two.
            retryable: res.retryable !== false,
            status: res.status,
            costUsd: 0,
            durationMs,
        };
    }

    // A truncated answer is structurally invalid JSON, and retrying it with the
    // same ceiling produces the same truncation — so it is reported as a
    // failure the caller can act on rather than as a successful bad answer.
    if (res.truncated) {
        return {
            ok: false,
            provider,
            model,
            error: `The model hit its ${maxTokens}-token output ceiling and the answer is incomplete.`,
            retryable: false,
            usage: res.usage,
            costUsd: priceCall(provider, model, res.usage) ?? 0,
            durationMs,
        };
    }

    if (schema && !res.json) {
        return {
            ok: false,
            provider,
            model,
            error: 'The model did not return parseable JSON.',
            // Worth one more go: this is usually a formatting wobble rather
            // than a request the provider will reject every time.
            retryable: true,
            usage: res.usage,
            costUsd: priceCall(provider, model, res.usage) ?? 0,
            durationMs,
        };
    }

    return {
        ok: true,
        provider,
        model: res.model ?? model,
        json: res.json,
        text: res.text,
        usage: res.usage,
        // null when the pricing table does not know this model. Deliberately
        // not zero — see config/llmModels.js.
        costUsd: priceCall(provider, model, res.usage),
        durationMs,
    };
};

/**
 * Run one stage against whichever provider is configured for it.
 *
 * @param {string}  orgId      whose settings apply. Omitted → server defaults only.
 * @param {string}  stage      'parse' | 'tailor' | 'check' | 'agent' | 'match'
 * @param {string}  system     stable instructions
 * @param {string}  cacheable  large stable content, sent first so it can cache
 * @param {string}  input      the volatile part, sent last
 * @param {object}  schema     JSON Schema for the answer, optional
 * @param {number}  maxTokens  the caller's own ceiling; an organisation setting wins
 *
 * ── THE FALLBACK ──────────────────────────────────────────────────────
 *
 * When the main model fails for ANY reason — outage, missing key, a timeout, a
 * truncated or unparseable answer — the same request goes once to the stage's
 * fallback model, if one is set and usable. The result then carries
 * `usedFallback: true` and the primary's error, and is priced against the model
 * that actually answered, plus whatever the failed attempt was billed.
 *
 * A stage with no provider at all is switched OFF, not failing, and never falls
 * back: an organisation that has not set AI up must not have it start spending
 * on a default nobody chose.
 */
export const callModel = async ({
    orgId = null, stage, system, cacheable, input, schema, maxTokens = 8000,
}) => {
    const cfg = await resolveStage(orgId, stage);
    const ceiling = cfg.maxOutputTokens ?? maxTokens;

    const primary = await attempt({
        stage, provider: cfg.provider, model: cfg.model, system, cacheable, input, schema,
        maxTokens: ceiling, temperature: cfg.temperature, timeoutMs: cfg.timeoutMs,
    });
    if (primary.ok) return primary;

    const fb = cfg.fallback;
    const worthTrying = Boolean(cfg.provider)
        && Boolean(fb)
        && !(fb.provider === cfg.provider && fb.model === cfg.model)
        && reasonFor(fb.provider, fb.model, `${stage} fallback`) === null;
    if (!worthTrying) return primary;

    // The temperature was chosen for the primary; another vendor's scale is not
    // the same scale, so the fallback runs on its own default.
    const second = await attempt({
        stage, label: `${stage} fallback`, provider: fb.provider, model: fb.model,
        system, cacheable, input, schema,
        maxTokens: ceiling, temperature: null, timeoutMs: cfg.timeoutMs,
    });

    const wasted = primary.costUsd ?? 0;
    if (second.ok) {
        return {
            ...second,
            costUsd: second.costUsd === null ? null : Number((second.costUsd + wasted).toFixed(6)),
            usedFallback: true,
            primaryError: primary.error,
            primaryProvider: primary.provider,
            primaryModel: primary.model,
        };
    }

    return {
        ...second,
        error: `${primary.provider}/${primary.model} failed (${primary.error}) and the fallback `
            + `${second.provider}/${second.model} also failed (${second.error})`,
        retryable: Boolean(primary.retryable || second.retryable),
        costUsd: Number(((second.costUsd ?? 0) + wasted).toFixed(6)),
        usedFallback: true,
    };
};

/**
 * A tiny real call, for the settings screen's "Test" button.
 *
 * Takes the candidate values as given rather than reading saved settings, so an
 * administrator can try a choice BEFORE saving it. It costs a fraction of a cent
 * and is not written to the spend ledger.
 */
export const probeModel = async ({ provider, model, temperature = null, timeoutMs = null }) => {
    const res = await attempt({
        stage: 'probe',
        label: 'probe',
        provider: String(provider ?? '').toLowerCase(),
        model,
        system: 'You reply with a single JSON object and nothing else.',
        input: 'Return {"ok": true}.',
        schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: { ok: { type: 'boolean' } },
        },
        // Generous on purpose: a model that spends tokens reasoning before it
        // answers would otherwise "fail" a test it would pass in real use.
        maxTokens: 2048,
        temperature,
        timeoutMs: timeoutMs ?? 30_000,
    });
    return {
        ok: res.ok,
        provider: res.provider,
        model: res.model,
        durationMs: res.durationMs ?? null,
        costUsd: res.costUsd ?? null,
        error: res.ok ? null : String(res.error ?? 'Unknown error').slice(0, 400),
    };
};

export { stageConfig, isStageConfigured };
