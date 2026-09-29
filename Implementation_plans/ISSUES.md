# System Audit

**Replaces the previous "Workflow Audit — after Phase 3" entirely.** Everything
below was re-verified against the running code and the live database rather than
carried across on trust; issues that turned out to be fixed have been dropped
rather than listed as closed.

**Audited against:** migrations through `031_org_settings_and_providers.sql`
(applied), 141 unit assertions passing, client building clean.

**Markers:** ✅ fixed this pass · 🟡 costs time or hides the truth · 🔵 debt ·
⚫ environment · 💬 deliberate.

| | Open | Fixed this pass |
|---|---:|---:|
| 🔴 Critical | 0 | 2 |
| 🟠 High | 0 | 3 |
| 🟡 Medium | 4 | 3 |
| 🔵 Low / debt | 5 | 1 |

**Needs `npm run migrate`** — migration `032_retire_held_matches.sql` is written
but **not dry-run verified**: PostgreSQL stopped mid-verification (E-1 below).
Start the database and apply it before trusting the M-1 fix.

---

## ✅ Fixed in this pass

| Was | What changed |
|---|---|
| **C-1** toggle 500s | `updateSource` no longer writes the health columns migration `031` dropped |
| **C-2** provider toggle did nothing | `PROVIDER` rows now write `organization_providers`; `PORTAL` rows keep the global flag. `listSources` overlays the per-agency value so the switch shows its true position |
| **H-1** housekeeping never ran | `startQueueMaintenance()` has its own 10-minute cron, deliberately **not** gated on `DISCOVERY_ENABLED` |
| **H-2** unassigned requests invisible | Flagged `is_unassigned` and sorted first in the approvals list, with a badge on the screen |
| **H-3** lost update on approve | The live row is re-read inside the approve transaction and compared against the submit-time snapshot; anything that moved returns **409** naming the fields |
| **M-1** dead `HELD` state | Migration `032` returns stranded rows to `PENDING`, drops `HELD` from the constraint, and renames `held_by_cap` → `awaiting_cap` |
| **M-2** unbounded queue screen | Queue listing defaults to actionable states, takes `?status=`/`?limit=`, and returns `total_count` |
| **M-4** promotion only inside a run | `promoteToReady()` also runs on the maintenance timer |
| **L-4** identity from `localStorage` | `AuditLogPanel` reads the auth context |

> **H-3 turned out to be different from its description.** The snapshot it asked
> for already existed — `old_value` is captured at submit and the screen already
> renders it, so the diff was never wrong. The real defect was the *approve*
> path writing blind: an admin editing the same field in the meantime had their
> change silently overwritten. That is what was fixed.

---

## 🟡 MEDIUM — costs time or hides the truth

### M-3 · Nothing prepares a queue item; `promoteToReady` marks it ready anyway

The readiness gate exists and is enforced, but the preparation stage that belongs
inside it does not. `promoteToReady()` moves items `QUEUED → READY` without
tailoring a resume or scoring anything.

This is the intended placeholder for the AI stage and behaves as designed —
recorded so nobody reads `READY` as "a tailored resume is attached", which is
what it will mean later.

---

### M-5 · Phase 4's question-bank screen was never built

*Carried forward, re-verified: `client/src/pages/management/` contains no
questions page.* The endpoints exist and are tested; the ORG_ADMIN curation
screen is not there. Recruiters can raise questions from the consultant tab, so
nothing is blocked, but the shared bank cannot be edited through the UI.

---

### M-6 · Most screens have still never been rendered in a browser

The discovery screen has now been seen running. The rest — approvals, answers
inbox, postings, consultant detail tabs, the portal pages — build and pass static
analysis but have not been opened. Every phase adds more, and the unverified
surface keeps compounding.

---

### M-7 · One of the two test suites needs a live server

`discovery.test.mjs` is pure and runs anywhere: 141 assertions, no network, no
database. `answers.test.mjs` is HTTP-level and fails with `fetch failed` unless a
seeded backend is listening on `:5001`, so it is in no automated run.

**Fix:** mark it clearly as a manual integration suite, or give it a harness that
starts the server.

---

