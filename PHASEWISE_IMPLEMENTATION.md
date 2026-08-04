# Phase-wise Implementation Record

**The running record of what has been built.** Each completed phase is appended here — this file is never replaced, only added to.

| Phase | Delivered | Status |
|---|---|---|
| **1** | Multi-tenant RBAC — 4 roles, 3 portals, audit log | ✅ Complete |
| **2** | Consultant profiles + self-service edit & approval workflow | ✅ Complete |
| 3 | Search criteria | ⬜ Next |
| 4 | Answer bank + approvals | ⬜ Planned |
| 5 | Job queue + application records | ⬜ Planned |
| 6 | Contacts | ⬜ Planned |

**Stack:** Node 24 · Express 5 · PostgreSQL (WSL2) · React 19 · Vite · Tailwind v4 · JWT httpOnly cookie · raw parameterised SQL, no ORM

---

# Environment

| Component | Where |
|---|---|
| PostgreSQL | WSL2 → Ubuntu |
| Backend | `http://localhost:5001` |
| Frontend | `http://localhost:5173` |
| Database | `staffing_autopilot` |

**After every Windows reboot** (Postgres does not auto-start):

```powershell
wsl -d Ubuntu -u root -- service postgresql start
```

**Run:**

```powershell
cd backend ; npm run dev      # terminal 1
cd client  ; npm run dev      # terminal 2
```

**Apply new migrations:**

```powershell
cd backend ; npm run migrate
```

Database roles and DBeaver setup: see `DATABASE_ACCESS.md`.

---

# Login accounts

| Email | Password | Role | Organization |
|---|---|---|---|
| `superadmin@staffing.local` | `SuperAdmin@123` | SUPER_ADMIN | *(none — platform)* |
| `admin@molina.local` | `Admin@123` | ORG_ADMIN | Molina Staffing |
| `recruiter1@molina.local` | `Recruiter@123` | RECRUITER | Molina Staffing |
| `recruiter2@molina.local` | `Recruiter@123` | RECRUITER | Molina Staffing |
| `consultant1@molina.local` … `consultant4@` | `Consultant@123` | CONSULTANT | Molina Staffing |
| `admin@apex.local` | `Admin@123` | ORG_ADMIN | Apex Staffing |
| `recruiter1@apex.local` | `Recruiter@123` | RECRUITER | Apex Staffing |
| `consultant1@apex.local` | `Consultant@123` | CONSULTANT | Apex Staffing |

Assignments: consultants 1–2 → recruiter1 · consultants 3–4 → recruiter2

**Two organizations exist deliberately** — cross-tenant isolation cannot be tested with only one.

---

# Architecture — three enforcement layers

Applies to every phase.

**Layer 1 — route guards** (`middleware/roleGuards.js`)
`isSuperAdmin` · `isOrgAdmin` · `isManagement` · `isConsultant` · `isTenantUser`
Applied as `app.get('/api/x', [verifyToken, isManagement], handler)`.
**Rule:** lifecycle routes are `isOrgAdmin` only, even where read is broader.

**Layer 2 — tenant scoping** (`utils/scope.js`, in every query)
Every query carries `WHERE organization_id = $1`, sourced from `req.user.orgId` — which comes from the **signed JWT**, never from the body, query string, or params. Recruiters narrow further via `getAssignedConsultantIds()`.
**This is the layer that actually prevents cross-tenant access.**

**Layer 3 — frontend guard** (`ProtectedRoute`, sidebar filtering)
UX only, never trusted. Nav items filtered by the same role lists used on the routes.

---
---

# PHASE 1 — Multi-tenant RBAC ✅

## What was built

### Migrations `001`–`006` — 9 tables

| Migration | Creates |
|---|---|
| `001_extensions_and_helpers.sql` | `pgcrypto`, `citext`, shared `set_updated_at()` trigger |
| `002_organizations.sql` | `organizations` — the tenant root |
| `003_users.sql` | `users` — 4 roles, AES passwords, `chk_org_required` |
| `004_assignments.sql` | `assignments` — consultant ↔ recruiter with history |
| `005_audit_logs.sql` | `audit_logs` + append-only trigger + privilege revoke |
| `006_lookups.sql` | `lkp_genders`, `lkp_user_statuses`, `lkp_work_auth_statuses`, `lkp_roles` |

### Conventions applied throughout

