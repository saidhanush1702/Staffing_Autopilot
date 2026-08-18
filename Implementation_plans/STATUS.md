# Build Status

**Verified, not asserted.** Every ✅ below was checked against the running code
or the live database at the time of writing. Four items previously reported as
done turned out not to be, and are corrected here.

**Database is at migration `033` — fully up to date.** All migrations and seeds
applied cleanly; the post-migration schema was re-verified rather than assumed
to match the dry-run.

**Key:** ✅ done and verified · ◐ partially done · ⬜ not started

| Group | Steps | ✅ | ◐ | ⬜ |
|---|---|---:|---:|---:|
| Foundation and discovery | 1–15 | 15 | — | — |
| Discovery corrections | 16–20 | 5 | — | — |
| Queue architecture | 21–30 | 10 | — | — |
| Queue actions and records | 31–38 | 4 | 1 | 3 |
| Desktop app — hub side | 39–44 | 6 | — | — |
| AI preparation | 45–50 | — | — | 6 |
| Desktop app — the app | 51–58 | — | — | 8 |
| Release | 59–61 | — | — | 3 |
| **Total** | **61** | **40** | **1** | **20** |

---

## 1–15 · Foundation and discovery

| # | Step | |
|---|---|:--:|
| 1 | Postgres schema, migration runner, two DB roles (app / migrator) | ✅ |
| 2 | Multi-tenant accounts — 4 roles, 3 portals, signed-token tenant scoping | ✅ |
| 3 | Append-only audit log, enforced by trigger + privilege revoke | ✅ |
| 4 | Consultant profiles + field-by-field approval workflow | ✅ |
| 5 | Resume upload and per-job delivery (no bulk export anywhere) | ✅ |
| 6 | Employment lifecycle — suspend/terminate, session revocation, lockout | ✅ |
| 7 | Search criteria — immutable versioning, pause/activate, consultant read-only | ✅ |
| 8 | Answer bank — category routing, salary/work-auth to owner, two-person approval | ✅ |
| 9 | Job discovery via SerpApi — provider client, key redaction, retry/backoff | ✅ |
| 10 | Google Jobs adapter — source vs portal detection, pay/date parsing | ✅ |
| 11 | Fingerprint de-duplication + sightings (R-15) | ✅ |
| 12 | Matching engine — hard filters, cheap pre-filter, scoring, criteria-version stamping | ✅ |
| 13 | Daily cap holding surplus, overlap flagging, no-reassignment-by-absence | ✅ |
| 14 | Discovery runs with per-stage counters, scheduler, discovery + postings screens | ✅ |
| 15 | Early-exit on duplicate pages, per-run credit ceiling, per-term yield reporting | ✅ |

## 16–20 · Discovery corrections

| # | Step | |
|---|---|:--:|
| 16 | Apply pending migrations — all through `033` now applied | ✅ |
| 17 | Replace deprecated `chips` with `uds` | ✅ |
| 18 | uds cache + auto-rediscovery (7-day TTL, reset on empty result) | ✅ |
| 19 | Monthly credit budget guard with a manual-run reserve | ✅ |
| 20 | SerpApi plan decision — *your call, recorded as made* | ✅ |

## 21–30 · Queue architecture

| # | Step | |
|---|---|:--:|
| 21 | `channel` BOT/HUMAN, set at ingest from `lkp_portal_types.is_automatable` | ✅ |
| 22 | Readiness gate — `QUEUED` ≠ ready; the app only pulls prepared items | ✅ |
| 23 | Cap slot taken at **ready**, not at queue creation | ✅ |
| 24 | `submitted_via` — DESKTOP_BOT / DESKTOP_ASSISTED / PORTAL_SELF_REPORTED | ✅ |
| 25 | Queue item lease **with expiry**, so a crashed app cannot lock an item | ✅ |
| 26 | Admin/recruiter cancel path; termination cancels the queue | ✅ |
| 27 | Provider config generalised to N providers, per agency | ✅ |
| 28 | Daily cap resets on the agency timezone | ✅ |
| 29 | Review expiry releases the cap slot | ✅ |
| 30 | Posting ageing sets `is_active = false` | ✅ |

## 31–38 · Queue actions and records

| # | Step | |
|---|---|:--:|
| 31 | `queueStates.js` — transitions declared once, enforced on every write | ✅ |
| 32 | Skip / re-queue / transition / cancel endpoints (reason mandatory, illegal → 409) | ✅ |
| 33 | `application_records` + `application_qa`, append-only + privilege-revoked | ✅ |
| 34 | Parked-unknown auto-release via `parked_question_id` | ✅ |
| 35 | Manual posting entry + CSV import | ⬜ |
| 36 | Seeded demo posting set | ⬜ |
| 37 | Consultant portal: own queue, own applications, "I applied to this" | ⬜ |
| 38 | Queue detail drawer + applications tab | ◐ |

**Why those four are marked as they are**

| # | Checked | Found |
|---|---|---|
| 35 | routes in `server.js` | no `POST /api/management/postings` — **not started** |
| 36 | `backend/db/seeds/` | five seed files, none for postings — **not started** |
| 37 | routes and `client/src/pages/portal/` | no `/api/portal/queue`, no page — **not started** |
| 38 | endpoint vs client call sites | endpoint returns item + full history and is verified; **nothing in the client calls it** — backend only |

## 39–44 · Desktop app, hub side

