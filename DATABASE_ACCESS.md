# Database Access — Credentials & Roles

Local development reference for the Staffing Autopilot PostgreSQL database.

> ⚠️ **Local development only.** These are throwaway development passwords. Never use them in staging or production, and never commit real credentials to this file.

---

## 1. Server

| Setting | Value |
|---|---|
| Engine | PostgreSQL |
| Host | `localhost` |
| Port | `5432` |
| Runs inside | **WSL2 → Ubuntu** (not Docker, not a native Windows install) |
| Main database | `staffing_autopilot` |
| Test database | `staffing_autopilot_test` |

WSL2 forwards the port to Windows automatically, so `localhost` works from DBeaver, Node, and any Windows tool.

### Start / stop / status

Postgres does **not** auto-start with Windows. After every reboot:

```powershell
# start
wsl -d Ubuntu -u root -- service postgresql start

# status
wsl -d Ubuntu -u root -- service postgresql status

# stop
wsl -d Ubuntu -u root -- service postgresql stop
```

**Symptom if you forget:** the backend exits at boot with `❌ Database unreachable`.

---

## 2. Database roles

Three logins to the **same** database. They differ only in what they are permitted to do.

| Role | Password | Used by |
|---|---|---|
| `app_role` | `app_dev_pw` | The Express API at runtime (`backend/db.js`) |
| `migrator_role` | `migrator_dev_pw` | The migration runner (`backend/migrate.js`) |
| `postgres` | `postgres` | Superuser — humans only, never by code |

### Permission matrix (verified, not assumed)

| Operation | `app_role` | `migrator_role` | `postgres` |
|---|:---:|:---:|:---:|
| `SELECT` / `INSERT` / `UPDATE` / `DELETE` on business tables | ✅ | ✅ | ✅ |
| `INSERT` into `audit_logs` | ✅ | ✅ | ✅ |
| `UPDATE` / `DELETE` on `audit_logs` | ❌ *permission denied* | ❌ *append-only trigger* | ❌ *append-only trigger* |
| `CREATE` / `ALTER` / `DROP TABLE` | ❌ | ✅ | ✅ |
| `CREATE ROLE`, extensions, server admin | ❌ | ❌ | ✅ |

**Nothing can modify `audit_logs` — not even the superuser.** Two independent layers enforce it: a privilege `REVOKE` for `app_role`, and a `BEFORE UPDATE OR DELETE` trigger for everyone else.

### Why the split

If an SQL injection ever reaches the API, the attacker inherits `app_role`:

| | If API ran as `postgres` | With `app_role` |
|---|---|---|
| Modify data | ✅ | ✅ |
| `DROP TABLE users` | ✅ total loss | ❌ blocked |
| Rewrite `audit_logs` to hide the attack | ✅ | ❌ blocked |
| Create a backdoor account | ✅ | ❌ blocked |

Same bug, very different outcome. Principle of least privilege: the API never creates tables, so it isn't allowed to.

---

## 3. DBeaver connections

Create **two**. DBeaver cannot switch users on an existing connection — duplicate it and edit the username.

### Connection 1 — `Staffing (app)` ← daily use

| Field | Value |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `staffing_autopilot` |
| Authentication | Username/password |
| Username | `app_role` |
| Password | `app_dev_pw` |

Shows exactly what the API can reach. `CREATE TABLE` failing here is **correct** — it's the security boundary, not a broken connection.

### Connection 2 — `Staffing (admin)` ← schema work, fixing test data

Same as above, but:

| Field | Value |
|---|---|
| Username | `postgres` |
| Password | `postgres` |

Full access to everything except modifying `audit_logs`.

### Two known connection errors

| Error | Cause | Fix |
|---|---|---|
| `FATAL: database "app_role" does not exist` | Database field left blank — DBeaver falls back to the username | Set Database to `staffing_autopilot` |
| `FATAL: invalid value for parameter "TimeZone": "Asia/Calcutta"` | Ubuntu 26.04 ships `tzdata` without legacy aliases; the JDBC driver sends the old zone name Windows reports | Already fixed — `apt install tzdata-legacy`. Re-apply if the DB is rebuilt |

---

## 4. Application connection strings

`backend/.env`:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_NAME=staffing_autopilot
DB_USER=app_role
DB_PASS=app_dev_pw

DB_MIGRATION_USER=migrator_role
DB_MIGRATION_PASS=migrator_dev_pw
```

Two separate credentials on purpose — `npm run dev` uses the first, `npm run migrate` uses the second.

---

## 5. Bootstrap SQL

⚠️ **This was applied by hand and is not yet reproducible from the repo.** If the database is ever rebuilt, or set up on another machine, re-run this as `postgres`:

```sql
-- Roles
CREATE ROLE migrator_role LOGIN PASSWORD 'migrator_dev_pw';
CREATE ROLE app_role      LOGIN PASSWORD 'app_dev_pw';
ALTER  ROLE postgres      WITH PASSWORD 'postgres';   -- WSL has no password by default

CREATE DATABASE staffing_autopilot;
CREATE DATABASE staffing_autopilot_test;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Run the rest connected to staffing_autopilot (repeat for the _test database)
\c staffing_autopilot

ALTER SCHEMA public OWNER TO migrator_role;
GRANT  ALL     ON SCHEMA   public TO migrator_role;