- UUID PKs — `CHAR(36)`, generated in Node with `uuidv4()`
- `lookup_id INT GENERATED ALWAYS AS IDENTITY` on every business table
- `organization_id CHAR(36)` on every business table, `ON DELETE CASCADE`
- Audit columns everywhere — `created_by`, `created_at`, `updated_by`, `updated_at`
- Never row deletes. Accounts move through `employment_status`
  (`ACTIVE` → `SUSPENDED` ⇄ back, or → `TERMINATED`, which is terminal);
  `is_active` is a generated column derived from it — see Phase 2.1
- Composite indexes `(organization_id, <frequent filter>)`
- Lookup tables prefixed `lkp_`, served in one call

### PostgreSQL translations of the MySQL conventions

| MySQL | PostgreSQL used here |
|---|---|
| `ON UPDATE CURRENT_TIMESTAMP` | shared `set_updated_at()` trigger per table |
| `ENUM(...)` | `VARCHAR + CHECK` — adding a role later is a one-line `ALTER` |
| `INT AUTO_INCREMENT` | `INT GENERATED ALWAYS AS IDENTITY` |
| `ON DUPLICATE KEY UPDATE` | `ON CONFLICT ... DO UPDATE` |
| Split statements on `;` | Not needed — `node-pg` runs multi-statement strings natively, so triggers and `DO $$` blocks work without isolation |

### Migration runner — `backend/migrate.js`

- Reads `db/migrations/*.sql`, sorted by 3-digit prefix
- Skips anything already in `schema_migrations`
- **Each file runs in its own transaction**, rolls back on failure
- **Exits `1` on failure** so CI catches it
- Connects as `migrator_role`, not the runtime `app_role`
- Then runs seeds on individually-commentable lines

### Endpoints

```
POST   /api/auth/login                          public, rate-limited 10/15min
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/change-password

GET    /api/super-admin/stats                   SUPER_ADMIN
GET    /api/super-admin/organizations
GET    /api/super-admin/organizations/:id
POST   /api/super-admin/organizations           creates org + first ORG_ADMIN in one transaction
PATCH  /api/super-admin/organizations/:id
POST   /api/super-admin/organizations/:id/toggle-active

GET    /api/management/stats                    ORG_ADMIN + RECRUITER
GET    /api/management/users                    RECRUITER narrowed to assigned
POST   /api/management/users                    ORG_ADMIN only
PATCH  /api/management/users/:id                 ORG_ADMIN only
POST   /api/management/users/:id/suspend          ORG_ADMIN only (reversible)
POST   /api/management/users/:id/reactivate       ORG_ADMIN only
POST   /api/management/users/:id/terminate        ORG_ADMIN only (permanent)
GET    /api/management/users/:id/password        ORG_ADMIN only, audited
POST   /api/management/users/:id/reset-password  ORG_ADMIN only
GET    /api/management/assignments
POST   /api/management/assignments               ORG_ADMIN only
GET    /api/management/audit-logs/:module        ORG_ADMIN only

GET    /api/portal/me                            CONSULTANT
GET    /api/portal/dashboard                     CONSULTANT

GET    /api/lookups                              any authenticated tenant user
GET    /api/health
```

### Screens

| Route | Role | Page |
|---|---|---|
| `/` | public | Login |
| `/unauthorized` | any | Access denied |
| `/super-admin` | SUPER_ADMIN | Platform dashboard |
| `/super-admin/organizations` | SUPER_ADMIN | Organizations — create, disable |
| `/management` | ORG_ADMIN + RECRUITER | Dashboard (different stats per role) |
| `/management/users` | ORG_ADMIN | Users — 3 role tabs, password reveal, reset |
| `/management/assignments` | ORG_ADMIN | Assign consultants, history |
| `/management/consultants` | RECRUITER | My Consultants (assigned only) |
| `/portal` | CONSULTANT | Dashboard |
| `/portal/profile` | CONSULTANT | My Profile |

## Security properties achieved

| Property | How | Verified |
|---|---|---|
| Cross-tenant isolation | `organization_id` from JWT in every query | Molina admin gets 404 on Apex user IDs |
| Recruiter scoping | `assignments` join, `effective_to IS NULL` | Reassignment removes access immediately |
| Consultant self-scope | every portal query filters `req.user.id` | No id parameter accepted |
| **Audit log immutability** | trigger + privilege revoke, two independent layers | Blocked for `app_role`, `migrator_role` **and** `postgres` |
| No account enumeration | identical response for unknown email and wrong password | Confirmed |
| SQL injection blast radius | API runs as `app_role` — no DDL, no audit mutation | Proven with a live privilege probe |
| Password reveal accountability | one user per request, org-scoped, every reveal audited | Recruiter 403, cross-org 404, list payload clean |

