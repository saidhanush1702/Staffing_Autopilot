# Implementation Plan — AI Resume Tailoring & Contact Discovery

Self-contained. It does not depend on, and does not update, any earlier document
in this folder. Scope is exactly two features:

1. **Resume Tailoring Engine** — for each matched job, rewrite the consultant's
   base resume to mirror the job description's language, with an ATS score, and
   without inventing anything.
2. **Fabrication Check** — an independent second model compares the tailored
   resume against the base and flags every claim with no basis in the original.
3. **Contact Discovery** — find the hiring contact for a job through Apollo,
   store it once, reuse it for 90 days.

(1) and (2) are one pipeline and are planned together. (3) is independent and
can be built in parallel by a second person once Part A lands.

---

## 1 · What already exists, verified

Nothing of these two features is built. But the codebase left the sockets open,
and that is why this is an insert rather than a rewrite. Each line below was
checked against the code, not assumed.

| Already there | Where | Why it matters |
|---|---|---|
| `queue_items.tailored_resume_artifact_id` | `024_job_queue.sql:121` | The column the tailored resume attaches to. Declared, never written. |
| `resume_artifacts.kind` accepts `'tailored'` | `007_resume_artifacts.sql:17` | The artifact type already exists. |
| `PREPARING` state, and `QUEUED → PREPARING → READY` transitions | `config/queueStates.js:58-64` | The AI stage's slot in the state machine is already legal. |
| `queue_items.preparation_attempts`, `preparation_error` | `029_queue_lanes_and_leasing.sql:83-84` | Retry counter and failure text, already present. |
| `promoteToReady()` with a comment reserving this exact seam | `controllers/discoveryController.js:405` | "Exactly here, between QUEUED and READY." One function to change. |
| Desktop app resolves `COALESCE(tailored, base)` | `controllers/deviceController.js:789` | **The desktop app needs no change to start using tailored resumes.** |
| `expireUnprepared()` sweep returns stuck `PREPARING` items to `QUEUED` | `jobs/queueMaintenance.js:78` | Crash recovery for the new stage already runs every 10 minutes. |
| `organization_providers` — per-org budget, rate limit, health, `credential_env` | `031_org_settings_and_providers.sql` | Apollo becomes a row here. No new configuration surface. |
| `job_source_payloads` / cost-ledger pattern | `023_job_postings.sql` | The precedent for recording every paid call. |
| Provider connector contract — never throws, retries, redacts the key | `connectors/serpapi.js` | The shape `anthropic.js` and `apollo.js` both copy. |
| Audited per-job resume delivery, no bulk route | `controllers/resumeController.js` | The access rules tailored resumes inherit for free. |

**Two facts that shape the plan:**

- **There is no daily cap.** Commit `1fe4a1d` removed it deliberately across the
  backend, client and desktop app; `consultant_profiles.daily_cap` survives as an
  unused column. Every match becomes a queue item and every queue item becomes
  `READY`. So nothing bounds tailoring volume, which is why §3 D4 exists.
- **`pruneResumes()` deletes every base resume that is not current**
  (`resumeController.js:40`). It filters on `kind = 'base'`, so tailored artifacts
  are safe today — but D2 puts them in a separate directory so that stays true by
  construction rather than by coincidence.

---

## 2 · What is left to build

Everything below. Five parts, in dependency order.

```
Part A  Foundation          background worker, Claude connector, text extraction
Part B  Tailoring engine    parse → tailor → ATS score → render PDF
Part C  Fabrication check   independent check + the human review gate
Part D  Contact discovery   Apollo waterfall, contact store, 3-role visibility
Part E  Close-out           dashboard, env, tests
```

Parts B and C are one pipeline; C is separated only because the review gate is
meaningful work of its own. Part D shares only Part A.

---

