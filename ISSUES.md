# Issue Register — audit after Phase 2

Findings from a code audit of everything built through Phase 2. Each item is verified against the code, not assumed.

| Severity | Count |
|---|---|
| 🔴 Critical — security or data integrity | 4 |
| 🟠 Functional gap — built but unreachable | 7 |
| 🟡 Workflow / UX | 7 |
| 🔵 Debt / cosmetic | 6 |
| **Total** | **24** |

---

## 🔴 CRITICAL

### C-1 · ORG_ADMIN can take over another ORG_ADMIN's account
**Where:** `backend/controllers/managementController.js` — `revealUserPassword`, `resetUserPassword`

`updateUser` and `deactivateUser` both guard against touching a peer admin:

```js
if (target.role === 'ORG_ADMIN') {
    return res.status(403).json({ error: 'Cannot modify another organization admin.' });
}
```

`revealUserPassword` and `resetUserPassword` have **no such check**. So ORG_ADMIN *A* can:
1. Reveal ORG_ADMIN *B*'s plaintext password, or
2. Reset it to a value they choose, and sign in as them

This is privilege escalation inside a tenant, and it defeats the audit trail — actions then appear under *B*'s name.

**Fix:** add the same `role === 'ORG_ADMIN' && target.id !== req.user.id` guard to both endpoints.

---

### C-2 · A disabled user can never be re-enabled
**Where:** `client/src/pages/management/Users.jsx:253`

```jsx
{u.role !== 'ORG_ADMIN' && u.is_active && (
    <button onClick={() => disable(u)}>Disable</button>
)}
```

The action only renders when `is_active` is **true**. Disable someone and the row shows "Disabled" with no control beside it. The API supports re-enabling (`PATCH /users/:id` with `isActive: true`) — there is simply no button.

**Impact:** disabling is a one-way door through the UI. Recovery needs a direct database edit.

**Fix:** render an Enable button when `is_active` is false.

---

### C-3 · `phone` is stored in two places and silently diverges
**Where:** `003_users.sql:15` and `008_consultant_profiles.sql:24`

Both tables have a `phone` column. `createUser` seeds both with the same value, then they drift:

| Action | Writes to |
|---|---|
| ORG_ADMIN edits a user | `users.phone` |
| Consultant's phone change is approved | `consultant_profiles.phone` |
| Users table displays | `users.phone` ← **stale** |
| Consultant's profile displays | `consultant_profiles.phone` |

A consultant updates their phone, a recruiter approves it, and the ORG_ADMIN's Users screen still shows the old number. Whichever one a job application eventually uses, the other is wrong.

**Fix:** pick one owner. Recommend `consultant_profiles.phone` for consultants, and have the Users list join to it for that role.

---

### C-4 · Uploaded resume files are never deleted
**Where:** `backend/controllers/resumeController.js` — no `fs.unlink` anywhere in the codebase

Every upload writes a row plus a file to `backend/uploads/<orgId>/`. Nothing removes them when:
- the consultant withdraws the change request
- the reviewer rejects the resume field
- a newer resume replaces the old one

**Impact:** unbounded disk growth, and rejected resumes remain readable via `GET /api/resumes/:id/download` by anyone with access to that consultant.

**Fix:** delete the artifact and file on withdraw/reject; keep superseded base resumes deliberately (they may be needed for audit) but stop unreferenced uploads accumulating.

---

## 🟠 FUNCTIONAL GAPS — built but unreachable

Seven endpoints exist and work, with no UI calling them.

### G-1 · Nobody can change their own password
`POST /api/auth/change-password` is wired and tested. There is **no account or settings page for any role.** Every password change must go through ORG_ADMIN's reset button — and ORG_ADMIN themselves has no route at all.

### G-2 · ORG_ADMIN cannot edit consultant profiles
`PUT /api/management/consultants/:id/profile` has no UI. Consequence — these fields are **unreachable from the app entirely**:

| Field | Effect |
|---|---|
| `daily_cap` | Stuck at the default 5 forever |
| `consent_on_file` / `consent_signed_at` | Consultant's profile permanently shows "Not yet" |
| `is_paused` | Cannot pause a consultant |
| `notes` | Internal notes cannot be written |

The consultant's own profile page *displays* daily cap and consent status, so they can see values nobody is able to set.

### G-3 · No consultants screen for ORG_ADMIN
`GET /api/management/consultants` returns work auth, completeness, missing-field lists and pending-change flags. No page consumes it. ORG_ADMIN's only view of consultants is the generic Users tab, which shows none of it.

