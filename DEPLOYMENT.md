# Deploying SmartApply on free infrastructure

A zero-cost deployment for showing the system to a client, structured so that
moving to a paid server later is a change of environment variables rather than a
change of code.

Free-tier terms move around. Check each provider's current limits before you
promise anything to the client.

---

## 0. Before you start: commit the untracked files

**Render and Vercel deploy from GitHub, not from your disk.** At the time this
guide was written, files the server imports at boot were untracked, and pushing
without them produces a service that crashes before it reaches the database
check — with a stack trace that points at an import, not at a config mistake.

Check what git does not yet know about:

```bash
git status --short
```

At minimum these must be added, because `server.js` loads
`discoveryController.js`, which imports the first three at module scope
([discoveryController.js:49](backend/controllers/discoveryController.js:49)):

- `backend/connectors/serpapi.js`
- `backend/connectors/googleJobs.js`
- `backend/connectors/text.js`
- `backend/db/migrations/026_search_provider.sql` — otherwise step 4 applies an
  incomplete schema and discovery fails at runtime instead of at boot

Plus the deployment files: `backend/config/cookie.js`, `client/vercel.json` and
this document.

Verify before pushing — this lists what a fresh clone would actually contain:

```bash
git ls-files backend/connectors/
```

If that prints nothing, the deploy will fail. `.gitignore` is not the cause;
the files were simply never added.

---

## 1. Why this stack, and not Vercel functions

The obvious idea — "put it all on Vercel" — does not work here, and it is worth
knowing why before you spend an evening on it.

This backend is a **long-running process**, not a collection of request
handlers. Four things in the code depend on that:

| What | Where | Why serverless breaks it |
|---|---|---|
| The 4-hour discovery cycle | `backend/jobs/discoveryScheduler.js` | `node-cron` needs a process that stays alive between requests. A function is gone the moment it responds. Vercel's Hobby cron fires once a day, not every four hours |
| Boot sequence | `backend/server.js` — `app.listen()`, `process.exit(1)` | A function exports a handler; it never listens or exits |
| Resume storage | `backend/utils/upload.js` — `fs.writeFileSync` | A function's filesystem is read-only apart from `/tmp`, which is not shared between invocations |
| `pg.Pool({ max: 10 })` | `backend/db.js` | Every warm function instance opens its own pool. Ten instances is 100 connections against a free database that allows far fewer |

Rewriting around all four is a genuine project. Renting a small always-on
container is free and needs almost nothing.

**The stack:**

| Layer | Provider | Free tier | Role |
|---|---|---|---|
| Frontend | **Vercel** | 100 GB bandwidth | Static Vite build **plus** a proxy that forwards `/api` to the backend |
| Backend | **Render** (Web Service) | 750 instance-hours/mo, 512 MB | Real Node process, so cron works untouched |
| Database | **Neon** | 0.5 GB | Postgres with `pgcrypto` + `citext` |

### The one design decision that matters

Vercel forwards `/api/*` to Render rather than the browser calling Render
directly. That makes the browser see **one origin**, which buys three things at
once:

- The session cookie stays **first-party**. Safari blocks third-party cookies
  outright and Chrome is heading the same way — a split-domain setup would log
  users in and then 401 every request after it.
- The PDF preview iframe (`ResumePreview.jsx`) authenticates. It is a
  third-party context on a split domain and would fail even where plain API
  calls still worked.
- **CORS stops being involved at all.** The proxy call is server-to-server and
  carries no `Origin` header.

If you ever do split the domains, set `CROSS_SITE_COOKIE=true` on the backend.
It switches the cookie to `SameSite=None; Secure`. Read the caveats in
`.env.example` first — it is the fallback, not the default.

---

## 2. Database — Neon

