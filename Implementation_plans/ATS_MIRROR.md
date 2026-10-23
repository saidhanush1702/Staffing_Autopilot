# ATS Live Mirror — reading employers' career systems directly

**Branch:** `feat/atsfetchingjobsfaster` · **Phase 5d** · a fourth ingestion door, built in parallel.

SerpApi, the JobsPipe webhook and the JobsPipe poller are **untouched** (see §9 for the one
shared-file edit and why it is safe). This door is OFF until switched on, twice, and starts in a
mode that cannot queue anything.

---

## 1. The idea in one paragraph

SerpApi and JobsPipe *ask a third party* what jobs exist, so they inherit that party's index lag
and per-request price. An employer's applicant-tracking system (ATS) already publishes a free,
unauthenticated JSON list of **every** open job — with an `ETag`, so an unchanged board answers
`304 Not Modified` with an empty body. The mirror keeps a registry of employer boards, reads each
one on an adaptive schedule, and **diffs** it against what it saw last time. Whatever appears is
new *by construction*, straight from the origin, with its real apply URL and its portal type known
before any page is fetched. Matching against consultants then happens locally through the existing
`evaluate()`. Cost scales with the number of **boards**, not consultants.

```
 registry of boards ──► due? ──► read board ──► diff vs memory ──► new job ──► fetch detail
   (ats_boards)        (tick)    (304 = free)   (atsDiff.js)                       │
                                                                                   ▼
                   OBSERVE: record + time it          LIVE: ingestAdapted()  ── the SAME function
                   (nothing queued, no AI spend)      → fingerprint (R-15) → evaluate()
                                                        → job_matches → queue_items → promoteToReady
```

## 2. What it reads (all verified live, not assumed)

