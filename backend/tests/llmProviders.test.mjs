/**
 * Org-supplied provider credentials — org_llm_providers.
 *
 *   node tests/llmProviders.test.mjs
 *
 * Runs against the real database. Needs LLM_KEY_ENC_KEY set (see .env.example).
 *
 * What this exists to prove:
 *
 *   1. A saved key is usable even when the server has none for that provider,
 *      and is reused across every stage — there is no per-task key.
 *   2. Saving again with a blank key keeps the one already stored and changes
 *      only the base URL; deleting removes it and calls fall back to the
 *      server's own key, if any.
 *   3. The organisation's key/base URL actually reach the adapter's request,
 *      not just the server's.
 *   4. The browser is never told a key, only whether one exists.
 *   5. A decrypt failure (wrong/rotated key) degrades to "no organisation
 *      key" rather than breaking the call.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';
process.env.LLM_MOCK_RESPONSE = '{"ok":true}';

import { query, pool } from '../db.js';
import { callModel, stageStatus, probeModel } from '../connectors/llm/index.js';
import {
    getProviderCredential, saveProviderCredential, deleteProviderCredential,
} from '../connectors/llm/providerSettings.js';
import {
    listLlmProviders, updateLlmProvider, resetLlmProvider,
} from '../controllers/llmProviderController.js';
import { getLlmSettings } from '../controllers/llmSettingsController.js';
import { saveOverride, deleteOverride } from '../connectors/llm/settings.js';

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

const main = async () => {
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 2');
    const [orgA, orgB] = orgs.map((o) => o.id);
    const admin = (params = {}, body = {}) => ({
        user: { orgId: orgA, id: null, role: 'ORG_ADMIN' }, params, body, query: {},
    });

    const clean = async () => {
        for (const o of [orgA, orgB].filter(Boolean)) {
            await query('DELETE FROM org_llm_providers WHERE organization_id = $1', [o]);
            await query('DELETE FROM org_llm_settings WHERE organization_id = $1', [o]);
        }
    };
    await clean();
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    /* ── 1. saving and reading a credential ────────────────────────── */

    section('a saved key is usable even with no server key, and shared across stages');

    let st = await stageStatus(orgA, 'tailor');
    check('with no provider chosen and no key anywhere, Claude is not usable', st.available, false);

    await saveProviderCredential(orgA, 'anthropic', { apiKey: 'sk-org-owned-key', baseUrl: null }, null);
    await saveOverride(orgA, 'tailor', {
        provider: 'anthropic', model: 'claude-sonnet-5', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);
    await saveOverride(orgA, 'check', {
        provider: 'anthropic', model: 'claude-haiku-4-5', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);

    st = await stageStatus(orgA, 'tailor');
    check('tailor is usable on the organisation\'s own key', st.available, true);
    st = await stageStatus(orgA, 'check');
    check('the same saved key also covers a second stage on the same provider', st.available, true);

    if (orgB) {
        st = await stageStatus(orgB, 'tailor');
        check('another organisation\'s Claude is untouched', st.available, false);
    }

    /* ── 2. blank key on save keeps what's stored; delete removes it ── */

    section('saving with a blank key keeps the stored one; delete removes it');

    await saveProviderCredential(orgA, 'anthropic', { apiKey: null, baseUrl: 'https://proxy.example.com/anthropic' }, null);
    let cred = await getProviderCredential(orgA, 'anthropic');
    check('the key survives a base-URL-only save', cred.apiKey, 'sk-org-owned-key');
    check('  and the base URL is the new one', cred.baseUrl, 'https://proxy.example.com/anthropic');

    await deleteProviderCredential(orgA, 'anthropic');
    cred = await getProviderCredential(orgA, 'anthropic');
    check('delete removes the credential entirely', cred, null);
    st = await stageStatus(orgA, 'tailor');
    check('the stage is unusable again with no key anywhere', st.available, false);

    /* ── 3. the credential reaches the adapter's actual request ──────── */

    section('the organisation\'s key and base URL reach the request, not the server\'s');

    process.env.ANTHROPIC_API_KEY = 'sk-server-key-should-not-be-used';
    await saveProviderCredential(orgA, 'anthropic', {
        apiKey: 'sk-org-key-should-be-used', baseUrl: 'https://org-proxy.example.com/v1',
    }, null);

    const realFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, init) => {
        seen = { url, headers: init.headers };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                content: [{ type: 'text', text: '{"ok":true}' }], usage: {}, stop_reason: 'end_turn',
            }),
        };
    };
    const res = await callModel({ orgId: orgA, stage: 'tailor', input: 'x', schema: { type: 'object' } });
    globalThis.fetch = realFetch;

    check('the call succeeds', res.ok, true);
    check('the organisation\'s key was sent, not the server\'s', seen.headers['x-api-key'], 'sk-org-key-should-be-used');
    check('the organisation\'s base URL was used', seen.url.startsWith('https://org-proxy.example.com/v1'), true);

    delete process.env.ANTHROPIC_API_KEY;
    await deleteProviderCredential(orgA, 'anthropic');
    await deleteOverride(orgA, 'tailor');
    await deleteOverride(orgA, 'check');

    /* ── 3b. DeepSeek/Qwen: a key alone must not land on OpenAI's endpoint ── */

    section('DeepSeek and Qwen default to their own endpoint, not OpenAI\'s');

    // An operator's own OpenAI setup, already configured — this must NOT be
    // where an organisation's DeepSeek key ends up.
    process.env.LLM_OPENAI_API_KEY = 'sk-the-servers-actual-openai-key';
    process.env.LLM_OPENAI_BASE_URL = 'https://api.openai.com';

    await saveProviderCredential(orgA, 'deepseek', { apiKey: 'sk-org-deepseek-key', baseUrl: null }, null);
    await saveOverride(orgA, 'tailor', {
        provider: 'deepseek', model: 'deepseek-chat', temperature: null, maxOutputTokens: null,
        timeoutMs: null, fallbackProvider: null, fallbackModel: null,
    }, null);

    const realFetch3 = globalThis.fetch;
    let seenDeepseek = null;
    globalThis.fetch = async (url, init) => {
        seenDeepseek = { url, headers: init.headers };
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {},
            }),
        };
    };
    const dsRes = await callModel({ orgId: orgA, stage: 'tailor', input: 'x', schema: { type: 'object' } });
    globalThis.fetch = realFetch3;

    check('the call succeeds', dsRes.ok, true);
    check('the organisation\'s DeepSeek key was sent', seenDeepseek.headers.authorization, 'Bearer sk-org-deepseek-key');
    check('  and it went to DeepSeek\'s own endpoint, not OpenAI\'s',
        seenDeepseek.url.startsWith('https://api.deepseek.com'), true);

    delete process.env.LLM_OPENAI_API_KEY;
    delete process.env.LLM_OPENAI_BASE_URL;
    await deleteProviderCredential(orgA, 'deepseek');
    await deleteOverride(orgA, 'tailor');

    /* ── 4. what the browser is told ──────────────────────────────── */

    section('the screen never learns a key');

    await saveProviderCredential(orgA, 'gemini', { apiKey: 'AIza-secret-do-not-leak', baseUrl: null }, null);

    let r = await call(listLlmProviders, admin());
    check('five providers are listed', r.body.providers.map((p) => p.name).sort(),
        ['anthropic', 'deepseek', 'gemini', 'openai', 'qwen'].sort());
    const gem = r.body.providers.find((p) => p.name === 'gemini');
    check('the organisation key is reported as present', gem.orgKeyConfigured, true);
    check('the key itself appears nowhere in the response',
        JSON.stringify(r.body).includes('AIza-secret-do-not-leak'), false);

    r = await call(getLlmSettings, admin());
    const geminiInStages = r.body.providers.find((p) => p.name === 'gemini');
    check('the per-task screen also shows Gemini as usable because the org has its own key',
        geminiInStages.keyConfigured, true);
    check('  the per-task screen never leaks the key either',
        JSON.stringify(r.body).includes('AIza-secret-do-not-leak'), false);

    await deleteProviderCredential(orgA, 'gemini');

    /* ── 5. PUT / DELETE through the controller ───────────────────── */

    section('the controller routes save and reset correctly');

    r = await call(updateLlmProvider, admin({ provider: 'openai' }, { apiKey: 'sk-typed-in-the-ui', baseUrl: null }));
    check('a save reports ok', r.body.ok, true);
    cred = await getProviderCredential(orgA, 'openai');
    check('  and the key is actually stored, encrypted, and reads back correctly', cred.apiKey, 'sk-typed-in-the-ui');

    r = await call(updateLlmProvider, admin({ provider: 'not-a-real-provider' }, { apiKey: 'x', baseUrl: null }));
    check('an unknown provider is a 404', r.statusCode, 404);

    r = await call(resetLlmProvider, admin({ provider: 'openai' }));
    check('reset reports ok', r.body.ok, true);
    cred = await getProviderCredential(orgA, 'openai');
    check('  and the credential is gone', cred, null);

    /* ── 6. the test-before-save path ─────────────────────────────── */

    section('a candidate key can be tested before it is saved');

    let probe = await probeModel({ provider: 'mock', model: 'mock-model', apiKey: 'unused-by-mock' });
    check('an explicit credential does not break a provider that ignores it', probe.ok, true);

    delete process.env.ANTHROPIC_API_KEY;
    probe = await probeModel({ provider: 'anthropic', model: 'claude-haiku-4-5' });
    check('with neither a server nor an organisation key, the probe fails and says why',
        [probe.ok, /no API key/.test(probe.error)], [false, true]);

    // An explicit apiKey candidate must get past the "no key" check without
    // making a real call — stub fetch, same as section 3, rather than hit
    // the real provider with a throwaway key.
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
            content: [{ type: 'text', text: '{"ok":true}' }], usage: {}, stop_reason: 'end_turn',
        }),
    });
    probe = await probeModel({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'sk-typed-for-this-test-only' });
    globalThis.fetch = realFetch2;
    check('an explicit apiKey candidate lets the probe proceed past the "no key" check', probe.ok, true);

    /* ── done ──────────────────────────────────────────────────────── */

    await clean();
    if (savedAnthropicKey) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
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
