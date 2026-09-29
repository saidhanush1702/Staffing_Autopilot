/**
 * Google Gemini adapter — generateContent.
 *
 * A third dialect again: no `messages`, no `system` field on the turn. The
 * system prompt is `systemInstruction`, turns are `contents[].parts[].text`,
 * and structured output is `generationConfig.responseSchema`.
 *
 * ── ONE SHARP EDGE ────────────────────────────────────────────────────
 *
 * `responseSchema` accepts a SUBSET of JSON Schema. `additionalProperties`,
 * `$ref` and several other keywords are rejected outright with a 400, so the
 * schema is stripped before it is sent. The strictness that is lost here is
 * recovered where it belongs anyway — the Joi validation in config/resumeSchema.js
 * runs over every response regardless of which provider produced it.
 */
import { postJson, extractJson, env, numEnv } from './transport.js';

export const name = 'gemini';

const apiKey = () => env('GEMINI_API_KEY', env('GOOGLE_API_KEY'));

export const isConfigured = () => apiKey().length > 0;

/** Keywords Gemini's schema dialect rejects. Removed rather than translated. */
const UNSUPPORTED = new Set([
    'additionalProperties', '$schema', '$ref', '$defs', 'definitions',
    'patternProperties', 'allOf', 'oneOf', 'not', 'const', 'examples',
]);

/**
 * Rewrite a nullable field into the one shape Gemini accepts.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────
 *
 * JSON Schema spells "a string or nothing" as `type: ['string', 'null']`, and
 * that is what config/resumeSchema.js uses for every optional field — an email,
 * a location, an end date. Gemini's responseSchema is not JSON Schema; it is an
 * OpenAPI-subset PROTO, where `type` is a single enum value and cannot be a
 * list. Sent as-is it returns a 400 for every optional field at once:
 *
 *   Unknown name "type" ... Proto field is not repeating, cannot start list.
 *
 * Stripping the key would be worse than the error — the field would silently
 * become "any type", and the model would be free to return a number where the
 * schema promised a string.
 *
 * ── WHY THE TRANSLATION LIVES HERE ────────────────────────────────────
 *
 * The shared schema stays honest JSON Schema, which is what OpenAI and
 * Anthropic want and what the Joi validator mirrors. One provider's proto
 * quirk is one provider's problem, so it is fixed in that provider's adapter
 * rather than by bending the shape every other stage depends on.
 */
const normaliseType = (node) => {
    if (!Array.isArray(node.type)) return node;

    const types = node.type.filter((t) => t !== 'null');
    const out = { ...node, type: types[0] ?? 'string' };
    if (node.type.includes('null')) out.nullable = true;
    return out;
};

const stripSchema = (node) => {
    if (Array.isArray(node)) return node.map(stripSchema);
    if (!node || typeof node !== 'object') return node;

    const source = normaliseType(node);
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        if (UNSUPPORTED.has(key)) continue;

        // ── AN EMPTY ENUM VALUE IS A 400, NOT A WARNING ───────────────
        //
        //   GenerateContentRequest.generation_config.response_schema
        //     .properties[kind].enum[0]: cannot be empty
        //
        // A flat schema that uses "" to mean "this field does not apply" is a
        // reasonable thing to write, is accepted by other providers, and takes
        // this one down on every single call. That is not hypothetical: the
        // form-filling agent shipped with exactly that schema and never ran
        // once, which read as broken automation rather than a rejected request.
        //
        // So empty values are dropped here rather than trusted not to appear.
        // If that empties the list, the enum goes with it — an unconstrained
        // string still passes our own validation, and a weaker hint to the
        // model beats a request the provider refuses to read at all.
        if (key === 'enum' && Array.isArray(value)) {
            const usable = value
                .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
                .map((v) => String(v));
            if (usable.length > 0) out[key] = usable;
            continue;
        }

        out[key] = stripSchema(value);
    }
    return out;
};

export const call = async ({
    model, system, cacheable, input, schema, maxTokens = 8000, temperature = null, timeoutMs = null,
}) => {
    const key = apiKey();
    if (!key) {
        return {
            ok: false,
            retryable: false,
            error: 'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set.',
        };
    }

    // Stable part first, volatile last — same ordering rule as every other
    // adapter, so implicit context caching has a prefix it can match.
    const parts = [];
    if (cacheable) parts.push({ text: cacheable });
    parts.push({ text: input });

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens },
    };
    if (temperature !== null && temperature !== undefined) {
        body.generationConfig.temperature = temperature;
    }
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (schema) {
        body.generationConfig.responseMimeType = 'application/json';
        body.generationConfig.responseSchema = stripSchema(schema);
    }

    const base = env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com');
    const res = await postJson({
        // The key goes in a header, not the query string: the URL is what ends
        // up in logs and error text, and a key in a log is a leaked key.
        url: `${base.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': key },
        body,
        timeoutMs: timeoutMs ?? numEnv('LLM_TIMEOUT_MS', 120_000),
    });
    if (!res.ok) return res;

    const candidate = res.body?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
        .map((p) => p?.text ?? '')
        .join('');

    const u = res.body?.usageMetadata ?? {};
    const cached = u.cachedContentTokenCount ?? 0;

    return {
        ok: true,
        text,
        json: schema ? extractJson(text) : null,
        model,
        usage: {
            // promptTokenCount includes cached tokens, as in the OpenAI dialect.
            inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
            outputTokens: u.candidatesTokenCount ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
        },
        truncated: candidate?.finishReason === 'MAX_TOKENS',
    };
};
