/**
 * ── THE AI MODELS SCREEN ──────────────────────────────────────────────
 *
 * Lets an ORG_ADMIN choose, for each of the five AI tasks, which model runs it
 * and how: temperature, output ceiling, timeout and a fallback model.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────
 *
 * API keys. This screen only learns whether one is present — for the server's
 * own key (the environment) and, now, for an organisation's own key (see
 * controllers/llmProviderController.js, the companion screen where an
 * organisation may supply its own key and base URL per provider). Neither
 * path ever returns a key to the browser once saved.
 *
 * ── HOW A SETTING TAKES EFFECT ────────────────────────────────────────
 *
 * Every field is an override: blank means "use the server default". Saving all
 * blanks removes the row, so an organisation can always get back to exactly what
 * the environment says. The next AI call picks the change up — there is no cache
 * to wait out and nothing to restart.
 */
import Joi from 'joi';
import {
    STAGES, STAGE_INFO, PROVIDER_INFO, knownModels, stageConfig, envFallback,
} from '../config/llmModels.js';
import {
    adapterFor, resolveStage, stageStatus, probeModel,
} from '../connectors/llm/index.js';
import {
    getAllOverrides, saveOverride, deleteOverride,
} from '../connectors/llm/settings.js';
import { getAllProviderCredentials } from '../connectors/llm/providerSettings.js';

const PROVIDERS = Object.keys(PROVIDER_INFO);

const nullable = (schema) => schema.allow(null, '').empty('').default(null);

export const llmSettingsSchema = Joi.object({
    provider: nullable(Joi.string().valid(...PROVIDERS)),
    model: nullable(Joi.string().trim().max(100)),
    temperature: nullable(Joi.number().min(0).max(2).precision(2)),
    maxOutputTokens: nullable(Joi.number().integer().min(256).max(64000)),
    timeoutSeconds: nullable(Joi.number().integer().min(5).max(600)),
    fallbackProvider: nullable(Joi.string().valid(...PROVIDERS)),
    fallbackModel: nullable(Joi.string().trim().max(100)),
});

export const llmTestSchema = Joi.object({
    provider: Joi.string().valid(...PROVIDERS).required(),
    model: Joi.string().trim().min(1).max(100).required(),
    temperature: nullable(Joi.number().min(0).max(2).precision(2)),
    timeoutSeconds: nullable(Joi.number().integer().min(5).max(600)),
});

const badStage = (res) => res.status(404).json({ error: 'Unknown AI task.' });

/** Is a key present for this provider, on the server? The only thing the browser is told about server keys. */
const keyPresent = (provider) => Boolean(adapterFor(provider)?.isConfigured());

/**
 * A provider is usable for a task if EITHER the server or this organisation
 * has a key for it — see controllers/llmProviderController.js for where an
 * organisation's own key is set. `keyConfigured` here answers "can a task be
 * pointed at this provider at all", not "whose key will it use".
 */
const providerList = async (orgId) => {
    const org = await getAllProviderCredentials(orgId);
    return PROVIDERS.map((name) => ({
        name,
        label: PROVIDER_INFO[name].label,
        keyEnv: PROVIDER_INFO[name].keyEnv,
        keyConfigured: keyPresent(name) || Boolean(org[name]?.keyConfigured),
        orgKeyConfigured: Boolean(org[name]?.keyConfigured),
        maxTemperature: PROVIDER_INFO[name].maxTemperature,
    }));
};

/* ── GET ───────────────────────────────────────────────────────────── */

export const getLlmSettings = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;
        const overrides = await getAllOverrides(orgId);

        const stages = [];
        for (const stage of STAGES) {
            const env = stageConfig(stage);
            const status = await stageStatus(orgId, stage);
            const eff = status.config;
            const o = overrides[stage] ?? null;

            stages.push({
                stage,
                ...STAGE_INFO[stage],
                // What the server would use with no override.
                defaults: {
                    provider: env.provider || null,
                    model: env.model || null,
                    fallback: envFallback(stage, env),
                },
                // What this organisation has chosen; null per field = inherited.
                override: o && {
                    provider: o.provider,
                    model: o.model,
                    temperature: o.temperature,
                    maxOutputTokens: o.maxOutputTokens,
                    timeoutSeconds: o.timeoutMs ? Math.round(o.timeoutMs / 1000) : null,
                    fallbackProvider: o.fallbackProvider,
                    fallbackModel: o.fallbackModel,
                },
                // What will actually run.
                effective: {
                    provider: eff.provider || null,
                    model: eff.model || null,
                    fallback: eff.fallback,
                },
                status: {
                    available: status.available,
                    reason: status.reason,
                    fallbackReason: status.fallbackReason,
                },
            });
        }

        return res.json({ stages, providers: await providerList(orgId), models: knownModels() });
    } catch (err) {
        return next(err);
    }
};

