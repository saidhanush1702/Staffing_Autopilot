-- 051_org_llm_settings.sql
--
-- Per-organisation overrides for each AI task (stage).
--
-- A row is an OVERRIDE, not a full configuration: every column except the key is
-- nullable, and NULL means "use the server default" (the LLM_* environment
-- variables, as before). An organisation with no rows behaves exactly as it did
-- before this table existed.
--
-- provider and model are set together or not at all, and so are the two fallback
-- columns — a model id only means something under the provider it belongs to,
-- so half a pair would silently point one vendor at another vendor's model.
--
-- API keys are deliberately NOT stored here. They stay in the server environment.

CREATE TABLE IF NOT EXISTS org_llm_settings (
    organization_id   CHAR(36)     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stage             VARCHAR(20)  NOT NULL,

    provider          VARCHAR(30)  DEFAULT NULL,
    model             VARCHAR(100) DEFAULT NULL,
    temperature       NUMERIC(3,2) DEFAULT NULL,
    max_output_tokens INT          DEFAULT NULL,
    timeout_ms        INT          DEFAULT NULL,

    fallback_provider VARCHAR(30)  DEFAULT NULL,
    fallback_model    VARCHAR(100) DEFAULT NULL,

    updated_by        CHAR(36)     DEFAULT NULL,
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, stage),

    CONSTRAINT chk_org_llm_stage
        CHECK (stage IN ('parse', 'tailor', 'check', 'agent', 'match')),
    CONSTRAINT chk_org_llm_primary_pair
        CHECK ((provider IS NULL) = (model IS NULL)),
    CONSTRAINT chk_org_llm_fallback_pair
        CHECK ((fallback_provider IS NULL) = (fallback_model IS NULL)),
    CONSTRAINT chk_org_llm_temperature
        CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2)),
    CONSTRAINT chk_org_llm_max_tokens
        CHECK (max_output_tokens IS NULL OR (max_output_tokens BETWEEN 256 AND 64000)),
    CONSTRAINT chk_org_llm_timeout
        CHECK (timeout_ms IS NULL OR (timeout_ms BETWEEN 5000 AND 600000))
);