### Verified database privilege matrix

| Operation | `app_role` | `migrator_role` | `postgres` |
|---|:---:|:---:|:---:|
| CRUD on business tables | ✅ | ✅ | ✅ |
| `INSERT` into `audit_logs` | ✅ | ✅ | ✅ |
| `UPDATE`/`DELETE` on `audit_logs` | ❌ | ❌ | ❌ |
| `CREATE`/`ALTER`/`DROP TABLE` | ❌ | ✅ | ✅ |
| `CREATE ROLE` | ❌ | ❌ | ✅ |

## Decisions locked

| Decision | Choice |
|---|---|
| Roles | 4 — `SUPER_ADMIN`, `ORG_ADMIN`, `RECRUITER`, `CONSULTANT` |
| SUPER_ADMIN tenancy | `users.organization_id` nullable + `CHECK`; every other table `NOT NULL` |
| Two-step verification | **Not implemented** — username + password only |
| Password storage | **AES-256-GCM, reversible** — enables the reveal feature |
| Assignments | In Phase 1 — recruiter scoping is untestable without it |
| Database | PostgreSQL in WSL2 Ubuntu |
| Styling | Tailwind v4 only, no component library |

### ⚠️ Known security posture

**Passwords are encrypted, not hashed.** Anyone holding both a database dump and `PASSWORD_ENC_KEY` recovers every plaintext password. Chosen deliberately to enable the password-reveal feature. Documented in `backend/utils/crypto.js`.

Mitigations: reveal is ORG_ADMIN-only, org-scoped, one user per request, never in list payloads, every reveal audited.

## Manual test gate — Phase 1

### Login and routing
| # | As | Do | Expect |
|---|---|---|---|
| 1 | superadmin | Sign in | `/super-admin`, sidebar = Platform + Organizations only |
| 2 | admin@molina | Sign in | `/management`, sidebar = Dashboard, Users, Approvals, Assignments |
| 3 | recruiter1@molina | Sign in | `/management`, sidebar = Dashboard, My Consultants, Approvals |
| 4 | consultant1@molina | Sign in | `/portal`, sidebar = Dashboard, My Profile |
| 5 | any | Wrong password | "Invalid email or password." |
| 6 | any | Non-existent email | **Identical message** — no enumeration |
| 7 | any | Refresh while signed in | Stays signed in |
| 8 | any | Sign out, press Back | Bounced to login |

### Layer 3 — frontend guard
| # | As | Do | Expect |
|---|---|---|---|
| 9 | recruiter1 | URL `/management/users` | → `/unauthorized` |
| 10 | consultant1 | URL `/management` | → `/unauthorized` |
| 11 | admin@molina | URL `/super-admin` | → `/unauthorized` |
| 12 | superadmin | URL `/portal` | → `/unauthorized` |

### Layer 1 — API role guards
| # | As | Endpoint | Expect |
|---|---|---|---|
| 13 | recruiter1 | `GET /api/super-admin/organizations` | **403** |
| 14 | recruiter1 | `POST /api/management/users` | **403** |
| 15 | recruiter1 | `DELETE /api/management/users/:id` | **403** |
| 16 | recruiter1 | `POST /api/management/assignments` | **403** |
| 17 | recruiter1 | `GET /api/management/audit-logs/users` | **403** |
| 18 | consultant1 | `GET /api/management/users` | **403** |
| 19 | consultant1 | `GET /api/super-admin/stats` | **403** |
| 20 | admin@molina | `GET /api/super-admin/organizations` | **403** |
| 21 | superadmin | `GET /api/management/users` | **403** |
| 22 | superadmin | `GET /api/lookups` | **403** |
| 23 | no cookie | `GET /api/auth/me` | **401** |

