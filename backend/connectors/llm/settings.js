/**
 * ── PER-ORGANISATION AI SETTINGS, AS STORED ───────────────────────────
 *
 * Reads and writes the org_llm_settings overrides and nothing else. It knows
 * nothing about adapters or prices, which is what lets the facade import it
 * without a cycle.
 *
 * A row is an OVERRIDE: any NULL column means "use the server default", so an
 * organisation with no row is configured exactly as it was before this existed.
 */
import { query } from '../../db.js';

const FIELDS = `provider, model, temperature::float8 AS temperature,
                max_output_tokens, timeout_ms, fallback_provider, fallback_model`;

const shape = (row) => (row ? {
    provider: row.provider,
    model: row.model,
    temperature: row.temperature,
    maxOutputTokens: row.max_output_tokens,
    timeoutMs: row.timeout_ms,
    fallbackProvider: row.fallback_provider,
    fallbackModel: row.fallback_model,
} : null);

/** One stage's override for one organisation, or null. Never throws. */
export const getOverride = async (orgId, stage) => {
    if (!orgId) return null;
    try {
        const { rows } = await query(
            `SELECT ${FIELDS} FROM org_llm_settings WHERE organization_id = $1 AND stage = $2`,
            [orgId, stage],
        );
        return shape(rows[0]);
    } catch (err) {
        // A settings lookup that fails must not take the AI call down with it:
        // the call carries on with the server defaults, which is what it did
        // before overrides existed.
        console.error('[llm settings] could not read overrides:', err.message);
        return null;
    }
};

/** Every override an organisation has, keyed by stage. */
export const getAllOverrides = async (orgId) => {
    const { rows } = await query(
        `SELECT stage, ${FIELDS} FROM org_llm_settings WHERE organization_id = $1`,
        [orgId],
    );
    return Object.fromEntries(rows.map((r) => [r.stage, shape(r)]));
};

export const saveOverride = async (orgId, stage, v, userId) => {
    await query(
        `INSERT INTO org_llm_settings
            (organization_id, stage, provider, model, temperature, max_output_tokens,
             timeout_ms, fallback_provider, fallback_model, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (organization_id, stage) DO UPDATE SET
             provider = EXCLUDED.provider,
             model = EXCLUDED.model,
             temperature = EXCLUDED.temperature,
             max_output_tokens = EXCLUDED.max_output_tokens,
             timeout_ms = EXCLUDED.timeout_ms,
             fallback_provider = EXCLUDED.fallback_provider,
             fallback_model = EXCLUDED.fallback_model,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
        [orgId, stage, v.provider, v.model, v.temperature, v.maxOutputTokens,
            v.timeoutMs, v.fallbackProvider, v.fallbackModel, userId],
    );
};

export const deleteOverride = async (orgId, stage) => {
    await query('DELETE FROM org_llm_settings WHERE organization_id = $1 AND stage = $2', [orgId, stage]);
};