## 3 · Locked decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Tailored resumes render into one **system-owned, single-column, ATS-safe template**. Section order, headings and voice from the base are preserved; original fonts, columns and graphics are not. | ATS parsers are the audience. Deterministic, no LibreOffice on the host. Surgical DOCX editing is ~3× the work, needs DOCX bases, and breaks on unusual Word files. |
| **D2** | **Base and tailored resumes stored separately.** Base at `uploads/<orgId>/`, tailored at `uploads/<orgId>/tailored/`. Separate `kind`, directory and lifecycle. | `pruneResumes()` deletes non-current base resumes. Physical separation makes tailored files impossible to catch in that net. |
| **D3** | **Every matched job is tailored.** No volume cap. | Your call. A tailored resume on every match is the product working as promised. |
| **D4** | **A per-org monthly AI budget exists, and hitting it never stops applications.** At the ceiling the item still reaches `READY` carrying the **base** resume, and is **marked** as not tailored. | Your call: "no AI tailoring — keep a symbol for that job and that consultant, and proceed." With no daily cap, spend scales with match volume; this makes the ceiling visible instead of surprising. |
| **D5** | **`queue_items.tailoring_state`** is that marker: `PENDING · TAILORED · NOT_TAILORED · FLAGGED`, with `tailoring_skip_reason`. Surfaced as a badge in the management queue, the consultant portal, and the desktop app. | One column answers "did this application go out with a tailored resume?" for every screen, forever. |
| **D6** | **Contact discovery fires after submission**, not after matching. | Lookups scale with *submissions* rather than *matches*. With the 90-day store deduplicating by company, marginal cost approaches zero as a bench settles into a set of employers. |
| **D7** | **A manual "find the contact now" action** exists for one job, on demand, one credit. | Recovers the pre-apply contact for the specific job a recruiter cares about, without paying for all of them. |
| **D8** | **Contacts are visible to all three roles** — ORG_ADMIN, RECRUITER, CONSULTANT. | Your call. Consultant sees contacts on their own jobs and applications; management sees everything and can search the store. Every view is audited; there is no bulk export route. |
| **D9** | **A flagged resume holds at a new `RESUME_REVIEW` state.** Recruiter and consultant both see it; management approves; the consultant can reject or request changes. | Matches every other approval flow here — profile changes, answers — where the consultant is the subject and management is the reviewer. |
| **D10** | **Models: `claude-sonnet-5` to tailor, `claude-haiku-4-5` to check.** Model id stored on every artifact. | Quality where it earns money, cheap where it is a checking task. $2/$10 and $1/$5 per MTok. Storing the id makes a model change auditable. |
| **D11** | **Prompt caching, not the Batch API, in v1.** | The base resume plus locked rules *is* the repeated input, resent per job — caching takes ~90% off it. Batch adds another 50% but brings polling, `custom_id` reconciliation and an hour of latency. The worker interface leaves room to add it later. |
| **D12** | **The ATS score is computed in code, never asked of the model.** Stored before and after. | A model asked to grade its own output reports a good number. Deterministic keyword coverage is defensible to a client, and the delta proves the tailoring did something. |
| **D13** | **The fabrication checker never sees the job description.** | Given the JD, a checker rationalises a fabricated claim as "clearly relevant". Given only base-vs-tailored, the only question it can answer is the one that matters. |
| **D14** | **The tailoring rules live in a frozen constant in code** — not the database, not a settings screen, not reachable from any portal. | It is the product's core guarantee. Changing it should be a code review, not a form submission. |

---

## 4 · Database changes

Four migrations, continuing from `037`.

### `038_background_jobs.sql`

```sql
background_jobs
  id, organization_id, kind, payload jsonb,
  status           PENDING | RUNNING | DONE | FAILED | DEAD
  attempts, max_attempts DEFAULT 3, next_attempt_at,
  locked_by, locked_until,          -- lease + expiry, like queue_items
  last_error, created_at, started_at, finished_at

  INDEX (status, next_attempt_at) WHERE status = 'PENDING'

organizations  + ai_monthly_budget_usd  NUMERIC(10,2) DEFAULT 50.00
               + ai_spend_reset_day     INT DEFAULT 1
```

