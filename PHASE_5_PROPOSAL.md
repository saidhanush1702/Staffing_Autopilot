# Phase 5 — Job Postings, Matching & the Application Queue

**Status: proposal, awaiting approval. No code has been written.**

This is the largest phase so far and the first one that makes SmartApply *do*
something rather than record something. Read **§9** before anything else — it holds
the two structural problems with building this now, and a recommended split.

---

## 1. What this feature is, in one paragraph

Everything built so far describes people. Phase 5 introduces the other half of the
system: **jobs**. It ingests postings, throws away the ones already seen, matches the
rest against each consultant's Phase 3 search criteria, and drops the survivors into a
per-consultant **queue** that respects their daily cap. It then tracks each queue item
through its life — queued, filled, parked on an unknown question, submitted, skipped —
and writes a permanent **application record** with the exact questions asked and the
exact answers given.

This is where Phases 3 and 4 stop being inventory and start being inputs.

---

## 2. Why this feature, and why now

Everything upstream is finished and idle:

```
Phase 1  who they are          ─┐
Phase 2  what they look like   ─┤
Phase 3  what they want        ─┼─→  PHASE 5  find jobs, queue them, record outcomes
Phase 4  how they answer       ─┘         │
                                          ├─→ Phase 6  tailor a resume per queue item
                                          ├─→ Phase 7  attach contacts to the job
                                          └─→ later    desktop app fills the form
```

Search criteria have no consumer. The answer bank has no form to fill. Both were
built to be read by this phase, and neither has been exercised against anything real.
Until Phase 5 exists, every phase before it is a well-tested guess.

It also closes the last major gaps in the canonical rules: **R-15** (fingerprint
de-duplication), **R-16** (cheap pre-filter before any AI call), **R-17** (daily caps
enforced at the hub), **R-01/R-03** (overlap allowed, flagged, and never reassignable).

---

## 3. The pipeline

```
  sources ──► normalise ──► FINGERPRINT DEDUPE  (company + title + location)   R-15
                                  │  already seen? update last_seen, no new row
                                  ▼
                          HARD FILTERS
                                  │  excluded companies    ← never a soft signal
                                  │  paused criteria       ← skip the consultant
                                  ▼
                          CHEAP PRE-FILTER  (title + location)                 R-16
                                  │  drop rate reported per run
                                  ▼
                          SCORED MATCH per consultant
                                  │  keywords, work type, minimum pay
                                  │  decision + reason stored
                                  ▼
                          DAILY CAP CHECK                                      R-17
                                  │  cap reached? HOLD for tomorrow, never discard
                                  ▼
                          QUEUE ITEM created (QUEUED)
                          + criteria_version_id that matched it
                          + overlap flag if it entered more than one queue
```

And then, per queue item:

```
QUEUED ──► FILLED ──► AWAITING_SUBMIT ──► SUBMITTED ──► application record (permanent)
   │          │
   │          └──► PARKED_UNKNOWN ──(Phase 4 answer approved)──► back to FILLED
   │
   └──► SKIPPED (with a reason, always)
```

---

## 4. Scope — what gets built

### Postings and ingestion
| # | Item |
|---|---|
| 1 | One normalised posting shape: source, source URL, company, title, location, work type, pay if listed, full description, portal type, first-seen |
| 2 | **Fingerprint de-duplication** on company + title + location (R-15) |
| 3 | A repeat sighting updates `last_seen` and records the sighting — it never creates a second posting |
| 4 | A **pluggable connector interface** — one contract, one connector per board |
| 5 | Connectors for the **five named boards** (§4.1): LinkedIn, Wellfound, Built In, TheLadders, CrunchBoard |
| 6 | **Raw payload retained** for every fetch, so a parser fix can be replayed against history |
| 7 | **Parse-failure quarantine** — a posting that will not parse is held for inspection, never silently dropped |
| 8 | Manual entry and CSV import as always-available fallbacks |
| 9 | Seeded posting set so matching is demonstrable on day one |

## 4.1 The five job boards

**Target boards, in the priority you gave:**

1. **LinkedIn Jobs** — top priority
2. `wellfound.com`
3. `builtin.com/jobs`
4. `theladders.com/jobs`
5. `crunchboard.com/jobs`

### The problem with the obvious approach

The instinctive design is a scraper per board: fetch the search URL, parse the HTML,
extract postings. I am not proposing that as the primary path, for three reasons that
are engineering reasons before they are legal ones:

