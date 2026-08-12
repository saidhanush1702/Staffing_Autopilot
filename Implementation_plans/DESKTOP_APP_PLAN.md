# Consultant Desktop App — Implementation Plan

**Standalone document.** It assumes the hub and web portal are complete and
serving the endpoints in §5. Nothing here depends on the web application's own
planning documents.

**Status: plan, awaiting approval. No code written.**

---

## 1. What this is

A small program on each consultant's own Windows machine. It pulls that
consultant's job queue from the hub, opens each job in a real browser using the
consultant's own saved logins, fills in what it can, and **stops** — the
consultant reads it over and clicks Submit themselves. It then reports the
outcome and the exact questions and answers back to the hub.

It is a **filling assistant with a human gate**, not an auto-applier. Nothing is
ever sent to an employer without the consultant pressing the button.

### Locked decisions

| Decision | Choice |
|---|---|
| Stack | Electron + Playwright, all JavaScript |
| Browser | The consultant's installed Chrome |
| Platform | **Windows first**, macOS later — code stays cross-platform |
| Boards, v1 | **LinkedIn (Easy Apply only), Wellfound, Built In, CrunchBoard** |
| TheLadders | **Deferred** pending the subscription decision |
| LinkedIn | Easy Apply only, human-paced, **stops for the day on any bot-check** |
| Off-board redirects | Bot opens the page, marks **"needs you"**, consultant applies by hand |
| Resume | The approved base resume from the profile. Tailoring lands later behind the same endpoint |

### Explicitly out of scope for v1

Job searching, criteria editing, resume tailoring, contact discovery, and
automating Greenhouse / Lever / Workday forms. A redirect to any of those is a
"needs you" item, not an automation target.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell, tray, scheduler, UI | **Electron** | Native tray, Windows installer, auto-update. React components and the axios client are shared with the portal. |
| Browser automation | **Playwright** | `launchPersistentContext` gives saved logins natively, which is the whole of §5.2. Auto-waiting and locators are not worth reimplementing. |
| Browser binary | **Installed Chrome** via `channel: 'chrome'` | Genuinely the consultant's real browser. No second Chromium in the installer. Sessions live in a real Chrome profile. |
| Local store | **SQLite** | Queue cache, cap counter, cycle log. Small, file-based, no service. |
| Secrets | **OS credential vault** (`safeStorage`) | Device token never sits in plain text. |
| Packaging | **electron-builder** | NSIS installer, signing and auto-update built in. |

**Process model.** The Electron main process owns the tray, the scheduler, the
hub client and SQLite. Playwright runs as a child process driving Chrome. The
renderer is the UI and touches neither the network nor the browser.

```
┌─ Electron main ──────────────────────────────┐
│  tray · scheduler · hub client · SQLite      │
│  device token (OS vault)                     │
└──────┬──────────────────────────┬────────────┘
       │ IPC                      │ controls
┌──────▼────────┐        ┌────────▼─────────────┐
│  Renderer     │        │  Playwright child     │
│  React UI     │        │  → real Chrome        │
│  (no network) │        │  persistent profile   │
└───────────────┘        │  per board            │
                         └───────────────────────┘
```

---

## 3. What the consultant sees

| Surface | Purpose |
|---|---|
| **Tray icon** | Always running. Status at a glance: idle / working / needs you / paused. Right-click: pause, sync now, quit. |
| **Activation** | Once, ever. Paste the one-time code from the admin. |
| **Sign-in prompts** | First time a board is needed, a normal browser window opens and the app steps aside. The consultant logs in themselves, phone code and all. |
| **Ready to review** | The main screen. Filled applications, each showing the job, the attached resume, and every question with the answer filled in. A **Submit** button per row. |
| **Needs you** | Two kinds: jobs paused on an unanswered question, and jobs that redirected off-board. |
| **Notifications** | Only two that matter: *"3 applications ready to review"* and *"Your Wellfound session expired — please sign in again."* |

---

## 4. Local data and security

**Stored permanently on the machine:** the device token (OS vault) and the
Chrome profile folders holding board sessions. Nothing else.

**Stored for one cycle, then deleted:** the resume PDF for each queue item, and
any scratch files. Deletion runs at the end of every cycle and again on startup,
so a crash mid-cycle cannot leave a resume behind.

