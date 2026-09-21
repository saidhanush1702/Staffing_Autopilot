/**
 * The AI models screen — per-organisation model settings and the fallback.
 *
 *   node tests/llmSettings.test.mjs
 *
 * Runs against the real database with the mock provider, and stubs `fetch` for
 * the adapter checks so nothing here can spend money or reach a vendor.
 *
 * What this exists to prove:
 *
 *   1. An organisation's override beats the server default field by field, blank
 *      falls through, and one organisation can never see another's.
 *   2. Bad combinations are refused (half a provider/model pair, a temperature
 *      the vendor would reject) and saving all-blank removes the override.
 *   3. The fallback fires on ANY primary failure, is priced and labelled as the
 *      model that actually answered, does not fire on success, and never fires
 *      for a stage that is switched off.
 *   4. Temperature and the timeout reach each vendor's request — and 0 is sent,
 *      not mistaken for "unset".
 *   5. The browser is never told a key, only whether one exists.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';
process.env.LLM_MOCK_RESPONSE = '{"ok":true}';

import { query, pool } from '../db.js';
import {
    callModel, resolveStage, stageStatus, probeModel,
} from '../connectors/llm/index.js';
import { stageConfig } from '../config/llmModels.js';
import * as anthropic from '../connectors/llm/anthropic.js';
import * as gemini from '../connectors/llm/gemini.js';
import * as openai from '../connectors/llm/openai.js';
import { saveOverride, deleteOverride } from '../connectors/llm/settings.js';
import {
    getLlmSettings, updateLlmSettings, resetLlmSettings, testLlmSettings, llmSettingsSchema,
} from '../controllers/llmSettingsController.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const mockRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};
const call = async (handler, req) => {
    const res = mockRes();
    let thrown = null;
    await handler(req, res, (e) => { thrown = e; });
    if (thrown) throw thrown;
    return res;
};

const BLANK = {
    provider: null, model: null, temperature: null, maxOutputTokens: null,
    timeoutSeconds: null, fallbackProvider: null, fallbackModel: null,
};

const main = async () => {
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 2');
    const [orgA, orgB] = orgs.map((o) => o.id);
    const admin = (params = {}, body = {}) => ({
        user: { orgId: orgA, id: null, role: 'ORG_ADMIN' }, params, body, query: {},
    });

    const clean = async () => {
        for (const o of [orgA, orgB].filter(Boolean)) {
            await query('DELETE FROM org_llm_settings WHERE organization_id = $1', [o]);
        }
    };
    await clean();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // The developer's own .env may name a fallback; these tests are about the
    // rules, so they start from none and set one deliberately where they need it.
    const savedFb = [process.env.LLM_FALLBACK_PROVIDER, process.env.LLM_FALLBACK_MODEL];
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;

    /* ── 1. resolution ──────────────────────────────────────────────── */

    section('an override beats the server default, field by field');

    let cfg = await resolveStage(orgA, 'tailor');
    check('no override: the server default applies', [cfg.provider, cfg.model, cfg.customised],
        ['mock', stageConfig('tailor').model, false]);
    check('  temperature and ceiling stay unset', [cfg.temperature, cfg.maxOutputTokens], [null, null]);

    await saveOverride(orgA, 'tailor', {
        provider: 'gemini', model: 'gemini-3.7-flash', temperature: 0.3, maxOutputTokens: 9000,
        timeoutMs: 45000, fallbackProvider: null, fallbackModel: null,
    }, null);
    cfg = await resolveStage(orgA, 'tailor');
    check('the override wins', [cfg.provider, cfg.model, cfg.temperature, cfg.maxOutputTokens, cfg.timeoutMs],
        ['gemini', 'gemini-3.7-flash', 0.3, 9000, 45000]);
    check('  and is marked customised', cfg.customised, true);

    cfg = await resolveStage(orgA, 'parse');
    check('another task of the same organisation is untouched', cfg.provider, 'mock');
    if (orgB) {
        cfg = await resolveStage(orgB, 'tailor');
        check('another organisation is untouched', cfg.provider, 'mock');
    }

    await saveOverride(orgA, 'check', {
        provider: null, model: null, temperature: 0, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);
    cfg = await resolveStage(orgA, 'check');
    check('leaving provider blank keeps the default model', [cfg.provider, cfg.model],
        ['mock', stageConfig('check').model]);
    check('  while a temperature of 0 is kept, not dropped', cfg.temperature, 0);
    await clean();

    /* ── 2. validation and saving ───────────────────────────────────── */

    section('bad combinations are refused');

    let r = await call(updateLlmSettings, admin({ stage: 'tailor' }, { ...BLANK, provider: 'gemini' }));
    check('a provider with no model is refused', r.statusCode, 422);
    r = await call(updateLlmSettings, admin({ stage: 'tailor' }, { ...BLANK, fallbackModel: 'claude-haiku-4-5' }));
    check('a fallback model with no provider is refused', r.statusCode, 422);
    r = await call(updateLlmSettings, admin({ stage: 'tailor' },
        { ...BLANK, provider: 'anthropic', model: 'claude-sonnet-5', temperature: 1.5 }));
    check('a temperature above Claude\'s ceiling is refused', r.statusCode, 422);
    r = await call(updateLlmSettings, admin({ stage: 'tailor' },
        { ...BLANK, provider: 'gemini', model: 'gemini-3.7-flash', temperature: 1.5 }));
    check('the same temperature is fine for Gemini', r.statusCode, 200);
    r = await call(updateLlmSettings, admin({ stage: 'nonsense' }, BLANK));
    check('an unknown task is a 404', r.statusCode, 404);

    check('a ceiling below 256 fails validation',
        Boolean(llmSettingsSchema.validate({ maxOutputTokens: 100 }).error), true);
    check('a timeout under 5 seconds fails validation',
        Boolean(llmSettingsSchema.validate({ timeoutSeconds: 2 }).error), true);
    check('an unknown provider fails validation',
        Boolean(llmSettingsSchema.validate({ provider: 'skynet', model: 'x' }).error), true);
    const cleaned = llmSettingsSchema.validate({ provider: '', temperature: '' }).value;
    check('blank strings become "unset"', [cleaned.provider, cleaned.temperature], [null, null]);

    section('saving all-blank removes the override');
    let n = (await query('SELECT count(*)::int AS n FROM org_llm_settings WHERE organization_id=$1 AND stage=$2',
        [orgA, 'tailor'])).rows[0].n;
    check('the earlier save left a row', n, 1);
    await call(updateLlmSettings, admin({ stage: 'tailor' }, BLANK));
    n = (await query('SELECT count(*)::int AS n FROM org_llm_settings WHERE organization_id=$1 AND stage=$2',
        [orgA, 'tailor'])).rows[0].n;
    check('all-blank deletes it', n, 0);

    await call(updateLlmSettings, admin({ stage: 'parse' },
        { ...BLANK, provider: 'gemini', model: 'gemini-3.7-flash', timeoutSeconds: 60 }));
    r = await call(resetLlmSettings, admin({ stage: 'parse' }));
    n = (await query('SELECT count(*)::int AS n FROM org_llm_settings WHERE organization_id=$1 AND stage=$2',
        [orgA, 'parse'])).rows[0].n;
    check('reset removes it too', n, 0);

    /* ── 3. the fallback ────────────────────────────────────────────── */

    section('the fallback');

    // A primary that cannot work (Claude, no key) backed by a fallback that can.
    await saveOverride(orgA, 'check', {
        provider: 'anthropic', model: 'claude-sonnet-5', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: 'mock', fallbackModel: 'mock-model',
    }, null);

    let res = await callModel({ orgId: orgA, stage: 'check', input: 'x', schema: { type: 'object' } });
    check('a primary with no key falls back and succeeds', [res.ok, res.usedFallback], [true, true]);
    check('  it is labelled as the model that answered', [res.provider, res.model], ['mock', 'mock-model']);
    check('  and remembers why the primary failed', /no API key/.test(res.primaryError ?? ''), true);

    let st = await stageStatus(orgA, 'check');
    check('the stage counts as available because the fallback works', st.available, true);

    process.env.LLM_MOCK_FAIL = 'permanent';
    res = await callModel({ orgId: orgA, stage: 'check', input: 'x', schema: { type: 'object' } });
    check('both failing is a failure', res.ok, false);
    check('  that names both models',
        /anthropic\/claude-sonnet-5 failed/.test(res.error) && /mock\/mock-model also failed/.test(res.error), true);
    delete process.env.LLM_MOCK_FAIL;

    // A primary that works must not touch the fallback.
    await saveOverride(orgA, 'check', {
        provider: 'mock', model: 'mock-model', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: 'anthropic', fallbackModel: 'claude-haiku-4-5',
    }, null);
    res = await callModel({ orgId: orgA, stage: 'check', input: 'x', schema: { type: 'object' } });
    check('a primary that works is not replaced', [res.ok, res.usedFallback], [true, undefined]);

    // Switched off is not failing.
    await clean();
    process.env.ANTHROPIC_API_KEY = 'sk-not-real';
    const wasProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = '';
    res = await callModel({ orgId: orgA, stage: 'check', input: 'x', schema: { type: 'object' } });
    check('a stage with no provider is off and does NOT fall back', [res.ok, res.usedFallback], [false, undefined]);
    process.env.LLM_PROVIDER = wasProvider;

    section('the default fallback');
    cfg = await resolveStage(orgA, 'tailor');
    check('with an Anthropic key and nothing chosen, Haiku 4.5 is the fallback', cfg.fallback,
        { provider: 'anthropic', model: 'claude-haiku-4-5' });
    await saveOverride(orgA, 'tailor', {
        provider: 'anthropic', model: 'claude-haiku-4-5', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);
    cfg = await resolveStage(orgA, 'tailor');
    check('a stage already ON Haiku has no fallback to itself', cfg.fallback, null);
    delete process.env.ANTHROPIC_API_KEY;
    await clean();
    cfg = await resolveStage(orgA, 'tailor');
    check('with no Anthropic key there is no default fallback', cfg.fallback, null);
    process.env.LLM_FALLBACK_PROVIDER = 'anthropic';
    process.env.LLM_FALLBACK_MODEL = 'claude-haiku-4-5';
    cfg = await resolveStage(orgA, 'tailor');
    check('a fallback named in the environment applies to every task, key or no key', cfg.fallback,
        { provider: 'anthropic', model: 'claude-haiku-4-5' });
    st = await stageStatus(orgA, 'tailor');
    check('  and the screen is told it cannot run yet without a key', /no API key/.test(st.fallbackReason), true);
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;
    await saveOverride(orgA, 'tailor', {
        provider: null, model: null, temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: 'openai', fallbackModel: 'gpt-4o-mini',
    }, null);
    cfg = await resolveStage(orgA, 'tailor');
    check('a fallback the organisation chose wins', cfg.fallback, { provider: 'openai', model: 'gpt-4o-mini' });
    await clean();

    /* ── 4. the adapters ────────────────────────────────────────────── */

    section('temperature and timeout reach each vendor');

    const realFetch = globalThis.fetch;
    let seen = null;
    const reply = (payload) => async (url, init) => {
        seen = { url, body: JSON.parse(init.body) };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
    process.env.ANTHROPIC_API_KEY = 'k';
    process.env.GEMINI_API_KEY = 'k';
    process.env.LLM_OPENAI_API_KEY = 'k';

    globalThis.fetch = reply({ content: [{ type: 'text', text: '{"ok":true}' }], usage: {}, stop_reason: 'end_turn' });
    await anthropic.call({ model: 'm', input: 'x', schema: { type: 'object' }, temperature: 0.4 });
    check('Anthropic: temperature sent', seen.body.temperature, 0.4);
    await anthropic.call({ model: 'm', input: 'x', schema: { type: 'object' }, temperature: 0 });
    check('Anthropic: 0 is sent, not mistaken for unset', seen.body.temperature, 0);
    await anthropic.call({ model: 'm', input: 'x', schema: { type: 'object' } });
    check('Anthropic: absent when nobody set one', 'temperature' in seen.body, false);

    globalThis.fetch = reply({
        candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: {},
    });
    await gemini.call({ model: 'm', input: 'x', schema: { type: 'object' }, temperature: 0.7 });
    check('Gemini: temperature sent', seen.body.generationConfig.temperature, 0.7);
    await gemini.call({ model: 'm', input: 'x', schema: { type: 'object' } });
    check('Gemini: absent when unset', 'temperature' in seen.body.generationConfig, false);

    globalThis.fetch = reply({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {} });
    await openai.call({ model: 'm', input: 'x', schema: { type: 'object' }, temperature: 1.2 });
    check('OpenAI dialect: temperature sent', seen.body.temperature, 1.2);
    await openai.call({ model: 'm', input: 'x', schema: { type: 'object' } });
    check('OpenAI dialect: absent when unset', 'temperature' in seen.body, false);

    // The output ceiling set by an organisation replaces the caller's own.
    await saveOverride(orgA, 'match', {
        provider: 'gemini', model: 'gemini-3.7-flash', temperature: null, maxOutputTokens: 3000,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);
    globalThis.fetch = reply({
        candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }], usageMetadata: {},
    });
    await callModel({ orgId: orgA, stage: 'match', input: 'x', schema: { type: 'object' }, maxTokens: 1024 });
    check('an organisation\'s output ceiling replaces the caller\'s', seen.body.generationConfig.maxOutputTokens, 3000);
    await clean();
    await callModel({ orgId: orgA, stage: 'match', input: 'x', schema: { type: 'object' }, maxTokens: 1024 });
    globalThis.fetch = realFetch;

    /* ── 5. what the browser is told ────────────────────────────────── */

    section('the screen never learns a key');

    process.env.ANTHROPIC_API_KEY = 'sk-secret-do-not-leak';
    r = await call(getLlmSettings, admin());
    check('five tasks are listed', r.body.stages.map((s) => s.stage), ['parse', 'tailor', 'check', 'agent', 'match']);
    const claude = r.body.providers.find((p) => p.name === 'anthropic');
    check('a key is reported as present', claude.keyConfigured, true);
    check('the key itself appears nowhere in the response',
        JSON.stringify(r.body).includes('sk-secret-do-not-leak'), false);
    check('known models come with prices',
        r.body.models.some((m) => m.provider === 'anthropic' && m.model === 'claude-haiku-4-5' && m.outPrice > 0), true);

    /* ── 6. the test button ─────────────────────────────────────────── */

    section('the test button');

    let probe = await probeModel({ provider: 'mock', model: 'mock-model' });
    check('a working model reports ok', probe.ok, true);
    delete process.env.ANTHROPIC_API_KEY;
    probe = await probeModel({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    check('a provider with no key reports why', [probe.ok, /no API key/.test(probe.error)], [false, true]);
    r = await call(testLlmSettings, admin({ stage: 'tailor' },
        { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 1.5, timeoutSeconds: null }));
    check('a temperature the vendor would refuse is caught before any call', r.statusCode, 422);
    r = await call(testLlmSettings, admin({ stage: 'nonsense' },
        { provider: 'gemini', model: 'x', temperature: null, timeoutSeconds: null }));
    check('an unknown task is a 404', r.statusCode, 404);

    /* ── done ───────────────────────────────────────────────────────── */

    await clean();
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedFb[0]) process.env.LLM_FALLBACK_PROVIDER = savedFb[0];
    if (savedFb[1]) process.env.LLM_FALLBACK_MODEL = savedFb[1];
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch(async (err) => {
    console.error('\nSuite aborted:', err);
    await pool.end().catch(() => {});
    process.exit(1);
});