| # | Step | |
|---|---|:--:|
| 39 | `devices`, `device_board_status`, `resume_deliveries` (migration `033`) | ✅ |
| 40 | One-time activation codes and device tokens, both stored **hashed** | ✅ |
| 41 | `verifyDevice` — separate identity; revocation, machine binding, employment check per call | ✅ |
| 42 | Device API — activate, heartbeat, queue, lease, filled, parked, skipped, reclassify, submitted, board-status | ✅ |
| 43 | Owner-side issue / revoke / list, one live device per consultant | ✅ |
| 44 | Devices panel — state per device, stalled boards, code shown once | ✅ |

**Verified against the live database:** a second pending device refused, a
second active device refused, the activation code burnt on use, the plaintext
token absent from the table, an expired lease swept back to `READY` while a live
lease is left alone, a retried submission unable to create a second record, and
`UPDATE` and `DELETE` on an application record refused by the trigger.

> **A test that lied, twice.** Checking append-only against an *empty* table
> passes trivially — `FOR EACH ROW` has no rows to fire on, so the write
> succeeds and looks like a missing trigger. Both times this check has been run
> it first gave a false result. It is only meaningful with a real row present.

### Schema state after migrating

```
migration        033_devices.sql
queue states     QUEUED → PREPARING → READY → FILLING → PARKED_UNKNOWN
                 → AWAITING_REVIEW → SUBMITTED → CANCELLED → SKIPPED
match states     PENDING, QUEUED          (HELD retired and rejected)
run counter      awaiting_cap             (was held_by_cap)
new tables       devices, device_board_status, resume_deliveries,
                 application_records, application_qa
automatable      BUILTIN, CRUNCHBOARD, LINKEDIN, WELLFOUND
lookups          4 submission methods, 4 application statuses
tests            141 passed, 0 failed
```

---

## 45–50 · AI preparation worker

| # | Step | |
|---|---|:--:|
| 45 | Background job table + worker loop (attempts, backoff, dead-letter) | ⬜ |
| 46 | Choose the model and lock the cost model | ⬜ |
| 47 | Resume tailoring against the base resume | ⬜ |
| 48 | No-fabrication second pass — reject anything not present in the base | ⬜ |
| 49 | Fit scoring, including items awaiting the cap, so the next fill orders best-first | ⬜ |
| 50 | Preparation-failed state, visible on a dashboard, with base-resume fallback | ⬜ |

**Until this exists** `promoteToReady()` marks items ready without tailoring
anything. The gate is real; the work inside it is not. `READY` does not yet mean
"a tailored resume is attached".

## 51–58 · Desktop app, the app itself

| # | Step | |
|---|---|:--:|
| 51 | **D1** Electron shell, tray, SQLite, activation, machine binding, heartbeat, revocation wipe, report outbox | ⬜ |
| 52 | **D2** Playwright + bundled Chromium, persistent profile per board, step-aside login, session-expiry detection | ⬜ |
| 53 | **D3** Cycle engine: pull, lease, open, classify lane, local cap, file cleanup — no form filling yet | ⬜ |
| 54 | **D4** Filling engine + human pacing + unknown-question parking, against a synthetic form | ⬜ |
| 55 | **D5** Review screen with full Q&A; consultant submits; record written to hub | ⬜ |
| 56 | **D6** Board recipes — Wellfound, Built In, LinkedIn Easy Apply, CrunchBoard | ⬜ |
| 57 | **D7** electron-builder installer, code signing, auto-update | ⬜ |
| 58 | **D8** Crash reporting, logs, diagnostics bundle | ⬜ |

The hub side is finished, so D1 can start immediately. Board recipes (D6) are
deliberately last: the engine is built and tested against a synthetic form
first, and the four recipes are written once real page markup is available.

## 59–61 · Release

| # | Step | |
|---|---|:--:|
| 59 | Security review — the gate before any real candidate data enters (R-27) | ⬜ |
| 60 | Pilot: 3 consultants, 1 category, cap 5/day, 2 weeks, every application reviewed in week one | ⬜ |
| 61 | Then Dice, TheLadders, higher caps, onboard in groups of five | ⬜ |

---

## Locked decisions

| | |
|---|---|
| Desktop stack | Electron + Playwright, all JavaScript, `desktop/` in this repo |
| Browser | **Bundled Chromium** — pinned version, no machine dependency |
| Platform | Windows first; the codebase stays cross-platform |
| Boards, v1 | LinkedIn (Easy Apply only), Wellfound, Built In, CrunchBoard |
| TheLadders | Deferred pending the subscription decision |
| Off-board redirects | App opens the page, marks "needs you", consultant applies by hand |
| Resume in v1 | The approved base resume, behind the endpoint tailoring will later use |
| Recipes | Engine first against a synthetic form; real recipes when markup exists |

**Accepted risk, recorded deliberately:** bundled Chromium reports as
`Chromium` rather than `Google Chrome`, which is a second detection signal on
top of the automation flags Playwright already sets. On LinkedIn — the board
under the most conservative treatment — those two stack. Chosen knowingly; if
LinkedIn begins challenging, this is the first thing to change.

---

## Immediate next steps

1. **Step 36 — the demo posting seed.** Smaller than it looks and worth doing
   first: without it, nothing about matching, capping or the queue can be shown
   without spending API credits, which on the current plan is a real constraint.
2. **Step 38's UI** — wire the queue detail drawer to the endpoint that already
   exists and is verified.
3. **Steps 35 and 37** — manual posting entry with CSV import, and the
   consultant portal's own queue and applications.
4. **Then D1** — the Electron shell, against a hub that is finished and proven.
