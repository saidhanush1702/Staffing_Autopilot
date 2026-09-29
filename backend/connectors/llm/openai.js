/**
 * OpenAI-compatible adapter — chat completions.
 *
 * ── WHY ONE ADAPTER COVERS SEVERAL VENDORS ────────────────────────────
 *
 * OpenAI's /v1/chat/completions shape became the de-facto dialect, and DeepSeek,
 * Qwen (DashScope compatible mode), Groq, Together, OpenRouter, vLLM and Ollama
 * all speak it. So adopting any of them is a base URL, a key and a model name —
 * not a new file.
 *
 * That is why the provider name is carried per-configuration rather than
 * hard-coded to 'openai': the pricing table and the ledger need to know it was
 * DeepSeek, even though the wire format was OpenAI's.
 *
 *   LLM_PROVIDER=deepseek
 *   LLM_OPENAI_BASE_URL=https://api.deepseek.com
 *   LLM_OPENAI_API_KEY=...
 *   LLM_TAILOR_MODEL=deepseek-chat
 *
 * ── CACHING ───────────────────────────────────────────────────────────
 *
 * There is no cache_control in this dialect. OpenAI and DeepSeek both cache
 * long prompt prefixes automatically and report the hit back in
 * `usage.prompt_tokens_details.cached_tokens`; others report nothing and simply
 * bill in full. Either way the `cacheable` block goes first, which is what
 * makes an automatic cache able to hit at all.
 */
import { postJson, extractJson, env, numEnv } from './transport.js';

export const name = 'openai';

const baseUrl = () => env('LLM_OPENAI_BASE_URL', env('OPENAI_BASE_URL', 'https://api.openai.com'));
const apiKey = () => env('LLM_OPENAI_API_KEY', env('OPENAI_API_KEY'));

export const isConfigured = () => apiKey().length > 0;

export const call = async ({
    model, system, cacheable, input, schema, maxTokens = 8000, temperature = null, timeoutMs = null,
}) => {
    const key = apiKey();
    if (!key) {
        return {
            ok: false,
            retryable: false,
            error: 'LLM_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.',
        };
    }

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    // Two user turns rather than one concatenated string: it keeps the stable
    // half a clean prefix, which is the only thing an automatic cache can key on.
    if (cacheable) messages.push({ role: 'user', content: cacheable });
    messages.push({ role: 'user', content: input });

    const body = { model, messages, max_tokens: maxTokens };
    if (temperature !== null && temperature !== undefined) body.temperature = temperature;

    if (schema) {
        // json_schema is the strict mode; a vendor that does not implement it
        // usually still honours json_object, and extractJson() covers the rest.
        body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'result', schema, strict: false },
        };
    }

    const res = await postJson({
        url: `${baseUrl().replace(/\/+$/, '')}/v1/chat/completions`,
        headers: { authorization: `Bearer ${key}` },
        body,
        timeoutMs: timeoutMs ?? numEnv('LLM_TIMEOUT_MS', 120_000),
    });
    if (!res.ok) return res;

    const choice = res.body?.choices?.[0];
    const text = choice?.message?.content ?? '';
    const u = res.body?.usage ?? {};

    // `prompt_tokens` INCLUDES the cached ones in this dialect, unlike
    // Anthropic's, where they are counted separately. Subtracting here means
    // the ledger's arithmetic is the same for every provider.
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = u.prompt_tokens ?? 0;

    return {
        ok: true,
        text,
        json: schema ? extractJson(text) : null,
        model: res.body?.model ?? model,
        usage: {
            inputTokens: Math.max(0, prompt - cached),
            outputTokens: u.completion_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
        },
        truncated: choice?.finish_reason === 'length',
    };
};