**Never stored, never transmitted:** portal passwords. The app has no password
field and no code path that reads one.

**Revocation.** Every hub call carries the device token. A revoked token gets a
`401`, on which the app immediately deletes its local database, clears the
device token, and returns to the activation screen. Revocation is effective on
the next call, at most one minute away because of the heartbeat.

**Machine binding.** Activation sends a machine fingerprint (hostname, OS
install ID, MAC hash). The hub binds token to person + machine. A token replayed
on a second machine is refused.

---

## 5. The hub contract

Everything the app needs, assuming the portal is complete. All calls are HTTPS
and carry `Authorization: Device <token>` except activation.

```
POST   /api/device/activate          { oneTimeToken, machineFingerprint }
                                     → { deviceToken, consultant, dailyCap }

GET    /api/device/heartbeat         → { ok, revoked, dailyCap, pausedBoards }
                                       called every 60s; the revocation channel

GET    /api/device/queue             → items for THIS consultant only
                                       each: id, board, jobUrl, company, title,
                                             status, approvedAnswers[]
GET    /api/device/queue/:id/resume  → the resume PDF for this item
                                       logged with time, person, machine

POST   /api/device/queue/:id/opened      { at }
POST   /api/device/queue/:id/filled      { fields[] }
POST   /api/device/queue/:id/parked      { unknownQuestions[] }
POST   /api/device/queue/:id/submitted   { qa[], submittedAt }
POST   /api/device/queue/:id/skipped     { reason }

POST   /api/device/board-status      { board, state: OK | SESSION_EXPIRED |
                                              BOT_CHECK, at }
```

Two properties matter and are worth stating to whoever builds the hub side:

- **Answers are delivered per queue item, never as the whole bank.** The app
  receives only the approved answers relevant to the job in front of it.
- **`POST /submitted` is the only route that creates an application record.**
  The app cannot create one any other way, and cannot edit or delete one.

---

## 6. The four boards

Each board is one recipe file: how to tell if we are logged in, how to find the
apply control, how to map form fields, and how to tell a bot-check from a form.

| Board | Apply flow | v1 treatment |
|---|---|---|
| **Wellfound** | Hosts its own form. Note/cover-letter field plus occasional screening questions. | **Full automation.** Most tractable of the four — start here. |
| **Built In** | Sometimes an on-site modal, more often a redirect to the employer's ATS. | Automate the on-site modal. **Redirect → "needs you".** |
| **LinkedIn** | Easy Apply is a multi-step modal on LinkedIn. Everything else redirects out. | **Easy Apply only**, human-paced, lowest daily volume. Non-Easy-Apply → "needs you". Any bot-check → **stop LinkedIn for the rest of the day.** |
| **CrunchBoard** | Almost always redirects to the employer. | Mostly **"needs you"**. Thin board; low expected volume. |

**Recipes are data, not code paths.** One module per board exporting the same
interface, so adding TheLadders later — or an ATS, if that decision changes — is
a new file rather than a change to the engine.

---

## 7. Behaviour limits (spec §5.4)

Enforced in the engine, not per board, so no recipe can forget them.

- **One application at a time.** Never parallel, across all boards.
- **Human-paced typing.** Per-character delay with jitter; pauses between
  fields; no instant-fill.
- **Daily cap enforced locally** as well as at the hub. The local counter is
  authoritative for stopping; the hub's value is the source of truth for what
  the cap is.
- **Random offset on the 4-hour wake**, so activity is not machine-timed.
- **LinkedIn bot-check → full stop for that board for the calendar day**,
  reported to the hub so it appears on the recruiter and owner dashboards.
- **Session expired → pause that board**, notify the consultant, report the
  stall. Other boards continue.

---

## 8. Phases

Each phase ends with something demonstrable. No phase leaves a half-built
mechanism behind.

### D1 — Shell, identity, hub link
Electron skeleton, tray with status, SQLite, hub client, activation with the
one-time token, machine fingerprint, device token in the OS vault, 60-second
heartbeat, revocation wipe. No browser yet.

**Done when:** the app activates against the hub, appears in the tray, survives
a restart, and wipes itself within a minute of the admin revoking it.

### D2 — Browser sessions and sign-in
Playwright launching installed Chrome with a persistent profile per board. The
"step aside and let the human log in" flow. Logged-in detection per board.
Session-expiry detection → pause board, notify, report to hub.