- **All five prohibit automated scraping in their terms.** LinkedIn's User Agreement
  §8.2 is explicit, and it is the board you have ranked first. Wellfound, Built In and
  TheLadders carry equivalent clauses.
- **LinkedIn in particular fights back.** Aggressive bot detection, IP and account
  bans, and challenge pages. A scraper against LinkedIn Jobs is an arms race you have
  to keep winning forever, and losing it costs the account.
- **Your own rulebook already anticipates this.** **R-22** demands LinkedIn get "the
  most conservative treatment: lowest volume, human submit always, and a full stop for
  the remainder of the day on any bot-check challenge." A high-volume harvester
  contradicts the posture the spec sets for that one source.

None of that makes the goal illegitimate — aggregating job postings for consultants you
represent is ordinary staffing work. It means the *acquisition method* has to be chosen
per board rather than assumed.

### What each board actually offers

| Board | Machine-readable access | Recommended acquisition | Risk |
|---|---|---|---|
| **LinkedIn Jobs** | No open jobs API. Talent Solutions is partner-gated and is for *posting* jobs, not harvesting. | **Job-alert emails** to an intake mailbox, from saved searches | Low — sanctioned |
| **Wellfound** | No public jobs API | **Job-alert emails** | Low |
| **Built In** | Per-city / per-category feeds have existed historically; must be verified live | **Feed if present, else alert emails** | Low |
| **TheLadders** | Subscription product, no public API | **Job-alert emails** | Low |
| **CrunchBoard** | Historically offered RSS on search results; the URL you gave is a search page whose params map cleanly to a feed query | **Feed if present, else alert emails** | Low |

### The recommended design: alert-email intake as the primary connector

Every one of the five offers **email job alerts**. The design is:

```
per consultant, per board
        │  a saved search built from their Phase 3 criteria
        ▼
board emails an alert  ──►  dedicated intake mailbox (IMAP)
        │
        ▼
EmailAlertConnector
        │  identify the board from sender + subject
        ▼
per-board parser  ──►  common posting shape  ──►  fingerprint dedupe  ──►  matching
        │
        └─ unparseable? RAW PAYLOAD STORED + QUARANTINED, run continues
```

This is not the safe-but-worse option. It is better engineering on four counts:

- **Sanctioned.** Boards *want* you to receive alerts. No ToS problem, no bans, no
  arms race, and it satisfies R-22 without special-casing LinkedIn.
- **More stable.** Alert email templates change far less often than search-result
  markup, and when one does change it breaks one parser, not the pipeline.
- **Already in the plan.** Spec module M5.2 and feature 4 name "job-alert emails
  parsed by the system from a dedicated intake mailbox." This is the path the
  specification already chose.
- **Pre-filtered at source.** A saved search per consultant means the board applies the
  first filter, so the volume reaching the pipeline is already relevant.

The cost is honest: alerts are **periodic, not real-time**, and coverage is only as
good as the saved searches. Whoever sets those up has to keep them aligned with the
consultant's criteria — which is a real operational task, not a free lunch.

### The connector contract

One interface, so a board is added without touching the engine:

```
fetch()      → raw items (email bodies, feed entries, or rows)
parse(raw)   → the common posting shape, or a ParseError
health()     → last success, consecutive failures, quarantine depth
```

Each connector is **independently disableable** and records its own success or failure.
A board that breaks does not fail the run — spec feature 14.

### Three things the fetch layer must do

1. **Store the raw payload before parsing.** When a board changes its template, a fixed
   parser can be replayed over retained history instead of losing the postings that
   arrived while it was broken. Cheap to store, impossible to reconstruct later.
2. **Quarantine, never drop.** A posting that will not parse goes to a quarantine table
   with its raw payload and the error. Silent drops are how a source degrades for weeks
   without anyone noticing.
3. **Be polite where it fetches at all.** For any feed connector: honour `robots.txt`,
   send a real User-Agent identifying SmartApply with a contact address, one request at
   a time per host with a conservative delay, exponential backoff on 429 or 5xx, and a
   per-source rate limit stored in config rather than hardcoded.

### If you want direct fetching anyway

That is your call to make, and I will build it — but as a **per-board opt-in flag,
default off**, with the politeness controls above, so it is a deliberate decision
recorded in configuration rather than the default behaviour of the system. My
recommendation is to leave LinkedIn on email intake regardless of what the other four
do, because R-22 already commits you to that posture and it is the board with real
consequences attached.

