-- 057_org_llm_providers.sql
--
-- Per-organisation, per-provider API credentials for the LLM connectors.
--
-- Deliberately separate from org_llm_settings (051): that table says WHICH
-- provider/model runs each AI task; this one says WHAT CREDENTIAL that
-- provider runs on for this organisation. One row per organisation per
-- provider, reused across every task set to that provider — there is no
-- per-task key, matching how a vendor account actually works.
--
-- The key is encrypted at rest (AES-256-GCM, LLM_KEY_ENC_KEY), the same
-- pattern as users.password_enc — see utils/llmKeyCrypto.js. It is never
-- returned to the browser; the settings screen and its API only ever report
-- whether a key is present.
--
-- A row with a base_url but no key is valid: it points a provider at a
-- different endpoint (a self-hosted or compatible gateway) while still
-- running on the platform's own key.

CREATE TABLE IF NOT EXISTS org_llm_providers (
    organization_id  CHAR(36)     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider         VARCHAR(30)  NOT NULL,

    api_key_enc      TEXT         DEFAULT NULL,
    api_key_iv       VARCHAR(32)  DEFAULT NULL,
    api_key_tag      VARCHAR(32)  DEFAULT NULL,
    base_url         VARCHAR(300) DEFAULT NULL,

    updated_by       CHAR(36)     DEFAULT NULL,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, provider),

    CONSTRAINT chk_org_llm_providers_provider
        CHECK (provider IN ('anthropic', 'gemini', 'openai', 'deepseek', 'qwen')),
    CONSTRAINT chk_org_llm_providers_key_parts
        CHECK ((api_key_enc IS NULL) = (api_key_iv IS NULL) AND (api_key_iv IS NULL) = (api_key_tag IS NULL))
);
