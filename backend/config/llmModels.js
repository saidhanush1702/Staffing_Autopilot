/**
 * ── WHICH MODEL RUNS WHICH STAGE, AND WHAT IT COSTS ───────────────────
 *
 * THE PROVIDER IS NOT DECIDED YET. Claude, Gemini, GPT, Qwen, DeepSeek and
 * anything speaking the OpenAI chat-completions dialect are all live options,
 * and the choice is a later decision. Nothing in this codebase may assume one.
 *
 * So this file holds the two things a provider choice actually changes —
 * WHICH MODEL and WHAT IT COSTS — and everything else in the pipeline reads
 * them from here. Switching provider is then an environment change plus, if
 * the model is unknown to the table below, one row.
 *
 * ── THE THREE STAGES ──────────────────────────────────────────────────
 *
 *   parse    base resume text → structured sections. Runs ONCE per resume,
 *            cached by sha256 afterwards. Cheap work; a small model is right.
 *   tailor   the quality-critical step. This is the one that earns money.
 *   check    the independent fabrication check. A comparison task — it reads
 *            two documents and reports what is in one and not the other, which
 *            a small model does reliably.
 *
 * A single provider does not have to serve all three. `LLM_TAILOR_PROVIDER`
 * and friends fall back to `LLM_PROVIDER`, so running the expensive stage on
 * one vendor and the cheap ones on another is configuration, not code.
 *
 * ── WHY PRICES LIVE HERE AND ARE ALLOWED TO BE UNKNOWN ────────────────
 *
 * Every run is written to resume_tailoring_runs with its cost, and that ledger
 * is what the monthly budget is enforced against. A price this table does not
 * know is recorded as NULL rather than as zero: "we do not know what this cost"
 * and "this cost nothing" are very different facts, and a budget that silently
 * treats the first as the second is a budget that never triggers.
 */

/**
 * Price per MILLION tokens, in USD.
 *
 * `cachedIn` is the rate for input served from a provider's prompt cache.
 * Where a provider has no cache, it equals `in` and the arithmetic still works.
 *
 * Keyed `provider:model`. Add a row when you adopt a model that is not here;
 * an absent row costs nothing except a NULL in the ledger and a one-line warning.
 */
export const PRICING = {
    // ── Anthropic ─────────────────────────────────────────────────────
    'anthropic:claude-opus-5':      { in: 5.00, cachedIn: 0.50, out: 25.00 },
    'anthropic:claude-sonnet-5':    { in: 2.00, cachedIn: 0.20, out: 10.00 },
    'anthropic:claude-haiku-4-5':   { in: 1.00, cachedIn: 0.10, out: 5.00 },

    // ── OpenAI ────────────────────────────────────────────────────────
    'openai:gpt-4o':                { in: 2.50, cachedIn: 1.25, out: 10.00 },
    'openai:gpt-4o-mini':           { in: 0.15, cachedIn: 0.075, out: 0.60 },

    // ── Google ────────────────────────────────────────────────────────
    'gemini:gemini-2.5-pro':        { in: 1.25, cachedIn: 0.31, out: 10.00 },
    'gemini:gemini-2.5-flash':      { in: 0.30, cachedIn: 0.075, out: 2.50 },

    // ── OpenAI-compatible third parties ───────────────────────────────
    'deepseek:deepseek-chat':       { in: 0.27, cachedIn: 0.07, out: 1.10 },
    'qwen:qwen-plus':               { in: 0.40, cachedIn: 0.40, out: 1.20 },
    'qwen:qwen-max':                { in: 1.60, cachedIn: 1.60, out: 6.40 },

    // The mock provider, used by the test suite. Free, obviously.
    'mock:mock-model':              { in: 0, cachedIn: 0, out: 0 },
};

/**
 * Cost of one call, in USD, or `null` when the model's price is not known.
 *
 * Null rather than zero — see the file header. A caller that treats an unknown
 * cost as free will spend a month's budget without the ceiling ever firing.
 */
export const priceCall = (provider, model, usage = {}) => {
    const row = PRICING[`${provider}:${model}`];
    if (!row) return null;

    const fresh = Math.max(0, Number(usage.inputTokens ?? 0));
    const cached = Math.max(0, Number(usage.cacheReadTokens ?? 0));
    const written = Math.max(0, Number(usage.cacheWriteTokens ?? 0));
    const out = Math.max(0, Number(usage.outputTokens ?? 0));

    // Cache WRITES are billed above the normal input rate by providers that
    // charge for them at all (Anthropic bills ~1.25x). Where a provider does
    // not, `cacheWriteTokens` is zero and this term vanishes.
    const cost = (fresh * row.in
        + cached * row.cachedIn
        + written * row.in * 1.25
        + out * row.out) / 1_000_000;

    // Six decimal places: a single cheap call can genuinely cost $0.0004, and
    // rounding that to a cent either way makes a month's ledger wrong.
    return Number(cost.toFixed(6));
};

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;

/**
 * Resolve a stage to `{ provider, model }`.
 *
 * Read fresh on every call rather than captured at import: the test suite sets
 * process.env and expects it to take effect, and the worker outlives any single
 * configuration. This is the same rule connectors/serpapi.js follows.
 *
 * With nothing configured, `provider` is an empty string. That is not an error
 * here — it is how the pipeline learns the feature is switched off, and the
 * tailoring handler turns it into a marked, un-tailored, still-shipped
 * application rather than a failure.
 */
export const stageConfig = (stage) => {
    const upper = String(stage).toUpperCase();
    const provider = env(`LLM_${upper}_PROVIDER`, env('LLM_PROVIDER'));
    const model = env(`LLM_${upper}_MODEL`, env('LLM_MODEL'));
    return { stage, provider: provider.toLowerCase(), model };
};

/** Is any provider configured for this stage? */
export const isStageConfigured = (stage) => {
    const { provider, model } = stageConfig(stage);
    return provider.length > 0 && model.length > 0;
};

export const STAGES = ['parse', 'tailor', 'check'];