### Layer 2 — tenant isolation (critical)
| # | As | Do | Expect |
|---|---|---|---|
| 24 | admin@molina | Open Users | **Only Molina users**, zero Apex |
| 25 | admin@apex | Open Users | Only Apex users |
| 26 | admin@molina | `PATCH /api/management/users/<apex-id>` | **404** |
| 27 | admin@molina | `DELETE /api/management/users/<apex-id>` | **404** |
| 28 | admin@molina | Assign an Apex consultant | **404** |

### Recruiter assignment scoping
| # | As | Do | Expect |
|---|---|---|---|
| 29 | recruiter1 | My Consultants | Exactly consultants 1 and 2 |
| 30 | recruiter2 | My Consultants | Exactly consultants 3 and 4 |
| 31 | admin@molina | Reassign consultant1 → recruiter2 | Saved, history row appears |
| 32 | recruiter2 | Reload | Now shows 1, 3, 4 |
| 33 | recruiter1 | Reload | consultant1 **gone** |
| 34 | admin@molina | Assignments → History | Old row has `effective_to`; nothing overwritten |

### Audit log
| # | Do | Expect |
|---|---|---|
| 35 | admin creates a user, expand Activity log | `Added User` in green |
| 36 | admin suspends a user, refresh | `Suspended User` in red |
| 37 | recruiter1 looks for Activity log panel | **Not rendered** — ORG_ADMIN only |
| 38 | psql: `UPDATE audit_logs SET action='x';` | **ERROR: audit_logs is append-only** |
| 39 | psql as `app_role`: `DELETE FROM audit_logs;` | **permission denied** |

### Account state
> Superseded by the Phase 2.1 lifecycle gate. Kept to show what Phase 1
> covered; run the 2.1 table instead.

| # | As | Do | Expect |
|---|---|---|---|
| 40 | admin@molina | Suspend consultant1 | Marked Suspended |
| 41 | consultant1 | Sign in | Refused — "access has been suspended" |
| 42 | admin@molina | Suspend own account | **400** blocked |
| 43 | admin@molina | Suspend another ORG_ADMIN | **403** blocked |

### Password reveal
| # | As | Do | Expect |
|---|---|---|---|
| 44 | admin@molina | Users → eye icon | Password revealed, auto-hides after 30s |
| 45 | admin@molina | Activity log | `Viewed Password` recorded |
| 46 | recruiter1 | `GET /api/management/users/:id/password` | **403** |
| 47 | admin@molina | Same for an Apex user id | **404** |
| 48 | any | Check `GET /users` response | **No password field** in the list payload |

---
---

# PHASE 2 — Consultant Profiles & Approval Workflow ✅

## The problem solved

After Phase 1 a consultant was just a login. Phase 2 makes them a real candidate record — and lets them **maintain their own details**, subject to approval.

## The workflow

```
ORG_ADMIN creates consultant           → profile row auto-created, mostly empty
        │
CONSULTANT logs in                     → sidebar badge: "My Profile ⑤"
        │
Opens My Profile                       → fills or edits fields
        │
Clicks "Submit for approval"           → ONLY changed fields become a request
        │                                 live values stay UNCHANGED
        ▼
Approvals tab (ORG_ADMIN + RECRUITER)  → each field approved or rejected individually
        │
   ┌────┴────┐
APPROVE    REJECT (note required)
   │          │
   │          └→ consultant sees the note, revises, resubmits
   ▼
Approved values become LIVE            → only now used for job matching
```

Mirrors §3.4 of the build specification: *consultant fills → recruiter approves → only then is it used.*

## What was built

### Migrations `007`–`010`

| Migration | Creates |
|---|---|
| `007_resume_artifacts.sql` | `resume_artifacts` — uploaded files with sha256 |
| `008_consultant_profiles.sql` | `consultant_profiles` — the **live (approved)** values |
| `009_profile_change_requests.sql` | `profile_change_requests` + `profile_change_request_fields` |
| `010_backfill_consultant_profiles.sql` | Profile rows for the already-seeded consultants |

**One pending request per consultant is enforced by the database**, not just the UI:

```sql
CREATE UNIQUE INDEX uq_one_pending_request_per_consultant
    ON profile_change_requests (consultant_id) WHERE status = 'PENDING';
```

A double-click or a stale tab cannot create a second.

### The field registry — `backend/config/profileFields.js`

**This is what makes the phase extensible.** One definition drives:

- the consultant's profile form
- the "profile incomplete" sidebar badge
- the change-request diff engine
- the reviewer's approval screen
- the whitelist of what a consultant may propose

