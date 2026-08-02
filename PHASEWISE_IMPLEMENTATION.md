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
**Rule:** DELETE / disable routes are `isOrgAdmin` only, even where read is broader.

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
- Soft disable via `is_active`, never row deletes
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
DELETE /api/management/users/:id                 ORG_ADMIN only (soft disable)
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
| 36 | admin disables a user, refresh | `Disabled User` in red |
| 37 | recruiter1 looks for Activity log panel | **Not rendered** — ORG_ADMIN only |
| 38 | psql: `UPDATE audit_logs SET action='x';` | **ERROR: audit_logs is append-only** |
| 39 | psql as `app_role`: `DELETE FROM audit_logs;` | **permission denied** |

### Account state
| # | As | Do | Expect |
|---|---|---|---|
| 40 | admin@molina | Disable consultant1 | Marked Disabled |
| 41 | consultant1 | Sign in | **403** "account has been disabled" |
| 42 | admin@molina | Disable own account | **400** blocked |
| 43 | admin@molina | Disable another ORG_ADMIN | **403** blocked |

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