## 🔵 LOW / debt

### L-1 · `GET /criteria` writes to the database

`ensureCriteriaRow()` runs an INSERT on a read path, to cover consultants that
predate Phase 3. Idempotent and deliberate, but it means a GET can fail on a
read-only replica and shows as a write in any audit of read traffic.

### L-2 · The client's "unsaved changes" check disagrees with the server's

*Carried forward.* The criteria editor's dirty-check and the server's
change-detection use different comparisons, so a save can be refused as unchanged
while the screen shows differences.

### L-3 · A concurrent double-save returns a generic 409

*Carried forward.* Two saves of the same criteria produce a constraint violation
surfaced as an unexplained conflict rather than "someone else just saved this".

### L-5 · Lookup labels flash raw enum names

*Carried forward.* Screens render `AWAITING_REVIEW` for a frame before
`LookupContext` resolves it to "Awaiting review".

### L-6 · The demo database is not a good demo

Re-counted live:

| Organisation | Role | Active | Terminated |
|---|---|---:|---:|
| Molina Staffing | Consultant | 14 | **27** |
| Molina Staffing | Recruiter | 17 | 7 |
| Apex Staffing | all roles | 3 | 0 |
| `test_new` | all roles | 3 | 0 |

Better than when first recorded, but two-thirds of Molina's consultants are
terminated, there are 17 active recruiters for 14 active consultants, and a stray
`test_new` organisation sits in the demo data. Cap logic, overlap and assignment
scoping are all hard to demonstrate convincingly on that shape.

20 postings and 5 queue items exist, so the pipeline does have something to show.

---

## ⚫ ENVIRONMENT

### E-1 · WSL tears down the distro shortly after the last session exits

PostgreSQL runs in WSL2 and does not auto-start. After a Windows reboot — or
simply after the last WSL session closes — the database is unreachable until:

```bash
wsl -d Ubuntu -u root -- service postgresql start
```

Every "cannot connect" report so far has traced back to this.

---

## 💬 By design — not bugs

**Consultants cannot edit their own search criteria.** No screen, no route. R-23
enforced by absence, deliberately.

**Postings are re-matched every run, not only newly-seen ones.** R-15 says only
postings first seen since the previous run move forward. The engine matches all
active postings instead, so a job found yesterday still reaches a consultant
whose criteria changed this morning, or who was at their cap. A recorded,
approved deviation.

**Google's recency filter cannot be narrower than a day.** No four-hour window
exists at any price. "Only jobs since the last cycle" is delivered by fingerprint
de-duplication, not by the request.

**A LinkedIn job cannot be lane-classified at ingest.** Easy Apply and an external
redirect are identical in the apply link. LinkedIn enters the BOT lane and the
desktop app reclassifies on open.

**The API key never reaches the database.** `organization_providers` stores the
*name* of the environment variable holding it, and request URLs are redacted
before retention.

---

## What was verified working

- Migrations `027`–`031` applied cleanly; every CHECK constraint rejects bad input
- `application_records` and `application_qa` refuse UPDATE and DELETE with a real
  row present — re-tested after an earlier check gave a false pass against an
  empty table
- Queue vocabulary correct, retired states gone: `QUEUED → PREPARING → READY →
  FILLING → PARKED_UNKNOWN → AWAITING_REVIEW → SUBMITTED → CANCELLED → SKIPPED`
- The state machine refuses `QUEUED → SUBMITTED`, refuses to leave `SUBMITTED` at
  all, and requires a reason for `SKIPPED`, `CANCELLED` and `PARKED_UNKNOWN`
- Cap accounting: `QUEUED` and `PREPARING` hold no slot; `READY`, `FILLING`,
  `AWAITING_REVIEW` and `SUBMITTED` do
- `chips` is never sent — the deprecated parameter is gone, `uds` replaces it
- The recency handle is extracted from both response shapes SerpApi emits
- Per-agency intervals: clamping, due-checks and next-run arithmetic
- Management can upload a resume on a consultant's behalf
  (`POST /api/management/consultants/:id/resume`) — a previously recorded gap,
  now closed and dropped from this register
- 141 assertions pass; client builds; every changed module loads
