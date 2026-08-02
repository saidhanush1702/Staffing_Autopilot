# Phase 1 — Role-Based Access Control

Multi-tenant RBAC across four roles and three portals. Business features come later; this phase proves that **who you are** correctly determines **what you can reach**.

**Stack:** Node 24 · Express 5 · PostgreSQL · React 19 · Vite · Tailwind v4 · JWT in httpOnly cookie

---

## 1. Roles

| Role | Organization | Sees |
|---|---|---|
| `SUPER_ADMIN` | none (`NULL`) | Organizations only. **No tenant business data.** |
| `ORG_ADMIN` | one | Everything inside their own organization |
| `RECRUITER` | one | Only consultants **currently assigned** to them |
| `CONSULTANT` | one | **Only themselves** |

---

## 2. Three enforcement layers

**Layer 1 — route guards** (`middleware/roleGuards.js`, wired in `server.js`)
Checks *who* you are. `isSuperAdmin`, `isOrgAdmin`, `isManagement`, `isConsultant`.
Rule applied: DELETE/disable routes are `isOrgAdmin` only, even where read is broader.

**Layer 2 — tenant scoping** (`utils/scope.js`, in every query)
Checks *what* you may touch. **This is the layer that actually prevents cross-tenant access.** Every query carries `WHERE organization_id = $1`, sourced from `req.user.orgId` — which comes from the signed JWT, never from the body, query string, or params.

**Layer 3 — frontend guard** (`ProtectedRoute`, sidebar filtering)
UX only, never trusted. Hides links you cannot open. Bypass it and you get an empty screen plus a 403.

---

## 3. Setup

```powershell
# 1. Start Postgres (your Docker container from earlier)
cd E:\staffing_automatic_molina\srct\app
docker compose up -d

# 2. Backend
cd E:\staffing_automatic_molina\srct\backend
npm install
Copy-Item .env.example .env
```

Generate the two secrets and paste them into `.env`:

```powershell
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('PASSWORD_ENC_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

> `PASSWORD_ENC_KEY` **must be exactly 64 hex characters**. The server refuses to start otherwise.

```powershell
# 3. Migrate + seed
npm run migrate

# 4. Run the API
npm run dev          # http://localhost:5000