**To add a new profile field later:**
1. Add the column in a new migration
2. Add one entry to the registry

Nothing else changes — no controller, form, or approval-screen edit.

Current fields:

| Field | Required | Consultant-editable |
|---|:---:|:---:|
| `phone` | ✅ | ✅ |
| `city` | ✅ | ✅ |
| `state` | ✅ | ✅ |
| `work_auth_status_id` | ✅ | ✅ |
| `base_resume_artifact_id` | ✅ | ✅ |
| `work_auth_notes` | — | ✅ |
| `linkedin_url` | — | ✅ |
| `daily_cap` | — | ❌ ORG_ADMIN only |
| `consent_on_file`, `consent_signed_at` | — | ❌ ORG_ADMIN only |
| `is_paused`, `notes` | — | ❌ ORG_ADMIN only |

### Endpoints

```
GET    /api/profile-schema                             the field registry
GET    /api/management/consultants                     list + completeness + pending flags
GET    /api/management/consultants/:id                 full profile
PUT    /api/management/consultants/:id/profile         ORG_ADMIN — direct write, no approval
GET    /api/management/consultants/:id/resumes         resume history
POST   /api/management/consultants/:id/resume          admin upload — applies immediately

GET    /api/management/profile-changes                 approvals queue (recruiter narrowed)
GET    /api/management/profile-changes/count           sidebar badge
POST   /api/management/profile-changes/:id/review      per-field approve/reject

GET    /api/portal/me                                  own profile + pending + last review
POST   /api/portal/resume                              consultant upload — pending approval
POST   /api/portal/profile/change-request              submit changed fields
DELETE /api/portal/profile/change-request              withdraw

GET    /api/resumes/:artifactId/download               ONE file, audited
```

### Screens

| Route | Role | What changed |
|---|---|---|
| `/portal/profile` | CONSULTANT | Now **editable**. Incomplete badge, pending lock, review outcome with approver name + role |
| `/management/approvals` | ORG_ADMIN + RECRUITER | **New.** Collapsible rows, per-field ✓/✗, reject notes |
| Sidebar | all | Live badges — pending approvals for reviewers, missing fields for consultants |

## Permission matrix

| Action | SUPER_ADMIN | ORG_ADMIN | RECRUITER | CONSULTANT |
|---|:---:|:---:|:---:|:---:|
| View profile | ✗ | all in org | **assigned only** | **self only** |
| Edit profile directly | ✗ | ✓ | ✗ | ✗ |
| Propose profile changes | ✗ | ✗ | ✗ | **✓ self** |
| Review changes | ✗ | **all in org** | **assigned only** | ✗ |
| Set daily cap | ✗ | **✓ only** | ✗ | ✗ |
| Upload resume | ✗ | ✓ immediate | ✓ immediate | ✓ pending approval |
| Download resume | ✗ | ✓ | assigned ✓ | own only |

## Design decisions

| Decision | Choice | Why |
|---|---|---|
| Profile row creation | **Auto** with the consultant user, in the same transaction | No read path ever handles a missing profile |
| Consultant edit scope | **Profile + resume**, not criteria | Criteria are a matching decision the recruiter owns |
| Approval granularity | **Field by field** | A reviewer can accept a phone change while rejecting work auth |
| Concurrent requests | **One at a time**, DB-enforced | Unambiguous "what is pending" |
| Approval + apply | **Same transaction** | A field can never be marked approved without going live |
| File validation | **Magic bytes**, not extension | A renamed `.exe` is rejected |
| Resume storage | `backend/uploads/<orgId>/<uuid>.ext` | User filenames never touch the filesystem |

## Manual test gate — Phase 2

### Consultant self-service
| # | As | Do | Expect |
|---|---|---|---|
| 1 | consultant1 | Sign in | Sidebar shows **My Profile ⑤** (5 required fields missing) |
| 2 | consultant1 | Open My Profile | Amber "profile incomplete" banner listing the missing fields |
| 3 | consultant1 | Submit without changing anything | Button disabled — "Change something first" |
| 4 | consultant1 | Fill phone, city, state, work auth → Submit | Blue "awaiting approval" panel listing the 4 changes |
| 5 | consultant1 | Check the form | **Locked read-only** while pending |
| 6 | consultant1 | Try to submit again | Blocked by the UI; API returns **409** |
| 7 | consultant1 | Click "Withdraw and edit again" | Form unlocks, request gone |

