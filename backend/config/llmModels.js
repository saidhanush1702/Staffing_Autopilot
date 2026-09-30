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
    //
    // The 2.5 family is kept for installations whose keys still reach it. Keys
    // issued now do not: the API answers "no longer available to new users" and
    // names a 3.x model instead, which is why the 3.x rows below exist.
    'gemini:gemini-2.5-pro':        { in: 1.25, cachedIn: 0.31, out: 10.00 },
    'gemini:gemini-2.5-flash':      { in: 0.30, cachedIn: 0.075, out: 2.50 },

    // Checked against ai.google.dev/gemini-api/docs/pricing on 2026-08-31.
    //
    // Note the ordering, which is not what the version numbers suggest: 3.6 and
    // 3.7 Flash are HALF the price of 3.5 Flash, so "newer" is also "cheaper"
    // here and there is no reason to stay on 3.5 for cost.
    //
    // Google has published an increase for 3.6/3.7 Flash from 1 January 2027
    // ($1.50 in / $7.50 out). These rows carry today's price; when that date
    // passes, the ledger silently halves the real spend until they are updated.
    'gemini:gemini-3.7-flash':      { in: 0.75, cachedIn: 0.075, out: 3.75 },
    'gemini:gemini-3.6-flash':      { in: 0.75, cachedIn: 0.075, out: 3.75 },
    'gemini:gemini-3.5-flash':      { in: 1.50, cachedIn: 0.15, out: 9.00 },
    'gemini:gemini-3.5-flash-lite': { in: 0.30, cachedIn: 0.03, out: 2.50 },
    // Pro is metered in two bands by prompt size; this is the <= 200k rate,
    // which is every call this pipeline makes — a resume plus a job description
    // is a few thousand tokens.
    'gemini:gemini-3.1-pro-preview': { in: 2.00, cachedIn: 0.20, out: 12.00 },

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

/**
 * `agent` is the form-filling agent: one short call per page it works through,
 * choosing a single action. Many small calls rather than one large one, so a
 * fast model is usually the right choice — see config/agentProtocol.js.
 *
 * `match` proposes which approved answer a differently-worded question is
 * really asking for. The consultant confirms it; nothing is typed on the
 * strength of a match alone — see controllers/questionSuggestionController.js.
 */
export const STAGES = ['parse', 'tailor', 'check', 'agent', 'match'];

/* ── what the settings screen needs to know ────────────────────────── */

/**
 * The five AI tasks, in the words an administrator would use.
 *
 * `defaultMaxTokens` is the ceiling the code itself asks for. It is shown as the
 * placeholder on the settings screen so "leave blank" has a visible meaning.
 * `suggestedTemperature` is advice, never a default: nothing is sent to a model
 * unless an administrator sets it.
 */
export const STAGE_INFO = {
    parse: {
        label: 'Resume reading',
        description: 'Reads an uploaded resume and splits it into sections. Runs once per '
            + 'resume file. It has to copy text exactly, so accuracy matters more than style.',
        defaultMaxTokens: 16000,
        suggestedTemperature: 0,
    },
    tailor: {
        label: 'Resume tailoring',
        description: 'Rewrites the resume for one specific job. The quality-critical step and '
            + 'the main cost. A little variation in wording is fine; invented facts are not.',
        defaultMaxTokens: 16000,
        suggestedTemperature: 0.3,
    },
    check: {
        label: 'Fabrication check',
        description: 'A second, independent model compares the original resume with the tailored '
            + 'one and flags anything invented. A comparison task, so a small model works well.',
        defaultMaxTokens: 4000,
        suggestedTemperature: 0,
    },
    agent: {
        label: 'Form-filling agent',
        description: 'Used on application pages no recipe recognises. Called once per page to '
            + 'choose a single action. Many small calls, so speed and price matter most.',
        defaultMaxTokens: 1024,
        suggestedTemperature: 0,
    },
    match: {
        label: 'Answer matching',
        description: 'When a form words a question differently from an approved answer, proposes '
            + 'which answer it really means. The consultant confirms; nothing is typed on its word alone.',
        defaultMaxTokens: 1024,
        suggestedTemperature: 0,
    },
};

/**
 * The providers an administrator can pick, and where each one's key lives.
 *
 * Keys stay in the server environment and never reach the browser; the screen
 * only learns whether one is present. DeepSeek and Qwen speak the OpenAI dialect,
 * so they share that adapter's key and base URL.
 */
export const PROVIDER_INFO = {
    anthropic: { label: 'Anthropic (Claude)', keyEnv: 'ANTHROPIC_API_KEY', maxTemperature: 1 },
    gemini: { label: 'Google (Gemini)', keyEnv: 'GEMINI_API_KEY', maxTemperature: 2 },
    openai: { label: 'OpenAI', keyEnv: 'LLM_OPENAI_API_KEY', maxTemperature: 2 },
    deepseek: {
        label: 'DeepSeek', keyEnv: 'LLM_OPENAI_API_KEY (+ LLM_OPENAI_BASE_URL)', maxTemperature: 2,
    },
    qwen: {
        label: 'Qwen', keyEnv: 'LLM_OPENAI_API_KEY (+ LLM_OPENAI_BASE_URL)', maxTemperature: 2,
    },
};

/**
 * Where DeepSeek and Qwen actually live, for an organisation that supplies its
 * own key and leaves the base URL blank.
 *
 * Both speak the OpenAI dialect through connectors/llm/openai.js, and that
 * adapter has no idea which of the three it is being called as — without a
 * base URL it defaults to OpenAI's own endpoint. Sent there, a DeepSeek or
 * Qwen key fails outright (wrong account, model not found), silently, in a
 * way "I set the key" gives no hint about. So an organisation's own key for
 * these two is paired with the right endpoint here rather than requiring the
 * base URL as a second mandatory field — see connectors/llm/index.js#attempt.
 */
export const PROVIDER_DEFAULT_BASE_URL = {
    deepseek: 'https://api.deepseek.com',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

/** Models the price table knows, grouped for a picker. */
export const knownModels = () => Object.entries(PRICING)
    .filter(([key]) => !key.startsWith('mock:'))
    .map(([key, p]) => {
        const [provider, ...rest] = key.split(':');
        return { provider, model: rest.join(':'), inPrice: p.in, cachedPrice: p.cachedIn, outPrice: p.out };
    });

/**
 * The fallback a stage uses when nothing has been chosen for it.
 *
 * Explicit environment wins (LLM_<STAGE>_FALLBACK_* then LLM_FALLBACK_*). With
 * none set, Claude Haiku 4.5 is the default — but only once an Anthropic key
 * exists, because a fallback that can never authenticate is not a fallback, just
 * a second failure to report. Returns null for "no fallback".
 */
export const DEFAULT_FALLBACK = { provider: 'anthropic', model: 'claude-haiku-4-5' };

export const envFallback = (stage, primary = {}) => {
    const upper = String(stage).toUpperCase();
    const provider = env(`LLM_${upper}_FALLBACK_PROVIDER`, env('LLM_FALLBACK_PROVIDER')).toLowerCase();
    const model = env(`LLM_${upper}_FALLBACK_MODEL`, env('LLM_FALLBACK_MODEL'));
    if (provider && model) return { provider, model };

    if (env('ANTHROPIC_API_KEY')
        && !(primary.provider === DEFAULT_FALLBACK.provider && primary.model === DEFAULT_FALLBACK.model)) {
        return { ...DEFAULT_FALLBACK };
    }
    return null;
};
