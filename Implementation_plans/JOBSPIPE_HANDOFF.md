# JobsPipe Real-Time Ingestion — Handoff

**Branch:** `feature/webapplication` · **Status:** complete, verified, **uncommitted**
**Built:** 2026-09-09 · **Amended:** 2026-09-12

---

## 1. What was asked for, and what was actually built

The brief asked for a FastAPI webhook, an APScheduler-aware parallel module, and pytest
tests. Three things in it did not match the codebase, and the work was adjusted rather
than blocked:

| The brief said | The codebase actually is | What was built |
|---|---|---|
| FastAPI `POST` route in Python | **Node.js / Express (ESM)** — no `.py` file exists anywhere | An Express route |
| pytest unit tests | Hand-rolled scripts run by `node --test tests/` | Same convention as the six existing suites |
| "the existing 4-hour APScheduler/cron job" | `node-cron` ticking **every 15 min**, asking which org is **due**; interval is **per-organisation** (default 6h, not 4h) | Left completely untouched |
| "existing Claude Haiku **AI matching** function" | Matching is **deterministic** (`config/jobMatcher.js`, pure scoring, no model). The LLM stage is **resume tailoring**, reached via `promoteToReady()` → background job → worker | Hooked into `promoteToReady()`, the real gate |
| "existing SerpAPI, **Greenhouse, Lever** ingestion flows" | Only **SerpAPI** is an ingestion flow. Greenhouse/Lever are **source/portal labels** detected from apply-URL hostnames inside that one path | Nothing to preserve separately; nothing broken |

A FastAPI service would have been useless here — it could not reach the DB layer, the
fingerprint, the matcher, or the worker.

---

## 2. Files

### New (5)

| File | Purpose |
|---|---|
| `backend/db/migrations/043_jobspipe_webhook.sql` | `JOBSPIPE` source row, per-agency secret table, event log |
| `backend/connectors/jobspipe.js` | Normaliser: JobsPipe JSON → the posting shape the pipeline consumes |
| `backend/controllers/jobspipeListener.js` | `POST /api/webhooks/jobspipe`, the ingest pipeline, admin routes |
| `backend/tests/jobspipe.test.mjs` | 90 tests |
| `client/src/pages/management/JobsPipe.jsx` | The operator screen |

### Modified (6)

| File | Change |
|---|---|
| `backend/controllers/discoveryController.js` | **2 `export` keywords + comments. Zero logic change.** See §3 |
| `backend/server.js` | Import block + 7 route registrations |
| `backend/package.json` | Added `"test:jobspipe"` script |
| `client/src/App.jsx` | Lazy import + one `<Route>` |
| `client/src/components/layout/Sidebar.jsx` | `Webhook` icon import + one nav item under *Sourcing* |
| `client/src/components/layout/Layout.jsx` | One breadcrumb entry |

> `client/src/pages/Login.jsx` and `desktop/src/renderer/screens/Activation.jsx` show as
> modified in git but were **already dirty before this work started**. Not touched here.

---

## 3. The only change to the discovery engine

Two `const` declarations in `discoveryController.js` became `export const`:

- `loadMatchableConsultants`
- `upsertPosting`

**Nothing else changed — no logic, no queries, no behaviour.**

This was deliberate. The brief said to run pushed jobs through the *existing*
de-duplication and pre-filter. Importing a non-exported `const` is impossible in ESM, so
the alternatives were: export them, or copy them. A second copy of the R-15 fingerprint
rule would drift from the original the first time either changed — and the moment it
drifts, the same job reaches a consultant twice and they apply twice. That is precisely
the failure R-15 exists to prevent.

Verified untouched: `jobs/discoveryScheduler.js`, `connectors/serpapi.js`,
`connectors/googleJobs.js`, `config/discoverySchedule.js`, `config/jobMatcher.js`,
`config/fingerprint.js` — all zero diff.

---

## 4. How it works

```
JobsPipe ──POST──▶ /api/webhooks/jobspipe
                         │
                   secret → which org?        (jobspipe_endpoints.token_hash)
                         │
                   jobspipeToPosting()        NEW  — connectors/jobspipe.js
                         │
                   upsertPosting()            EXISTING — R-15 fingerprint dedup
                         │
                   evaluate()                 EXISTING — hard filter → cheap
                         │                               pre-filter (R-16) → score
                   job_matches + queue_items  (no cap here, same as the cycle)
                         │
                   promoteToReady()           EXISTING — enqueues the AI stage
                         │
                   worker → tailorResume → LLM (off the request path)
```