### Live values stay untouched
| # | Do | Expect |
|---|---|---|
| 8 | Submit changes, then check `consultant_profiles` in DBeaver | Columns still **NULL** — nothing applied yet |
| 9 | Sidebar badge while pending | Still shows the original missing count |

### Reviewer — recruiter scoping (critical)
| # | As | Do | Expect |
|---|---|---|---|
| 10 | recruiter1 | Open Approvals | Only **assigned** consultants' requests |
| 11 | recruiter2 | Open Approvals | consultant1's request **not** listed |
| 12 | admin@molina | Open Approvals | **All** consultants' requests |
| 13 | recruiter2 | `POST /api/management/profile-changes/<c1-req>/review` | **403** |
| 14 | admin@apex | Open Approvals | **0** — cross-tenant isolation |

### Per-field review
| # | As | Do | Expect |
|---|---|---|---|
| 15 | recruiter1 | Approvals → click the arrow | Row expands showing `old → new` per field |
| 16 | recruiter1 | Submit with one field undecided | **422** naming the missing field |
| 17 | recruiter1 | Reject a field | Note box appears; note reaches the consultant |
| 18 | recruiter1 | Approve 3, reject 1 → Submit | Status `PARTIALLY_APPROVED`, shown as `3✓ 1✗` |
| 19 | — | Check `consultant_profiles` | The 3 approved values are live; the rejected one is **still NULL** |

### Outcome visible to both sides
| # | As | Do | Expect |
|---|---|---|---|
| 20 | consultant1 | Reload My Profile | Outcome panel: approved/rejected per field |
| 21 | consultant1 | Read the panel | Names the reviewer **and their role** — e.g. "Riya Recruiter `RECRUITER`" |
| 22 | consultant1 | Check a rejected field | Reviewer's note shown |
| 23 | recruiter1 | Approvals → Approved tab | Row shows reviewer name + role |
| 24 | consultant1 | Submit again after review | Allowed — the previous request is closed |

### Resume upload
| # | As | Do | Expect |
|---|---|---|---|
| 25 | consultant1 | Upload a PDF | "New file — submit to send for approval" |
| 26 | consultant1 | Submit, before approval | Live `base_resume_artifact_id` unchanged |
| 27 | recruiter1 | Approve the resume field | Now live; consultant can download it |
| 28 | any | Rename a `.exe` to `.pdf` and upload | **422** — magic-byte check |
| 29 | any | Upload a 20 MB file | Rejected on size |
| 30 | consultant2 | Download consultant1's resume by URL | **403** |
| 31 | admin@molina | Download, then check Activity log | `Sent Resume` recorded with actor + IP |

### Audit
| # | Do | Expect |
|---|---|---|
| 32 | Expand Activity log on the Approvals page | `Submitted Profile Changes`, `Approved Profile Changes`, `Rejected Profile Changes` |
| 33 | Read a review entry | Names which fields were approved and which rejected |

---
---

# Phase 2.1 — employment lifecycle & session integrity ✅

Remediation of three audit findings, plus the two-state lifecycle. Covered by
an automated HTTP suite (48 assertions, all green) as well as the manual gate
below.

## What changed and why

### A-1 — a disabled account kept its live session

Phase 1 checked the account only at **login**. The JWT then stood on its own
until expiry, so suspending someone mid-session did nothing until their token
aged out. The Phase 1 gate claimed this was covered. It was not — that claim
was wrong and has been removed.

`middleware/verifyToken.js` is now async and re-checks on **every** request:
the user still exists, `employment_status = 'ACTIVE'`, the organisation is
still active, and the token's `role` claim still matches the database — so a
demotion also takes effect at once. On any failure it clears the cookie.

Those rejections return **401, not 403**. The distinction is load-bearing: 403
means "signed in but not allowed to do this", and the client keeps the session;
401 means the session itself is dead, which is what makes the browser drop its
state and bounce to login. Returning 403 here left a suspended user sitting on
the page collecting error toasts, never actually logged out.

The cost is one indexed primary-key lookup per request — the right trade for
revocation being immediate.

### A-2 — lockout protected the wrong thing

The old limiter was per-IP across all logins, so it did nothing against someone
grinding one account from many addresses, while a shared office NAT could lock
out a whole organisation at once.

