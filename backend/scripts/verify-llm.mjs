/**
 * ── DOES THE CONFIGURED MODEL PROVIDER ACTUALLY WORK? ─────────────────
 *
 *   npm run verify:llm
 *
 * Run this after changing ANY of LLM_PROVIDER, LLM_*_MODEL, or an API key —
 * and before switching a live organisation on. It makes one real call per
 * stage against whatever `.env` currently names, and reports what happened.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE TEST SUITE ────────────────────
 *
 * The committed suites run on `LLM_PROVIDER=mock` on purpose: they must be
 * runnable on any laptop, in CI, with no key and no bill. That is the right
 * default and it has one blind spot, which is the entire question this script
 * answers — whether the provider you are actually paying for accepts the
 * requests this pipeline sends.
 *
 * Every real failure found while wiring Gemini up was invisible to the mock:
 *
 *   · a model that ListModels advertises but the key may not call
 *     ("no longer available to new users")
 *   · a Pro model that answers 429 because the key has no Pro quota
 *   · a schema Gemini's proto rejects outright, so EVERY structured call 400s
 *
 * None of those are bugs a mock can have. All three are one command away here.
 *
 * ── WHAT IT COSTS ─────────────────────────────────────────────────────
 *
 * Three small calls, a few thousand tokens in total — well under a cent on any
 * current model, and nothing at all on a free tier. It touches no queue item
 * and writes nothing to the database.
 */
import 'dotenv/config';
import { callModel, isAvailable, unavailableReason } from '../connectors/llm/index.js';
import { stageConfig, priceCall, PRICING } from '../config/llmModels.js';
import { RESUME_JSON_SCHEMA, validateResume, flattenResumeText } from '../config/resumeSchema.js';
import {
    PARSE_SYSTEM, TAILOR_SYSTEM, tailorInstruction,
    CHECK_SYSTEM, CHECK_JSON_SCHEMA, checkInstruction, PROMPT_VERSION,
} from '../config/tailoringRules.js';

const RESUME_TEXT = `Dev Anand
dev.anand@example.com | 555-0142 | Austin, TX

SUMMARY
Data engineer building batch pipelines for retail analytics.

SKILLS
Python, SQL, Scala

EXPERIENCE
Data Engineer, Northwind Retail, Austin TX (Jan 2021 - Present)
- Built nightly batch pipelines in Python against the sales warehouse.
- Modelled reporting tables in SQL for the analytics team.
- Maintained Scala jobs that aggregate store-level transactions.

EDUCATION
BSc Computer Science, State University`;

const JOB = {
    company: 'Vector Analytics',
    title: 'Senior Data Engineer',
    description: `We need a data engineer strong in Python and SQL to build and
operate data pipelines against our retail warehouse. Scala experience is useful.
Requirements: Python, SQL, data pipelines, warehouse modelling, ETL.`,
};

/**
 * A tailored resume with two claims that are NOT in the original: a seniority
 * ("led a team") and an ownership claim. Neither introduces a new proper noun or
 * a new number, so the mechanical pass cannot see them — only the model can.
 * That makes this the one case that proves the checking stage is doing real work
 * rather than returning an empty list quickly.
 */
const POISONED_TEXT = `Dev Anand
SUMMARY
Senior data engineer who led the analytics platform team.
EXPERIENCE
Data Engineer, Northwind Retail
- Led a team of engineers building nightly batch pipelines in Python.
- Owned and architected the reporting layer used across the whole company.`;

