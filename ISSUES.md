# Workflow Audit — after Phase 2 remediation

Full end-to-end trace of every user journey, with the suspicious paths tested against a running server rather than assumed. Supersedes the earlier register.

| Severity | Count | |
|---|---|---|
| 🔴 Critical — security | 2 | session revocation, login lockout |
| 🟠 High — workflow breaks | 5 | one is a regression from the pagination work |
| 🟡 Medium | 5 | |
| 🔵 Low / debt | 4 | |
| 💬 Workflow gaps (by design, not bugs) | 4 | |
| **Total** | **20** | |

---

## What works — verified end to end

These journeys were traced and behave correctly:

| Journey | Status |
|---|---|
| SUPER_ADMIN creates org + first admin in one transaction | ✅ |
| ORG_ADMIN creates recruiter and consultant; profile row auto-created | ✅ |
| Assignment and reassignment; history preserved, access moves immediately | ✅ |
| Consultant fills profile → only changed fields submitted | ✅ |
| Live profile untouched while pending; DB-enforced single pending request | ✅ |
| Recruiter sees only assigned consultants' requests; cross-tenant returns 404 | ✅ |
| Per-field approve/reject; approved values applied in the same transaction | ✅ |
| Rejected fields return with the reviewer's note and name/role | ✅ |
| Resume: magic-byte validation, one file per consultant, old file deleted | ✅ |
| Peer-admin password takeover blocked on all four endpoints | ✅ |
| Audit log append-only — blocked even for the superuser | ✅ |

The architecture holds. Everything below is a gap in it, not a flaw of it.

---

## 🔴 CRITICAL

### A-1 · Disabling an account does not end that person's session — ✅ FIXED (Phase 2.1)

> Fixed. `verifyToken` re-checks the account on every request and returns **401**
> so the client drops the session. See Phase 2.1 in PHASEWISE_IMPLEMENTATION.md.

**Tested against a live server:**

```
recruiter signs in, reads data      : 200
ORG_ADMIN disables the account      : done
SAME cookie, reads data again       : 200   ← still working
SAME cookie, opens approvals        : 200   ← still working
only /auth/me notices               : 401
fresh login attempt                 : 403
```

`verifyToken` verifies the JWT signature and nothing else — it never touches the database. The token stays valid for its full **24-hour** lifetime.

**Impact:** dismiss an employee and they keep full access for up to a day. They can read every consultant's data, download resumes, and approve profile changes. Only a page refresh (which triggers `/auth/me`) logs them out — and they have no reason to refresh.

The same applies to two other cases:
- **Organisation disabled** — login is blocked, existing sessions are not
- **Role changed** — demote a recruiter to consultant and their JWT still says `RECRUITER` for 24 hours

**Note:** `PHASEWISE_IMPLEMENTATION.md` test 13 claims *"Disable a user while they have a live session → their next action is rejected."* That has never been true. The doc is wrong and should be corrected alongside the fix.

**Fix:** have `verifyToken` load the user and check `is_active`, the organisation's `is_active`, and that the role still matches the token. That is one indexed primary-key lookup per request — sub-millisecond at this scale, and it closes all three cases at once.

---

### A-2 · Login lockout protects the wrong thing, and locks out the wrong people — ✅ FIXED (Phase 2.1)

> Fixed. Lockout is now per account via the `login_attempts` table, not per IP.

**Tested:**

```
12 wrong passwords -> 3 were 429 (IP limit)
correct password now : 429   ← the correct password is now refused
```

Two separate problems:

**The limit is per IP, not per account.** A staffing agency sits behind one NAT'd office IP. One person mistyping their password ten times locks out *everyone in the building* for 15 minutes — including the admin who would fix it.

**There is no per-account lockout at all.** `login_attempts` was specified in the phase plan and never built — migrations jump from `006_lookups` to `007_resume_artifacts`. `LOGIN_MAX_ATTEMPTS` and `LOGIN_LOCKOUT_MINUTES` sit unused in `.env.example`.

So the protection that blocks colleagues exists, and the protection that would actually stop credential stuffing does not.

**Fix:** key the limiter on `email + IP` rather than IP alone, and add the per-account lockout the plan already describes.

---

## 🟠 HIGH — workflow breaks

### B-1 · Users page role tabs are broken by pagination — *regression I introduced* — ✅ FIXED (Phase 2.1)

> Fixed. `?role=` filters in SQL; tab badges come from an org-wide counts aggregate.

`Users.jsx` fetches 25 rows, then filters client-side:

```js
const visible = users.filter((u) => u.role === activeTab);
```

With 30 consultants and 2 admins, page 1 is mostly consultants — the **Org Admins tab can show zero rows** even though admins exist. The tab count badges are also per-page, not per-organisation, so they under-report.

**Fix:** send `role` to the server and paginate within the tab. The endpoint already accepts `?role=`; the page just doesn't use it.

### B-2 · An unassigned consultant's request is invisible to every recruiter

`listChangeRequests` narrows a recruiter by *current* assignment. A consultant with no assignment — newly created, or whose recruiter was reassigned or disabled — submits a request that **only ORG_ADMIN can see**.

No error is raised. The consultant's screen says "awaiting approval" with no hint that nobody is watching. In a large organisation it sits indefinitely.

**Fix:** surface unassigned consultants with pending requests on the ORG_ADMIN dashboard, and tell the consultant their request is waiting on the admin rather than a recruiter.

### B-3 · A concurrent admin edit makes the reviewer's diff wrong

1. Consultant submits `phone: A → B`
2. ORG_ADMIN directly edits the same field to `C`
3. The pending request still displays `A → B`
4. Reviewer approves — `C` is silently overwritten by `B`

The reviewer was shown an old value that is no longer current, and made a decision on it.