`login_attempts` (migration 013) records every attempt. `checkLockout(email)`
counts failures **for that email** since its last successful login, inside a
rolling window. `MAX_ATTEMPTS` and `LOCKOUT_MINUTES` come from env. A successful
login resets the count by definition, since the window starts from it.

The per-IP limiter was kept but demoted and loosened (10 → 60 failures / 15 min).
It is now only a volumetric backstop against spray from one address; at 10 it was
itself the "locks out the wrong people" half of this finding, since a handful of
colleagues behind one office NAT fumbling passwords could lock out the building.
The per-account lockout is the precise control, so the coarse one no longer needs
to be tight. This surfaced during testing, when repeated runs from one machine
locked out the org admin.

### B-1 — role tabs were broken by pagination (my regression)

The Users page fetched one page of 25 and then filtered by role in the browser,
so a tab could show an empty table while that role clearly had members — the
rows simply sat on another page.

`listUsers` now takes `?role=` and filters in SQL, so a page belongs to exactly
one tab. Tab badges come from a separate org-wide `counts` aggregate
(`{ active, total }` per role), not from the current page, so they stay correct
wherever you are in the list.

### C-2 — a pending request outlived the person who submitted it

A consultant could leave a change request in a reviewer's queue and then stop
working there. Approving it would push values live for a non-employee;
rejecting it sends a note to an account nobody can read. Neither is meaningful.

The fix splits by intent rather than treating "not active" as one case:

- **Terminate** cancels the pending request in the **same transaction** as the
  termination, so the queue can never disagree with employment state.
- **Suspend** deliberately does **not**. Suspension is reversible and the person
  is still an employee — discarding their work over a two-week leave would just
  make them redo it. The queue flags the consultant as suspended instead, so the
  reviewer decides knowingly.

Cancellation uses a new `CANCELLED` status rather than reusing an existing one.
`WITHDRAWN` means the consultant changed their mind — recording an
admin-initiated termination that way would put words in their mouth and make the
audit trail lie about who did what. `REJECTED` is worse: it implies a reviewer
looked at the values and turned them down. `CANCELLED` says the true thing —
nobody judged these values, the request simply stopped being relevant.

`reviewChangeRequest` also refuses a decision on a terminated consultant. That
path should be unreachable, but a reviewer with the screen already open when the
termination lands would otherwise post a stale approval.

## The two-state lifecycle

| | Suspend | Terminate |
|---|---|---|
| Portal access | removed | removed |
| Still an employee | **yes** | **no** |
| Reversible | **yes** — Reactivate | **never** |
| Intended for | leave, a temporary hold | resignation, contract end, dismissal |
| Current assignment | left in place | closed in the same transaction |

Terminate is refused a reactivate **at the API**, not merely hidden in the UI;
the same goes for suspending someone already terminated. The record and its
history are always kept.

**Migration 012** adds `employment_status` with its `suspended_*` /
`terminated_*` columns, migrates every existing `is_active = FALSE` row to
`SUSPENDED`, then drops `is_active` and re-adds it as
`GENERATED ALWAYS AS (employment_status = 'ACTIVE') STORED`. Deriving it rather
than dropping it keeps every existing read working, and makes any stale *write*
fail loudly — which is exactly how the two seed files still setting `is_active`
by hand were caught.

## Listing behaviour

Both lists show **active people only** by default — the everyday question is who
is on the roster now. A *Show all* toggle sends `includeInactive=true` and
brings suspended and terminated rows in alongside the active ones, ordered
ACTIVE → SUSPENDED → TERMINATED.

## Files

| File | Change |
|---|---|
| `db/migrations/012_employment_status.sql` | new — status columns, generated `is_active` |
| `db/migrations/013_login_attempts.sql` | new — per-account attempt log |
| `db/migrations/014_cancel_change_requests.sql` | new — `CANCELLED` status + backfill |
| `middleware/verifyToken.js` | per-request revocation check, 401 on dead session |
| `controllers/authController.js` | per-account lockout, status-aware login errors |
| `server.js` | lifecycle routes; per-IP login limiter demoted to a backstop |
| `controllers/managementController.js` | `suspendUser` / `reactivateUser` / `terminateUser`; `listUsers` role filter + org-wide counts; cancels pending requests on terminate |
| `controllers/profileChangeController.js` | queue exposes consultant employment status; review refuses a terminated consultant |
| `controllers/profileController.js` | `listConsultants` honours `includeInactive` |
| `db/seeds/002`, `db/seeds/003` | stopped writing the now-generated `is_active` |
| `components/EmploymentStatus.jsx` | new — status badge |
| `components/LifecycleActions.jsx` | new — Suspend / Reactivate / Terminate + confirm dialog |
| `pages/management/Users.jsx` | lifecycle actions, status column, Show all |
| `pages/management/Consultants.jsx` | status badge, Show all |
| `pages/management/ProfileApprovals.jsx` | `Cancelled` pill, suspended-consultant flag |

