# Workflow Audit — after Phase 3

**Supersedes the post-Phase-2 register.** Everything in the previous file has been
re-checked: fixed items are recorded as closed with evidence, unfixed ones are
carried forward, and the Phase 3 code is audited for the first time.

**Method.** Static read of the whole codebase, plus live probes against a running
server on `localhost:5001` with the seeded two-org demo data. Findings marked
**tested** were reproduced against that server; findings marked **read-only** come
from reading the code and have not been executed. The distinction is deliberate —
the last audit's credibility came from not asserting what it had not run.

| Severity | Count | |
|---|---|---|
| 🔴 Critical — security | 0 | both prior criticals verified fixed |
| 🟠 High — workflow breaks | **2** | H-1 and H-2 fixed; 2 carried forward still open |
| 🟡 Medium | **5** | M-3 fixed; M-4 partly fixed; M-6 new in Phase 4 |
| 🔵 Low / debt | 6 | |
| ⚫ Environment | 1 | has interrupted work three times |
| 💬 By design, not bugs | 3 | |
| **Total open** | **14** | |

**Fixed:** H-1, H-2, M-3 — 28 assertions verifying the three, plus a 12-assertion
re-run of the criteria permission matrix confirming the `resolveConsultant` refactor
caused no regression.

**Partly fixed:** M-4 — Phase 4's suite is in the repo behind `npm test`; three
earlier suites are not.

**New in Phase 4:** M-6 (question-bank screen not built). M-5 widened — five more
screens and four more dialogs now exist that have never been rendered.

Three bugs were found and fixed *during* Phase 4 rather than surviving into this
register: `pageResult` called with the wrong signature (inbox pagination metadata was
garbage), `cancelledAnswers` missing from the terminate response, and a malformed
predicate in `classifyQuestion`.

---

## Closed since the last audit

| Ref | Was | Evidence it is closed |
|---|---|---|
| **A-1** | A disabled account kept its live session | `middleware/verifyToken.js` re-reads the user on every request and checks `employment_status`, org `is_active`, and that the token's role still matches. Returns **401** so the client drops the session. **Tested** in Phase 2.1. |
| **A-2** | Lockout was per-IP, locking out colleagues behind one NAT | `login_attempts` (migration 013) + `checkLockout(email)`. Per-IP limiter demoted to a volumetric backstop. |
| **B-1** | Users role tabs broken by pagination | `?role=` filters in SQL; tab badges come from an org-wide counts aggregate. |
| **C-2** | A pending request outlived the person who submitted it | Terminate cancels it in the same transaction (`CANCELLED`, migration 014); suspend deliberately keeps it and flags the reviewer. |
| **NEW-during-audit** | `OrganizationDetail.jsx` used `<EmploymentStatus>` without importing it — the super admin's org detail page threw `ReferenceError` on any org with users. Present since commit `bd90dd8`. | Fixed during the design-system work. Import added. A sweep of all 28 JSX files found no other undefined component. |

---

## 🟠 HIGH — workflow breaks

### H-1 · Terminating a consultant leaves their search criteria ACTIVE — ✅ FIXED

> Fixed. `terminateUser` now pauses the criteria in the **same transaction** as the
> termination, alongside releasing assignments and cancelling pending change
> requests — so the two states can never disagree. `paused_by` records who, and the
> audit line gains "(job discovery paused)".
>
> **Tested:**
> ```
> active before terminate      : true
> terminate                    : 200, pausedCriteria = 1
> criteria after terminate     : isActive = false, paused_at recorded
> ```
>
> **Deliberately NOT applied to suspend.** Suspension is reversible and the person
> is still an employee. Auto-pausing would need an auto-resume, and silently
> restarting job discovery on reactivation is a decision the admin should make
> rather than one to infer. Say the word if you want suspend to pause too.

```
before terminate: active = true
terminate        -> 200
AFTER terminate : criteria still active = true
```

`terminateUser` closes assignments and cancels pending change requests in its
transaction. It never touches `search_criteria`. The row keeps `is_active = true`
and a current version pointer.