Claimed with `FOR UPDATE SKIP LOCKED` so two workers never take one row; leased
with an expiry so a crashed worker cannot hold one forever.

### `039_resume_tailoring.sql`

```sql
resume_documents            -- parse once per resume, not once per job
  id, organization_id, artifact_id, sha256 UNIQUE,
  sections jsonb, raw_text, parser_version, parsed_at

resume_artifacts     + source_artifact_id  -> the base it came from
                     + queue_item_id       -> the job it was made for
                     + model, ats_score_before, ats_score_after, generated_at

resume_tailoring_runs       -- the cost ledger and the audit trail
  id, organization_id, queue_item_id, attempt,
  model, prompt_version,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cost_usd, verdict (CLEAN|FLAGGED|FAILED), duration_ms, error

resume_fabrication_flags
  id, organization_id, tailoring_run_id, tailored_artifact_id,
  claim_text, section, severity (HIGH|MEDIUM|LOW),
  detected_by (RULE|MODEL), reason,
  reviewer_verdict (PENDING|ACCEPTED|REJECTED), reviewed_by, reviewed_at

queue_items          + tailoring_state VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                       CHECK (tailoring_state IN
                         ('PENDING','TAILORED','NOT_TAILORED','FLAGGED'))
                     + tailoring_skip_reason VARCHAR(40)
                       -- BUDGET_EXHAUSTED | NO_BASE_RESUME
                       -- | UNPARSEABLE_RESUME | AI_FAILED

lkp_queue_statuses   + RESUME_REVIEW ('Resume needs review', sort_order 3;
                       READY -> 4, FILLING -> 5)
```

### `040_contacts.sql`

```sql
contacts
  id, organization_id,
  full_name, first_name, last_name, title, seniority,
  company, company_domain, location, linkedin_url,
  email, email_status, email_source, email_pulled_at,
  phone, phone_source, phone_pulled_at,
  provider, provider_person_id,
  do_not_contact bool DEFAULT false, dnc_by, dnc_at, dnc_reason,
  created_at, updated_at,
  UNIQUE (organization_id, lower(full_name), lower(company))   -- dedupe rule

contact_links
  id, organization_id, contact_id,
  posting_id, application_id, queue_item_id,
  link_reason (POSTER | COMPANY_FALLBACK | MANUAL), rank, linked_at,
  UNIQUE (contact_id, posting_id)

contact_lookups             -- every paid call, so cost is answerable
  id, organization_id, provider, endpoint, query jsonb,
  http_status, result_count, credits_used, cache_hit bool,
  cost_usd, error, created_at
```

Plus an `APOLLO` row in `lkp_job_sources` (`fetch_mode = 'PROVIDER'`), so the
existing `organization_providers` machinery covers Apollo's budget, rate limit,
health and `credential_env` with no new settings surface.

> Contacts are a **link table**, never a column on `application_records` — that
> table is append-only and enforced by a trigger, so anything discovered after
> submission could never be written into it.

### `041_contact_access.sql`

Grants, indexes, and audit-module registration for `contacts`. Every contact
view writes an audit row.

---

## 5 · The build

Each step says what it is, how to do it, and how you know it is finished.

---

### Part A — Foundation

Nothing user-visible. Both features sit on it.

#### A1 · Migration `038`
**How.** Write the migration; run `npm run migrate`. Verify `SKIP LOCKED`
behaviour by opening two `psql` sessions and claiming concurrently.
**Done when** two concurrent claims return different rows, and neither blocks.

#### A2 · `jobs/worker.js`
**How.** A self-scheduling loop, not a cron expression — cron's finest grain is a
minute and preparation should start in seconds.

```
every WORKER_INTERVAL_MS (default 15s):
  claim  UPDATE background_jobs SET status='RUNNING', locked_by=$worker,
                                    locked_until = now() + interval '10 min',
                                    attempts = attempts + 1, started_at = now()
         WHERE id IN (SELECT id FROM background_jobs
                       WHERE status = 'PENDING' AND next_attempt_at <= now()
                       ORDER BY created_at
                       FOR UPDATE SKIP LOCKED
                       LIMIT $batch)
         RETURNING *
  dispatch on kind -> jobs/handlers/<kind>.js
  success -> status DONE
  failure -> attempts < max ? PENDING with exponential next_attempt_at
                            : DEAD, last_error kept
```