## Manual test gate — Phase 2.1

### Session revocation
| # | Do | Expect |
|---|---|---|
| 1 | consultant1 signs in, leaves a tab open; admin suspends them; consultant clicks anything | Bounced to login **immediately** — no waiting for token expiry |
| 2 | Same, but terminate | Same |
| 3 | Admin changes a user's role mid-session; that user acts | Signed out, "permissions have changed" |
| 4 | SUPER_ADMIN disables an org; its admin acts | Signed out |

### Lifecycle
| # | As | Do | Expect |
|---|---|---|---|
| 5 | admin@molina | Suspend a recruiter | Amber **Suspended** badge; row hidden once back on active-only |
| 6 | that recruiter | Sign in | Refused, told they are suspended |
| 7 | admin@molina | Reactivate them | Back to **Active**; they can sign in |
| 8 | admin@molina | Terminate a consultant | Red **Terminated**; dialog warned it is permanent |
| 9 | admin@molina | Look at that row | **No actions** — no reactivate offered |
| 10 | — | `POST /users/:id/reactivate` on them by hand | **4xx** — refused server-side, not just hidden |
| 11 | admin@molina | Check their recruiter assignment | Released |
| 12 | admin@molina | Terminate own account | Blocked |
| 13 | admin@molina | Terminate another ORG_ADMIN | **403** blocked |

### Listing
| # | Do | Expect |
|---|---|---|
| 14 | Open Users, any tab | Active only |
| 15 | Click *Show all* | Suspended + terminated appear, active first |
| 16 | Switch tabs | Every row matches the tab; badge counts org-wide, not page counts |
| 17 | Page 2 of a tab | Counts unchanged; rows still all one role |
| 18 | Consultants page, *Show all* | Same behaviour |

### Pending requests vs employment (C-2)
| # | As | Do | Expect |
|---|---|---|---|
| 19 | consultant1 | Submit a profile change | Appears in the reviewer's Pending queue |
| 20 | admin@molina | Suspend that consultant | Request **still pending**, row flagged **Suspended** |
| 21 | admin@molina | Approve it anyway | Allowed — their work survives the suspension |
| 22 | consultant2 | Submit a change; admin terminates them | Gone from Pending |
| 23 | admin@molina | Filter **All** | Shows **Cancelled** — not Rejected, not Withdrawn |
| 24 | admin@molina | Expand that row | Read-only; no approve/reject buttons |
| 25 | — | Post a review to it by hand | **409** refused |
| 26 | admin@molina | Check the sidebar pending badge | Dropped by one |

### Lockout
| # | Do | Expect |
|---|---|---|
| 27 | Fail one account's password repeatedly | That account locks |
| 28 | Immediately sign in as a **different** user, same machine | **Succeeds** — lockout is per account |
| 29 | Return to the locked account with the **correct** password | Still refused until the window passes |
| 30 | Wait out `LOCKOUT_MINUTES`, sign in correctly | Succeeds |

---
---

# Upcoming

| Phase | Scope |
|---|---|
| **3** | **Search criteria** — job titles, keywords, locations, work types, min pay, excluded companies, with version history |
| 4 | Answer bank + approval workflow (two-person rule, salary/work-auth routed to owner) |
| 5 | Job postings, queue items, application records + Q&A |
| 6 | Contacts, do-not-contact, contact store |
| later | Two-step verification · forgot-password over SMTP · job discovery engine · resume tailoring · consultant desktop app |

## Signing off a phase

A phase is complete when:

1. Every migration it lists is applied and `npm run migrate` reports clean
2. Every numbered feature is demonstrable in the running app
3. Every row of its manual test gate has been run **by hand** and recorded
4. Every rule has at least one **negative** test proving the system *refuses* the forbidden action — not merely that the button is hidden
5. Every audited action produces an audit row, verified by inspection