### G-4 · Admin/recruiter resume upload unreachable
`POST /api/management/consultants/:id/resume` — no UI. Only a consultant can upload, and only through the approval flow. An agency cannot upload a resume on someone's behalf.

### G-5 · Resume history unreachable
`GET /api/management/consultants/:id/resumes` — no UI. Previous versions are invisible.

### G-6 · Organizations cannot be edited
`PATCH /api/super-admin/organizations/:id` exists; the UI only has the active/inactive toggle. Name, contact email, phone and timezone are set once at creation and then frozen.

### G-7 · Organization detail view unreachable
`GET /api/super-admin/organizations/:id` returns the org plus its user list. No page opens it.

---

## 🟡 WORKFLOW / UX

### W-1 · Recruiter's consultant list ignores everything Phase 2 added
**Where:** `client/src/pages/management/MyConsultants.jsx:15`

Calls `/management/users`, not `/management/consultants`. So a recruiter sees name, email, phone, status — but **not** work authorization, profile completeness, or whether changes are pending. The phone shown is the stale `users.phone` (see C-3).

### W-2 · Sidebar badges never refresh
**Where:** `client/src/components/layout/Sidebar.jsx:61` — `useEffect(..., [user])`

`user` only changes at login, so the counts fetch **once per session**:
- Consultant submits changes → the reviewer's Approvals badge stays at its old value
- Reviewer approves → the consultant's "missing fields" badge stays stale
- Consultant completes their profile → badge still shows a count until they log out and back in

**Fix:** poll on an interval, or refetch on route change, or lift the counts into a context that mutations can invalidate.

### W-3 · No way to inspect a consultant before approving
The Approvals screen shows `old → new` per field but nothing else. A reviewer deciding whether "H1-B" is plausible cannot open the consultant's full profile or resume from that screen.

### W-4 · Consultant's daily cap and consent are visible but unsettable
Directly caused by G-2. The profile page renders "Daily application cap: 5" and "Consent on file: Not yet" — values no screen can change. Reads as broken rather than incomplete.

### W-5 · No pagination anywhere
Users, Organizations, and Approvals all fetch and render unbounded lists. Fine at 11 users; a 500-consultant tenant will render 500 rows and every password cell at once.

### W-6 · Withdrawn requests have no tab
The Approvals tabs are Pending / Approved / Partly / Rejected / All. `WITHDRAWN` requests appear only under All, with no filter of their own.

### W-7 · Consultant doesn't know who will review before submitting
The "waiting on {recruiter}" line appears only *after* submission. Before submitting there is no indication of who receives it.

---

## 🔵 DEBT / COSMETIC

### D-1 · Seeded credentials printed on the login page
`client/src/pages/Login.jsx:101` renders the demo account emails under the form. Convenient now; must be removed before any real deployment.

### D-2 · Dead code — `portalController.myProfile`
`server.js:47` imports `myProfile` from `profileController`; `portalController.js:10` still exports its own unused version. Two functions with the same name, one never called.

### D-3 · `ProfileField` is hardcoded to the consultant upload endpoint
`POST /portal/resume` is baked in, so the component cannot be reused for an admin-side profile editor (needed for G-2).

### D-4 · sha256 is computed and stored but never used
`resume_artifacts.sha256` is populated on every upload. Nothing reads it — no duplicate detection, no integrity check on download.

### D-5 · Sidebar duplicates the consultant's profile fetch
For consultants the sidebar calls `/portal/me` purely to count missing fields, while `MyProfile` fetches the same payload. Two round trips, two copies of the same state.

### D-6 · `DATABASE_ACCESS.md` with plaintext passwords is committed
Throwaway dev credentials, but they are in git history permanently. Replace with placeholders before a staging environment exists.

---

## Suggested order of fixes

**Before Phase 3** — these are cheap and one of them is a security hole:

| # | Issue | Effort |
|---|---|---|
| 1 | **C-1** peer-admin password takeover | 10 min |
| 2 | **C-2** Enable button | 15 min |
| 3 | **G-1** account/settings page with password change | 1 hr |
| 4 | **G-2 + W-4** ORG_ADMIN consultant profile editor | 3 hr |
| 5 | **W-2** sidebar badge refresh | 1 hr |
| 6 | **C-3** resolve the duplicate phone column | 1 hr |
| 7 | **W-1** point MyConsultants at the richer endpoint | 30 min |

Roughly **one day** to clear all seven.

**Can wait:** C-4 (file cleanup), G-3 to G-7 (screens for existing endpoints), W-3/W-5/W-6/W-7, all of D.

**Do before any real data enters the system:** D-1, D-6, and rotating every seeded password.