Started from `server.js` behind `WORKER_ENABLED`, exactly as
`startQueueMaintenance()` is. A lease-expiry sweep joins the existing 10-minute
maintenance tick and returns abandoned `RUNNING` rows to `PENDING`.
**Done when** A5's tests pass.

#### A3 · `connectors/anthropic.js`
**How.** `npm i @anthropic-ai/sdk`. One exported `callModel({model, system,
messages, outputSchema, cacheBreakpoints})`. Copy `serpapi.js`'s contract
exactly: config read fresh per call (never captured at import, so tests can set
`process.env`), retry 429/5xx with backoff, **never throw** — return
`{ok:false, error}` — and the key never enters storage. Returns `usage` so the
ledger can be written. Budget guard reads month-to-date `SUM(cost_usd)` from
`resume_tailoring_runs` against `organizations.ai_monthly_budget_usd`.
**Done when** a request with a bad key returns `{ok:false}` rather than throwing,
and a 429 is retried twice then given up on.

#### A4 · `utils/resumeText.js` + `config/resumeSchema.js`
**How.** `npm i pdfjs-dist mammoth`. PDF → text via pdfjs, DOCX → text via
mammoth. Legacy `.doc` (OLE2) is **refused** with a plain message — there is no
sound pure-JS parser for it. `resumeSchema.js` is a Joi schema for the structured
resume: `{contact, summary, skills[], experience[{company,title,location,start,
end,bullets[]}], education[], certifications[]}`. Both the parse step and the
tailor step must satisfy it.
**Done when** a real PDF and a real DOCX both round-trip to text, and a `.doc`
returns the refusal.

#### A5 · Worker tests
**How.** `backend/tests/worker.test.mjs`: a handler that fails twice then
succeeds ends `DONE` with `attempts = 3`; one that always fails ends `DEAD` with
`last_error` set; two workers started together never process the same row; an
expired lease returns to `PENDING`.
**Done when** all four pass under `npm test`.

---

### Part B — Tailoring engine

#### B1 · Migration `039`
**Done when** migrated and `RESUME_REVIEW` is present with `READY` and `FILLING`
re-spaced to 4 and 5.

#### B2 · `services/resumeParse.js`
**How.** Given a base `resume_artifacts` row: if `resume_documents` already has
its `sha256`, return it. Otherwise extract text (A4), send it to
`claude-haiku-4-5` with a "split this into sections, change no wording" prompt
and the `resumeSchema` as structured output, validate, and store.
**Why cached by sha256:** parsing costs once per resume, not once per job. A
consultant with 40 matches pays for one parse.
**Done when** two consecutive calls for one artifact make exactly one model call.

#### B3 · `config/tailoringRules.js`
**How.** A frozen exported constant — the system prompt. It must state, in
order: keep the existing format, section order and voice; reorder and reword
bullets to mirror the job description's vocabulary; surface real experience that
is relevant; and the hard rule — **never add a skill, tool, employer, job title,
date, certification or metric that is not in the base resume.** Ship a
`PROMPT_VERSION` string alongside; every run records it, so a quality change is
attributable to a prompt change.
**Done when** reviewed and signed off, and no code path can read it from the
database or a request body.

#### B4 · `config/atsScore.js`
**How.** Pure function, no model.
1. Tokenise the JD; drop stopwords; keep 1–3-gram phrases.
2. Weight each keyword by frequency, and ×2 if it appears in a requirements or
   skills section, and ×1.5 if it also appears in the consultant's own search
   criteria skills.
3. Coverage = Σ(weight of JD keywords present in the resume) ÷ Σ(all weights),
   scaled to 0–100.