**Done when:** the consultant signs into all four boards once, restarts the
machine, and the app still reports all four as logged in.

### D3 — The cycle engine
4-hour scheduler with random offset. Pull queue, work one item at a time, open
the job page, classify **on-board form vs redirect**, mark redirects "needs
you". Local daily cap. Working-file cleanup at cycle end and on startup. Status
reporting for every item.

**Done when:** a full cycle runs end to end over a real queue, opening every job
and correctly classifying each, with nothing filled yet and the cap respected.
*This proves the whole loop before any form is touched.*

### D4 — Form filling: Wellfound, then Built In
The field-mapping engine and human-paced typing. Resume download, attach, and
delete. Unknown-question detection → send to hub, park the item. Stop at the
filled state — no submitting yet.

**Done when:** a Wellfound and a Built In application are filled correctly,
resume attached, an unknown question parks the item, and the resume file is gone
from disk afterwards.

### D5 — Review and submit
The review screen: each filled application with its full question-and-answer
list and the attached resume. Submit per item, driven by the consultant.
Submission confirmation, then `POST /submitted` with the complete Q&A. Failure
handling if the portal rejects the submit.

**Done when:** a consultant reviews a filled application, clicks Submit, the
employer receives it, and the hub holds a permanent record with every question
and answer as filled.

### D6 — LinkedIn Easy Apply and CrunchBoard
Easy Apply multi-step modal. LinkedIn's conservative rules: lowest volume, and
the bot-check full-stop. CrunchBoard recipe, which is mostly redirect handling.

**Done when:** an Easy Apply application completes through review and submit,
and a simulated bot-check stops LinkedIn for the day while the other boards keep
running.

### D7 — Packaging and update
electron-builder NSIS installer, code signing, auto-update channel, silent
update on restart. Clean-install and upgrade testing on a machine that has never
seen the app.

**Done when:** a consultant installs from a signed installer, activates, and
receives an update without being asked to do anything.

### D8 — Hardening and pilot
Crash reporting, local rotating logs with no personal data, a diagnostics bundle
the consultant can send. Pilot per spec §11: three consultants, one category,
cap of 5/day, two weeks, every application reviewed by the recruiter in week one.

**Done when:** the pilot's success gate is met — zero fabricated content, and
the intended applications actually submitted.

---

## 9. Testing

| Layer | Approach |
|---|---|
| Field mapping | Saved HTML fixtures per board. Runs offline, in CI, costs nothing. |
| Engine rules | Unit tests for cap, pacing, one-at-a-time, cleanup, bot-check stop. |
| Hub contract | Mock hub, including the revocation and session-expiry paths. |
| Live boards | Manual, against real accounts, once per phase. Cannot be automated in CI without burning real applications. |

**The rule that protects everyone:** no test ever submits a real application.
Live testing stops at the review screen.

---

## 10. Prerequisites and open decisions

**Needed before D1:**
- The hub endpoints in §5, including one-time token issue and revoke on the
  owner dashboard.
- Free accounts on Wellfound, Built In and CrunchBoard, plus a LinkedIn account
  per pilot consultant.

**Needed before D7 — still undecided:**

1. **Windows code signing certificate.** Without one, every consultant sees
   *"Windows protected your PC"* on install and some corporate machines refuse
   outright. OV is roughly $200–400/yr and builds reputation over weeks; EV is
   roughly $400–600/yr and is trusted immediately but needs a hardware token.
   **Recommendation: EV**, because a warning on first install of a tool that
   handles job applications will cost more in support than the difference.
2. **Where auto-update files are hosted.** A static bucket or GitHub Releases is
   enough. Needs deciding before the update channel is built.
3. **macOS timing.** Code stays cross-platform throughout; adding Mac is a build
   configuration plus an Apple Developer account ($99/yr) and notarisation.

**Accepted risk, recorded here deliberately:** LinkedIn Easy Apply automation
carries residual detection risk, because Playwright drives Chrome over CDP and
that is detectable. The mitigations in §7 reduce it but do not remove it, and a
ban would land on the consultant's own personal account. This was chosen with
that understood; the alternative — opening LinkedIn and letting the consultant
apply by hand — remains a one-line configuration change per board.