1. Sign up at **neon.tech** with GitHub.
2. Create a project. Pick the region nearest your client, not nearest you.
3. From **Connection Details**, copy the **direct** connection string (not the
   pooled one — the backend runs a single process with its own pool, and the
   direct string avoids pgBouncer's prepared-statement edge cases).

It looks like:

```
postgresql://user:password@ep-xxx-xxx.region.aws.neon.tech/neondb?sslmode=require
```

Keep it somewhere safe; you need it twice.

> Neon suspends a free database after ~5 minutes idle and wakes it on the next
> query. That wake is why `connectionTimeoutMillis` in `backend/db.js` is 10s
> rather than 5s.

---

## 3. Generate your two secrets

The server refuses to boot without both ([server.js:340](backend/server.js:340)).
Run each and keep the output:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The first is `JWT_SECRET`. The second is `PASSWORD_ENC_KEY` and **must** be
exactly 64 hex characters.

> `PASSWORD_ENC_KEY` makes stored passwords reversible by design. Anyone holding
> both it and a database dump can read every user's password. Use a value you
> have never used elsewhere, and do not reuse this demo's key in production.

---

## 4. Run the migrations against Neon

From your machine, pointing at the remote database. In PowerShell, from the
`backend` folder:

```powershell
$env:DATABASE_URL="postgresql://...your neon string..."; $env:DB_SSL="true"; node migrate.js
```

You should see 25 migrations applied, then the seeds. This creates the schema,
the lookups, the super admin, and a demo organisation with users.

Two things worth knowing:

- `DATABASE_URL` overrides every `DB_*` variable, so your local `.env` is
  ignored for this run and your local database is untouched.
- The `app_role` GRANT in `005_audit_logs.sql` is wrapped in a `pg_roles` check,
  so it skips cleanly on Neon where that role does not exist. The append-only
  **trigger** on `audit_logs` still applies — that is the real protection, and
  it does not depend on the role split.

---

## 5. Backend — Render

Push your branch to GitHub first; Render deploys from a repository.

**New → Web Service →** connect the repo, then:

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path | `/api/health` |

Add these environment variables:

```
NODE_ENV=production
DATABASE_URL=<your neon string>
DB_SSL=true
JWT_SECRET=<from step 3>
PASSWORD_ENC_KEY=<from step 3>
APP_TIMEZONE=Asia/Kolkata
DISCOVERY_ENABLED=false
SEED_SUPER_ADMIN_EMAIL=superadmin@staffing.local
SEED_SUPER_ADMIN_PASSWORD=<a real password, not the .env.example one>
```

Do **not** set `PORT` — Render injects it, and `server.js` already reads it.

You do not need `CLIENT_ORIGIN` when using the proxy, because proxied requests
arrive without an `Origin` header and the CORS callback lets those through
([server.js:101](backend/server.js:101)). Set it only if you later point a
browser at Render directly.

Deploy, then confirm:

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
```

Expect `{"status":"ok","db":"ok",...}`. If it says `degraded`, the database
string or `DB_SSL` is wrong.

---

## 6. Frontend — Vercel

First point the proxy at Render. In [client/vercel.json](client/vercel.json),
replace the placeholder host with your real Render URL:

```json
{ "source": "/api/:path*", "destination": "https://YOUR-SERVICE.onrender.com/api/:path*" }
```

Commit and push. Then on **vercel.com → Add New Project →** import the repo:

| Setting | Value |
|---|---|
| Root Directory | `client` |
| Framework Preset | Vite (auto-detected) |
| Build Command | `npm run build` |
| Output Directory | `dist` |

**Add no environment variables.** `API_ROOT` in
[client/src/api/axios.js](client/src/api/axios.js) is deliberately empty in a
production build so calls go to the same origin and hit the proxy. Setting
`VITE_BACKEND_URL` would opt you back into split-domain and its cookie problems.

The second rewrite rule sends every other path to `index.html`, which is what
stops React Router deep links (`/consultants/abc-123`) from 404ing on refresh.
Order matters: `/api` is matched first.

---

## 7. Stop the backend falling asleep

A free Render service spins down after 15 minutes idle, and the next request
pays a ~50 second cold start. Live, in front of a client, that reads as broken.

Create a free account at **cron-job.org** and add a job:

- URL: `https://YOUR-SERVICE.onrender.com/api/health`
- Interval: every 10 minutes

750 instance-hours a month against a ~730-hour month means one always-on
service fits the free allowance almost exactly. Do not run a second free
service alongside it or you will exhaust the budget mid-month.

This ping also keeps **Neon** awake, because `/api/health` runs a query.

---

## 8. Job discovery — read before switching it on

Discovery buys results from SerpApi. **Every result page is one credit**, and
the free plan is roughly 100 searches per month.

At the shipped defaults (`DISCOVERY_MAX_QUERIES=6` × `DISCOVERY_MAX_PAGES=2`)
one run costs 12 credits. The 4-hour cycle is 6 runs a day:

```
12 x 6 = 72 credits/day  ->  a free month's quota gone in under two days
```

So for a free demo, **leave `DISCOVERY_ENABLED=false`** and trigger runs by hand
from the Job Discovery screen. That is about 8 manual runs a month.

You can also demo the screen with **no key at all**. With `SERPAPI_KEY` empty a
run still executes, fetches nothing, records that in the run notes, and matches
against postings already in the pool — enough to show the workflow, the run
history and the board health panel.

---

## 9. Deployment order

Dependencies run one way, so this order avoids backtracking:

```
Neon  ->  migrations  ->  Render  ->  vercel.json (Render URL)  ->  Vercel  ->  keep-alive ping
```

---

## 10. What to tell the client

Be straight about these; all three disappear on a paid server.

1. **Uploaded resumes are temporary.** Render's free tier has no persistent
   disk, so files written by `persistResume` are lost on every deploy and every
   spin-down. Database records survive and the UI stays consistent — only the
   file bytes go. **Re-upload a sample resume immediately before the demo.**
2. **The first request may be slow** if the keep-alive ping has lapsed.
3. **Job discovery is rate-limited** by the free SerpApi quota.

---

## 11. Moving to a paid server later

Nothing here is a rewrite. In order of value:

1. **Persistent disk** — attach one on Render (or any VPS) and point
   `UPLOAD_DIR` at it. Resumes stop vanishing. *One environment variable.*
2. **No sleep** — a paid instance removes cold starts and the keep-alive job.
   *No code change.*
3. **Single origin** — serve the built client from the same host as the API and
   drop the Vercel proxy. `API_ROOT` is already relative in production, so this
   is a hosting change only.
4. **Restore the role split** — on a database where you control roles, create
   `app_role` and `migrator_role`, set the discrete `DB_*` and
   `DB_MIGRATION_*` variables, and unset `DATABASE_URL`. The `005` GRANT starts
   applying again on the next migration run. *Environment only.*
5. **Discovery on** — with a paid SerpApi plan, set `DISCOVERY_ENABLED=true`
   after checking the credit arithmetic in section 8 against your quota.

---

## Appendix — troubleshooting

| Symptom | Cause |
|---|---|
| Login succeeds, every later call 401s | Split domains without `CROSS_SITE_COOKIE=true`. Use the proxy instead |
| `/api/health` returns `degraded` | Wrong `DATABASE_URL`, or `DB_SSL` not `true` |
| Server exits at boot | `JWT_SECRET` or `PASSWORD_ENC_KEY` missing. Render logs name the one that is missing |
| `PASSWORD_ENC_KEY` error at login | Not exactly 64 hex characters |
| Refreshing a deep link 404s | The SPA rewrite in `vercel.json` is missing or ordered before `/api` |
| PDF preview blank, rest of app fine | Third-party cookie blocked in the iframe — you are on split domains |
| First request of the day times out | Cold start; check the keep-alive job is running |