GRANT  CONNECT ON DATABASE staffing_autopilot TO app_role;
GRANT  USAGE   ON SCHEMA   public             TO app_role;
REVOKE CREATE  ON SCHEMA   public             FROM app_role;

-- Must run BEFORE the first migration: default privileges only apply to
-- objects created after this statement.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO app_role;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator_role IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO app_role;
```

Plus the OS-level requirement:

```bash
apt-get install -y tzdata-legacy && service postgresql restart
```

Because of `ALTER DEFAULT PRIVILEGES`, **every table a future migration creates is automatically usable by `app_role`** — no manual grant needed.

---

## 6. Verifying the setup

```powershell
# app_role CAN read
wsl -d Ubuntu -- psql "postgres://app_role:app_dev_pw@localhost:5432/staffing_autopilot" -c "SELECT count(*) FROM users;"

# app_role CANNOT create tables  ← this failing is SUCCESS
wsl -d Ubuntu -- psql "postgres://app_role:app_dev_pw@localhost:5432/staffing_autopilot" -c "CREATE TABLE _t(id int);"
# expect: ERROR: permission denied for schema public

# nobody can tamper with the audit log  ← this failing is SUCCESS
wsl -d Ubuntu -- psql "postgres://postgres:postgres@localhost:5432/staffing_autopilot" -c "UPDATE audit_logs SET action='x';"
# expect: ERROR: audit_logs is append-only (attempted UPDATE)
```

---

## 7. Editing data directly in DBeaver

Direct edits **bypass the application layer**. Four things stop happening:

| Bypassed | Consequence |
|---|---|
| AES password encryption | **A hand-inserted user cannot log in** |
| Joi validation | Malformed data gets in |
| Audit logging | The change leaves no trace |
| Business rules | e.g. "cannot disable another ORG_ADMIN" |

The password one bites immediately: `password_enc` is base64 AES-256-GCM ciphertext, with the IV and auth tag in separate columns. Typing a plaintext password there creates a row that can never authenticate.

**Generate valid password columns:**

```powershell
cd E:\staffing_automatic_molina\srct\backend
node --env-file=.env -e "import('./utils/crypto.js').then(m => console.log(m.encryptPassword('YourPassword123')))"
```

**Read an existing password back** (possible because storage is reversible AES, by product decision):

```powershell
cd E:\staffing_automatic_molina\srct\backend
node --env-file=.env -e "import('./utils/crypto.js').then(async m => { const pg=(await import('pg')).default; const c=new pg.Client({connectionString:'postgres://app_role:app_dev_pw@localhost:5432/staffing_autopilot'}); await c.connect(); const {rows}=await c.query('SELECT email,password_enc,password_iv,password_tag FROM users'); rows.forEach(r=>console.log(r.email,'->',m.decryptPassword({enc:r.password_enc,iv:r.password_iv,tag:r.password_tag}))); await c.end(); })"
```

**Recommendation:** for anything you'd do more than twice — creating users, assigning consultants — use the UI instead. You get encryption, validation, and an audit entry for free, and you exercise the code path you're actually shipping.

---

## 8. Application accounts (seeded)

Created by `backend/db/seeds/002_super_admin_seed.js` and `003_demo_org_seed.js`. Passwords are AES-encrypted in the database, listed here in plaintext for testing.

| Email | Password | Role | Organization |
|---|---|---|---|
| `superadmin@staffing.local` | `SuperAdmin@123` | SUPER_ADMIN | *(none — platform)* |
| `admin@molina.local` | `Admin@123` | ORG_ADMIN | Molina Staffing |
| `recruiter1@molina.local` | `Recruiter@123` | RECRUITER | Molina Staffing |
| `recruiter2@molina.local` | `Recruiter@123` | RECRUITER | Molina Staffing |
| `consultant1@molina.local` … `consultant4@molina.local` | `Consultant@123` | CONSULTANT | Molina Staffing |
| `admin@apex.local` | `Admin@123` | ORG_ADMIN | Apex Staffing |
| `recruiter1@apex.local` | `Recruiter@123` | RECRUITER | Apex Staffing |
| `consultant1@apex.local` | `Consultant@123` | CONSULTANT | Apex Staffing |

Assignments: consultants 1–2 → recruiter1 · consultants 3–4 → recruiter2.

**Two organisations exist deliberately** — cross-tenant isolation cannot be tested with only one.

`superadmin@staffing.local` is the only user with `organization_id = NULL`, enforced by the `chk_org_required` constraint.

Seeds are **idempotent** — re-running `npm run migrate` never resets a password you've changed.

---

## 9. Current tables (9)

| Table | Purpose |
|---|---|
| `organizations` | Tenant root — one row per staffing agency |
| `users` | All four roles; AES-encrypted passwords |
| `assignments` | Consultant ↔ recruiter, with history |
| `audit_logs` | **Append-only** activity trail |
| `schema_migrations` | Migration runner bookkeeping |
| `lkp_genders` · `lkp_user_statuses` · `lkp_work_auth_statuses` · `lkp_roles` | Lookups, served via `GET /api/lookups` |

---

## 10. Reset to a clean database

```powershell
wsl -d Ubuntu -u root -- su - postgres -c "dropdb staffing_autopilot && createdb staffing_autopilot"
```

Then re-apply §5 for that database, and:

```powershell
cd E:\staffing_automatic_molina\srct\backend
npm run migrate
```

Migrations and seeds both re-run from scratch.
