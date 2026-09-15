-- 048_agent_fallback.sql
-- Purpose: the AI agent that fills an application when a coded recipe breaks,
--          or when no recipe exists for the site at all.
-- Phase: 8
--
-- ── A THIRD LANE, NOT A FLAG ON THE SECOND ────────────────────────────
--
-- A job whose portal has no recipe used to go straight to HUMAN, and the
-- desktop app only ever asks for BOT. So "no automation exists" jobs never
-- reached the machine that could now fill them. AGENT is the lane for exactly
-- those: the desktop takes them, the agent tries, and anything it cannot finish
-- goes to HUMAN through the same reclassify path a recipe failure already uses.
--
-- ── OFF, SHADOW, ON ───────────────────────────────────────────────────
--
-- SHADOW exists because an agent should be watched deciding before it is
-- allowed to type. In shadow the desktop observes the page and asks the model
-- what it WOULD do, records that, and hands the job over exactly as before.
-- The steps table is then a week of evidence rather than a leap of faith.
--
-- ── WHY STEPS ARE THEIR OWN LEDGER ────────────────────────────────────
--
-- The monthly AI budget is enforced against spend, and until now all spend was
-- resume_tailoring_runs. An agent run is many calls with no resume attached, so
-- it gets its own table and spendThisPeriod sums both. cost_usd stays nullable
-- for the same reason as tailoring: an unknown price must read as unknown, not
-- as free, or the ceiling never fires.

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS chk_queue_channel;
ALTER TABLE queue_items
    ADD CONSTRAINT chk_queue_channel CHECK (channel IN ('BOT', 'AGENT', 'HUMAN'));

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS agent_mode            VARCHAR(10)  NOT NULL DEFAULT 'OFF',
    -- A hard stop per job. One badly-behaved site must not be able to spend a
    -- month's budget in an afternoon.
    ADD COLUMN IF NOT EXISTS agent_job_cap_usd     NUMERIC(8,4) NOT NULL DEFAULT 0.50,
    ADD COLUMN IF NOT EXISTS agent_max_model_calls INT          NOT NULL DEFAULT 25;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS chk_org_agent_settings;
ALTER TABLE organizations
    ADD CONSTRAINT chk_org_agent_settings CHECK (
        agent_mode IN ('OFF', 'SHADOW', 'ON')
        AND agent_job_cap_usd >= 0 AND agent_job_cap_usd <= 10
        AND agent_max_model_calls BETWEEN 1 AND 100
    );

CREATE TABLE IF NOT EXISTS agent_runs (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    queue_item_id   CHAR(36) NOT NULL
                    REFERENCES queue_items(id) ON DELETE CASCADE,
    device_id       CHAR(36) DEFAULT NULL
                    REFERENCES devices(id) ON DELETE SET NULL,

    -- RECIPE_FAILED  a coded recipe ran and could not finish
    -- NO_RECIPE      nothing coded exists for this site
    entry           VARCHAR(20) NOT NULL
                    CHECK (entry IN ('RECIPE_FAILED', 'NO_RECIPE')),
    -- Why the recipe gave up, in its own words. What turns "the agent is busy
    -- on Greenhouse" into "the next recipe worth writing is Greenhouse".
    trigger_detail  VARCHAR(500) DEFAULT NULL,
    host            VARCHAR(255) DEFAULT NULL,
    shadow          BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_version  VARCHAR(40)  DEFAULT NULL,

    outcome         VARCHAR(30)  DEFAULT NULL,
    detail          VARCHAR(500) DEFAULT NULL,
    actions         INT NOT NULL DEFAULT 0,
    refused_actions INT NOT NULL DEFAULT 0,
    model_calls     INT NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
    unpriced_calls  INT NOT NULL DEFAULT 0,

    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_org_time
    ON agent_runs (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_item
    ON agent_runs (queue_item_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_host
    ON agent_runs (organization_id, host);

CREATE TABLE IF NOT EXISTS agent_steps (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    run_id          CHAR(36) NOT NULL
                    REFERENCES agent_runs(id) ON DELETE CASCADE,
    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    n               INT NOT NULL,

    -- The action as validated, with answer aliases already mapped back to real
    -- question ids. NULL when the model's reply was unusable.
    action          JSONB DEFAULT NULL,
    -- Why the HUB refused the reply. The desktop's own refusals arrive on the
    -- next step as `last_result`, which is kept too.
    refused         VARCHAR(500) DEFAULT NULL,
    last_result     VARCHAR(500) DEFAULT NULL,
    page_url        VARCHAR(1000) DEFAULT NULL,

    provider        VARCHAR(40)  DEFAULT NULL,
    model           VARCHAR(120) DEFAULT NULL,
    input_tokens       INT DEFAULT NULL,
    output_tokens      INT DEFAULT NULL,
    cache_read_tokens  INT DEFAULT NULL,
    cache_write_tokens INT DEFAULT NULL,
    cost_usd        NUMERIC(12,6) DEFAULT NULL,
    duration_ms     INT DEFAULT NULL,
    error           VARCHAR(2000) DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The budget query reads steps by organisation and time, exactly like the
-- tailoring ledger.
CREATE INDEX IF NOT EXISTS idx_agent_steps_org_time
    ON agent_steps (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_steps_run
    ON agent_steps (run_id, n);

COMMENT ON COLUMN organizations.agent_mode IS
    'OFF: no agent. SHADOW: the agent decides but never acts, and the job is '
    'handed over as before. ON: the agent fills forms recipes cannot.';