Today that is inert — nothing reads criteria yet. **From Phase 5 it means the
discovery engine generates job matches for someone who no longer works there**,
and Phase 6 would tailor resumes for them. The whole point of Phase 2.1's
lifecycle work was that termination takes effect everywhere at once; criteria were
added afterwards and missed that rule.

**Fix:** in the same transaction as the termination, set
`search_criteria.is_active = FALSE` and record `paused_by`. Suspend should
probably do the same — but that is a product call: suspension is reversible, and
silently resuming discovery on reactivation may be either the desired behaviour or
a nasty surprise.

### H-2 · `toggle-active` lets you activate discovery for a terminated consultant — ✅ FIXED

> Fixed, and fixed structurally rather than by adding a third copy of the same
> check. `resolveConsultant` now takes `{ forWrite }` and owns the rule; the three
> write paths opt in, the three read paths do not. A new write endpoint has to opt
> **out** of the guard rather than remember to opt in — which is precisely how this
> was missed the first time.
>
> Return shape mirrors `resolveManageableUser` in `utils/scope.js`
> (`{ consultant }` or `{ error: { status, message } }`) so the 404/409 distinction
> survives.
>
> **Tested:**
> ```
> re-activate a terminated consultant : 409
> pause          (also a write path)  : 409
> save                                : 409
> restore                             : 409
> read criteria / list versions       : 200  ← read paths unaffected
> ```

```
re-ACTIVATE a terminated consultant -> 200  ALLOWED
save        for a terminated consultant -> 409  (correctly refused)
```

`saveCriteria` and `restoreCriteriaVersion` both refuse on
`employment_status === 'TERMINATED'`. `toggleCriteriaActive` has no such check, so
the one endpoint that decides *whether the system acts on the criteria at all* is
the one without the guard.

The inconsistency is the tell: the rule was applied to the paths that felt like
"editing" and missed the one that felt like a toggle.

**Fix:** the same TERMINATED guard in `toggleCriteriaActive`. Better, hoist it into
`resolveConsultant` with an `allowTerminated` opt-out for the read paths, so a
future endpoint cannot forget it. Sibling of H-1 and worth fixing together.

### H-3 · An unassigned consultant's change request is invisible to every recruiter — *carried forward, still open*

`listChangeRequests` narrows a recruiter by **current** assignment:

```sql
AND ($3::text IS NULL OR a.recruiter_id = $3)
```

A consultant with no current assignment — newly created, or whose recruiter was
terminated, which now releases the assignment — submits a request that only
ORG_ADMIN can see. No error is raised. The consultant's screen says "awaiting
approval" and nobody is watching.

Phase 2.1 made this **more** likely, not less: terminating a recruiter now closes
their assignments, orphaning every consultant they held.

**Fix:** surface unassigned consultants with pending requests on the ORG_ADMIN
dashboard, and tell the consultant their request sits with the admin.

### H-4 · A concurrent admin edit makes the reviewer's diff wrong — *carried forward, still open*

1. Consultant submits `phone: A → B`
2. ORG_ADMIN edits the same field directly to `C`
3. The pending request still displays `A → B` — `old_display` is a snapshot taken
   at submit time and never re-read
4. Reviewer approves, and `C` is silently overwritten by `B`

The reviewer was shown a value that is no longer current and decided on it.

**Fix:** re-read the live value when rendering the review screen and flag any field
that moved since submission.

---

## 🟡 MEDIUM

### M-1 · The field registry no longer drives the complete/incomplete filter — *carried forward*

`config/profileFields.js` is documented as the single source of required fields,
and `REQUIRED_FIELDS` is imported into `profileController.js` — but the SQL filter
hardcodes the list anyway:

```sql
($4 = 'complete' AND p.phone IS NOT NULL AND p.city IS NOT NULL
 AND p.state IS NOT NULL AND p.work_auth_status_id IS NOT NULL
 AND p.base_resume_artifact_id IS NOT NULL)
```

Add a required field and the **badge** updates while the **filter** does not. The
two then disagree about who is complete — directly contradicting the extensibility
guarantee the registry exists for.