| System | List | Pub. time | Conditional | Notes |
|---|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs` | `first_published` (exact) | ETag → 304 | description needs a per-job detail call; content is **entity-escaped** HTML |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` | `createdAt` (epoch ms) | ETag → 304 | list has everything; 5.8 MB for Palantir; EU host via `config.host` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}` | `publishedAt` | ETag → 304 | CDN-cached 60 s (so 60 s is the floor); 13 MB for OpenAI; `isRemote` is true for 140/153 *Hybrid* jobs → `workplaceType` wins |
| Workday | `POST {tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | a **day** only ("Posted Today") | none (`no-store`) | newest-first, 20/page, total caps at 2000; held to a 5-min floor; change detected by hashing ids |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings` | `releasedDate` (exact) | ETag → 304 | newest-first; id is **case-sensitive** and not guessable |

## 3. The decisions that matter (and what each one prevents)

| Decision | Prevents |
|---|---|
| **First read is a baseline.** Only jobs *provably* published inside `bootstrap_age_hours` (default 48) are candidates. | Adding Stripe (725 open jobs) would otherwise queue 725 stale roles. |
| **"New" = unseen id, never a timestamp.** | Greenhouse's `updated_at` moves on every typo fix. |
| **Close a job only after 2 consecutive *complete* reads without it; partial reads (Workday/SmartRecruiters) never close; >50 % vanishing at once = bad read.** | One truncated response closing half a board. |
| **Rows are never deleted;** a closed job that returns is *reopened*, not re-ingested. | A flapping board re-queuing the same role. |
| **A board with no real company name only OBSERVES.** | R-15 fingerprints company+title+location; `northwindlabs` ≠ `Northwind Labs`, so the same job from two doors would be two postings (asserted in tests). |
| **OBSERVE mode** (default) records detections + latency, creates **no** posting/queue/AI spend. | Turning on a firehose that spends model credits before anyone has seen what it finds. |
| **Latency is NULL, not 0,** for baseline rows and day-precision systems. | A "median 0 s" that is really "we weren't watching". |
| **Per-poll bounds** (`max_ingest_per_poll`, `detail_cap_per_poll`); overflow is kept as `DETECTED` and drains on the next poll — even a 304. | One board flooding the queue or the host. |
| **Per-host concurrency + spacing, identifying User-Agent, backoff honouring `Retry-After`.** | Getting blocked. |
| **Claims are leases (`FOR UPDATE SKIP LOCKED`).** | Two processes polling one board; a crash stranding a board. |
| **Real publish dates of any age are kept** (only future / pre-2000 rejected). | 57 % of Palantir's jobs are >1 year old; discarding them made re-listed old reqs look *undated*, i.e. new. |

## 4. Where the code lives

```
backend/
  db/migrations/058_ats_mirror.sql      5 new tables + ATS_DIRECT source row (additive, idempotent)
  connectors/ats/
    http.js          fetch w/ timeout, ETag, typed errors, per-host limiter
    detect.js        paste a careers link → family + board key
    greenhouse|lever|ashby|workday|smartrecruiters.js     one adapter each
    adapted.js       item → the posting shape ingestAdapted() already consumes
    shared.js labels.js index.js
  config/atsSchedule.js     adaptive interval policy (pure)
  services/atsDiff.js       new / gone / baseline logic (pure)
  services/atsPoller.js     poll one board (DB + network)
  services/atsIngest.js     bridge into ingestAdapted (own source row, cached bench)
  services/atsDiscover.js   grow the registry (mine postings; probe company-name slugs)
  jobs/atsMirror.js         the tick loop (flagged off)
  controllers/atsController.js   /api/management/ats/*
  scripts/ats-probe.mjs     CLI: see what the mirror would see for any link
  tests/atsMirror.test.mjs  226 unit assertions (fixtures = trimmed REAL responses)
  tests/atsMirror.db.test.mjs   DB integration (refuses to run on a non-"test" DB)
client/src/
  pages/management/AtsMirror.jsx  +  components/ats/*  (Overview · Boards · Live feed · Activity)
  design/tokens.js   (+ meterTrack / meterFill)    utils/relativeTime.js
```

## 5. Switching it on (nothing happens until all three)

1. `ATS_MIRROR_ENABLED=true` in `backend/.env`, restart the server. *(Without it the loop never starts; manual "Read now" still works.)*
2. In the UI → **Live Mirror → Overview**, turn the switch on. *(Starts in **Observe**.)*
3. Add boards. Watch **Typical time to notice** and the **Live feed** for a few days.
4. Only when satisfied, switch **Observe → Live**. *(Confirmation dialog explains the AI-credit cost.)*

A switched-off agency is never claimed by the loop, and a manual read while off is forced to
OBSERVE — there is no back door that still creates queue items.

## 6. How to test

### A. Unit tests (no DB, no network) — run any time
```
cd backend
npm run test:ats            # 226 assertions
npm run test:jobspipe-search && node tests/jobspipe.test.mjs && npm run test:discovery   # prove the old doors are unchanged
```

### B. See it work on a real employer (no DB, read-only)
```
npm run ats:probe -- https://boards.greenhouse.io/stripe
npm run ats:probe -- lever:palantir --jobs 5
npm run ats:probe -- https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
```

### C. Database integration (needs an isolated DB — never your dev data)
The suite **refuses** any database whose name lacks `test`, and any `DATABASE_URL`.
```
$env:DB_NAME='staffing_autopilot_test'; npm run migrate     # applies 001–058 + seeds
$env:ATS_TEST_DB='staffing_autopilot_test'; npm run test:ats-db
```
It runs the real poller, diff, matcher and queue against a scripted employer and asserts: baseline
vs news, 304s, latency, OBSERVE vs LIVE, cross-door de-duplication (a job JobsPipe already holds is a
`DUPLICATE`, never a second queue item), provenance wording, burst caps + backlog drain, two-miss
closure, mass-disappearance guard, error back-off, NOT_FOUND parking, nameless-board guard,
lease/race claiming, and tenant isolation.

### D. In the UI
Start API + client (API on `:5001`, client on `:5173`), sign in as an **ORG_ADMIN**, open
**Sourcing → Live Mirror**.
1. *Overview* — see the red-flag banner if the loop is off; flip the switch; note Observe is selected.
2. *Employer boards → Add board* — paste `https://boards.greenhouse.io/stripe` → **Verify** (shows job count + real titles) → company is pre-filled → **Add board**. Row appears as *Watching*; a first read has already happened.
3. Paste a Lever link → Verify → company name is **required** (the system doesn't state it).
4. *Add board → Paste a list* — several `url, Company` lines.
5. *Find boards* — "From your postings" and "By company name" (Start scan, watch the meter; tick rows → Add).
6. Open a board (click its name) → recent reads and noticed jobs; **Read now**.
7. *Live feed* / *Activity* — populate as boards publish; the **Delay** column is the headline metric.
8. Sign in as a **RECRUITER** — read-only: no switch, no add/remove buttons.

## 7. Known limits (be honest about these)

- **Coverage = your registry.** The mirror is only as wide as the boards you give it. Growing it
  is the ongoing work; "Find boards" helps, but only ~3 % of existing postings link to an ATS, and
  company-name guessing finds a subset of the rest.
- **Not covered:** LinkedIn, Indeed, Dice, VMS portals and vendor requirement e-mails. A large
  share of US IT-contract demand lives there — that is a separate lane, not this one.
- Registry is **per agency**: two agencies watching Stripe each poll Stripe. Fine at today's scale;
  a shared fetch layer would be the upgrade.
- Pay is captured only where the system states a *unit* (Lever, Ashby). Greenhouse/Workday/
  SmartRecruiters pay is left empty rather than guessed.
- Greenhouse **EU** boards (`boards.eu.greenhouse.io`) use a different API host and are not yet read.
- Workday/SmartRecruiters reads are *partial* (newest pages), so removals on those boards aren't detected.
- ATS jobs land in the **HUMAN/AGENT** lane: their portals (`GREENHOUSE`, `LEVER`, …) aren't
  `is_automatable` yet. That is the *next* phase (auto-fill), not this one.
- **LIVE mode spends AI credits** on every matched job (via `promoteToReady`) — same as the other doors, but this one is faster.

## 8. Merging

This branch is built on `feature/webapplication`, which is **~40 commits ahead of `main`**
(all of the queue/JobsPipe/desktop work lives only there). Merging this branch to `main` directly
would carry those commits with it — merge `feature/webapplication` first, or merge into it.

## 9. The one edit to an existing ingest file

`controllers/jobspipeListener.js`: `ingestAdapted` gained an optional `viaLabel` (default `'JobsPipe'`).
Without it every ATS match would be stamped `[via JobsPipe]` — sending someone looking for a delivery
that never happened. The default reproduces the old output byte for byte; the three pre-existing
suites (101 + 90 + 133 assertions) pass unchanged.

Other edits to existing files are additive wiring only: `server.js` (imports, routes, flagged loop),
`lookupController.js` (+`atsFamilies`), `.env.example`, `package.json` scripts, `App.jsx`/`Layout.jsx`/
`Sidebar.jsx` (route, breadcrumb, nav entry), `tokens.js` (+2 meter tokens).
