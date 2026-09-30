/**
 * ── PER-ORGANISATION PROVIDER CREDENTIALS, AS STORED ──────────────────
 *
 * Reads and writes org_llm_providers and nothing else — it knows nothing
 * about adapters or stages, which is what lets the facade import it without
 * a cycle. Mirrors settings.js (the per-stage override table) in shape.
 *
 * A row is additive, not an override: an organisation with no row for a
 * provider runs on the server's own key for it, exactly as before this
 * table existed. A row with a base_url but no key is valid — it changes only
 * the endpoint, not who pays.
 */
import { query } from '../../db.js';
import { encryptSecret, decryptSecret } from '../../utils/llmKeyCrypto.js';

const shape = (row) => {
    if (!row) return null;
    let apiKey = null;
    if (row.api_key_enc) {
        try {
            apiKey = decryptSecret({ enc: row.api_key_enc, iv: row.api_key_iv, tag: row.api_key_tag });
        } catch (err) {
            // A key that no longer decrypts (rotated LLM_KEY_ENC_KEY, tampered
            // row) must not take the AI call down with it — fall through as
            // "no organisation key", which is exactly the safe state: the call
            // still runs, on whatever the server's own key allows.
            console.error('[llm providers] could not decrypt a stored key:', err.message);
        }
    }
    return { apiKey, baseUrl: row.base_url ?? null };
};

/** One provider's credential for one organisation, or null. Never throws. */
export const getProviderCredential = async (orgId, provider) => {
    if (!orgId || !provider) return null;
    try {
        const { rows } = await query(
            `SELECT base_url, api_key_enc, api_key_iv, api_key_tag
               FROM org_llm_providers WHERE organization_id = $1 AND provider = $2`,
            [orgId, provider],
        );
        return shape(rows[0]);
    } catch (err) {
        console.error('[llm providers] could not read a credential:', err.message);
        return null;
    }
};

/** Every provider an organisation has configured, keyed by provider name. Never leaks a key. */
export const getAllProviderCredentials = async (orgId) => {
    const { rows } = await query(
        `SELECT provider, base_url, (api_key_enc IS NOT NULL) AS key_configured, updated_at
           FROM org_llm_providers WHERE organization_id = $1`,
        [orgId],
    );
    return Object.fromEntries(rows.map((r) => [r.provider, {
        baseUrl: r.base_url,
        keyConfigured: r.key_configured,
        updatedAt: r.updated_at,
    }]));
};

/**
 * Save a provider's credential for an organisation.
 *
 * `apiKey` is write-only and optional on every call after the first: leaving
 * it blank keeps whatever key is already stored and changes only the base
 * URL, the same "leave blank to keep it" pattern a password-change form uses.
 */
export const saveProviderCredential = async (orgId, provider, { apiKey, baseUrl }, userId) => {
    if (apiKey) {
        const { enc, iv, tag } = encryptSecret(apiKey);
        await query(
            `INSERT INTO org_llm_providers
                (organization_id, provider, api_key_enc, api_key_iv, api_key_tag, base_url, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now())
             ON CONFLICT (organization_id, provider) DO UPDATE SET
                 api_key_enc = EXCLUDED.api_key_enc,
                 api_key_iv = EXCLUDED.api_key_iv,
                 api_key_tag = EXCLUDED.api_key_tag,
                 base_url = EXCLUDED.base_url,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = now()`,
            [orgId, provider, enc, iv, tag, baseUrl ?? null, userId],
        );
        return;
    }

    await query(
        `INSERT INTO org_llm_providers (organization_id, provider, base_url, updated_by, updated_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (organization_id, provider) DO UPDATE SET
             base_url = EXCLUDED.base_url,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
        [orgId, provider, baseUrl ?? null, userId],
    );
};

export const deleteProviderCredential = async (orgId, provider) => {
    await query('DELETE FROM org_llm_providers WHERE organization_id = $1 AND provider = $2', [orgId, provider]);
};