Every step after normalisation is the cycle's own code, imported not copied.

### Deliberate non-behaviours

- **Never writes a `discovery_runs` row.** `uq_one_running_discovery` allows one open run
  per org; a webhook opening a run could race the scheduler and block the cycle from
  starting. Matches and queue items carry `run_id = NULL`.
- **Never calls a model on the request path.** It enqueues; the worker spends the money.
- **Never touches** the scheduler, SerpAPI, or any source row but its own.

### Status codes (chosen for the sender's retry logic)

| Code | Meaning |
|---|---|
| `200` | Processed — **including** "suited nobody" and "already had it". Those are correct outcomes; any other code would make the sender redeliver forever |
| `400` | Body is not a job. Retrying won't help |
| `401` | Secret wrong or missing (one message for every rejection reason, so the endpoint can't be probed) |
| `403` | Secret valid, but this tenant has the endpoint switched off |
| `500` | **Our** fault. The only code that should be retried |

### The secret

Follows migration 034's device-activation pattern exactly:
- `token_hash` (sha256) — the **only** thing a delivery is verified against
- `token_enc` / `token_iv` / `token_tag` (AES-256-GCM under `PASSWORD_ENC_KEY`) — exists
  solely so an admin can read it back to paste into JobsPipe. Never authenticates anything.

**No new environment variables.** The secret lives in the DB, per organisation.

---

## 5. Verification performed

### Test suites — all green

```
jobspipe     90 passed, 0 failed     discovery   133 passed, 0 failed
worker       34 passed, 0 failed     tailoring    59 passed, 0 failed
contacts    108 passed, 0 failed     llm          59 passed, 0 failed
```

`tests/answers.test.mjs` fails with `ERROR: fetch failed` — it needs a live server, and it
fails **identically on a clean stash**. Pre-existing, not a regression.

Client builds clean: `JobsPipe-Cw74M4Fg.js  14.53 kB`.

### Live HTTP, against the real database

```
401  no token
401  bad token
400  valid token, body with no company
QUEUED     "Senior React Developer" @ Globex — 1 considered, 1 matched, 1 queued,
                                               1 → AI prep   (118ms)
DUPLICATE  same job reworded ("Globex Corporation, Inc.", "Urgent Hiring", "Remote")
                                             → times_seen=2, no second queue item
FILTERED   "Warehouse Associate" @ Initech — pre-filter dropped it, posting still stored
```

The queue item reached **READY** via the worker running `tailorResume` (status `DONE`).
UI verified in-browser: funnel tiles, endpoint card, secret reveal/rotate, delivery log,
and the expandable raw-payload viewer all render and work.

---

## 6. Amendment on 2026-09-12 — three defects found in the test button

A `FILTERED` result from a test delivery sent from the UI on 09-09 at 19:27 could not be
reproduced. Replaying that exact stored payload against the current bench scored **92 and
matched**, while the bench and criteria had not changed since August. Investigation found
three real defects in `sendTestEvent` — all in code written on 09-09, none in the
ingestion path itself:

1. **Non-deterministic title.** The title query used
   `GROUP BY t.value ORDER BY COUNT(*) DESC LIMIT 1`. On a small bench every title ties at
   one apiece, so Postgres was free to return any of them. Each press generated a different
   job with no way to tell why.
2. **Titles drawn from the wrong set.** It queried `search_criteria` directly, which
   includes consultants who are paused, terminated, or have no profile —
   `loadMatchableConsultants` excludes all of them. So the button could generate a job
   titled for somebody who cannot receive work, which always came back "Suited nobody" and
   read as a broken feed. (A stray `Probe Engineer` title in this org came from exactly
   such a consultant.)
3. **Repeat presses were no-ops.** Company, title and location were all constant, so the
   fingerprint was constant. The first press created a posting; every press after it
   collapsed onto that row and reported "Already had it, 0 queued". Correct R-15
   de-duplication, useless as a smoke test.

### The fix

`backend/controllers/jobspipeListener.js` — `sendTestEvent` now:
- takes the title from `loadMatchableConsultants` (the same bench `ingestJob` matches
  against), with an alphabetical tie-break so a press is reproducible;
- passes that bench into `ingestJob`, so the consultant the title was chosen for is
  provably the consultant it is matched against;
- appends a 6-char marker to the **company** (not the title — the title must stay exactly
  what a consultant asked for, or the matcher drops it), so each press is a genuinely new
  posting and the whole path runs every time;
- returns `title` and `benchSize` alongside the result.

`client/src/pages/management/JobsPipe.jsx` — the banner now distinguishes the three ways a
test can queue nothing (empty bench / nobody wants this title / already held), and says
plainly that each press is a **real** delivery that stores a posting and can spend a model
call.

### Verified

```
press 1: title="Frontend Engineer" outcome=QUEUED bench=1 matched=1 queued=1 prepared=1 (236ms)
press 2: title="Frontend Engineer" outcome=QUEUED bench=1 matched=1 queued=1 prepared=1  (90ms)
press 3: title="Frontend Engineer" outcome=QUEUED bench=1 matched=1 queued=1 prepared=1  (90ms)
```

Deterministic, repeatable, full path every time.

---

## 7. ⚠️ Open items — read before trusting the trial

### The field mapping is unverified against real JobsPipe

The adapter was written from **what this pipeline needs**, not from a captured live
delivery. JobsPipe's real schema was never confirmed. Send one real delivery, open the row
in the UI to read the raw payload, and compare against `ACCEPTED_PATHS` in
`connectors/jobspipe.js`. Every mapping is one table there, so a rename is a one-line fix
plus a test. **Until that is done, the trial numbers are not trustworthy.**

### Authentication is a bearer secret, not HMAC

An HMAC over the body would prove the *body* is unmodified; a shared secret only proves the
sender knows the secret. HMAC is the right answer and the hook belongs in `presentedToken`
— it was not implemented because JobsPipe's signing scheme is unconfirmed, and a check
written against a guessed scheme rejects every real delivery. **Keep the endpoint behind
TLS.**

### Other limits

- Deliveries over **1 MB** are rejected by `express.json()` before reaching the handler, so
  they never appear in the event log.
- The endpoint keeps the standard `/api` rate limit (300/min).
- `MAX_JOBS_PER_DELIVERY = 25`; the overflow is reported in the response as `skipped`.

### Test data left in the database

Verification created rows in the `Molina Staffing` org:

- **5** synthetic postings (`company LIKE 'JobsPipe Test Employer%'`) and **4** queue items
- **2** curl-test postings (`Globex Corporation`, `Initech Logistics`)
- **11** rows in `jobspipe_webhook_events`

Harmless, but they inflate the funnel. Delete when convenient — **review before running**:

```sql
DELETE FROM job_postings
 WHERE company LIKE 'JobsPipe Test Employer%'
    OR company IN ('Globex Corporation', 'Initech Logistics');
DELETE FROM jobspipe_webhook_events;
```

Queue items and matches cascade from `job_postings`.

---

## 8. Picking this up

### Local run

```bash
node backend/migrate.js          # applies 043 if not already applied
node backend/server.js           # :5001
npm run dev --prefix client      # :5173
```

Sign in as `admin@molina.local` / `Admin@123` → **Sourcing → JobsPipe Feed**.
(Seeded demo credentials, `db/seeds/003_demo_org_seed.js`.)

### Going live with the real feed

1. Press **Generate secret**; copy it and the webhook URL into JobsPipe's dashboard.
2. Press **Turn on**.
3. The URL must be internet-reachable — on a laptop, put ngrok or Cloudflare Tunnel in
   front of `:5001` and give JobsPipe the tunnel address.
4. After the first real delivery, do the `ACCEPTED_PATHS` check in §7.

### Manual smoke test

```bash
curl -X POST http://localhost:5001/api/webhooks/jobspipe \
  -H 'Content-Type: application/json' \
  -H 'X-JobsPipe-Token: <secret>' \
  -d '{"job":{"id":"jp_1","title":"React Developer","company":{"name":"Globex"},
       "location":{"city":"Dallas","region":"TX","remote":true},
       "employment_type":"contract","apply_url":"https://boards.greenhouse.io/globex/jobs/1",
       "salary":{"min":70,"max":90,"currency":"USD","interval":"hourly"},
       "description":"React and TypeScript."}}'
```

### Tests

```bash
npm run test:jobspipe --prefix backend
```

### Not yet done

- **Nothing is committed.** All 11 changed/new files are still in the working tree.
- No README section was added (the 38 KB README was left alone).
- `job_source_payloads` is not written by this path — the event log's `raw_payload`
  serves the same purpose for webhook deliveries.