There is also a middle path worth pricing: **licensed aggregator feeds** (the spec's
"paid search feed for coverage"). One paid source can cover several boards legitimately
and removes the parser-maintenance burden entirely. It is procurement rather than code,
but it may be cheaper than maintaining five parsers.

---

### Matching
| # | Item |
|---|---|
| 10 | Excluded companies applied as a **hard filter**, before anything else |
| 11 | Paused or unconfigured criteria → consultant skipped entirely |
| 12 | Cheap title + location pre-filter, with its drop rate reported per run (R-16) |
| 13 | Scored match across titles, include/exclude keywords, work types, minimum pay |
| 14 | The **matched criteria version** stored on the queue item — "why did this match?" answerable forever |
| 15 | A short human-readable match reason stored alongside |
| 16 | **Source board recorded** on every posting, so per-board yield and quality are measurable |

### The queue
| # | Item |
|---|---|
| 17 | Per-consultant queue with an explicit state machine, transitions enforced server-side |
| 18 | **Daily cap stops assignment**; surplus matches are **held, not discarded** (R-17) |
| 19 | **Overlap flag** when one posting enters several queues — allowed, visible, never blocked (R-01, R-03) |
| 20 | **Nothing can move a queue item to a different consultant** — no endpoint, by design (R-03) |
| 21 | Full transition history per item: who, when, from what to what |
| 22 | Actions: re-queue a skipped item, cancel with a reason, view a parking reason |
| 23 | **Parked-unknown releases automatically** when Phase 4 approves the missing answer |

### Application records
| # | Item |
|---|---|
| 24 | A **permanent, append-only** record per submitted application |
| 25 | The exact question text as the form asked it, and the exact answer as filled, in order |
| 26 | Final status: submitted / waiting-on-consultant / stalled-on-login / skipped-with-reason |
| 27 | Link to the exact resume file used |
| 28 | **No bulk resume export anywhere** (R-10) |

### Runs
| # | Item |
|---|---|
| 29 | A run record per discovery cycle: start, end, per-stage in/out counts, per-source errors |
| 30 | A failing source or posting **never aborts the run** |
| 31 | **Two runs cannot overlap** — the second is refused |
| 32 | Manual trigger; scheduled runs deferred (see §9) |

### Screens
| # | Screen | Who |
|---|---|---|
| 33 | Consultant Detail → **Queue** tab, with a detail drawer per item | ORG_ADMIN, RECRUITER |
| 34 | Consultant Detail → **Applications** tab | ORG_ADMIN, RECRUITER |
| 35 | `/management/postings` — the posting pool, with a manual "Add a job" | ORG_ADMIN, RECRUITER |
| 36 | `/management/runs` — run history and per-stage counts | ORG_ADMIN |
| 37 | `/portal/queue` — the consultant's own queue, **read-only** | CONSULTANT |
| 38 | `/portal/applications` — their own history | CONSULTANT |

---

## 5. Permission matrix

| Action | SUPER_ADMIN | ORG_ADMIN | RECRUITER | CONSULTANT |
|---|:---:|:---:|:---:|:---:|
| View postings | ✗ | ✓ all | ✓ all in org | ✗ |
| Add a posting manually | ✗ | ✓ | ✓ | ✗ |
| Trigger a discovery run | ✗ | **✓ only** | ✗ | ✗ |
| View a queue | ✗ | ✓ all | ✓ assigned | **✓ own, read-only** |
| Skip / re-queue / cancel an item | ✗ | ✓ | ✓ assigned | ✗ |
| Move an item to another consultant | ✗ | **✗** | **✗** | ✗ |
| View application records | ✗ | ✓ all | ✓ assigned | ✓ own |
| Delete an application record | ✗ | **✗ nobody** | ✗ | ✗ |
| View run history | ✗ | ✓ | ✗ | ✗ |

Consultants are read-only across this entire phase — consistent with R-23. Reassignment
being absent from every role is the point of item 16.

---

## 6. Design decisions — the ones that matter

### 6.1 Deterministic matching now; the AI stage is a separate decision

The plan specifies an AI match/no-match stage. **I propose Phase 5 ships without it**,
and here is why that is not a shortcut:

- R-16 already mandates a **cheap deterministic pre-filter before any AI call**. That
  filter has to be built regardless, and it is the majority of the matching work.