Run against the base to get `ats_score_before`, and the tailored to get
`ats_score_after`.
**Done when** unit tests over three fixed JD/resume pairs return stable scores,
and a resume that literally contains the JD scores near 100.

#### B5 · `services/resumeTailor.js`
**How.** One `claude-sonnet-5` call, laid out for cache hits — stable content
first, volatile last, because caching is a prefix match:

```
system   [ tailoringRules      cache_control: ephemeral ]
messages [ user: base resume JSON   cache_control: ephemeral ]
         [ user: job description                          ]   <- volatile, last
output_config.format = resumeSchema        (structured output)
thinking = adaptive, effort = medium
```

Validate the response against `resumeSchema`; a malformed response is a retry,
not a bad PDF. Record `usage.cache_read_input_tokens` — if it is ever zero on a
repeat job for the same consultant, something volatile has leaked into the
prefix and cost has silently tripled.
**Done when** the second job for one consultant reports a non-zero cache read.

#### B6 · `services/resumePdf.js`
**How.** `npm i pdfkit`. One column. No tables, no text boxes, no graphics, no
headers or footers — every one of those is an ATS parsing hazard. Standard
section headings in a fixed order. Filename `Company_Title_Date.pdf`, sanitised.
Written into `uploads/<orgId>/tailored/` per D2.
**Gate:** produce one sample from a real base resume and a real JD, and get
client sign-off before B7 runs against anything live. This is the visible
artefact of the whole feature.
**Done when** the sample is approved and the file opens cleanly with selectable,
correctly-ordered text.

#### B7 · `jobs/handlers/tailorResume.js`
**How.** The pipeline, in order, all inside one job:

```
 1  load queue item, posting, consultant, base resume artifact
 2  no base resume?      -> NOT_TAILORED / NO_BASE_RESUME, READY, stop
 3  budget exhausted?    -> NOT_TAILORED / BUDGET_EXHAUSTED, READY, stop
 4  parse base           (B2, cached)
 5  unparseable (.doc)?  -> NOT_TAILORED / UNPARSEABLE_RESUME, READY, stop
 6  ats_score_before     (B4 over base)
 7  tailor               (B5)
 8  fabrication check    (C1)
 9  ats_score_after      (B4 over tailored)
10  render PDF           (B6)
11  write resume_artifacts + resume_tailoring_runs
12  flags?  -> tailoring_state FLAGGED, status RESUME_REVIEW
    clean?  -> tailoring_state TAILORED, set tailored_resume_artifact_id,
               status READY
```

Steps 2, 3 and 5 are the D4/D5 path: **the application still goes out**, marked.
On an unexpected error the job retries; after `max_attempts` it lands
`NOT_TAILORED / AI_FAILED` and `READY` with the base resume.
**Done when** each of the five outcomes is reachable in a test.

#### B8 · Rewire `promoteToReady()`
**How.** In `controllers/discoveryController.js:405`, replace the direct
`QUEUED → READY` update with `QUEUED → PREPARING` plus a `background_jobs` insert
of kind `tailorResume`. Keep the transition row. The existing
`expireUnprepared()` sweep already returns stuck `PREPARING` items to `QUEUED`,
so crash recovery needs no new code.
**Done when** a discovery run leaves items at `PREPARING` with a pending job
each, and the worker walks them to `READY`.

#### B9 · Surface the marker
**How.** Add `tailoring_state` and `tailoring_skip_reason` to the payloads of
`listConsultantQueue`, `getQueueItem`, and `deviceQueue`. Render a badge:
green *Tailored*, grey *Not tailored — <reason>*, amber *Needs review*. Three
places: `client/src/components/queue/ConsultantQueue.jsx`,
`QueueItemDrawer.jsx`, and the desktop app's `Work.jsx` / `Review.jsx`.
**Done when** a consultant, a recruiter and the desktop app all show the same
state for the same job.

---

### Part C — Fabrication check and review gate

#### C1 · `services/fabricationCheck.js`
**How.** Two passes, cheap one first.

