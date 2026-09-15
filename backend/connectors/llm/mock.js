/**
 * The mock provider.
 *
 * ── WHY THIS IS A REAL PROVIDER AND NOT A TEST DOUBLE ─────────────────
 *
 * Every other stage of this system can be tested without money — fingerprinting,
 * matching, the state machine, the queue sweeps. The preparation pipeline could
 * not be, because it is defined by a model call in the middle of it. That makes
 * the pipeline the one part nobody exercises until it is live and billing.
 *
 * So the mock registers as a provider like any other. Set LLM_PROVIDER=mock and
 * the whole path — claim, parse, tailor, check, score, render, transition —
 * runs end to end, deterministically, for free.
 *
 * Behaviour is steered by env so a test can ask for a specific failure without
 * reaching inside:
 *
 *   LLM_MOCK_RESPONSE_PARSE   the answer for the parse stage
 *   LLM_MOCK_RESPONSE_TAILOR  the answer for the tailoring stage
 *   LLM_MOCK_RESPONSE_CHECK   the answer for the fabrication check
 *   LLM_MOCK_RESPONSE         the answer for any stage without its own
 *   LLM_MOCK_FAIL             'retryable' | 'permanent' — fail instead
 *   LLM_MOCK_FAIL_STAGE       fail only on this stage, leaving the others alone
 *   LLM_MOCK_LATENCY_MS       pause before answering
 *
 * Per-stage answers matter because the three stages ask structurally different
 * questions — a resume, a resume, and a list of flags — and one canned reply
 * cannot satisfy all three schemas.
 */
import { env, numEnv } from './transport.js';

export const name = 'mock';

/*
 * ── A SCRIPT, FOR STAGES THAT ARE A CONVERSATION ──────────────────────
 *
 * The agent stage is called once per turn and needs a DIFFERENT answer each
 * time — press Apply, fill the email, press Next, declare ready. One canned
 * reply cannot walk a form, so a stage may be given a JSON array instead:
 *
 *   LLM_MOCK_SCRIPT_AGENT='[{"action":"press",...},{"action":"fill",...}]'
 *
 * Each call takes the next entry; once the script runs out, the last entry
 * repeats. `resetMockScripts` rewinds every script, for a suite that runs the
 * same one twice.
 */
const cursors = new Map();

export const resetMockScripts = () => { cursors.clear(); };

const scripted = (stage) => {
    const raw = env(`LLM_MOCK_SCRIPT_${String(stage ?? '').toUpperCase()}`);
    if (!raw) return null;
    let steps;
    try { steps = JSON.parse(raw); } catch { return null; }
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const key = `${stage}:${raw}`;
    const at = cursors.get(key) ?? 0;
    cursors.set(key, at + 1);
    return JSON.stringify(steps[Math.min(at, steps.length - 1)]);
};

export const isConfigured = () => true;

export const call = async ({ stage, model, input, schema }) => {
    const latency = numEnv('LLM_MOCK_LATENCY_MS', 0);
    if (latency > 0) await new Promise((r) => { setTimeout(r, latency); });

    const failure = env('LLM_MOCK_FAIL');
    const failStage = env('LLM_MOCK_FAIL_STAGE');
    const shouldFail = failure && (!failStage || failStage === stage);

    if (shouldFail && failure === 'retryable') {
        return { ok: false, retryable: true, error: 'Mock provider: simulated 503.' };
    }
    if (shouldFail && failure === 'permanent') {
        return { ok: false, retryable: false, error: 'Mock provider: simulated 400.' };
    }

    const canned = scripted(stage)
        ?? env(`LLM_MOCK_RESPONSE_${String(stage ?? '').toUpperCase()}`, env('LLM_MOCK_RESPONSE'));
    const text = canned || (schema ? '{}' : 'mock response');

    let json = null;
    if (schema) {
        try { json = JSON.parse(text); } catch { json = null; }
    }

    return {
        ok: true,
        text,
        json,
        model: model || 'mock-model',
        usage: {
            // Not zero: a ledger that only ever sees zeros cannot show that its
            // own arithmetic works.
            inputTokens: Math.ceil(String(input ?? '').length / 4),
            outputTokens: Math.ceil(text.length / 4),
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
        },
        truncated: false,
    };
};