- Phase 3 criteria are unusually structured — ordered titles, include/exclude keywords,
  locations with work modes, work types, a minimum pay floor, excluded companies. That
  is enough signal for real matching. It is not a bag of words needing interpretation.
- No LLM provider is wired into this project today. Choosing one means choosing a cost
  model and a prompt contract, and **there is currently no real posting data to
  evaluate either against**. Picking now would be guessing, then defending the guess.

So: build the deterministic engine, store a match score and reason, and measure what it
gets wrong against real postings. The AI stage then becomes a well-specified second pass
over a small pre-filtered set — which is exactly the shape R-16 asks for anyway. If you
want it inside Phase 5, say so and I will scope the provider decision separately rather
than smuggle it in.

### 6.2 The fingerprint follows the spec exactly, and normalisation is conservative

R-15 fixes the fingerprint as **company + title + location**. Each part is normalised
the same way Phase 4 normalises questions — lowercase, strip punctuation, collapse
whitespace, no stemming or fuzzy distance.

The two failure modes are not symmetrical, and both are bad:

- **too loose** → two genuinely different jobs merge, and one is never surfaced
- **too tight** → the same job is queued twice and a consultant applies to it twice

The second is worse: a duplicate application is visible to the employer and wastes a
slot against the daily cap. But merging away a real job is invisible, which makes it
harder to notice. Since the spec fixes the fields, the remaining lever is
normalisation, and it stays conservative — with the **sightings table** as the safety
net, because it makes every merge decision inspectable after the fact rather than
silently final.

### 6.3 The queue is a state machine, enforced server-side

`QUEUED → FILLED → AWAITING_SUBMIT → SUBMITTED`, plus `PARKED_UNKNOWN` and `SKIPPED`.

Allowed transitions are declared in one place and checked on every write. A status
column with no transition rules is how "submitted" ends up preceding "filled" in a
history nobody can explain — and this history is the evidence trail behind a real
application to a real employer.

Every transition writes a row: who, when, from, to, why. That is the answer to "what
happened to this application?".

### 6.4 Caps hold surplus; they never discard it

R-17 says a cap stops assignment. It does not say the extra matches evaporate. A match
found today that exceeds the cap is **held** and reconsidered on the next run, so a
good job found on a busy day is not lost because of the hour it arrived.

This also means the queue is not the same thing as the match set, and the schema keeps
them separate.

### 6.5 Application records are append-only, like the audit log

Permanent, per the data model. Same enforcement as `audit_logs`: a trigger plus a
privilege revoke, so `app_role` cannot update or delete them even through SQL
injection. An application record is a statement about what was sent to an employer in
someone's name — it is not editable history.

### 6.6 Overlap is a flag, never a block

One posting matching several consultants is expected and permitted. Each applies under
their own name (R-01). The flag exists so a recruiter can *see* it on the dashboard,
not so the system can prevent it. And there is **no endpoint anywhere** that moves a
queue item between consultants — R-03 is enforced by absence, the same way R-23 is.

### 6.7 Phase 3's versioning finally pays off

Each queue item stores the `search_criteria_version_id` that matched it. Phase 3 made
versions immutable specifically for this: six months from now, "why was this job sent
to this person?" resolves to a version that still exists verbatim, not to whatever the
criteria happen to say today.

### 6.8 Parked-unknown closes the Phase 4 loop

When a form asks something with no approved answer, the item parks. When Phase 4
approves that answer, every item parked on that question for that consultant returns to
fillable — proposal item 49 from Phase 4, deferred because there was no queue to
release. It is a hook in the existing review handler, not new machinery.

---

## 7. Data model

**Thirteen tables.** This is by far the largest phase, which is itself an argument for
the split in §9.

| Table | Purpose | Mutability |
|---|---|---|
| `lkp_job_sources` | the five boards + manual + CSV, each with `enabled`, `fetch_mode` (EMAIL / FEED / MANUAL), rate limit and contact address | seeded lookup |
| `job_source_payloads` | the raw email or feed entry, kept before parsing so a parser fix can be replayed | **append-only** |
| `job_parse_quarantine` | anything that would not parse, with its error — inspected, never dropped | mutable (resolved flag) |
| `lkp_portal_types` | LinkedIn, Workday, Greenhouse, Lever, direct — LinkedIn matters for R-22 | seeded lookup |
| `lkp_queue_statuses` | the six states, with UI labels | seeded lookup |
| `lkp_application_statuses` | the four final states | seeded lookup |
| `job_postings` | the normalised posting + fingerprint | mutable (`last_seen`) |
| `job_posting_sightings` | every time a source saw it — makes dedupe inspectable | append-only |
| `queue_items` | consultant × posting, status, criteria version, overlap flag | mutable pointer |
| `queue_item_transitions` | who moved it, when, from, to, why | **append-only** |
| `job_matches` | matches found but **held** by the cap, plus score and reason | mutable |
| `application_records` | permanent record of what was sent | **append-only, privilege-revoked** |
| `application_qa` | exact question, exact answer, field type, order | **append-only** |
| `discovery_runs` | per-run stage counts, errors, timings | append-only |