*Mechanical pre-pass, in code, no model.* Extract from the tailored text every
capitalised token, every known technology term, every number, percentage, money
amount and year. Any of them absent from the base text is flagged **HIGH**,
`detected_by = RULE`. This is what catches invented metrics — the classic
failure — for free and without asking a model to be honest about itself.

*Model pass.* `claude-haiku-4-5`, given **only** the base text and the tailored
text (D13 — no JD). Structured output: a list of `{claim, section, reason}`.
Base text gets a cache breakpoint; it is the same bytes for every job that
consultant has.

Flags from both passes are written to `resume_fabrication_flags`.
**Done when** a deliberately poisoned tailored resume — one invented tool, one
invented percentage — produces both a RULE flag and a MODEL flag.

#### C2 · `RESUME_REVIEW` in the state machine
**How.** In `config/queueStates.js`: add `RESUME_REVIEW` to `QUEUE_STATES`, add
it to `PREPARING`'s allowed targets, and give it
`['READY', 'PREPARING', 'QUEUED', 'SKIPPED']`. Add it to `CANCELLABLE`. Because
every route and the desktop app share this one table, no endpoint needs to learn
the new state individually.
**Done when** `checkTransition('PREPARING','RESUME_REVIEW')` passes and
`checkTransition('READY','RESUME_REVIEW')` returns a 409.

#### C3 · `controllers/resumeReviewController.js`
**How.** Four routes, `isManagement`, recruiters narrowed by the existing
`canAccessConsultant`:

```
GET  /api/management/resume-reviews            list, with counts
GET  /api/management/resume-reviews/:itemId    base + tailored + flags
POST /api/management/resume-reviews/:itemId/approve      -> READY,  TAILORED
POST /api/management/resume-reviews/:itemId/reject       -> READY,  NOT_TAILORED
                                                            (base resume used)
POST /api/management/resume-reviews/:itemId/retry        -> PREPARING, re-queued
```

Every decision writes the reviewer's verdict onto each flag row and an audit
entry.
**Done when** approve, reject and retry each land the item in the right state
with a transition row.

#### C4 · Consultant view
**How.** `GET /api/portal/resume-reviews` and a detail route, consultant-scoped
to their own items. They can call `reject` (use my base resume) but not
`approve` — per D9.
**Done when** a consultant can see the flagged claims on their own resume and
cannot approve one.

#### C5 · Review UI
**How.** `client/src/pages/management/ResumeReview.jsx` — a list of waiting
items — and `components/resume/TailoredDiff.jsx` — base and tailored side by
side, each flagged claim highlighted in place with its severity and the
checker's reason, and the three action buttons. A matching, read-only,
reject-only version in the consultant portal.
**Done when** a reviewer can decide an item without leaving the screen.

#### C6 · Review expiry
**How.** Add a sweep to `jobs/queueMaintenance.js` alongside the existing three:
an item in `RESUME_REVIEW` older than `review_expiry_days` goes to `READY` as
`NOT_TAILORED / AI_FAILED`, with a transition row saying so.
**Done when** nothing can sit in `RESUME_REVIEW` indefinitely.

---

### Part D — Contact discovery

Independent of B and C. Only needs Part A.

#### D1 · Migrations `040`, `041`, and the `APOLLO` provider row
**Done when** migrated, and an `organization_providers` row exists per org with
`credential_env = 'APOLLO_API_KEY'`.

#### D2 · `connectors/apollo.js`
**How.** Same contract as `serpapi.js` — config read fresh, retries, never
throws, key never stored. Two operations the waterfall needs:

```
matchPerson({ name, company, domain })   -> one person, business email
searchPeople({ domain, titles, location, limit })
                                         -> ranked people at a company
```

Auth by header, base URL and timeout from env. **Every call writes a
`contact_lookups` row**, hit or miss, so cost is answerable.
**Verification note:** the exact request and response shapes are confirmed
against live Apollo responses once `APOLLO_API_KEY` is in the environment. Until
then the connector is developed against recorded fixtures, and D6 is the gate
that says it has been checked for real.
**Done when** fixture tests pass and a missing key degrades to `{ok:false}`
without throwing.