/* ── PUT ───────────────────────────────────────────────────────────── */

export const updateLlmSettings = async (req, res, next) => {
    try {
        const { stage } = req.params;
        if (!STAGES.includes(stage)) return badStage(res);

        const b = req.body;
        const provider = b.provider ? b.provider.toLowerCase() : null;
        const model = b.model || null;
        const fallbackProvider = b.fallbackProvider ? b.fallbackProvider.toLowerCase() : null;
        const fallbackModel = b.fallbackModel || null;

        // A model id only means something under its own provider, so the pair is
        // all-or-nothing. Half a pair would send one vendor another vendor's model.
        if (Boolean(provider) !== Boolean(model)) {
            return res.status(422).json({
                error: 'Choose a provider and a model together, or leave both on the default.',
            });
        }
        if (Boolean(fallbackProvider) !== Boolean(fallbackModel)) {
            return res.status(422).json({
                error: 'Choose a fallback provider and a fallback model together, or leave both blank.',
            });
        }

        // Scales differ by vendor (Claude stops at 1, the others at 2), and the
        // provider that will run may be the inherited one.
        const runsOn = provider ?? (await resolveStage(req.user.orgId, stage)).provider;
        const ceiling = PROVIDER_INFO[runsOn]?.maxTemperature ?? 2;
        if (b.temperature !== null && b.temperature > ceiling) {
            return res.status(422).json({
                error: `${PROVIDER_INFO[runsOn]?.label ?? runsOn} accepts a temperature of at most ${ceiling}.`,
            });
        }

        const values = {
            provider,
            model,
            temperature: b.temperature,
            maxOutputTokens: b.maxOutputTokens,
            timeoutMs: b.timeoutSeconds === null ? null : b.timeoutSeconds * 1000,
            fallbackProvider,
            fallbackModel,
        };

        // Everything blank IS "no override" — remove the row rather than store a
        // row that says nothing.
        if (Object.values(values).every((v) => v === null)) {
            await deleteOverride(req.user.orgId, stage);
        } else {
            await saveOverride(req.user.orgId, stage, values, req.user.id);
        }

        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/* ── DELETE ────────────────────────────────────────────────────────── */

export const resetLlmSettings = async (req, res, next) => {
    try {
        if (!STAGES.includes(req.params.stage)) return badStage(res);
        await deleteOverride(req.user.orgId, req.params.stage);
        return res.json({ ok: true });
    } catch (err) {
        return next(err);
    }
};

/* ── POST /test ────────────────────────────────────────────────────── */

/**
 * Try a candidate before saving it: one small real call, reported plainly.
 *
 * A wrong model id, a key the provider rejects and a temperature the model
 * refuses all surface here as the provider's own message, which is exactly what
 * an administrator needs and cannot get any other way without breaking live work.
 */
export const testLlmSettings = async (req, res, next) => {
    try {
        if (!STAGES.includes(req.params.stage)) return badStage(res);

        const { provider, model, temperature, timeoutSeconds } = req.body;

        const ceiling = PROVIDER_INFO[provider]?.maxTemperature ?? 2;
        if (temperature !== null && temperature > ceiling) {
            return res.status(422).json({
                error: `${PROVIDER_INFO[provider].label} accepts a temperature of at most ${ceiling}.`,
            });
        }

        const result = await probeModel({
            provider,
            model,
            temperature,
            timeoutMs: timeoutSeconds === null ? null : timeoutSeconds * 1000,
            orgId: req.user.orgId,
        });
        return res.json(result);
    } catch (err) {
        return next(err);
    }
};