House conventions throughout. Two invariants worth calling out now:

```sql
-- R-15. One posting per fingerprint per organisation.
CREATE UNIQUE INDEX uq_posting_fingerprint_per_org
    ON job_postings (organization_id, fingerprint);

-- A consultant is never queued the same job twice.
CREATE UNIQUE INDEX uq_one_open_queue_item
    ON queue_items (consultant_id, posting_id)
    WHERE status_id <> (SELECT id FROM lkp_queue_statuses WHERE name = 'SKIPPED');

-- Two discovery runs cannot overlap (R-16 discipline, feature 27).
CREATE UNIQUE INDEX uq_one_running_discovery
    ON discovery_runs (organization_id) WHERE finished_at IS NULL;
```

---

## 8. Endpoints

```
GET    /api/management/postings                      the pool, filterable
POST   /api/management/postings                      add one manually
POST   /api/management/postings/import               CSV / file connector
GET    /api/management/postings/:id                  detail + sightings

POST   /api/management/discovery/run                 ORG_ADMIN — trigger a cycle
GET    /api/management/discovery/runs                run history
GET    /api/management/discovery/runs/:id            per-stage counts and errors

GET    /api/management/consultants/:id/queue         one consultant's queue
GET    /api/management/queue/:itemId                 item detail + full transition history
POST   /api/management/queue/:itemId/skip            reason required
POST   /api/management/queue/:itemId/requeue
POST   /api/management/queue/:itemId/transition      guarded by the state machine

GET    /api/management/consultants/:id/applications  application history
GET    /api/management/applications/:id              record + the exact Q&A list
POST   /api/management/applications                  record one manually (see §9)

GET    /api/portal/queue                             CONSULTANT — own, read-only
GET    /api/portal/applications                      CONSULTANT — own, read-only
GET    /api/lookups                                  + the four new lookups
```

No route moves an item between consultants. No route deletes an application record.

---

## 9. The two problems with building this now

### Problem 1 — the five boards need accounts and a mailbox before any code runs

The boards are now named (§4.1), which settles *what* to connect to. It does not
settle the prerequisites, and none of them are code:

- **An intake mailbox** — a dedicated address with IMAP access and credentials in
  `.env`. SMTP settings are currently blank in `.env.example`, so nothing mail-related
  is configured yet.
- **An account per board**, with saved searches configured and alerts pointed at that
  mailbox. LinkedIn, Wellfound, Built In and TheLadders all require a login;
  TheLadders is a paid subscription.
- **Saved searches that reflect each consultant's criteria.** This is an ongoing
  operational task, not a one-off. The system cannot create them.

Until a mailbox exists with real alerts arriving, the connectors can only be built
against **captured sample emails** — which is a legitimate way to develop and test
parsers, but it is not proof the pipeline works end to end.

**The unblocking step is yours:** create the mailbox, set up one saved search on one
board, and forward me a few real alert emails. Two or three samples per board is
enough to write a parser that will hold.

### Problem 2 — nothing fills or submits a form

The desktop app is a separate, later phase. Without it no queue item can genuinely
reach `SUBMITTED`, and no application record can be created by the system. Left
literal, Phase 5 ships a queue that never advances past `QUEUED`.

Phase 3 had a mild version of this. Phase 4's was worse. **Phase 5's is the worst
yet**, because two independent halves of the pipeline are missing at once.

### Recommended: split the phase