**Fix:** generate the predicate from `REQUIRED_FIELDS`, or drop the SQL filter and
compute completeness in one place.

### M-2 · No way to upload a resume on a consultant's behalf — *carried forward*

`POST /management/consultants/:id/resume` works and is tested. Nothing in the UI
calls it. The consultant detail page shows "No resume uploaded yet" and dead-ends.
An agency onboarding someone who emailed their CV has no route in.

### M-3 · The resume preview floods the audit log — ✅ FIXED

> Fixed. `?disposition=inline` now logs **`Viewed Resume`** / "Previewed resume …";
> a real download still logs `Sent Resume` / "Downloaded resume …". Same
> authorisation on both paths — the fix is distinguishability, not silence, because
> a preview is still someone reading a CV.
>
> **Tested** — 2 previews + 1 download issued:
> ```
> Viewed Resume  +2
> Sent Resume    +1   ← was +3 before the fix
> ```
>
> `Viewed` falls through to the neutral colour in `AuditLogPanel`, matching the
> existing `Viewed Password` action. No colour-map change needed.

### M-4 · The test suites live in a scratchpad, not the repo — ◐ PARTLY FIXED

> **Phase 4's suite is in the repo**: `backend/tests/answers.test.mjs`, 60 HTTP
> assertions, wired to `npm test` and `npm run test:answers`. It passes **twice
> consecutively** — deliberately verified, because a suite that only passes on a
> clean database is not a regression check.
>
> It also **creates its own fixtures** rather than consuming the seeded demo
> accounts. That is a direct consequence of **L-6**: a suite naming
> `recruiter1@molina.local` breaks permanently the first time some other run
> terminates that account, which is exactly what happened to Phase 3's suite.
>
> **Still outstanding:** Phase 2.1's 48 assertions, the 33 assignment assertions,
> and Phase 3's 57 remain throwaway scripts in a temp directory. Phase 3's is
> additionally **unrunnable** now, since it logs in as a terminated account.
>
> **Remaining fix:** port those three to `backend/tests/`, using the
> self-provisioning fixture pattern the Phase 4 suite establishes.

### M-5 · The design-system refactor has never been rendered in a browser

Eighteen files were changed to route every popup through one `Modal`, every card
and button through `design/tokens.js`, and every role/status label through
`LookupContext`. It builds, and static analysis confirms no token is used without
being imported and no component is referenced without being in scope.

**But no page has been opened.** Build success does not catch a mis-nested dialog
or a layout that collapses. The four dialogs, the Users role tabs, and the super
admin org detail page all warrant a manual pass.

**Phases 3 and 4 have widened this considerably.** Never rendered, on top of the
refactor: the Search Criteria tab with its editor, version history, diff and restore
dialogs; `/portal/criteria`; the answer inbox with grouping and locked sensitive
items; `/portal/answers`; the Answers tab on Consultant Detail. That is five new
screens and four new dialogs verified only by `vite build` and static analysis.

**Fix:** install Playwright and add a smoke test that loads each route per role, or
click through the screens by hand once and record it.

### M-6 · Phase 4's question-bank screen was not built

`/management/questions` — proposal §4 item 23, the ORG_ADMIN screen for curating the
shared question set. The endpoints exist and are covered by tests (`GET`, `POST`,
`PATCH`, duplicate detection, the recruiter 403), but there is no page behind them.

Nothing is blocked: recruiters raise questions from the consultant's Answers tab, and
the 26 seeded standard questions cover the common cases. But an ORG_ADMIN cannot
retire a stale question or fix a mis-categorised one without calling the API directly
— and recategorising is exactly what the fail-safe classifier is designed to invite,
since it deliberately over-assigns unclear questions to owner review.

**Fix:** a list screen over `GET /management/questions` with an inline category select
and an active toggle.

---

## 🔵 LOW / debt

### L-1 · `GET /criteria` writes to the database

`ensureCriteriaRow` is called from every read path, including `getCriteria` and
`getMyCriteria`. A plain read creates a `search_criteria` row with the reader as
`created_by`.

