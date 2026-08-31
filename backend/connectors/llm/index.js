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
import { stageConfig, priceCall, isStageConfigured } from '../../config/llmModels.js';
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
 * Is the given stage usable right now — provider named, adapter known, key set?
 *
 * Called before any work is done, so "the feature is switched off" is answered
 * without spending anything or writing a half-finished row.
 */
export const isAvailable = (stage) => {
    if (!isStageConfigured(stage)) return false;
    const { provider } = stageConfig(stage);
    const adapter = adapterFor(provider);
    return Boolean(adapter?.isConfigured());
};

/**
 * Why a stage is unavailable, in words a dashboard can show.
 * Returns null when it IS available.
 */
export const unavailableReason = (stage) => {
    const { provider, model } = stageConfig(stage);
    if (!provider) {
        return `No model provider is configured. Set LLM_PROVIDER (or LLM_${stage.toUpperCase()}_PROVIDER).`;
    }
    const adapter = adapterFor(provider);
    if (!adapter) {
        return `Unknown model provider "${provider}". Known: ${knownProviders().join(', ')}.`;
    }
    if (!model) {
        return `No model named for the ${stage} stage. Set LLM_MODEL or LLM_${stage.toUpperCase()}_MODEL.`;
    }
    if (!adapter.isConfigured()) {
        return `The ${provider} provider has no API key in the environment.`;
    }
    return null;
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
    const { rows } = await query(
        `SELECT COALESCE(SUM(r.cost_usd), 0)::float8      AS spent,
                COUNT(*) FILTER (WHERE r.cost_usd IS NULL)::int AS unpriced,
                o.ai_monthly_budget_usd::float8           AS budget
           FROM organizations o
      LEFT JOIN resume_tailoring_runs r
             ON r.organization_id = o.id
            AND r.created_at >= (
                CASE WHEN EXTRACT(DAY FROM now()) >= o.ai_spend_reset_day
                     THEN date_trunc('month', now())
                     ELSE date_trunc('month', now()) - interval '1 month'
                END + (o.ai_spend_reset_day - 1) * interval '1 day'
            )
          WHERE o.id = $1
       GROUP BY o.ai_monthly_budget_usd`,
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
 * Run one stage against whichever provider is configured for it.
 *
 * @param {string}  stage      'parse' | 'tailor' | 'check'
 * @param {string}  system     stable instructions
 * @param {string}  cacheable  large stable content, sent first so it can cache
 * @param {string}  input      the volatile part, sent last
 * @param {object}  schema     JSON Schema for the answer, optional
 * @param {number}  maxTokens
 */
export const callModel = async ({
    stage, system, cacheable, input, schema, maxTokens = 8000,
}) => {
    const { provider, model } = stageConfig(stage);

    const reason = unavailableReason(stage);
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
        stage, model, system, cacheable, input, schema, maxTokens,
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

export { stageConfig, isStageConfigured };