#### D3 · Poster-name extraction
**How.** Pure function over `job_postings.description`, per portal. LinkedIn and
Dice usually name the poster; Greenhouse and Lever usually do not. Patterns
plus a rejection list for generic senders — "HR Team", "Talent Acquisition",
"Recruiting", "Careers", "no-reply". No API call, no cost.
**Done when** unit tests over real posting descriptions extract a name where one
exists and return null for every generic sender.

#### D4 · `services/contactDiscovery.js` — the waterfall
**How.** Stop at the first step producing a usable contact.

```
1  read the posting for a poster name              (D3, free)
2  contact store: same person+company, or same company+location,
   pulled within 90 days?  -> reuse, link, cost $0
3  name found and stale/absent?
   -> apollo.matchPerson  -> upsert contact, link, log the lookup
4  no personal name?
   -> apollo.searchPeople(company, TA/recruiting titles, location, limit 2)
   -> enrich both, link both, ranked
```

Two rules enforced here rather than at call sites: a contact with
`do_not_contact` is **never** linked, and the unique index on
`(org, lower(full_name), lower(company))` means one person contacted for five
jobs is one row linked five times.
**Done when** the same company on a second application makes zero API calls.

#### D5 · `jobs/handlers/discoverContact.js`
**How.** Enqueued from `reportSubmitted` in `deviceController.js` and from the
portal self-report path, immediately after the `application_records` insert,
inside the same transaction. The handler runs later, on the worker — so an
Apollo outage can never fail a submission.
**Done when** submitting an application creates a pending job and the contact
appears against that application within one worker tick.

#### D6 · Live Apollo verification
**How.** With `APOLLO_API_KEY` set: run one `matchPerson` and one `searchPeople`
against real data, compare the parsed result to the raw response, and correct
the connector where the documented shape and the real shape differ.
**Done when** both operations return correctly-parsed contacts from live Apollo
and the `contact_lookups` rows show accurate credit counts.

#### D7 · Manual per-job lookup
**How.** `POST /api/management/queue/:id/find-contact`, ORG_ADMIN and recruiter,
audited, runs the waterfall synchronously for one job. This is D7's escape hatch
for a recruiter who wants the contact before applying.
**Done when** a recruiter can pull a contact for one job and see the credit
recorded.

#### D8 · `services/phoneProvider.js`
**How.** An interface — `lookupPhone({name, company, linkedinUrl})` — and a
`NullPhoneProvider` returning nothing. Apollo's own phone is used when present.
Lusha or SignalHire drops in here later without touching the waterfall.
**Done when** the waterfall calls the interface and works with the null
implementation.

#### D9 · Contact API and UI, three roles (D8)
**How.**

```
GET   /api/management/contacts                  store search   (admin, recruiter)
GET   /api/management/applications/:id/contacts
GET   /api/management/queue/:id/contacts
POST  /api/management/contacts/:id/do-not-contact              (admin, recruiter)
GET   /api/portal/applications/:id/contacts     own only       (consultant)
GET   /api/device/queue/:id/contacts            own only       (desktop app)
```

UI: `components/contacts/ContactCard.jsx` — name, title, company, email, phone,
source, date pulled — reused in the queue drawer, the application detail and the
consultant portal; `pages/management/Contacts.jsx` for the store search and the
do-not-contact toggle. **Every read writes an audit row. No bulk export route
exists**, and that is the enforcement.
**Done when** all three roles see a contact through their own portal and no
route returns more than one job's contacts at a time to a consultant.

---

### Part E — Close-out

| # | Step | Done when |
|---|---|---|
| E1 | Cost dashboard: AI spend month-to-date vs budget, cache hit rate, flag rate, not-tailored counts by reason, Apollo credits and store hit rate | An owner can answer "what did last month cost and why" from one screen |
| E2 | `.env.example` and `README.md` updated with every new variable | A fresh checkout starts with both features off and no crash |
| E3 | End-to-end test on the demo posting seed: match → tailor → check → review → apply → contact | The whole path runs green without a real API key, using fixtures |