| | Scope | Deliverable |
|---|---|---|
| **5A** *(recommended now)* | Postings, fingerprint dedupe, sightings, the five board connectors, raw-payload retention, quarantine, matching engine, cap logic, the queue and its state machine, run records, queue screens | Demonstrable end to end. Parsers built against captured sample emails until the mailbox exists; manual entry, CSV import and seeded postings cover the gap. First real exercise of Phase 3 criteria. |
| **5B** *(after, or alongside the desktop app)* | Application records, Q&A entries, applications screens | Schema plus a **manual "record an application"** path, which real staffing firms do anyway when someone applies by hand. Becomes automatic when a submitter exists. |

5A is a coherent, testable feature on its own. 5B without a submitter is mostly a table
and a form — worth building, but not worth pretending it is the same deliverable.

**If you want it in one phase, that is fine** — say so and I will build 5A then 5B in
sequence under one banner. What I want to avoid is starting an eleven-table phase with
the two halves undifferentiated.

### Also explicitly out of scope

| Not building | Why |
|---|---|
| **The AI matching stage** | §6.1 — no provider wired, and no real posting data to evaluate a prompt or a cost model against. |
| **The 4-hour schedule** | Manual trigger only until real alerts are flowing. A cron over an empty mailbox is theatre; the scheduler ships with the first live connector. |
| **Direct scraping of the five boards** | §4.1. Available as a per-board opt-in flag, default off, if you decide you want it. |
| Licensed aggregator feeds | Procurement. Worth pricing against the cost of maintaining five parsers — see the end of §4.1. |
| Resume tailoring per item | Phase 6. Queue items carry the field, unpopulated. |
| Contact attachment | Phase 7. Same. |

---

## 10. Manual test gate

Every restriction gets a negative test proving the server refuses.

### Board connectors (§4.1)
| # | Do | Expect |
|---|---|---|
| A | Feed a captured LinkedIn alert email through the parser | Postings extracted with company, title, location, source URL |
| B | Same for Wellfound, Built In, TheLadders, CrunchBoard | Each parser produces the common shape |
| C | Feed an email whose template has changed | **Quarantined** with its error and raw payload — not dropped, run continues |
| D | Fix the parser, replay the retained payload | The quarantined posting is recovered |
| E | Disable one board in config | It is skipped; the others still deliver |
| F | Break one board's parser deliberately | Run completes, that board's failure recorded, others unaffected |
| G | Check per-board health | Last success, consecutive failures, quarantine depth all reported |
| H | Confirm no board is fetched directly unless its opt-in flag is set | Default configuration performs no scraping |
| I | Feed the same posting from two different boards | **One** posting, two sightings, both sources visible |

### De-duplication (R-15)
| # | Do | Expect |
|---|---|---|
| 1 | Import the same posting twice from two sources | **One** posting row; two sightings; `last_seen` updated |
| 2 | Change only the location, re-import | Treated as a **distinct** posting |
| 3 | Same job with different punctuation and casing | Matched as the same posting |
| 4 | Inspect a merged posting | Both sightings visible with their sources |

### Matching
| # | Do | Expect |
|---|---|---|
| 5 | Narrow a consultant's criteria; run | Only matching postings queue; check 5 matches and 5 non-matches by hand |
| 6 | Add a company to their excluded list | Its postings never appear, however well they match |
| 7 | **Pause** their criteria; run | Consultant skipped entirely |
| 8 | Consultant with criteria **not set up** | Skipped — never "matches everything" |
| 9 | Check the pre-filter drop rate in the run record | Reported, and non-trivial |
| 10 | Open a queue item | Shows the **criteria version** that matched and a readable reason |

### Caps (R-17)
| # | Do | Expect |
|---|---|---|
| 11 | Cap 3, force 10 matches | Exactly **3** queue items |
| 12 | Check the other 7 | **Held**, not discarded — visible as pending matches |
| 13 | Run again the next day | Held matches are reconsidered |

### Overlap and reassignment (R-01, R-03)
| # | Do | Expect |
|---|---|---|
| 14 | One posting matches two consultants | In **both** queues, overlap flag set on each |
| 15 | Look for any way to move an item to another consultant | None in the UI **and** none in the API |
| 16 | Craft the request by hand | **404/405** — the route does not exist |

### Queue state machine
| # | Do | Expect |
|---|---|---|
| 17 | Skip an item with no reason | **422** — a reason is mandatory |
| 18 | Re-queue a skipped item | Returns to QUEUED; both transitions in the history |
| 19 | Force an illegal transition by hand (`QUEUED → SUBMITTED`) | **409** — refused |
| 20 | Read an item's history | Every transition: who, when, from, to, why |

