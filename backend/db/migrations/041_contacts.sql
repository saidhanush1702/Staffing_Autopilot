-- 041_contacts.sql
-- Purpose: the hiring contact behind a job, found once and reused.
-- Phase: 7
--
-- ── WHEN THIS RUNS, AND WHY IT IS NOT WHEN YOU WOULD EXPECT ──────────────
--
-- Contact discovery fires AFTER an application is submitted, not after a job is
-- matched.
--
-- Matching is unbounded — the daily cap was removed, so every posting that
-- suits a consultant becomes a queue item, and a busy bench produces hundreds a
-- day. A paid lookup per match is a bill that scales with how well the matcher
-- works, which is exactly the wrong incentive.
--
-- Submissions are bounded by how many applications a person actually makes. And
-- the contact is wanted for FOLLOW-UP: the recruiter emails the hiring contact
-- after the application is in, not before it exists. So the later trigger is
-- both cheaper and closer to what the contact is for.
--
-- A recruiter who wants a contact before applying can still buy one for a
-- single job, on demand, through the manual endpoint.
--
-- ── WHY CONTACTS ARE A LINK TABLE ────────────────────────────────────────
--
-- application_records is append-only and enforced by a trigger, so a contact
-- discovered after submission could never be written onto it as a column. That
-- constraint pushes toward the right design anyway: one person contacted about
-- five jobs is ONE record linked five times, not five paid lookups and five
-- half-agreeing copies of the same human being.

/* ── the people ──────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS contacts (
    id              CHAR(36) PRIMARY KEY,
    lookup_id       INT GENERATED ALWAYS AS IDENTITY UNIQUE,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,

    full_name       VARCHAR(255) NOT NULL CHECK (length(btrim(full_name)) > 0),
    first_name      VARCHAR(120) DEFAULT NULL,
    last_name       VARCHAR(120) DEFAULT NULL,
    title           VARCHAR(255) DEFAULT NULL,
    -- Ranks the fallback results. When no poster is named we take the two most
    -- senior talent-acquisition people at the company, and "most senior" has to
    -- be a stored judgement rather than one recomputed differently each time.
    seniority       VARCHAR(60)  DEFAULT NULL,

    company         VARCHAR(255) NOT NULL,
    company_domain  VARCHAR(255) DEFAULT NULL,
    location        VARCHAR(255) DEFAULT NULL,
    linkedin_url    VARCHAR(500) DEFAULT NULL,

    -- Email and phone carry their own source and date because they frequently
    -- come from DIFFERENT providers on different days. One `pulled_at` for the
    -- whole row would make a fresh phone look like a fresh email.
    email           VARCHAR(320) DEFAULT NULL,
    email_status    VARCHAR(40)  DEFAULT NULL,   -- verified / guessed / unavailable
    email_source    VARCHAR(40)  DEFAULT NULL,
    email_pulled_at TIMESTAMPTZ  DEFAULT NULL,

    phone           VARCHAR(60)  DEFAULT NULL,
    phone_source    VARCHAR(40)  DEFAULT NULL,
    phone_pulled_at TIMESTAMPTZ  DEFAULT NULL,

    provider           VARCHAR(40)  DEFAULT NULL,
    provider_person_id VARCHAR(120) DEFAULT NULL,

    -- ── the flag that outranks everything else ────────────────────────
    --
    -- Set once by a recruiter when somebody asks not to be contacted, and after
    -- that the waterfall never attaches this person to another job. It is
    -- deliberately a property of the PERSON, not of a job or a campaign: "stop
    -- contacting me" is not a per-posting preference, and honouring it only in
    -- the place it was said would be honouring it in name.
    do_not_contact  BOOLEAN NOT NULL DEFAULT FALSE,
    dnc_by          CHAR(36) DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
    dnc_at          TIMESTAMPTZ DEFAULT NULL,
    dnc_reason      VARCHAR(500) DEFAULT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- De-duplication by person plus company.
--
-- Lowercased in the index rather than in the column so the spelling a provider
-- returned is preserved for display, while "Sarah Chen" and "sarah chen" at the
-- same employer resolve to one row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_person_company
    ON contacts (organization_id, lower(btrim(full_name)), lower(btrim(company)));

CREATE INDEX IF NOT EXISTS idx_contacts_company
    ON contacts (organization_id, lower(btrim(company)));
CREATE INDEX IF NOT EXISTS idx_contacts_dnc
    ON contacts (organization_id) WHERE do_not_contact;

DROP TRIGGER IF EXISTS trg_contacts_updated_at ON contacts;
CREATE TRIGGER trg_contacts_updated_at
    BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


/* ── which contact belongs to which job ──────────────────────────────── */