# 5. Frontend (new terminal)
cd E:\staffing_automatic_molina\srct\client
npm install
Copy-Item .env.example .env
npm run dev          # http://localhost:5173
```

---

## 4. Seeded accounts

| Email | Password | Role | Org |
|---|---|---|---|
| `superadmin@staffing.local` | `SuperAdmin@123` | SUPER_ADMIN | — |
| `admin@molina.local` | `Admin@123` | ORG_ADMIN | Molina |
| `recruiter1@molina.local` | `Recruiter@123` | RECRUITER | Molina |
| `recruiter2@molina.local` | `Recruiter@123` | RECRUITER | Molina |
| `consultant1@molina.local` … `consultant4@` | `Consultant@123` | CONSULTANT | Molina |
| `admin@apex.local` | `Admin@123` | ORG_ADMIN | Apex |
| `recruiter1@apex.local` | `Recruiter@123` | RECRUITER | Apex |
| `consultant1@apex.local` | `Consultant@123` | CONSULTANT | Apex |

Assignments: consultants 1–2 → recruiter1, consultants 3–4 → recruiter2.

**Two organizations exist on purpose** — cross-tenant isolation cannot be tested with only one.

---

## 5. API surface

| Method | Route | Guard |
|---|---|---|
| POST | `/api/auth/login` | public (rate-limited 10 / 15 min) |
| POST | `/api/auth/logout` | public |
| GET | `/api/auth/me` | authenticated |
| POST | `/api/auth/change-password` | authenticated |
| GET | `/api/lookups` | authenticated |
| GET | `/api/super-admin/stats` | SUPER_ADMIN |
| GET/POST | `/api/super-admin/organizations` | SUPER_ADMIN |
| GET/PATCH | `/api/super-admin/organizations/:id` | SUPER_ADMIN |
| POST | `/api/super-admin/organizations/:id/toggle-active` | SUPER_ADMIN |
| GET | `/api/management/stats` | ORG_ADMIN + RECRUITER |
| GET | `/api/management/users` | ORG_ADMIN + RECRUITER *(recruiter narrowed)* |
| POST/PATCH/DELETE | `/api/management/users[/:id]` | **ORG_ADMIN only** |
| GET | `/api/management/assignments` | ORG_ADMIN + RECRUITER |
| POST | `/api/management/assignments` | **ORG_ADMIN only** |
| GET | `/api/management/audit-logs/:module` | **ORG_ADMIN only** |
| GET | `/api/portal/me` | CONSULTANT |
| GET | `/api/portal/dashboard` | CONSULTANT |

---

## 6. Manual test gate

Run every row. **A test that expects 403 is passing when it returns 403.**

### 6.1 Login and routing

| # | As | Do | Expect |
|---|---|---|---|
| 1 | superadmin | Sign in | Lands on `/super-admin`, sidebar shows Platform + Organizations only |
| 2 | admin@molina | Sign in | Lands on `/management`, sidebar shows Dashboard, Users, Assignments |
| 3 | recruiter1@molina | Sign in | Lands on `/management`, sidebar shows Dashboard + My Consultants **only** (no Users, no Assignments) |
| 4 | consultant1@molina | Sign in | Lands on `/portal`, sidebar shows Dashboard + My Profile only |
| 5 | any | Wrong password | "Invalid email or password." |
| 6 | any | Non-existent email | **Identical message** — no account enumeration |
| 7 | any | Refresh the page while signed in | Stays signed in (cookie + `/auth/me`) |
| 8 | any | Sign out, press Back | Bounced to login |

### 6.2 Layer 3 — frontend guard

| # | As | Do | Expect |
|---|---|---|---|
| 9 | recruiter1 | Type `/management/users` in the URL bar | Redirected to `/unauthorized` |
| 10 | consultant1 | Type `/management` | Redirected to `/unauthorized` |
| 11 | admin@molina | Type `/super-admin` | Redirected to `/unauthorized` |
| 12 | superadmin | Type `/portal` | Redirected to `/unauthorized` |

### 6.3 Layer 1 — API role guards

Call directly (DevTools console, signed in as the stated role):

```js
await fetch('http://localhost:5000/api/super-admin/organizations', { credentials: 'include' })
  .then(r => r.status)
