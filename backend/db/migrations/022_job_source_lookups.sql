-- 022_job_source_lookups.sql
-- Purpose: lookups for job discovery.
-- Phase: 5
--
-- lkp_job_sources carries CONFIGURATION, not just a label. Enabling a board,
-- changing how politely it is fetched, or turning one off after a failure is a
-- row update — never a code change and never a redeploy. That matters because
-- the thing most likely to need changing at 2am is "stop hitting that board".

CREATE TABLE IF NOT EXISTS lkp_job_sources (
    id              INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(40)  NOT NULL UNIQUE,
    label           VARCHAR(80)  NOT NULL,

    -- HTTP  fetched over the web
    -- MANUAL a person pasted it in
    -- CSV    bulk import
    fetch_mode      VARCHAR(10)  NOT NULL DEFAULT 'HTTP'
                    CHECK (fetch_mode IN ('HTTP', 'MANUAL', 'CSV')),

    base_url        VARCHAR(255) DEFAULT NULL,

    -- The search URL template. {q} and {l} are substituted per query.
    search_template VARCHAR(500) DEFAULT NULL,

    -- Off by default. A board is only ever fetched because somebody turned it
    -- on deliberately.
    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,

    -- Politeness, per board rather than global — boards differ enormously in
    -- what they tolerate.
    rate_limit_ms   INT NOT NULL DEFAULT 5000 CHECK (rate_limit_ms >= 1000),
    max_pages       INT NOT NULL DEFAULT 2    CHECK (max_pages BETWEEN 1 AND 20),
    respect_robots  BOOLEAN NOT NULL DEFAULT TRUE,

    -- Rolling health, written by the orchestrator so a degrading board is
    -- visible before it is silently contributing nothing.
    last_success_at TIMESTAMPTZ DEFAULT NULL,
    last_error      VARCHAR(500) DEFAULT NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,

    notes           VARCHAR(500) DEFAULT NULL
);

-- Which application system the job lives on. LinkedIn is separated because
-- R-22 gives it the most conservative treatment downstream.
CREATE TABLE IF NOT EXISTS lkp_portal_types (
    id    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR(40) NOT NULL UNIQUE,
    label VARCHAR(80) NOT NULL
);

-- The queue state machine's vocabulary. Transitions themselves are declared in
-- config/queueStates.js — this table exists so no screen types a status by hand.
CREATE TABLE IF NOT EXISTS lkp_queue_statuses (
    id       INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     VARCHAR(30) NOT NULL UNIQUE,
    label    VARCHAR(80) NOT NULL,
    -- TRUE for states that need no further action from anyone.
    is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INT NOT NULL DEFAULT 0
);