CREATE TABLE IF NOT EXISTS contact_links (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      CHAR(36) NOT NULL
                    REFERENCES contacts(id) ON DELETE CASCADE,

    posting_id      CHAR(36) NOT NULL
                    REFERENCES job_postings(id) ON DELETE CASCADE,
    -- Nullable: the manual lookup attaches a contact to a job nobody has applied
    -- to yet, which is the entire point of that endpoint.
    application_id  CHAR(36) DEFAULT NULL
                    REFERENCES application_records(id) ON DELETE SET NULL,
    queue_item_id   CHAR(36) DEFAULT NULL
                    REFERENCES queue_items(id) ON DELETE SET NULL,

    -- POSTER            the posting named this person
    -- COMPANY_FALLBACK  no name in the posting, so we took recruiters at the company
    -- MANUAL            a recruiter asked for this one specifically
    --
    -- Worth keeping: a POSTER contact is the person who wrote the advert, and a
    -- COMPANY_FALLBACK contact is a stranger who happens to work there. A
    -- recruiter about to send an email should be able to tell those apart.
    link_reason     VARCHAR(20) NOT NULL DEFAULT 'POSTER'
                    CHECK (link_reason IN ('POSTER','COMPANY_FALLBACK','MANUAL')),

    rank            INT NOT NULL DEFAULT 1,
    linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_contact_per_posting UNIQUE (contact_id, posting_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_links_posting
    ON contact_links (posting_id, rank);
CREATE INDEX IF NOT EXISTS idx_contact_links_application
    ON contact_links (application_id);
CREATE INDEX IF NOT EXISTS idx_contact_links_contact
    ON contact_links (contact_id, linked_at DESC);


/* ── every paid call ─────────────────────────────────────────────────── */
--
-- The same reasoning as job_source_payloads: without a per-call record, nobody
-- can answer "what did contact discovery cost us last month", and nobody can
-- tell a provider that is failing from a store that is simply working well and
-- returning hits for free.
--
-- Cache hits are recorded too, and that is the point. The ratio of cache_hit
-- true to false IS the value of the 90-day store, and it is invisible if only
-- the paid calls are written down.
CREATE TABLE IF NOT EXISTS contact_lookups (
    id              CHAR(36) PRIMARY KEY,

    organization_id CHAR(36) NOT NULL
                    REFERENCES organizations(id) ON DELETE CASCADE,
    posting_id      CHAR(36) DEFAULT NULL
                    REFERENCES job_postings(id) ON DELETE SET NULL,

    provider        VARCHAR(40) NOT NULL,
    endpoint        VARCHAR(120) DEFAULT NULL,
    -- What we asked for. No credentials: the connector strips them before this
    -- is written, the same rule the search provider's URLs already follow.
    query           JSONB DEFAULT NULL,

    http_status     INT DEFAULT NULL,
    result_count    INT NOT NULL DEFAULT 0,
    credits_used    INT NOT NULL DEFAULT 0,
    cache_hit       BOOLEAN NOT NULL DEFAULT FALSE,
    cost_usd        NUMERIC(12,6) DEFAULT NULL,

    error           VARCHAR(1000) DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_lookups_org_time
    ON contact_lookups (organization_id, created_at DESC);


/* ── Apollo as a provider ────────────────────────────────────────────── */
--
-- Registered in lkp_job_sources so the existing organization_providers
-- machinery covers it: per-agency enablement, monthly budget, rate limit,
-- health, and the NAME of the environment variable holding the key.
--
-- The key itself never lands in a table. A secret an operator can read through
-- a UI is a secret that has already leaked, and this codebase already redacts
-- the search provider's key out of stored URLs for exactly that reason.
INSERT INTO lkp_job_sources (name, label, fetch_mode, is_enabled, max_pages, rate_limit_ms)
VALUES ('APOLLO', 'Apollo (contact enrichment)', 'PROVIDER', FALSE, 1, 1000)
ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label;

INSERT INTO organization_providers
    (id, organization_id, source_id, is_enabled, monthly_budget, max_pages,
     rate_limit_ms, credential_env)
SELECT gen_random_uuid()::text, o.id, s.id, FALSE, 500, 1, 1000, 'APOLLO_API_KEY'
  FROM organizations o
 CROSS JOIN lkp_job_sources s
 WHERE s.name = 'APOLLO'
ON CONFLICT (organization_id, source_id) DO NOTHING;

COMMENT ON TABLE contacts IS
    'Hiring contacts, de-duplicated by person plus company and reused for 90 '
    'days before a fresh paid lookup is allowed. do_not_contact is permanent '
    'and outranks every other rule.';