---

## 6 · Configuration

```bash
# ── AI (Phase 7) ─────────────────────────────────────────
# Both features are OFF unless the worker is on. A fresh checkout never
# spends money on its own.
WORKER_ENABLED=false
WORKER_INTERVAL_MS=15000
WORKER_BATCH_SIZE=5

ANTHROPIC_API_KEY=
ANTHROPIC_TIMEOUT_MS=120000

# Model per stage. Both are overridable so a model change is config, not a
# deploy — the id used is recorded on every artifact regardless.
AI_TAILOR_MODEL=claude-sonnet-5
AI_CHECK_MODEL=claude-haiku-4-5
AI_PARSE_MODEL=claude-haiku-4-5

# The monthly ceiling is per organisation, set in the UI, not here.
# At the ceiling, jobs still reach READY carrying the base resume and are
# marked NOT_TAILORED / BUDGET_EXHAUSTED.

# ── Contact discovery (Apollo) ───────────────────────────
# Named by organization_providers.credential_env. The key stays in the
# environment and never enters the database, exactly like SERPAPI_KEY.
APOLLO_API_KEY=
APOLLO_BASE_URL=https://api.apollo.io
APOLLO_TIMEOUT_MS=20000
CONTACT_REUSE_DAYS=90
```

---

## 7 · What it costs to run

Per tailored job, once the cache is warm:

| Call | Model | Input | Output | Rate |
|---|---|---|---|---|
| Parse base resume | `claude-haiku-4-5` | — | — | **once per resume**, not per job |
| Tailor | `claude-sonnet-5` | ~5K, of which ~3K reads from cache at ~10% | ~2K | $2 / $10 per MTok |
| Fabrication check | `claude-haiku-4-5` | ~4K, base portion cached | ~500 | $1 / $5 per MTok |
| ATS score | — | — | — | code, free |

**Roughly 2–4 cents per job**, dominated by Sonnet's output tokens. Contact
discovery adds at most one Apollo credit per *submitted* application that misses
the 90-day store, trending toward zero as the store fills.

With no daily cap, the monthly figure is (matches × ~$0.03). The per-org budget
in D4 is what turns that from an unknown into a number the owner sets.

---

## 8 · Risks

| Risk | Handling |
|---|---|
| **Legacy `.doc` base resumes cannot be parsed** in pure JavaScript. | The item goes `READY` marked `NOT_TAILORED / UNPARSEABLE_RESUME` and the consultant is asked to re-upload PDF or DOCX. **Audit what is on file before B2** — if the bench is full of `.doc`, that is a task of its own, not a surprise mid-build. |
| **The clean template discards the consultant's original design.** | D1, taken deliberately. B6 gates on client sign-off of a real sample. |
| **Unbounded volume**, since the daily cap was removed. | D4's budget, and E1's dashboard. Nothing blocks; spend becomes visible and bounded. |
| **Prompt caching silently stops working** — a timestamp or per-job id leaks into the cached prefix and cost triples. | `resume_tailoring_runs.cache_read_tokens` is recorded per call and charted in E1. A drop to zero is visible rather than invisible. |
| **Flag rate could be high** and clog the review queue. | Measured from day one. Above ~10% the fix is the prompt in B3, not a bigger queue. |
| **Apollo's real response shape may differ** from its documentation. | D2 is built against fixtures; **D6 is the gate** that says it has been verified against a live key before it is trusted. |
| **A model or provider outage** stalls preparation. | Every failure path in B7 ends `READY` with the base resume and a marker. Applications never stop. |

---

## 9 · Open items before Part B starts

1. **B6 template sign-off.** One sample tailored PDF from a real base resume and
   a real job description, approved before anything live runs through it.
2. **Base resume format audit.** How many consultants are on legacy `.doc`.
3. **`APOLLO_API_KEY` in the environment** before D6. Parts D1–D5 and D7–D9 do
   not block on it; D6 does.