**Fix:** re-read the live value when rendering the review screen and flag any field that has moved since submission.

### B-4 · The field registry no longer drives the complete/incomplete filter

`config/profileFields.js` is documented as *the* single source of required fields. But the SQL filter hardcodes them:

```sql
($4 = 'complete' AND p.phone IS NOT NULL AND p.city IS NOT NULL
 AND p.state IS NOT NULL AND p.work_auth_status_id IS NOT NULL
 AND p.base_resume_artifact_id IS NOT NULL)
```

Add a required field to the registry and the **badge** updates while the **filter** does not — the two then disagree about who is complete.

This directly contradicts the extensibility guarantee the registry was built for.

**Fix:** generate the predicate from `REQUIRED_FIELDS`, or drop the SQL filter and compute completeness in one place.

### B-5 · No way to upload a resume on a consultant's behalf

The consultant detail page shows **"No resume uploaded yet"** with no action beside it. `POST /management/consultants/:id/resume` works and is tested — nothing in the UI calls it.

An agency onboarding someone who emailed their CV has no way to attach it. The consultant must do it themselves and wait for approval.

Now more visible than before, because the detail page exists and dead-ends.

---

## 🟡 MEDIUM

### C-1 · The resume preview floods the audit log

**Tested:** `3 preview renders -> audit rows went 6 -> 9 (+3)`

Every iframe render writes a `Sent Resume` row. Opening the detail page logs one, clicking full-screen logs another, navigating back and forth logs more. Genuine downloads become impossible to pick out of the noise.

**Fix:** log previews as a distinct action (`Viewed Resume`) so the two are separable, or skip logging the inline variant.

### C-2 · A disabled consultant keeps a live pending request — ✅ FIXED (Phase 2.1)

> Fixed, and split by intent rather than treated as one case:
> **terminate** cancels the pending request in the same transaction (new
> `CANCELLED` status, migration 014); **suspend** deliberately keeps it, and
> the reviewer's queue flags the consultant as suspended instead. The review
> endpoint also refuses a stale decision on a terminated consultant.

Nothing cancels or flags it. A reviewer can approve profile changes for someone who can no longer sign in.

### C-3 · Reassignment mid-request transfers the reviewer silently

Consultant reassigned R1 → R2 with a request pending: R1 loses it from their queue, R2 gains it, neither is told. Defensible behaviour, but invisible — R1 may believe they still owe a decision.

### C-4 · Approvals rows don't link to the consultant's profile

`ConsultantDetail` now exists, but a reviewer deciding whether "Green Card" is plausible still cannot open the profile or resume from the approval row. One link would close it.

### C-5 · No loading state while paginating

Clicking **Next** leaves the previous page's rows on screen until the request returns. On a slow connection it looks like the click did nothing.

---

## 🔵 LOW / DEBT

| # | Issue |
|---|---|
| **D-1** | Sidebar polls `/portal/me` every 30s purely to count missing fields — amplified by the badge-refresh fix. A `{ missingCount }` endpoint would be a fraction of the payload |
| **D-2** | The iframe preview relies on the API and client being same-site. Works now (localhost ports, and `api.x.com`/`app.x.com` later); breaks if the API ever moves to a different registrable domain — would need a signed URL or a same-origin proxy |
| **D-3** | `sha256` computed and stored on every upload, still never read |
| **D-4** | `ProfileField` hardcodes `POST /portal/resume`, so it cannot be reused for B-5 or the parked admin editor |

---

## 💬 WORKFLOW GAPS — not bugs, but the flow is incomplete

### E-1 · No notifications anywhere
A consultant submits; the recruiter finds out only by visiting the Approvals page. A request is approved; the consultant finds out only by reopening their profile. No email, no in-app alert. Nothing is lost, but the loop depends on people checking.

### E-2 · Pending requests have no ageing signal
The row shows a submitted timestamp, but a request waiting five days looks identical to one from five minutes ago. There is no "oldest waiting" indicator to work from.

### E-3 · The consultant cannot explain a change
The reviewer sees `H1-B → Green Card` with no context. There is no note field on submission, so the reviewer must either guess or reject and ask.

### E-4 · The reviewer can only approve or reject
There is no "ask a question" state. Needing clarification means rejecting, which reads as a refusal and forces a full resubmission.

---

## Recommended order

**Before anything else — the two security items:**

| # | Issue | Effort |
|---|---|---|
| 1 | **A-1** session revocation | 1 hr |
| 2 | **A-2** per-account lockout + email-keyed rate limit | 2 hr |

**Then the workflow breaks:**

| # | Issue | Effort |
|---|---|---|
| 3 | **B-1** role tabs vs pagination *(my regression)* | 30 min |
| 4 | **B-4** registry-driven completeness filter | 45 min |
| 5 | **B-3** stale diff warning | 1 hr |
| 6 | **B-5** admin resume upload *(needs D-4 first)* | 1.5 hr |
| 7 | **B-2** unassigned-consultant visibility | 1 hr |

**Then the cheap quality wins:** C-1 (audit noise), C-4 (link to profile), C-5 (loading state) — about an hour together.

Roughly **one and a half days** for everything above the Low tier.

**E-1 through E-4 are product decisions, not defects** — worth deciding before Phase 3, since notifications in particular get harder to retrofit once more workflows depend on them.

---

## Correction to the docs — ✅ DONE

`PHASEWISE_IMPLEMENTATION.md` claimed two things that were not true:

- that a live session was rejected once the account was disabled (A-1: it was not)
- that lockout behaviour existed (A-2: it had never been built)

Both claims are gone, and both behaviours now genuinely exist — built in Phase
2.1 and covered by the automated suite plus the 2.1 manual gate. The Phase 1
"Account state" table is marked superseded rather than deleted, so the record of
what that phase actually covered stays honest.