It was chosen so no read path meets a missing row — the Phase 2 principle — and it
avoided a backfill migration. The cost is a non-idempotent GET: a recruiter merely
looking at a consultant leaves a row behind, attributed to them.

**Fix if it matters:** create the row in `createUser` alongside the profile, and
backfill once. The lazy path can then become a read that tolerates `null`.

### L-2 · The client's "unsaved changes" check disagrees with the server's

`CriteriaEditor` compares a `JSON.stringify` of the draft against the loaded
version. The server compares a **normalised** fingerprint — de-duplicated, with
`workTypeIds` sorted.

Untick and re-tick two work types in a different order and the client says
"unsaved changes", the Save button enables, and the server answers **409 Nothing
has changed**. Harmless but confusing.

**Fix:** apply the same normalisation client-side before comparing. The rules are
already in `config/criteriaSchema.js` and could be shared.

### L-3 · A concurrent double-save returns a generic 409

`writeVersion` computes `MAX(version_no) + 1` and inserts. Two simultaneous saves
both read the same max; `uq_version_no_per_consultant` catches the collision, and
`errorHandler` maps `23505` to *"That record already exists."*

Correct, but the message tells the user nothing. Vanishingly unlikely with one
editor per consultant.

**Fix:** catch `23505` in `saveCriteria` and retry once, or return "Someone else
saved at the same moment — reload and try again."

### L-4 · `AuditLogPanel` reads `localStorage` instead of the auth context

```js
if (localStorage.getItem('userRole') !== 'ORG_ADMIN') return null;
```

It works — `AuthContext` writes `userRole` on login and on `/auth/me` — and the
server enforces `isOrgAdmin` regardless, so this is cosmetic. But it is the only
component reading role from storage rather than `useAuth()`, and storage can be
stale where the context cannot.

### L-5 · Lookup labels differ before the lookup arrives

`LookupContext` falls back to `humanise()` when `/api/lookups` has not landed,
turning `ORG_ADMIN` into "Org Admin". The lookup says "Organization Admin". A brief
flash of the wrong label on first paint, and the permanent label if the fetch
fails.

**Fix:** hold the badge blank until `ready`, or seed the fallback from the same
labels. Not worth much — but worth knowing why the text sometimes differs.

### L-6 · The demo database has degraded past the point of being a good demo — **worse than first recorded**

A count of Molina users during the fix round:

```
TERMINATED  CONSULTANT  × 20   (mostly temp.consultant.* from old suite runs)
TERMINATED  RECRUITER   ×  7
TERMINATED  RECRUITER   recruiter1@molina.local     ← the primary demo recruiter
ACTIVE      CONSULTANT  ×  5
ACTIVE      RECRUITER   ×  3
```

**`recruiter1@molina.local` (Riya Recruiter) is terminated.** She is the recruiter
named in the login table of `PHASEWISE_IMPLEMENTATION.md`, the one every manual test
gate uses, and the one holding consultants 1–2. Termination is permanent by design,
so she cannot be brought back — the seeded scenario the docs describe no longer
exists in this database.

This is not a code fault. Automated suites across several sessions create and
terminate accounts, and nothing resets between runs. It broke the Phase 3 suite
during this round: it could not log in as `recruiter1` and aborted before its first
assertion. The permission matrix was re-verified against `recruiter2` instead, and
passed 12/12 — but the suite as written is now unrunnable.

**Fix:** re-seed. The seeds are idempotent and would restore Riya as a fresh ACTIVE
row only if the email were free, which it is not — so this needs a real reset:

```powershell
wsl -d Ubuntu -u root -- su - postgres -c "dropdb staffing_autopilot && createdb staffing_autopilot"
# then re-grant roles per DATABASE_ACCESS.md, and:
cd backend ; npm run migrate
```

Destructive and therefore yours to run. Worth pairing with **M-4** — suites that
live in the repo can be written to create and clean up their own fixtures instead of
consuming the demo data.

---

## ⚫ ENVIRONMENT

### E-1 · WSL tears down the distro ~10 seconds after the last session exits — **tested**

This has interrupted work three times and looked like a database fault every time.

```
booted-and-ready
+  5s -> distro Running=True   port5432=True
+ 15s -> distro Running=False  port5432=False
```

