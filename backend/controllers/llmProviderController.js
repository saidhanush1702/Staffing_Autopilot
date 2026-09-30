/**
 * ── THE PROVIDER CREDENTIALS SCREEN ────────────────────────────────────
 *
 * Lets an ORG_ADMIN supply their own API key and base URL for a provider —
 * Anthropic, Gemini, OpenAI, DeepSeek or Qwen — instead of running on the
 * platform's server-side key.
 *
 * ── HOW THIS RELATES TO llmSettingsController.js ──────────────────────
 *
 * That screen says WHICH provider/model runs each AI task. This one says
 * WHAT CREDENTIAL that provider runs on for this organisation. One key per
 * provider, reused by every task set to it — there is no per-task key,
 * because that is not how a vendor account works.
 *
 * ── THE KEY IS WRITE-ONLY ──────────────────────────────────────────────
 *
 * Once saved, a key is never read back to the browser in any form — GET only
 * reports `orgKeyConfigured: boolean`. Leaving the field blank on a later save
 * keeps the key that is already stored and changes only the base URL, the
 * same pattern a password-change form uses.
 */
import Joi from 'joi';
import { PROVIDER_INFO, PROVIDER_DEFAULT_BASE_URL } from '../config/llmModels.js';
import { adapterFor, probeModel } from '../connectors/llm/index.js';
import {
    getAllProviderCredentials, saveProviderCredential, deleteProviderCredential,
} from '../connectors/llm/providerSettings.js';

const PROVIDERS = Object.keys(PROVIDER_INFO);

const nullable = (schema) => schema.allow(null, '').empty('').default(null);

export const llmProviderCredentialSchema = Joi.object({
    apiKey: nullable(Joi.string().trim().min(8).max(500)),
    baseUrl: nullable(Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(300)),
});

export const llmProviderTestSchema = Joi.object({
    apiKey: Joi.string().trim().min(8).max(500).required(),
    baseUrl: nullable(Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(300)),
    model: Joi.string().trim().min(1).max(100).required(),
});

const badProvider = (res) => res.status(404).json({ error: 'Unknown provider.' });

/* ── GET ───────────────────────────────────────────────────────────── */

export const listLlmProviders = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const saved = await getAllProviderCredentials(orgId);

        const providers = PROVIDERS.map((name) => {
            const org = saved[name] ?? null;
            return {
                name,
                label: PROVIDER_INFO[name].label,
                serverKeyConfigured: Boolean(adapterFor(name)?.isConfigured()),
                orgKeyConfigured: Boolean(org?.keyConfigured),
                baseUrl: org?.baseUrl ?? null,
                // Shown as the field's placeholder so an administrator can see,
                // for DeepSeek/Qwen, exactly where a blank base URL actually
                // goes — null for a provider with no dialect ambiguity.
                defaultBaseUrl: PROVIDER_DEFAULT_BASE_URL[name] ?? null,
                updatedAt: org?.updatedAt ?? null,
            };
        });

        return res.json({ providers });
    } catch (err) {
        return next(err);
    }
};

/* ── PUT ───────────────────────────────────────────────────────────── */

export const updateLlmProvider = async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS.includes(provider)) return badProvider(res);

        const { apiKey, baseUrl } = req.body;
        await saveProviderCredential(req.user.orgId, provider, { apiKey, baseUrl }, req.user.id);
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/* ── DELETE ────────────────────────────────────────────────────────── */

export const resetLlmProvider = async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS.includes(provider)) return badProvider(res);

        await deleteProviderCredential(req.user.orgId, provider);
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/* ── POST /test ────────────────────────────────────────────────────── */

/**
 * Try a key before saving it. Takes the candidate key/base URL/model exactly
 * as typed rather than reading anything stored, so an administrator can catch
 * a bad key or a wrong endpoint before it ever reaches the database.
 */
export const testLlmProvider = async (req, res, next) => {
    try {
        const { provider } = req.params;
        if (!PROVIDERS.includes(provider)) return badProvider(res);

        const { apiKey, baseUrl, model } = req.body;
        const result = await probeModel({ provider, model, apiKey, baseUrl });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
};