### Parked-unknown ↔ Phase 4
| # | Do | Expect |
|---|---|---|
| 21 | Park an item on a question with no approved answer | `PARKED_UNKNOWN`, reason names the question |
| 22 | Approve that answer in the Phase 4 inbox | Item returns to fillable **automatically** |
| 23 | Reject the answer instead | Item stays parked |

### Application records
| # | Do | Expect |
|---|---|---|
| 24 | Create one, then try to edit it | Refused — append-only |
| 25 | `UPDATE application_records` as `app_role` in psql | **permission denied** |
| 26 | Open a record | Exact questions and exact answers, in order |
| 27 | Look for a bulk resume export | None anywhere (R-10) |

### Permissions — negatives
| # | As | Do | Expect |
|---|---|---|---|
| 28 | recruiter | Queue of an unassigned consultant | **404** |
| 29 | recruiter | Trigger a discovery run | **403** — ORG_ADMIN only |
| 30 | consultant | Own queue | Read-only; no actions |
| 31 | consultant | Any management queue route | **403** |
| 32 | admin@apex | Any Molina posting, queue item or record | **404** |
| 33 | superadmin | Any Phase 5 endpoint | **403** |

### Runs
| # | Do | Expect |
|---|---|---|
| 34 | Trigger a run | Run record with per-stage counts |
| 35 | Break one connector deliberately | Run **completes**; failure recorded; other sources deliver |
| 36 | Trigger a second run while one is going | **Refused** |
| 37 | Compare engine-created and manually-added items in the audit log | Distinguishable |

### Lifecycle
| # | Do | Expect |
|---|---|---|
| 38 | Terminate a consultant with an open queue | Queue items cancelled; **application records kept** |
| 39 | Suspend a consultant | Queue held, not cancelled — reversible |

> Tests 38–39 exist because this went wrong in Phase 3: terminating a consultant left
> their criteria active (`ISSUES.md` **H-1**). Any new per-consultant state gets
> checked against the lifecycle from the start now.

---

## 11. Rough shape

| Area | Estimate |
|---|---|
| Migrations | 5–6 (`022`–`027`) |
| New backend config | `fingerprint.js`, `matcher.js`, `queueStateMachine.js` — all pure and unit-testable |
| New controllers | `postingController`, `discoveryController`, `queueController`, `applicationController` |
| Endpoints | ~18 |
| New screens | 6 (2 tabs, 4 pages) |
| Tests | ~90 assertions, in `backend/tests/` from the start |

Largest phase to date, roughly the size of Phases 3 and 4 combined — the second reason
for the §9 split.

---

## 12. What I need from you

1. **§9 — split into 5A and 5B, or one phase?** This is the real decision.
2. **§6.1 — deterministic matching now, AI stage as a separate decision?** Or do you
   want the AI stage inside Phase 5, in which case the provider and cost model need
   their own conversation first.
3. **§4.1 — alert-email intake as the primary acquisition method**, with direct
   fetching as a per-board opt-in that is off by default. Confirm, or tell me you want
   direct fetching on for specific boards and I will build it with the politeness
   controls described.
4. **The intake mailbox.** Which address, and can you set up one saved search on one
   board and send me two or three real alert emails? That is the single thing that
   unblocks parser work.
5. **Anything in §4 to cut.** The run-history screen (item 36) is the most droppable —
   the data is recorded either way, and Phase 8 surfaces it properly.

## 13. Before Phase 5 starts

Three items from `ISSUES.md` are worth clearing first — not because they block it, but
because Phase 5 makes each more expensive:

- **L-6 — the demo database has degraded.** Matching needs a believable bench to test
  against, and right now Molina holds 27 terminated users against 8 active, with the
  primary demo recruiter permanently terminated. Testing cap logic and overlap on that
  is unreliable. This is the one I would fix first.
- **M-5 — five screens and four dialogs have never been rendered.** Phase 5 adds six
  more. The unverified surface is compounding.
- **M-4 — three test suites still live in a scratchpad**, one of them unrunnable.
  Phase 5 is the biggest surface yet and needs regression cover that survives a
  session.

Also worth knowing: `IMPLEMENTATION_PLAN.md` and `implementation.md` were deleted in
commit `765ec0f`. They are recoverable with `git show 765ec0f^:IMPLEMENTATION_PLAN.md`,
and this proposal was written from that recovered copy. If the deletion was deliberate,
fine — but the Phase 5 spec lives there and nowhere else.