Postgres is not at fault. It starts correctly and systemd already has
`postgresql.service` **enabled**. WSL terminates the whole Ubuntu VM once no
`wsl.exe` client session is attached, and port 5432 disappears with it. The backend
then fails at boot with `ECONNREFUSED` on both `::1` and `127.0.0.1`, and nodemon
exits.

Because the VM must be *running* for the port to exist, **a connection attempt
cannot wake it** — there is nothing listening to trigger a start.

**Two consequences to fix:**

1. `/etc/wsl.conf` now has a **duplicate `[boot]` section**, appended during
   troubleshooting on top of an existing one:
   ```ini
   [boot]
   systemd=true

   [user]
   default=dhanush

   [boot]
   command = service postgresql start
   ```
   The second section is ignored by the INI parser and is redundant anyway, since
   systemd already starts Postgres. Restore it with:
   ```powershell
   wsl -d Ubuntu -u root -- bash -c "printf '[boot]\nsystemd=true\n\n[user]\ndefault=dhanush\n' > /etc/wsl.conf"
   ```

2. Something must hold the distro open. A hidden startup entry running a
   long-lived session is the reliable fix:
   ```powershell
   $s = (New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\wsl-keepalive.lnk")
   $s.TargetPath  = "$env:SystemRoot\System32\wsl.exe"
   $s.Arguments   = "-d Ubuntu -u root -- sleep infinity"
   $s.WindowStyle = 7
   $s.Save()
   ```
   Delete any earlier `wsl-postgres.lnk` — it ran `wsl … -- true`, which exits
   immediately and lets the distro die seconds later.

---

## 💬 By design — not bugs

### D-1 · Nothing reads search criteria yet

Phase 3 delivers the editor, the versioning and the schema. The consuming engine is
Phase 5. Stated in the proposal and accepted before implementation.

### D-2 · The "postings that would have matched" preview was not built

Plan item 25. There are no job postings in the database, so the number could only
be fabricated. A fake number on a real screen is worse than no number.

### D-3 · Consultants cannot propose criteria changes

R-23. A profile field is a fact about the consultant, so they assert it and a
reviewer checks. Criteria are a business decision about how to spend the
application budget, so the recruiter owns them outright. Enforced by there being no
consultant-facing write endpoint — **tested**: a consultant hitting the management
write route gets 403, and the portal route accepts no id parameter at all.

---

## Documentation corrections needed

| Doc | Claim | Reality |
|---|---|---|
| `PHASEWISE_IMPLEMENTATION.md` test **#22** | superadmin → `GET /api/lookups` → **403** | Returns **200** — **tested**. The route carries only `verifyToken`, not `isTenantUser`. Arguably correct behaviour (lookups are global reference data, and the super admin's own screens need role labels), so the **doc** is what should change, not the guard. Same class of false assurance as the A-1 claim already corrected. |
| `PHASEWISE_IMPLEMENTATION.md` | Phase 3 listed as ⬜ Next | Phase 3 is complete: migrations 016–018 applied, 57 assertions green. The phase record has not been appended to. |

---

## What was verified working, end to end

Traced and behaving correctly:

| Journey | Status |
|---|---|
| Session revocation — suspend/terminate/demote ends the session on the next request | ✅ |
| Per-account lockout; a different user on the same machine still signs in | ✅ |
| Cross-tenant isolation across every Phase 3 endpoint (404, never 403) | ✅ tested |
| Recruiter scoping — assigned consultants only, by URL as well as by list | ✅ tested |
| Bulk assignment editing from either end, reconciling to a desired end state | ✅ 33 assertions |
| Criteria versioning — append-only, one current version, restore copies forward | ✅ tested |
| Pause does not fork a version; an unconfigured set cannot be activated | ✅ tested |
| Pay and location rules refused at the API and unstorable at the database | ✅ tested |
| Audit rows for save, pause and resume, naming the editor and what moved | ✅ tested |
| Audit log append-only — blocked even for the superuser | ✅ |

The architecture holds. Every item above is a gap in it, not a flaw of it.
