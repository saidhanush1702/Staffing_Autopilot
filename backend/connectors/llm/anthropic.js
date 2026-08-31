/**
 * Anthropic (Claude) adapter.
 *
 * Speaks the Messages API. Implements the one contract every adapter in this
 * folder implements — see connectors/llm/index.js for the shape and for what
 * each field means.
 *
 * ── WHAT THIS PROVIDER GIVES US THAT THE OTHERS MAY NOT ───────────────
 *
 * Explicit prompt caching. `cache_control` marks a point in the prompt, and
 * everything before it is billed at roughly a tenth on the next call that
 * shares the same prefix. Our prompts are shaped for exactly this: the locked
 * rules and the consultant's base resume are identical across every job that
 * consultant is matched to, and only the job description changes.
 *
 * Caching is a PREFIX match, so ordering is not cosmetic — system, then the
 * cacheable block, then the volatile input, and any change to the earlier parts
 * throws away everything after it.
 */
import { postJson, extractJson, env, numEnv } from './transport.js';

export const name = 'anthropic';

export const isConfigured = () => env('ANTHROPIC_API_KEY').length > 0;

export const call = async ({
    model, system, cacheable, input, schema, maxTokens = 8000,
}) => {
    const apiKey = env('ANTHROPIC_API_KEY');
    if (!apiKey) {
        return { ok: false, retryable: false, error: 'ANTHROPIC_API_KEY is not set.' };
    }

    const content = [];
    if (cacheable) {
        content.push({
            type: 'text',
            text: cacheable,
            cache_control: { type: 'ephemeral' },
        });
    }
    content.push({ type: 'text', text: input });

    const body = {
        model,
        max_tokens: maxTokens,
        // System is an array so the rules can carry their own cache breakpoint.
        // They never change between calls, which makes them the cheapest thing
        // in the prompt to keep cached.
        system: system
            ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
            : undefined,
        messages: [{ role: 'user', content }],
    };

    if (schema) {
        body.output_config = {
            format: { type: 'json_schema', schema },
        };
    }

    const res = await postJson({
        url: `${env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')}/v1/messages`,
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': env('ANTHROPIC_VERSION', '2023-06-01'),
        },
        body,
        timeoutMs: numEnv('LLM_TIMEOUT_MS', 120_000),
    });
    if (!res.ok) return res;

    const blocks = Array.isArray(res.body?.content) ? res.body.content : [];
    const text = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('');

    const u = res.body?.usage ?? {};

    return {
        ok: true,
        text,
        json: schema ? extractJson(text) : null,
        model: res.body?.model ?? model,
        usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
        // A response cut off at the token ceiling is truncated JSON, which is
        // a different failure from a bad one and is worth surfacing.
        truncated: res.body?.stop_reason === 'max_tokens',
    };
};