```

| # | As | Endpoint | Expect |
|---|---|---|---|
| 13 | recruiter1 | `GET /api/super-admin/organizations` | **403** |
| 14 | recruiter1 | `POST /api/management/users` | **403** — write is ORG_ADMIN only |
| 15 | recruiter1 | `DELETE /api/management/users/:id` | **403** |
| 16 | recruiter1 | `POST /api/management/assignments` | **403** |
| 17 | recruiter1 | `GET /api/management/audit-logs/users` | **403** |
| 18 | consultant1 | `GET /api/management/users` | **403** |
| 19 | consultant1 | `GET /api/super-admin/stats` | **403** |
| 20 | admin@molina | `GET /api/super-admin/organizations` | **403** |
| 21 | superadmin | `GET /api/management/users` | **403** — platform role has no tenant |
| 22 | superadmin | `GET /api/lookups` | **403** — `isTenantUser` rejects the platform role |
| 23 | nobody (no cookie) | `GET /api/auth/me` | **401** |

### 6.4 Layer 2 — tenant isolation (the critical set)

| # | As | Do | Expect |
|---|---|---|---|
| 24 | admin@molina | Open Users | **Only Molina users.** Zero Apex users. |
| 25 | admin@apex | Open Users | Only Apex users |
| 26 | admin@molina | `PATCH /api/management/users/<apex-user-id>` | **404** — "not found in your organization" |
| 27 | admin@molina | `DELETE /api/management/users/<apex-user-id>` | **404** |
| 28 | admin@molina | `POST /api/management/assignments` with an Apex consultant id | **404** |

> To get an Apex user id: sign in as `admin@apex.local`, open Users, copy an id from the network response. Then sign back in as `admin@molina.local` and try to use it.

### 6.5 Recruiter assignment scoping

| # | As | Do | Expect |
|---|---|---|---|
| 29 | recruiter1@molina | Open My Consultants | Exactly **consultant1 and consultant2** |
| 30 | recruiter2@molina | Open My Consultants | Exactly **consultant3 and consultant4** |
| 31 | admin@molina | Reassign consultant1 → recruiter2 | Saved; history row appears |
| 32 | recruiter2 | Reload My Consultants | Now shows consultants 1, 3, 4 |
| 33 | recruiter1 | Reload My Consultants | consultant1 is **gone** — access removed immediately |
| 34 | admin@molina | Check Assignments → History | Old row present with an `effective_to` date; nothing overwritten |

### 6.6 Consultant self-scope

| # | As | Do | Expect |
|---|---|---|---|
| 35 | consultant1 | Open My Profile | Own details + assigned recruiter |
| 36 | consultant1 | Look for any edit control | **None** — read-only |
| 37 | consultant1 | `GET /api/portal/me` | Own record only, no id parameter accepted |

### 6.7 SUPER_ADMIN tenant management

| # | As | Do | Expect |
|---|---|---|---|
| 38 | superadmin | Create an organization + first admin | Created; appears in the list |
| 39 | — | Sign in as that new admin | Works; sees an empty organization |
| 40 | superadmin | Reuse an existing slug | **409** conflict |
| 41 | superadmin | Disable an organization | Marked Disabled |
| 42 | user of that org | Try to sign in | **403** "This organization has been disabled." |

### 6.8 Audit log

| # | As | Do | Expect |
|---|---|---|---|
| 43 | admin@molina | Create a user, then expand "Activity log" | `Added User` in green with a description |
| 44 | admin@molina | Disable a user, refresh the panel | `Disabled User` in red |
| 45 | admin@molina | Assign a consultant | `Updated Assignment` in amber |
| 46 | recruiter1 | Look for the Activity log panel | **Not rendered** — ORG_ADMIN only |
| 47 | — | In psql: `UPDATE audit_logs SET action='x' WHERE id=(SELECT id FROM audit_logs LIMIT 1);` | **ERROR: audit_logs is append-only** |
| 48 | — | In psql as `app_role`: `DELETE FROM audit_logs;` | **permission denied** |

### 6.9 Account state

| # | As | Do | Expect |
|---|---|---|---|
| 49 | admin@molina | Disable consultant1 | Marked Disabled |
| 50 | consultant1 | Try to sign in | **403** "This account has been disabled." |
| 51 | admin@molina | Try to disable your own account | **400** — blocked |
| 52 | admin@molina | Try to disable another ORG_ADMIN | **403** — blocked |

---

## 7. Known constraints in this phase

- **Passwords are AES-256-GCM encrypted, not hashed** — reversible by design, per product decision. See the note at the top of `backend/utils/crypto.js`. Anyone with a database dump *and* `PASSWORD_ENC_KEY` recovers plaintext passwords.
- **No two-step verification** — username + password only.
- **No forgot-password flow** — `reset_code` / `reset_expiry` columns exist so no migration is needed when it lands.
- **Consultant dashboard counters are zeros** — queue, applications, and unknowns arrive with the business modules.

---

## 8. Sign-off

Phase 1 is complete when all **52** rows pass and are recorded. Do not start Phase 2 with any row open — particularly §6.4 (tenant isolation) and §6.5 (recruiter scoping), which are the guarantees every later feature inherits.