let failed = 0;
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const bad = (m) => { failed += 1; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`); };
const info = (m) => console.log(`        ${m}`);

const money = (n) => (n == null ? 'UNPRICED' : `$${n.toFixed(6)}`);

const runStage = async (stage, { system, input, cacheable, schema, validate }) => {
    const cfg = stageConfig(stage);
    console.log(`\n— ${stage} — ${cfg.provider || '(no provider)'} / ${cfg.model || '(no model)'}`);

    if (!isAvailable(stage)) {
        bad(`not available: ${unavailableReason(stage)}`);
        return null;
    }

    const t0 = Date.now();
    const res = await callModel({ stage, system, input, cacheable, schema, maxTokens: 16000 });
    const ms = Date.now() - t0;

    if (!res.ok) {
        // The provider's own words. Almost every real misconfiguration is
        // diagnosable from this line alone — a wrong key, a model the account
        // cannot reach, a quota, a schema it refuses.
        const m = /"message":\s*"([^"]+)/.exec(res.error ?? '');
        bad(`the call failed after ${ms}ms${res.status ? ` (HTTP ${res.status})` : ''}`);
        info(m ? m[1] : String(res.error).slice(0, 400));
        info(`retryable: ${res.retryable}`);
        return null;
    }

    ok(`answered in ${ms}ms`);
    info(`tokens  in=${res.usage.inputTokens} out=${res.usage.outputTokens} `
        + `cached=${res.usage.cacheReadTokens}`);

    const priced = PRICING[`${cfg.provider}:${cfg.model}`];
    const cost = priceCall(cfg.provider, cfg.model, res.usage);
    info(`cost    ${money(cost)}${priced ? '' : '  ← add this model to config/llmModels.js PRICING'}`);
    if (!priced) {
        // Not a hard failure — a free tier genuinely costs nothing. But an
        // unpriced model means the per-org monthly ceiling can never fire,
        // which is the opposite of harmless once a card is attached.
        bad(`"${cfg.provider}:${cfg.model}" has no price, so the monthly budget cannot enforce itself`);
    }

    if (res.truncated) bad('the answer was cut off at the token limit');

    if (schema) {
        if (!res.json) {
            bad('the answer was not parseable JSON');
            info(String(res.text).slice(0, 300));
            return null;
        }
        ok('returned valid JSON for the schema');
    }

    if (validate) {
        const v = validate(res.json);
        if (v.ok) ok('the JSON satisfies the resume schema');
        else {
            bad(`the JSON does not satisfy the resume schema: ${v.error}`);
            return null;
        }
        return v.value;
    }
    return res.json;
};

console.log(`Verifying the model provider against the live API.  prompt ${PROMPT_VERSION}`);

/* ── 1 · parse ─────────────────────────────────────────────────────── */
const parsed = await runStage('parse', {
    system: PARSE_SYSTEM,
    input: `RESUME TEXT\n===========\n${RESUME_TEXT}`,
    schema: RESUME_JSON_SCHEMA,
    validate: validateResume,
});

/* ── 2 · tailor ────────────────────────────────────────────────────── */
let tailored = null;
if (parsed) {
    tailored = await runStage('tailor', {
        system: TAILOR_SYSTEM,
        cacheable: `BASE RESUME (JSON)\n${JSON.stringify(parsed)}`,
        input: tailorInstruction(JOB),
        schema: RESUME_JSON_SCHEMA,
        validate: validateResume,
    });
}

/* ── 3 · check ─────────────────────────────────────────────────────── */
//
// Run TWICE, deliberately. A checking stage that always answers "nothing wrong"
// passes a one-case test and is worthless. The pair — clean must be silent,
// poisoned must not be — is the smallest test that can tell the difference.
const checkOnce = async (label, adaptedText) => {
    const cfg = stageConfig('check');
    if (!isAvailable('check')) return null;
    const res = await callModel({
        stage: 'check',
        system: CHECK_SYSTEM,
        cacheable: `ORIGINAL RESUME\n${RESUME_TEXT}`,
        input: checkInstruction({ originalText: RESUME_TEXT, adaptedText }),
        schema: CHECK_JSON_SCHEMA,
        maxTokens: 8000,
    });
    if (!res.ok) {
        const m = /"message":\s*"([^"]+)/.exec(res.error ?? '');
        bad(`the ${label} check failed: ${m ? m[1] : String(res.error).slice(0, 200)}`);
        return null;
    }
    const flags = res.json?.flags ?? [];
    info(`${label.padEnd(9)} ${flags.length} flag(s)   `
        + `cost ${money(priceCall(cfg.provider, cfg.model, res.usage))}`);
    return flags;
};

console.log(`\n— check — ${stageConfig('check').provider} / ${stageConfig('check').model}`);
if (isAvailable('check')) {
    const clean = await checkOnce('honest', flattenResumeText(parsed ?? {}) || RESUME_TEXT);
    const dirty = await checkOnce('invented', POISONED_TEXT);

    if (clean === null || dirty === null) {
        bad('the checking stage could not be exercised');
    } else if (clean.length > 0) {
        bad(`an honest resume raised ${clean.length} flag(s) — false positives will clog the review queue`);
        for (const f of clean.slice(0, 3)) info(`· ${JSON.stringify(String(f.claim).slice(0, 80))}`);
    } else if (dirty.length === 0) {
        // The dangerous failure, and the quiet one: everything "passes", every
        // resume ships, and the guarantee the product is sold on is off.
        bad('an invented resume raised NO flags — the fabrication check is not working');
    } else {
        ok(`silent on an honest resume, ${dirty.length} flag(s) on an invented one`);
        for (const f of dirty.slice(0, 3)) info(`· ${JSON.stringify(String(f.claim).slice(0, 80))}`);
    }
} else {
    bad(`not available: ${unavailableReason('check')}`);
}

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log('  All stages work against the live provider.');
} else {
    console.log(`  ${failed} problem(s) above. The pipeline will not tailor reliably.`);
}
console.log('─'.repeat(60));
process.exit(failed === 0 ? 0 : 1);
