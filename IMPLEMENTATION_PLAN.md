# Staffing Application Automation System — Implementation Plan (v2)

**Source of truth:** `Staffing Automation Build Specification.docx.pdf` (Version 1.1, July 4 2026)
**Plan status:** Technology-stack agnostic. No language, framework, database, or hosting choice is
made here. This document defines *what* gets built, *in what order*, *with which rules*, and
*how you manually verify each phase before moving on*.

---

## 0. How to read this plan

### 0.1 Structure of every phase

Each phase is written in the same shape:

| Section | Meaning |
|---|---|
\;'| **Objective** | The single sentence that describes what this phase makes possible. |
| **Modules delivered** | The named units of functionality that must exist when the phase ends. |
| **Data objects** | Records + fields + states this phase introduces or extends. |
| **Feature list** | Explicit, numbered, individually testable features. Portal phases are broken down tab by tab. |
| **Rules enforced** | The hard restrictions from the spec that this phase must make impossible to violate. |
| **Dependencies & stubs** | What this phase consumes, and what is faked/manual until a later phase automates it. |
| **Manual test gate** | The checklist you personally run before signing the phase off. |
| **Exit criteria** | Binary conditions. All must be true to start the next phase. |

### 0.2 The producer / consumer design decision that drives the phase order

The system has two kinds of parts:

- **Producers** — the automated engines: job discovery, resume tailoring, contact discovery.
  They create rows.
- **Consumers** — the three portals and the desktop app. They read, display, edit, and act on
  those rows.

This plan builds **consumers first, producers second**, with one deliberate addition: every
consumer phase ships an **Operator Simulation Panel** — an owner-only screen that lets you create
the rows an engine would later create (a job posting, a queue item, a tailored resume file, a
contact record) *by hand*.

Why this order:

1. You asked for portals to be testable early, one complete portal per phase. This delivers that.
2. Every portal is genuinely functional at its phase gate — not a mock. It reads real records from
   the real database with the real permission checks.
3. When the engines arrive in Phases 5–7 they do not require any portal rework. They write to
   exactly the same tables the Simulation Panel writes to. The engine phase is "replace the manual
   producer with the automated one", not "now build the UI".
4. The desktop app (Phase 4) can be built and proven against hand-created queue items pointing at
   real live job postings — which is the *only* clean way to test browser automation in isolation
   from AI matching noise.

The Simulation Panel is not throwaway code. It stays permanently as the owner's manual-override and
support tool (re-queue a job, re-issue a resume, hand-add a contact).

### 0.3 Complete end-to-end workflow (the thing being built)

```
                        ┌─────────────────────────────────────────────┐
                        │            CENTRAL HUB (cloud)              │
                        └─────────────────────────────────────────────┘

  [1] Owner onboards          [2] Every 4 hours:               [3] For each matched job:
      recruiter + consultant      job feeds pulled                 resume tailored from base
      assigns consultant          keyword pre-filter               fabrication check runs
      to recruiter                duplicate fingerprint drop       clean  -> queue
      sets daily cap              AI match vs criteria             flagged -> recruiter review
      issues device token         AI work-type classify
                                                                [4] Contact waterfall runs:
                                                                    poster from posting
                                                                    -> store (90d reuse)
                                                                    -> licensed enrichment
                                                                    -> 2 TA-contact fallback
                                       │
                                       ▼
                        ┌─────────────────────────────────────────────┐
                        │   CONSULTANT QUEUE (one per consultant)     │
                        │   job link + portal type + tailored resume  │
                        │   + approved answers + contact card(s)      │
                        └─────────────────────────────────────────────┘
                                       │  pulled on 4h cycle (+random offset)
                                       ▼
                        ┌─────────────────────────────────────────────┐
                        │   CONSULTANT DESKTOP APP (personal machine) │
                        │   saved browser session -> open job         │
                        │   fill form, human typing pace, one at a    │
                        │   time -> attach tailored resume            │
                        │   unknown question? -> park, send to hub    │
                        │   STOP AT REVIEW SCREEN                     │
                        └─────────────────────────────────────────────┘
                                       │
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
        [5] Consultant clicks SUBMIT      [6] Unknown question appears on
            (human, always)                   consultant dashboard
            app confirms + reports            consultant types answer -> PENDING
            full Q&A list to hub              recruiter approves -> APPROVED
            app deletes local working         (salary / work-auth -> OWNER only)
            files                             approved answer joins answer bank
                       │                               │
                       └───────────────┬───────────────┘
                                       ▼
                        ┌─────────────────────────────────────────────┐
                        │   PERMANENT RECORD STORE + APPEND-ONLY AUDIT│
                        │   application record, exact resume PDF,     │
                        │   full Q&A, every login/download/approval   │
                        └─────────────────────────────────────────────┘
```

### 0.4 Phase map

| Phase | Name | Delivers | Manually testable as |
|---|---|---|---|
| **0** | Program Setup & Ground Rules | Repo layout, environments, seed strategy, definition of done | N/A (setup) |
| **1** | Identity, Roles, Access Control & Audit | Users, roles, 2-step verification, assignments, permission engine, append-only audit, owner user-admin screens | Log in as each role, prove each role can/cannot do each matrix row |
| **2** | Recruiter Portal (complete) | Every recruiter tab, consultant profiles, criteria, queue records, application records, answer bank state machine, contact display, Simulation Panel | Recruiter does a full day's work end to end |
| **3** | Consultant Web Portal (complete) | Every consultant tab, unknowns workflow, own history, own resumes, device status | Consultant does a full day's work end to end |
| **4** | Consultant Desktop Application | Environment, activation tokens, saved sessions, 4-hour cycle, form fillers, review-screen stop, reporting, local cleanup, installer | Install on a clean machine, apply to a real job, stop at review |
| **5** | Job Discovery Engine | 4-hour cycle, feeds, pre-filter, de-duplication, AI matching, queue population, caps | Watch a real cycle fill real queues |
| **6** | Resume Tailoring Engine | Locked prompt tailoring, fabrication check, PDF output, flagged routing | Feed a job, inspect the tailored PDF, plant a lie and catch it |
| **7** | Contact Discovery Engine | 4-step waterfall, 90-day reuse, enrichment, DNC, credit budget cutoff | Run against real jobs, watch credits and reuse |
| **8** | Owner Command Center | Agency-wide analytics, global search, bulk contact export, caps/budgets, token console, audit explorer, system health | Owner runs the agency from one screen |
| **9** | Portal Coverage Expansion | Dice, then Workday, then LinkedIn (conservative) form fillers | Apply on each new portal type |
| **10** | Security Review, Backup & Pilot | Revocation drills, restore test, spend caps, audit immutability proof, pilot rollout | Full security drill + 2-week pilot |

Phases 1–4 are the ones you asked to be able to test as complete, standalone products. Phases 5–7
are automation layers that light up work the portals already know how to display. Phases 8–10 close
the system out.

---

## 1. Cross-cutting rules register

These rules are not owned by any single phase. Every phase must respect them, and Phase 10
re-verifies all of them. Each has an ID so test cases can cite it.

| ID | Rule | Source | Enforced in |
|---|---|---|---|
| **R-01** | Every application goes out under the consultant's own name, email, and portal accounts. | §1.1 | Ph 2, 4 |
| **R-02** | The final submit click is made by a human consultant, never by the machine. | §1.1, §5.3 | Ph 4 |
| **R-03** | Jobs are never moved between consultants. An expired login parks that consultant's queue only. | §1.1 | Ph 2, 4, 5 |
| **R-04** | Resume tailoring may reword and reorder true content. It must never invent skills, tools, employers, dates, or accomplishments. | §1.1, §3.2 | Ph 6 |
| **R-05** | The no-fabrication instruction set lives in hub code only. No portal user at any level can view, edit, or weaken it. | §3.2, §6 | Ph 6 |
| **R-06** | No answer is ever auto-approved. A consultant can never approve their own answer (two-person rule). | §3.4, §6 | Ph 2, 3 |
| **R-07** | Any answer touching salary expectations or work authorization routes to the **owner** only, regardless of recruiter. | §1.1, §3.4 | Ph 2, 3, 8 |
| **R-08** | All records are kept indefinitely: every application, the exact resume file submitted, every answer given. Nothing is ever hard-deleted. | §1.1, §3.5 | All |
| **R-09** | The audit table is strictly append-only. No row can ever be edited or deleted, by anyone, including the owner and including direct database access. | §7 | Ph 1 |
| **R-10** | Resumes are delivered **per job only**. There is no bulk resume download anywhere in the system, for any role. | §3.2, §6 | Ph 2, 3, 4, 8 |
| **R-11** | Every resume delivery is logged with time, person, and machine. Every contact view is logged. | §3.5, §4.1, §6 | Ph 1, 2, 3, 7 |
| **R-12** | The system never scrapes LinkedIn profiles. All contact data comes through licensed providers' official interfaces. Sales Navigator stays a manual recruiter tool, unconnected to the system. | §3.6 | Ph 7 |
| **R-13** | Contacts are de-duplicated by person name + company. Re-pull only permitted after 90 days. | §3.6, §7 | Ph 7 |
| **R-14** | A do-not-contact flag is permanent. Once set, the system never attaches that contact to any job again. | §3.6 | Ph 7 |
| **R-15** | Job postings are de-duplicated by a company + title + location fingerprint. Only postings first seen after the previous run move forward. | §3.1 | Ph 5 |
| **R-16** | A cheap keyword pre-filter (title + location) must run before any AI matching call. | §3.1 | Ph 5 |
| **R-17** | Daily application caps are set centrally by the owner, enforced at the hub **and** independently enforced locally in the desktop app. | §3.3, §5.4 | Ph 2, 4, 8 |
| **R-18** | The desktop app never holds, stores, or transmits any portal password. | §5.2, §6 | Ph 4 |
| **R-19** | The desktop app processes one application at a time, never in parallel, at realistic human typing speed with pauses. | §5.4 | Ph 4 |
| **R-20** | The desktop app deletes all local working files after each cycle. Only the saved browser sessions and the app itself persist. | §5.3 | Ph 4 |
| **R-21** | Device tokens bind to one person **and** one machine, and are revocable instantly by the owner, which kills the app immediately. | §5.1, §6 | Ph 4, 8 |
| **R-22** | LinkedIn receives the most conservative treatment: lowest volume, human submit always, and a full stop for the remainder of the day on any bot-check challenge. | §5.4 | Ph 9 |
| **R-23** | Consultants have read-only access to their own profile and queue. They cannot see other candidates, edit search criteria, or change approved answers directly. | §6 | Ph 3 |
| **R-24** | All hub data encrypted at rest; all traffic between app, portal, and hub encrypted in transit. | §6 | Ph 0, 10 |
| **R-25** | A monthly contact-credit budget set by the owner cuts off external pulls and drops the system into reuse-only mode when reached. | §8.3 | Ph 7, 8 |
| **R-26** | A form-filler failure must park the application with a clear error. It must never submit partial or wrong data. | §10.3 | Ph 4, 9 |
| **R-27** | No real candidate data enters the system until the Phase 10 security review is complete. All build and test work uses seeded fake data. | §10.2 | All |

---

## 2. Canonical permission matrix

Implemented once in Phase 1 as a single server-side authorization module. Every later phase calls
into it; no phase re-implements its own checks. The client never decides permission — it only hides
what the server has already refused.

| # | Capability | Owner | Recruiter | Consultant |
|---|---|---|---|---|
| P-01 | Add or remove recruiters; assign consultants to recruiters | Yes | No | No |
| P-02 | See all consultants, all applications, all records | Yes | No | No |
| P-03 | See assigned consultants' dashboards, queues, records | Yes | Yes (own list only) | No |
| P-04 | Approve pending answers | Yes (all) | Yes (own consultants, except salary & work-auth) | No |
| P-05 | Approve salary and work-authorization answers | Yes (only) | No | No |
| P-06 | Set daily application caps | Yes | No | No |
| P-07 | Issue and revoke consultant app tokens | Yes | No | No |
| P-08 | View application history, resumes, queue status | Yes (all) | Yes (own consultants) | Yes (self only) |
| P-09 | Fill answers for unknown questions | No | No | Yes (self only, pending approval) |
| P-10 | Edit search criteria for a consultant | Yes | Yes (own consultants) | No |
| P-11 | View audit log | Yes | No | No |
| P-12 | View contacts attached to a job | Yes | Yes (own consultants' jobs) | Yes (own queue items only) |
| P-13 | Search the full contact store; flag do-not-contact | Yes | Yes | No |
| P-14 | Export contacts in bulk | Yes (only) | No | No |
| P-15 | Two-step verification required at login | Yes | Yes | Optional (owner-configurable) |

---

## 3. Complete data model reference

Introduced progressively across phases; listed here in one place so no field is forgotten. Names
are content descriptions, not final column names.

| Record | Contents | Introduced |
|---|---|---|
| **User** | Name, email, role (owner / recruiter / consultant), login credentials, two-step setting & enrolment secret, active or disabled, created/updated stamps | Ph 1 |
| **Assignment** | Which consultant belongs to which recruiter, effective-from, effective-to, plus full change history (who moved whom, when, why) | Ph 1 |
| **Audit event** | Actor, action, target type, target id, timestamp, source machine/device, IP, before/after summary where relevant. **Append-only.** | Ph 1 |
| **Consultant profile** | Contact details, work-authorization status, base resume file reference, search criteria, daily cap, LinkedIn-conservative flag, onboarding/consent status | Ph 2 |
| **Search criteria** | Job titles, keywords, locations, work types (contract / full-time / part-time / C2C / W2), minimum pay, excluded companies, active flag, version history | Ph 2 |
| **Job posting** | Source, source URL, company, title, location, work type, pay if listed, full description text, de-duplication fingerprint (company + title + location), first-seen time, portal type | Ph 2 (schema), Ph 5 (populated) |
| **Queue item** | Consultant, job, tailored resume file link, portal type, status (queued / filled / parked-unknown / awaiting-submit / submitted / skipped), overlap flag, timestamps for each transition, skip reason | Ph 2 |
| **Application record** | Consultant, job, company, portal, date & time, final status (submitted / waiting-on-consultant / stalled-on-login / skipped-with-reason), resume file reference, Q&A list reference. **Permanent.** | Ph 2 |
| **Application Q&A entry** | Application record, question text exactly as the form asked it, answer text exactly as filled, field type, order | Ph 2 (schema), Ph 4 (populated) |
| **Answer** | Consultant, question text, normalised question key, answer text, status (pending / approved / rejected), who approved, when, rejection/correction note, sensitive-routing flag (salary / work-authorization) | Ph 2 |
| **Resume artifact** | Owning consultant, kind (base / tailored), job link if tailored, file reference, filename `Company_Title_Date.pdf`, generation stamp, fabrication-check verdict + flagged claims | Ph 2 (schema), Ph 6 (populated) |
| **Contact** | Person name, title, company, work location, business email, phone, data source, date pulled, do-not-contact flag, DNC set-by/when | Ph 2 (schema), Ph 7 (populated) |
| **Contact link** | Which contact attaches to which job posting, and when. One contact links to many jobs. | Ph 2 (schema), Ph 7 |
| **Device token** | Consultant, machine fingerprint, issued date, issued by, activation state, last heartbeat, revoked date + revoked by if any, app version | Ph 4 |
| **Cycle run** | Run id, kind (discovery / tailoring / contact), start, end, counts in/out per stage, errors, cost markers | Ph 5 |
| **Credit ledger** | Provider, operation, credits consumed, job/contact reference, timestamp, running monthly total, budget state | Ph 7 |

---

# PHASE 0 — Program Setup & Ground Rules

**Duration guide:** 2–3 days.

### Objective
Put the working environment, conventions, and safety rails in place so that every later phase is
built, tested, and signed off the same way.

### Modules delivered

- **M0.1 Repository & workspace layout** — three top-level areas: hub service, web portal,
  consultant desktop app; plus a docs area holding a plain-text copy of the specification, and a
  root-level agent/context file capturing the locked rules (R-01 … R-27) so any AI-assisted coding
  session inherits them automatically.
- **M0.2 Environment tiers** — local development, shared staging (fake data only), production.
  Production stays empty until Phase 10.
- **M0.3 Configuration & secrets policy** — every credential, API key, and provider token read from
  configuration, never committed. One documented list of every secret the system will need by the
  end of Phase 10.
- **M0.4 Seed data pack** — a fixed cast used in every manual test from Phase 1 onward:
  - 1 owner, 2 recruiters, 6 consultants (4 assigned to recruiter A, 2 to recruiter B).
  - 6 base resumes with deliberately known content (so fabrication tests have a ground truth).
  - 20 job postings across the portal types.
  - A pre-built answer bank with a mix of approved, pending, rejected, and sensitive answers.
- **M0.5 Definition of done** — a feature is done when: it has automated tests, it is reachable
  through the UI or API by the intended role only, it writes an audit event where the spec requires
  one, and it appears in that phase's manual test gate.
- **M0.6 Test-evidence log** — a running document where each phase's manual test gate results are
  recorded with date and tester, because the pilot success gate (Phase 10) references them.

### Rules enforced
R-24 (transport & at-rest encryption configured from day one, not retrofitted), R-27 (fake data
only until Phase 10).

### Manual test gate
1. A clean machine can set up the project and run the whole stack from written instructions with no
   verbal help.
2. The seed data pack loads and resets cleanly with one command.
3. No secret appears anywhere in version control.

### Exit criteria
Environment reproducible; seed pack loads; rules register (R-01 … R-27) is present in the repo as
the standing constraint document.

---

# PHASE 1 — Identity, Roles, Access Control & Audit Foundation

**Duration guide:** 1.5–2 weeks.
**This is your "roles, user tables, role-based access control" phase.**

### Objective
Make the system know who someone is, what role they hold, which consultants they are allowed to
touch, and record every consequential thing they do in a log nobody can alter.

### Modules delivered

- **M1.1 User & credential store**
- **M1.2 Authentication & session management**
- **M1.3 Two-step verification (mandatory for Owner and Recruiter)**
- **M1.4 Role & permission engine** (single server-side authority for the matrix in §2)
- **M1.5 Assignment engine** (recruiter ↔ consultant mapping with history)
- **M1.6 Append-only audit log** (write path + owner-only read path)
- **M1.7 Portal application shell** (navigation, role-aware menu, session handling, error/permission
  screens) — the frame that Phases 2, 3, and 8 fill in
- **M1.8 Owner user-administration screens** (the minimum owner needs to create the cast)
- **M1.9 Account lifecycle** (disable / re-enable / forced password reset / 2FA reset)

### Data objects

**User:** name, email (unique, login identity), role (exactly one of owner / recruiter /
consultant), password credential, two-step enabled flag, two-step enrolment secret, recovery codes,
active/disabled, failed-login counter, lockout-until, last-login-at, created-by, created-at.

**Assignment:** consultant, recruiter, effective-from, effective-to (null = current), created-by,
reason note. A consultant has exactly one current recruiter. History rows are never deleted.

**Audit event:** actor user, actor role, action code, target type, target id, timestamp (server
clock, timezone-explicit), source machine/device identifier, source IP, human-readable summary,
structured detail payload. **No update path. No delete path. Ever.**

### Feature list

**Authentication & sessions**
1. Email + password login for all three roles.
2. Two-step verification challenge, mandatory for Owner and Recruiter, owner-configurable per
   consultant. Login is not complete until the second factor passes.
3. Two-step enrolment flow on first login for a role that requires it, with recovery codes issued
   once and shown once.
4. Session lifetime, idle timeout, and explicit logout. Sessions invalidate immediately when a user
   is disabled or their role changes.
5. Failed-login throttling and temporary lockout, with both the failures and the lockout audited.
6. Password change (self) and password reset (owner-initiated, forces re-enrolment of 2FA if reset
   for a compromised account).
7. "Active sessions" view for the user themselves, with a revoke-this-session action.

**Roles & permissions**
8. Exactly one role per user, set at creation, changeable only by the owner, always audited.
9. A single server-side permission check used by every endpoint. A request that fails it returns a
   refusal and writes an audit event — it never silently returns empty data.
10. Client-side navigation reflects the role, but is treated as cosmetic: every screen's data call
    is independently authorised.
11. Consultant scope rule: a consultant's every query is automatically narrowed to their own
    records (R-23).
12. Recruiter scope rule: a recruiter's every query is automatically narrowed to consultants
    currently assigned to them (P-03). Removing an assignment removes access immediately, but the
    historical record of what they saw remains in the audit log.

**Assignments**
13. Owner assigns a consultant to a recruiter.
14. Owner reassigns a consultant from one recruiter to another; the previous assignment row is
    closed with an effective-to date, never overwritten.
15. Assignment history view showing who moved whom, when, and why.
16. Guard: a consultant cannot be left without a recruiter while active; a consultant cannot have
    two current recruiters.

**Audit log**
17. Audit write helper invoked by every consequential action. Phase 1 covers: login success, login
    failure, logout, 2FA enrolment, 2FA failure, user created, user role changed, user disabled,
    user re-enabled, password reset, assignment created, assignment changed.
18. Later phases add their own action codes to the same log: resume download (Ph 2/3/4), answer
    approval (Ph 2), token issued/revoked (Ph 4), contact view (Ph 7), bulk contact export (Ph 8).
19. Owner-only audit viewer with filters by actor, action, target, date range, and machine.
20. Immutability enforcement at three layers: no update/delete operation exists in the application;
    the database account the application uses holds insert-and-select rights only on that table;
    and a periodic integrity check (sequence/chain verification) detects any out-of-band tampering.

**Owner user administration**
21. Create a recruiter (name, email, initial credential, 2FA required by default).
22. Create a consultant (name, email; full profile comes in Phase 2).
23. List users with role, status, assigned recruiter, last login.
24. Disable / re-enable a user, with the reason recorded.
25. Remove a recruiter — blocked while consultants are still assigned to them; the owner must
    reassign first. This is a guard, not a silent cascade.

### Rules enforced
R-09 (append-only audit — the headline restriction of this phase), R-11 (audit coverage begins
here), R-23 (consultant read-only scope), R-08 (nothing hard-deleted; disable, never delete),
P-01/P-11/P-15.

### Dependencies & stubs
None upstream. Phases 2, 3, 8 all mount inside the Phase 1 shell and call the Phase 1 permission
engine.

### Manual test gate

*Access control*
1. Log in as owner → 2FA is demanded → dashboard shell loads with owner navigation.
2. Log in as recruiter → 2FA is demanded → recruiter navigation only.
3. Log in as consultant → logs in per the configured 2FA setting → consultant navigation only.
4. As a recruiter, request an owner-only URL directly → refused, and the refusal appears in the
   audit log.
5. As a recruiter, request a consultant record belonging to the *other* recruiter → refused.
6. As a consultant, request another consultant's record → refused.
7. Disable a user while they have a live session → their next action is rejected and they are
   logged out.

*Assignments*
8. As owner, assign consultant C1 to recruiter R1 → R1 sees C1; R2 does not.
9. Reassign C1 to R2 → R2 now sees C1; R1's access is gone within the same session; both the old
   and new assignment rows exist in history.
10. Try to delete recruiter R1 while consultants are assigned → blocked with a clear message.

*Audit*
11. Every one of the above actions has a matching audit row with actor, action, target, time, and
    machine.
12. Attempt to edit an audit row through the application → no such capability exists.
13. Attempt to delete an audit row directly with the application's own database credentials →
    permission denied at the database layer.
14. Run the integrity check → reports intact.

### Exit criteria
- All 14 test-gate items pass and are recorded in the test-evidence log.
- Every row of the §2 permission matrix that Phase 1 can express has a passing automated test.
- The audit log has been proven un-editable by two independent means (application + database).

---

# PHASE 2 — Recruiter Portal (Complete)

**Duration guide:** 3–3.5 weeks. The largest portal phase.
**This is your "recruiter portal, all tabs, every feature" phase.**

### Objective
Give a recruiter everything they need to run their assigned bench: see their consultants, maintain
their search criteria, watch their queues, work the approval inbox, review flagged resumes, search
records, and work the contact store — with every action scoped to their own list and fully audited.

### Modules delivered

- **M2.1 Consultant profile module** (profile, work authorization, base resume, daily cap view)
- **M2.2 Search criteria module** (full editor with versioning)
- **M2.3 Queue module** (queue item record, state machine, overlap flag, stall surfacing)
- **M2.4 Application record module** (permanent record, per-application Q&A list, resume linkage)
- **M2.5 Answer bank module** (answers, states, normalised question keys, sensitive routing)
- **M2.6 Approval workflow module** (two-person rule, recruiter inbox, owner routing)
- **M2.7 Resume review module** (fabrication-flag queue and its decisions)
- **M2.8 Contact display & contact store search module**
- **M2.9 Recruiter dashboard & reporting module**
- **M2.10 Operator Simulation Panel** (owner-only; creates the records engines will later create)
- **M2.11 Notification & alert module** (in-portal alert centre; delivery channel decided later)

### Data objects introduced

**Consultant profile:** contact details, work-authorization status, base resume artifact, current
search criteria, daily application cap, portal-conservatism flags, consent-on-file flag, notes.

**Queue item:** consultant, job posting, portal type, tailored resume artifact, bundled approved
answers snapshot, status, overlap flag, per-transition timestamps, skip reason, stall reason,
parked-on-answer reference.

Queue item state machine (exact states from spec §7):

```
                    ┌──────────┐
                    │  QUEUED  │  created by discovery (Ph5) or Simulation Panel
                    └────┬─────┘
       app opens job     │
                         ▼
                    ┌──────────┐   unknown question hit   ┌────────────────┐
                    │  FILLED  │ ───────────────────────► │ PARKED-UNKNOWN │
                    └────┬─────┘                          └───────┬────────┘
       form complete     │                                        │ answer approved
                         ▼                                        │ (returns to fill)
                 ┌────────────────┐  ◄──────────────────────────--┘
                 │ AWAITING-SUBMIT│  app stopped at review screen (R-02)
                 └────┬───────────┘
     human clicks     │
     submit           ▼
                 ┌───────────┐
                 │ SUBMITTED │  terminal — application record finalised
                 └───────────┘

    Any state ──► ┌─────────┐  with mandatory reason: login-stalled, portal-error,
                  │ SKIPPED │  cap-reached, job-closed, filler-failure, owner-cancelled
                  └─────────┘
```

**Application record:** consultant, job, company, portal, submitted-at, final status (submitted /
waiting-on-consultant / stalled-on-login / skipped-with-reason), exact resume artifact reference,
full ordered Q&A list. Written once, never edited (corrections are appended as annotations).

**Answer:** consultant, question text as asked, normalised question key, answer text, status
(pending / approved / rejected), approver, approval time, correction note, sensitive flag (salary /
work-authorization), source (which application first raised it), usage count.

Answer state machine:

```
   consultant types answer          recruiter (or owner) reviews
   ┌──────────┐                     ┌──────────────────────────────┐
   │ (unknown)│ ──── fills ───────► │           PENDING            │
   └──────────┘                     └──────┬──────────────┬────────┘
                                           │              │
                             approve /     │              │  reject with note
                             correct+approve│             │
                                           ▼              ▼
                                    ┌────────────┐  ┌──────────┐
                                    │  APPROVED  │  │ REJECTED │
                                    └─────┬──────┘  └────┬─────┘
                                          │              │ consultant may re-answer
                                          │              └────► back to PENDING
                                joins answer bank, reusable

   Routing gate: sensitive flag (salary expectations OR work authorization)
                 ⇒ recruiter approval is BLOCKED; only the owner can approve. (R-07)
   Identity gate: approver.id ≠ answer.consultant.user_id, always. (R-06)
   No path exists from (unknown) directly to APPROVED. (R-06)
```

### Feature list — tab by tab

#### Tab 1 — Dashboard (recruiter home)
1. Headline counters for the recruiter's own bench only: applications today, this week, per
   consultant.
2. Queue health strip: items queued / filled / parked-unknown / awaiting-submit / submitted /
   skipped, per consultant.
3. **Stalled logins panel** — consultants whose portal session expired, which portal, since when.
   This is the recruiter's most urgent action list.
4. **Pending approvals badge** — count of answers waiting on this recruiter, with the oldest-waiting
   age shown (so nothing rots).
5. **Flagged resumes badge** — tailored resumes the fabrication check flagged, awaiting this
   recruiter's review.
6. **Overlap flags** — jobs that appear in more than one of their consultants' queues, shown as an
   informational flag only. Overlap is expected and allowed; each consultant applies under their own
   name (R-01, R-03).
7. Daily cap usage bar per consultant (used / cap), showing which consultants have hit the cap.
8. Recent activity feed scoped to their consultants.
9. Every dashboard number is click-through to the underlying filtered list.

#### Tab 2 — My Consultants
10. List of consultants currently assigned to this recruiter, with: name, work-authorization status,
    daily cap, today's usage, queue depth, unknowns waiting, last application, device/app status,
    active/disabled.
11. Search and filter across that list (by status, by cap usage, by stalled state).
12. Explicit statement in the UI when the list is empty because nothing is assigned — not a blank
    screen.
13. No path from this tab to any consultant outside the recruiter's list, including by direct URL
    (P-03).

#### Tab 3 — Consultant Detail (sub-tabbed workspace)
The core working screen. Opens on a single consultant with the following sub-tabs:

**3a. Profile**
14. View contact details, work-authorization status, consent-on-file flag, daily cap (read-only —
    caps are owner-set, P-06).
15. View the base resume: single-file, view-in-place or single download, each download audited
    (R-10, R-11).
16. Editable notes field with an append-only note history.

**3b. Search Criteria** (P-10 — recruiter may edit for their own consultants)
17. Job titles list (add / remove / reorder by priority).
18. Keywords list, with include and exclude groups.
19. Locations list, including remote/hybrid/onsite designation and radius where relevant.
20. Work types: contract, full-time, part-time, C2C, W2 — multi-select.
21. Minimum pay (rate or salary, with the unit made explicit).
22. Excluded companies list.
23. Active/paused toggle for the whole criteria set (pauses discovery for that consultant without
    deleting anything).
24. Criteria versioning: every save creates a new version with editor and timestamp; previous
    versions viewable; audit event written. This matters because "why did this job match?" is
    answered by the criteria version in force at match time.
25. A preview panel showing how many of the last 7 days' postings *would have* matched the current
    criteria — becomes live once Phase 5 exists; reads the seeded posting set before that.

**3c. Queue**
26. The consultant's current queue: job title, company, location, portal type, status, age, tailored
    resume link, contact card indicator.
27. Filter by status, portal, age; sort by any column.
28. Queue item detail drawer: job description, matched criteria, tailored resume preview (single
    file), attached contact card(s), and the full transition timeline of that item.
29. Actions on a queue item: re-queue a skipped item, cancel an item with a reason, and view the
    parking reason for parked-unknown items.
30. Explicit visual for R-03: nothing on this screen allows moving a job to a different consultant.

**3d. Applications**
31. Full application history for this consultant: date, company, title, portal, final status.
32. Application detail: the exact resume PDF that was submitted (single-file access, audited), and
    the complete question-and-answer list exactly as the form asked and as it was answered.
33. Status filters, especially "stalled-on-login" and "skipped-with-reason" with the reason text
    shown inline.
34. No bulk export of resumes anywhere on this tab (R-10).

**3e. Answers**
35. The consultant's answer bank: approved answers with their question text, answer text, approver,
    approval date, and how many times each has been used.
36. Pending answers awaiting this recruiter.
37. Rejected answers with the rejection note and whether the consultant has re-answered.
38. Sensitive answers (salary / work-authorization) shown clearly marked and **read-only to the
    recruiter**, with the label "routed to owner" (R-07).

**3f. Contacts**
39. All contacts attached to this consultant's queued and applied jobs: name, title, company,
    business email, phone, source, date pulled.
40. Every view of a contact card writes an audit event (R-11).
41. Do-not-contact toggle available here (P-13), with a confirmation step, because it is permanent
    (R-14).

#### Tab 4 — Approval Inbox
The recruiter's second-most-used screen after the dashboard.
42. All pending answers across all their consultants in one list, oldest first by default.
43. Each row shows: consultant, the question exactly as the form asked it, the consultant's proposed
    answer, the job/application that raised it, and how long it has been waiting.
44. Three actions per item: **Approve as-is**, **Correct and approve** (recruiter edits the answer
    text, and the edit is recorded as the recruiter's), **Reject with note** (note is mandatory).
45. Similar-question grouping: if the same normalised question is pending for several consultants,
    they are grouped for faster processing — but each is approved individually and audited
    individually.
46. **Sensitive items are visible but not actionable.** A salary or work-authorization item shows a
    locked state with "Owner approval required" and appears in the owner's queue instead (R-07).
47. **Two-person rule enforcement** (R-06): the approve action is refused if the approver is the same
    person as the answering consultant. This is checked server-side, not just hidden in the UI.
48. Every approval, correction, and rejection writes an audit event with before/after answer text.
49. On approval, the answer enters the answer bank and becomes available to future applications;
    any queue item parked on that specific unknown is automatically released back to fillable state.

#### Tab 5 — Resume Review
50. List of tailored resumes the fabrication check flagged, for this recruiter's consultants only.
51. Side-by-side comparison: base resume against tailored resume, with the specific claims the check
    flagged highlighted and its reasoning shown.
52. Actions: **Approve to queue** (the resume proceeds and the queue item is created),
    **Reject and regenerate** (returns for a fresh tailoring attempt), **Reject and skip job**
    (queue item is skipped with reason).
53. Every decision is audited with the recruiter's identity and the flagged-claim list.
54. The recruiter can read the flagged claims but **cannot see or edit the tailoring instruction
    set** (R-05).
55. Before Phase 6 exists, this tab is fed by the Simulation Panel, which can mark a seeded resume
    as flagged with sample claims — so the workflow is fully testable in Phase 2.

#### Tab 6 — Records Search
56. Search across the recruiter's consultants only: by company, by job title, by consultant, by date
    range, by final status.
57. Results show application records with click-through to the exact resume and Q&A list.
58. Result counts and empty-state messaging that distinguishes "no results" from "not permitted".
59. Export of the *result list* (metadata) is permitted; export of resume *files* in bulk is not
    (R-10).

#### Tab 7 — Contact Store
60. Search the full contact store by person name, company, title, or location (P-13 — recruiters get
    full-store search, unlike consultants).
61. Contact detail: name, title, company, work location, business email, phone, data source, date
    pulled, age in days, and every job it is linked to.
62. Flag do-not-contact, with confirmation and mandatory reason; permanent and irreversible in
    effect (R-14).
63. Freshness indicator showing whether a contact is inside or beyond the 90-day reuse window
    (R-13).
64. **No bulk export** — bulk contact export is owner-only (P-14). The option is absent, and the
    underlying endpoint refuses recruiters.
65. Every contact search and every contact detail view is audited (R-11).

#### Tab 8 — Alerts
66. In-portal alert centre for: new stalled login, new pending approval, new flagged resume, cap
    reached, queue empty for more than N hours, consultant device token revoked or offline.
67. Read/unread state, and a link straight to the item that raised the alert.
68. Per-alert-type mute settings for the recruiter, except stalled logins and sensitive approvals,
    which cannot be muted.

#### Tab 9 — My Account
69. Profile, password change, two-step verification management, recovery codes, active sessions with
    revoke.
70. The recruiter's own recent activity, sourced from the audit log — a recruiter may see their own
    audit trail, but not the global log (P-11).

#### Owner-only — Operator Simulation Panel (M2.10)
Not a recruiter tab. Lives in the owner area, built in this phase because it is what makes Phases
2–4 testable before the engines exist.
71. Create a job posting by hand (paste a real posting URL and its details; fingerprint computed
    automatically).
72. Create a queue item for a chosen consultant from a chosen posting.
73. Attach an uploaded PDF as the "tailored resume" for a queue item.
74. Mark a tailored resume as fabrication-flagged with sample flagged claims.
75. Create a contact record and link it to a job.
76. Force a queue item into any state, with the forced transition clearly labelled as manual in the
    audit log — so nothing manual can ever be mistaken for engine output.
77. Every simulation action is audited as `simulated:*` so test data is distinguishable forever.

### Rules enforced
R-01, R-03, R-06, R-07, R-08, R-10, R-11, R-17 (cap display and enforcement at assignment time),
R-23 (recruiter cannot act as a consultant), P-03, P-04, P-08, P-10, P-12, P-13, P-14.

### Dependencies & stubs
- Consumes Phase 1 identity, permissions, and audit.
- Queue items, tailored resumes, contacts, and fabrication flags come from the Simulation Panel
  until Phases 5, 6, and 7 replace those producers. **No portal code changes when they do.**
- Application Q&A lists are hand-seeded until Phase 4's desktop app reports real ones.

### Manual test gate

*Scoping*
1. Recruiter R1 sees exactly their assigned consultants, and nothing about R2's.
2. Direct-URL access to an R2 consultant's queue, application, answer, or profile → refused and
   audited.

*Criteria*
3. Edit a consultant's criteria across all seven fields → saved, versioned, audited; the previous
   version is still viewable.
4. Pause criteria → the consultant is marked paused; nothing is deleted.

*Approval workflow (the heart of this phase)*
5. Seed an unknown question for consultant C1 → it appears as pending in R1's inbox.
6. Approve as-is → status becomes approved, answer enters the bank, audit written with approver.
7. Correct and approve → the corrected text is what enters the bank; both original and corrected
   text appear in the audit event.
8. Reject with note → status rejected, note visible to the consultant in Phase 3.
9. **Two-person rule:** log in as consultant C1 and attempt to approve C1's own answer by every
   route available (UI, direct request) → refused every time (R-06).
10. **Sensitive routing:** seed a salary-expectation answer and a work-authorization answer → both
    appear in R1's inbox as locked, both are refused if R1 attempts approval by direct request, and
    both appear in the owner's approval queue (R-07).
11. A queue item parked on an unknown returns to fillable state the moment that unknown is approved.

*Queue & records*
12. Create three queue items via the Simulation Panel; drive one through every state; confirm each
    transition is timestamped and visible on the item timeline.
13. Skip an item → the reason is mandatory and is displayed everywhere the item appears.
14. Confirm no UI path and no endpoint allows moving a queue item to a different consultant (R-03).
15. Open an application record → the exact resume file and the full Q&A list are shown.
16. Download a resume → single file only, audit event records time, person, and machine (R-11).
17. Search for any bulk-resume-download capability across the entire portal → none exists (R-10).

*Resume review*
18. Simulate a flagged resume → it appears in Tab 5 with the flagged claims; approving it creates
    the queue item; rejecting it skips the job with a reason.
19. Confirm the tailoring instruction set is nowhere visible or editable in the portal (R-05).

*Contacts*
20. Search the contact store as recruiter → works. Attempt bulk export → refused (P-14).
21. Flag a contact do-not-contact → confirmation required, flag set, audited, and thereafter the
    contact shows as DNC everywhere.
22. Verify every contact view produced an audit row (R-11).

*Dashboard*
23. Every dashboard counter matches a hand count of the underlying seeded data.
24. Stalled-login panel populates when a queue item is skipped with reason `login-stalled`.
25. Overlap flag appears when one seeded job is queued for two consultants.

### Exit criteria
- All 25 gate items pass and are logged.
- A recruiter can complete a realistic full working day using only this portal against seeded data.
- Every restriction in the Rules-enforced list has at least one negative test proving it blocks.

---

# PHASE 3 — Consultant Web Portal (Complete)

**Duration guide:** 2–2.5 weeks.
**This is your "consultant web portal, all features" phase.**

### Objective
Give a consultant a read-only window onto their own work, plus the one and only thing they are
allowed to write: answers to unknown questions, which then require someone else's approval.

The governing constraint (R-23): *consultants get read-only access to their own profile and queue;
they cannot see other candidates, edit criteria, or change answers directly.*

### Modules delivered

- **M3.1 Consultant dashboard**
- **M3.2 My Queue view (own items only)**
- **M3.3 Unknowns workflow (fill → pending → approved/rejected)**
- **M3.4 My Applications history**
- **M3.5 My Resumes (per-job single access)**
- **M3.6 My Profile (read-only)**
- **M3.7 Device & App status (Phase 4 hand-off surface)**
- **M3.8 Contact card display (own queue items only)**
- **M3.9 Consultant alerts & account settings**

### Feature list — tab by tab

#### Tab 1 — My Dashboard
1. Today at a glance: applications submitted today, cap for today, remaining allowance (R-17).
2. Queue summary by state: queued, filled, parked-unknown, awaiting-submit, submitted, skipped.
3. **Action-needed panel, ordered by urgency:**
   - Applications waiting at the review screen for their submit click (R-02) — always first.
   - Unknown questions waiting for them to answer.
   - Portals whose login has expired and needs re-login.
   - Answers that were rejected and need re-answering.
4. Desktop app status: last check-in time, app version, activation state, current cycle state.
5. Recent activity for themselves only.
6. Every panel is click-through to its tab.

#### Tab 2 — My Queue
7. Their own queue items only. No other consultant's data is reachable by any route (R-23, P-08).
8. Per item: job title, company, location, portal type, status, age, and the tailored resume for
   that job.
9. Item detail: full job description, the tailored resume for this specific job (view/download,
   single file, audited — R-10/R-11), and the item's state timeline.
10. **Contact card on the queue item** — name, title, company, business email, phone (P-12,
    spec §4.1). Displayed per queue item only; the consultant has **no** access to the wider contact
    store and no search over it (P-13). Every view is audited (R-11).
11. Parked items show plainly *which* unknown question is blocking them and link to the answer form.
12. Skipped items show the skip reason in plain language.
13. Read-only: no state changes, no re-queueing, no cancelling. The consultant acts through the
    desktop app, not here.

#### Tab 3 — Unknowns (the consultant's only write surface)
14. List of questions the desktop app could not answer, newest first, each showing the job and
    company it came from.
15. Answer form showing the question exactly as the portal asked it, with the appropriate input
    shape (free text, yes/no, number, choice) captured from the form.
16. On save, the answer is created as **PENDING**. It is never used on any application until approved
    (R-06).
17. Clear status labelling per item: *Waiting for your answer* / *Waiting for recruiter approval* /
    *Waiting for owner approval* / *Approved* / *Rejected — please revise*.
18. Sensitive questions (salary expectations, work authorization) are visibly labelled as going to
    the owner, so the consultant understands the longer wait (R-07).
19. Rejected answers show the reviewer's note and allow one re-answer, which returns to pending.
20. **The consultant cannot approve anything**, including their own answers, from any screen or by
    any direct request (R-06). No approve control exists in this portal at all.
21. Approved answers are visible read-only in a "my approved answers" section so the consultant can
    see what will be used on their behalf — but they cannot edit them. A change request goes through
    a new pending answer, not an edit (R-23).

#### Tab 4 — My Applications
22. Complete personal application history: date, company, title, portal, final status.
23. Application detail: the exact resume PDF submitted for that job, and the complete
    question-and-answer list as filled.
24. Filters by status and date; search by company or title.
25. Status meanings shown in plain language, especially *stalled on login* and *skipped with reason*.
26. Permanent history — nothing the consultant can delete (R-08).

#### Tab 5 — My Resumes
27. Their base resume, viewable and downloadable as a single file.
28. Every tailored resume, listed per job with the `Company_Title_Date.pdf` name, accessible one at a
    time from its job.
29. **No bulk download control anywhere** (R-10). The underlying endpoint refuses any multi-file
    request regardless of role.
30. Every access writes an audit event with time, person, and machine (R-11).

#### Tab 6 — My Profile
31. Read-only view of: contact details, work-authorization status, assigned recruiter, daily cap,
    and current search criteria.
32. The criteria are shown so the consultant understands what they are being matched against, but
    are **not editable** (P-10, R-23).
33. A "request a change" action that creates a note for their recruiter — a message, not an edit.
34. Consent-on-file status displayed (spec §12).

#### Tab 7 — My App & Device
The hand-off surface into Phase 4; built now so Phase 4 has somewhere to land.
35. Current device: activation state, machine label, activated date, app version, last heartbeat.
36. Download links for the installer, per operating system.
37. Step-by-step activation instructions, including where the one-time token comes from (the owner,
    P-07 — the consultant cannot issue their own).
38. Per-portal login status: which portals have a valid saved session, which have expired and need a
    fresh login (spec §5.2).
39. A clear "your login for portal X expired — open the app and sign in again" call to action, since
    an expired session stops that portal's queue for them and only them (R-03).
40. Read-only on tokens: the consultant can see state but cannot issue, re-issue, or revoke (P-07).

#### Tab 8 — Alerts
41. Alerts for: applications ready for your submit click, new unknowns, rejected answers, expired
    portal logins, cap reached, token revoked.
42. Read/unread and click-through.

#### Tab 9 — My Account
43. Password change, two-step verification management if enabled for them, active sessions with
    revoke.
44. Their own recent activity from the audit log; no access to the global log (P-11).

### Rules enforced
R-02 (the portal continuously reinforces that the consultant does the submitting), R-06, R-07, R-08,
R-10, R-11, R-23 (the defining rule of this phase), P-08, P-09, P-12, P-13 (denied), P-07 (denied).

### Dependencies & stubs
- Consumes Phase 1 identity/permissions/audit and every Phase 2 data object.
- Queue items, tailored resumes, contacts, and unknowns still come from the Simulation Panel until
  Phases 4–7 produce them for real.

### Manual test gate

*Isolation*
1. Consultant C1 sees only their own queue, applications, resumes, answers, and contacts.
2. Direct-URL attempts at C2's queue item, application, resume, answer, and contact → each refused
   and audited.
3. Attempt to reach the contact store search endpoint as a consultant → refused (P-13).
4. Attempt to reach the audit log as a consultant → refused (P-11).

*Read-only enforcement*
5. Attempt to edit search criteria by every available route → refused (P-10, R-23).
6. Attempt to edit an already-approved answer → refused; only a new pending answer is possible.
7. Attempt to change a queue item's state → refused.
8. Attempt to issue or revoke a device token → refused (P-07).

*Unknowns workflow, end to end with Phase 2*
9. Simulate an unknown for C1 → it appears in C1's Unknowns tab with the exact question text.
10. C1 answers → status pending → it appears in that consultant's recruiter's approval inbox.
11. Recruiter approves → C1's view flips to approved, and the answer appears in "my approved
    answers", read-only.
12. Recruiter rejects with a note → C1 sees the note and can re-answer once, returning to pending.
13. Simulate a salary question → C1's view says owner approval; the recruiter's inbox shows it
    locked; the owner can approve it (R-07).
14. **C1 attempts to approve their own pending answer by direct request → refused (R-06).**

*Resumes and records*
15. Download the base resume and one tailored resume → both work as single files, both audited with
    machine identity.
16. Attempt any multi-resume request → refused (R-10).
17. Application detail shows the exact submitted PDF and the complete Q&A list.

*Status surfaces*
18. Mark a portal session expired via the Simulation Panel → C1's dashboard and App tab both show
    the re-login call to action; the recruiter's stalled-login panel shows it too; **no other
    consultant's queue is affected** (R-03).
19. Set today's usage to the cap → the dashboard shows the cap reached and no further items are
    assigned (R-17).

### Exit criteria
- All 19 gate items pass and are logged.
- Negative tests confirm the consultant cannot write anything except a pending answer.
- The Phase 2 ↔ Phase 3 loop (unknown → fill → approve → reusable) works end to end with the
  two-person rule and sensitive routing both proven.

---

# PHASE 4 — Consultant Desktop Application

**Duration guide:** 3–3.5 weeks. Split into five sub-stages, each independently testable.
**This is your "consultant app / exe" phase — environment setup, verify it works, then features,
then access model.**

### Objective
Deliver a small program the consultant installs once on their own machine that pulls their queue,
opens job portals in a real browser using their own saved logins, fills the forms at human pace,
stops dead at the review screen for them to submit, reports everything back, and leaves nothing
sensitive behind.

### 4A — Environment setup and proving the environment works

Do this *before* writing any product feature. Its whole purpose is to answer "can this machine
drive a real browser reliably?" separately from "does our logic work?".

**Modules**
- **M4.1 Local development environment** for the desktop app, on both target operating systems
  (Windows and Mac, spec §5.1).
- **M4.2 Browser automation runtime installation** — the browser binary/runtime the app will drive,
  installed as part of the app's own setup rather than assumed present on the machine.
- **M4.3 Persistent browser profile store** — one isolated, protected profile directory per portal,
  in a per-user protected location, so a logged-in session survives between runs exactly the way a
  normal browser stays signed in (spec §5.2).
- **M4.4 Smoke-test harness** — a standalone runnable check that proves the environment before any
  real work runs.

**Environment smoke tests (must all pass before 4B starts)**
1. Launch a visible browser window from the app and navigate to a public page.
2. Log in manually to a test site inside that window, close the app entirely, relaunch, and confirm
   the session is still logged in from the saved profile.
3. Fill a multi-field test form with human-paced typing and confirm the values landed correctly.
4. Upload a file to a test form.
5. Detect a page that failed to load / timed out, and exit cleanly with a clear error instead of
   hanging.
6. Detect that a session has expired (redirected to a login page) and report it rather than trying to
   log in.
7. Confirm the protected profile directory is per-user and not world-readable.
8. Run the same seven checks on the second operating system.

**Deliverable of 4A:** a written environment-verification report, plus the smoke harness kept in the
repo permanently — it becomes the first diagnostic whenever a consultant reports the app misbehaving.

### 4B — Identity, access, and activation (how the app is allowed in)

This is the "how to access — tokens or something new" question, answered concretely.

**The access model, in three layers:**

| Layer | What it is | Lifetime | Who controls |
|---|---|---|---|
| **Activation token** | A one-time code the owner generates in the portal and hands to one named consultant. Single use. Short expiry (e.g. 72 hours). | One use, then dead | Owner (P-07) |
| **Device credential** | Created at activation by binding the activation token to that consultant **and** that machine's fingerprint. This is the app's long-lived identity. Never leaves the machine's protected store. | Until revoked | Owner revokes; consultant cannot re-issue |
| **Working session credential** | Short-lived credential the app obtains by presenting the device credential, used for the actual queue-pull and report-back calls. Refreshed automatically. | Minutes to hours | Hub issues; dies on revocation |

Why three layers rather than one long-lived token: the activation token can be handed over a
low-security channel because it is single-use and short-lived; the device credential never travels;
and the working credential's short life is what makes "revoke kills the app instantly" (R-21) true
in practice rather than in theory.

**Modules**
- **M4.5 Token issuance (portal side, owner-only)** — generate, display once, mark issued, expire
  unused tokens, audit issuance (P-07).
- **M4.6 Activation flow (app side)** — first-run screen accepting the token, computing a stable
  machine fingerprint, binding, and storing the device credential in the operating system's
  protected credential store.
- **M4.7 Heartbeat & revocation enforcement** — the app checks in on a short interval and before
  every cycle; a revoked or unknown device is refused, the app wipes local working data and
  self-locks with a clear message (R-21).
- **M4.8 Device registry (portal side)** — owner sees every device: consultant, machine label,
  activated date, app version, last heartbeat, state; and revokes with one action.

**Features**
1. Owner issues a one-time activation token for a named consultant; the token is displayed once and
   the issuance is audited.
2. Consultant installs the app and enters the token on first run.
3. The app binds token + person + machine fingerprint; a second machine using the same token is
   refused (R-21).
4. The device credential is stored in the platform's protected credential store, never in a plain
   file.
5. Every hub call carries the working credential; every call is attributable to a specific device in
   the audit log (R-11).
6. The owner revokes a device from the portal → the app's next heartbeat or call is refused → the app
   stops all work immediately, deletes local working files, and displays a locked state (R-21).
7. A revoked device cannot be reactivated with the old token; the owner must issue a new one.
8. The app version is reported on every heartbeat, so the owner can see who is out of date.
9. The consultant's own App tab (Phase 3, Tab 7) reflects all of this state read-only.

**Explicitly out of scope:** the app never holds any *portal* password (R-18). Activation credentials
authenticate the app to *the hub only*.

### 4C — Portal login and saved sessions

**Modules**
- **M4.9 Portal registry** — the list of supported portal types, each with its login-detection rule,
  session-validity check, and its own isolated browser profile.
- **M4.10 Assisted-login flow** — the app opens a real, visible browser window at the portal's login
  page and **steps aside**. The consultant logs in themselves, including any code sent to their
  phone. The app waits, then verifies the session is live and closes the window (spec §5.2).
- **M4.11 Session validity monitor** — before each portal's work, verify the saved session; on
  expiry, pause that portal's queue, notify the consultant locally, and report the stall to the hub
  so it surfaces on the recruiter and owner dashboards (spec §5.2).
- **M4.12 Per-company account handling** — corporate portals requiring one account per company:
  the consultant creates each account once, and the session is saved the same way. Expect a burst of
  one-time logins in the first two weeks (spec §5.2).

**Features**
10. First use of any portal triggers the assisted-login flow; the app never types a portal password.
11. Sessions persist across app restarts and machine reboots.
12. Session expiry is detected before work starts, not mid-form.
13. On expiry: that portal's items are paused for that consultant only; other portals keep working;
    no job is ever moved to another consultant (R-03).
14. The stall is reported to the hub with the portal name and time, and appears in the recruiter's
    stalled-login panel and the consultant's action-needed panel within one cycle.
15. A per-portal login-status screen in the app mirrors Phase 3 Tab 7.

### 4D — The application cycle (the core feature set)

**Modules**
- **M4.13 Cycle scheduler** — wakes every 4 hours with a small random offset so activity does not
  look machine-timed (spec §5.3).
- **M4.14 Queue puller** — fetches this consultant's current queue: job link, portal type, tailored
  resume, and the approved answers likely needed for that portal's form (spec §3.3).
- **M4.15 Form-filling engine** — per-portal fillers, starting with the two simplest portal families
  (the ones the pilot uses); the remaining portals arrive in Phase 9.
- **M4.16 Unknown-question handler** — detects a question with no approved answer, sends it to the
  hub as an unknown, and parks that application.
- **M4.17 Review-screen stop & submission confirmation** — the hard human gate.
- **M4.18 Reporter** — sends status, the full question-and-answer list, and outcomes back to the hub.
- **M4.19 Local cleanup** — deletes all working files at cycle end.
- **M4.20 Behaviour limiter** — human pacing, strict serialisation, local cap enforcement.
- **M4.21 App user interface** — a small always-available interface (system-tray style or equivalent)
  showing cycle state, items awaiting submit, unknowns, portal login state, and a manual "run now".

**The cycle, step by step (spec §5.3):**

```
 wake (4h + random offset)
   └─ check device credential valid ────────► revoked? wipe + lock, stop
   └─ check today's local cap remaining ────► reached? sleep until tomorrow (R-17)
   └─ pull queue from hub
        for each item, ONE AT A TIME, never parallel (R-19):
          ├─ check that portal's saved session ──► expired? pause portal, notify, report, next portal
          ├─ open job link in real browser with saved session
          ├─ fill every field from hub-provided data + approved answers, human-paced
          ├─ attach the tailored resume for this job
          ├─ hit an unanswerable question?
          │     └─ send unknown to hub, PARK item, close cleanly, move to next item
          ├─ page layout unexpected / filler cannot proceed?
          │     └─ SKIP with clear error, never submit partial data (R-26)
          └─ form complete ─► STOP AT REVIEW SCREEN, mark AWAITING-SUBMIT (R-02)
   └─ present the awaiting-submit list to the consultant
   └─ consultant reviews each and clicks SUBMIT themselves
   └─ app confirms the submission landed, reports to hub with the full Q&A list
   └─ delete all local working files (R-20)
   └─ sleep
```

**Features**
16. Automatic 4-hour cycle with randomised offset; plus a manual "run now" the consultant can
    trigger.
17. Queue pull delivers only what is needed for the current queue — jobs, resume files for those
    jobs, and the approved answers likely needed. Nothing else is ever sent down (spec §2).
18. Resume files are fetched **per job**, one at a time, never as a batch (R-10), and every fetch is
    audited hub-side with time, person, and machine (R-11).
19. Form filling uses the consultant's own identity throughout — their name, email, and portal
    account (R-01).
20. Human-paced typing with realistic per-character delays, natural pauses between fields, and
    randomised think-time before submission-adjacent actions (R-19).
21. Strictly one application at a time. No concurrency anywhere in the app (R-19).
22. Local daily cap enforcement, independent of the hub's enforcement. If the two disagree, the
    lower wins (R-17).
23. Unknown-question detection → the question text is captured exactly as the form asked it →
    posted to the hub → the item moves to PARKED-UNKNOWN → the consultant sees it in the portal
    (Phase 3 Tab 3) and in the app.
24. A parked item resumes automatically on a later cycle once the answer is approved — no manual
    re-queue needed.
25. Completed forms **stop at the review screen**. The app never clicks the final submit under any
    circumstance, including in test mode (R-02).
26. The app lists all awaiting-submit applications for the consultant with the job, company, and a
    reminder to check the form before submitting.
27. After the consultant submits, the app confirms the submission actually landed (confirmation page
    or equivalent signal) before reporting success. An unconfirmed submit is reported as
    waiting-on-consultant, not submitted.
28. The full question-and-answer list is reported for every application, exactly as asked and
    answered, and becomes the permanent Q&A record (spec §3.5).
29. Failure handling: any filler failure, unexpected layout, missing field, or portal error parks or
    skips the item with a clear, specific error message. Partial or wrong data is never submitted
    (R-26).
30. Local cleanup at the end of every cycle deletes downloaded resumes, temporary form data, logs
    containing job or answer content, and any scratch files. Only the saved browser sessions and the
    app itself persist (R-20).
31. The app's own diagnostic log is scrubbed of answer content and job detail, keeping only
    timings, states, and error codes.
32. Offline handling: if the hub is unreachable, the app reports nothing, does no work, retries with
    backoff, and shows a clear offline state.

### 4E — Packaging, installation, and update

**Modules**
- **M4.22 Installer build** for both operating systems, producing a single downloadable installer.
- **M4.23 First-run experience** — install → launch → enter activation token → assisted login per
  portal → first cycle.
- **M4.24 Update mechanism** — version check on heartbeat, notify the consultant, and a
  minimum-supported-version rule the hub can enforce (old versions are refused, not silently
  tolerated).
- **M4.25 Uninstall** — removes the app and the device credential, and leaves the browser profiles
  removable by explicit choice.
- **M4.26 Consultant-facing installation guide** — plain language, screenshot-led, written for a
  non-technical user.

**Features**
33. One installer per operating system, downloadable from the consultant's App tab.
34. Install requires no technical knowledge and no separately installed prerequisites — the browser
    runtime comes with it.
35. Clean-machine test: install, activate, log in to one portal, complete one application to the
    review screen, submit, and see it in the portal — with no developer assistance.
36. Version is visible in the app and reported to the hub.
37. Below-minimum versions are refused by the hub with an upgrade message.

### Rules enforced
R-01, R-02 (the defining rule of this phase), R-03, R-10, R-11, R-17, R-18, R-19, R-20, R-21, R-26.

### Dependencies & stubs
- Consumes Phase 1 (identity/audit), Phase 2 (queue items, approved answers, application records),
  Phase 3 (consultant-facing status surfaces).
- Queue items are created by the Simulation Panel and point at **real, live job postings** on the
  first supported portals, which is what makes this phase testable without the discovery engine.
- Tailored resumes are hand-uploaded PDFs until Phase 6.

### Manual test gate

*Environment (4A)*
1. All eight 4A smoke tests pass on both operating systems, evidenced in the verification report.

*Access & tokens (4B)*
2. Owner issues a token → it displays once → issuance is audited.
3. Activate on machine A → success. Attempt the same token on machine B → refused (R-21).
4. Attempt to activate with an expired token → refused.
5. Inspect the machine's filesystem → no plain-text credential exists.
6. Owner revokes the device mid-cycle → the app stops within one heartbeat interval, wipes local
   working files, and shows a locked state. Confirm no further hub call from that device succeeds
   (R-21).
7. Attempt reactivation with the revoked token → refused; a new token works.

*Portal login (4C)*
8. First use of a portal opens a visible browser; the consultant logs in manually including a phone
   code; the app never touches the password field (R-18).
9. Restart the machine → the session is still valid; no re-login needed.
10. Invalidate the session (log out elsewhere) → the app detects it before starting work, pauses that
    portal only, notifies locally, and reports the stall, which appears on the recruiter dashboard
    and the consultant dashboard (R-03).

*The cycle (4D) — the core proof*
11. Queue three real jobs by hand across two portal types. Run a cycle.
12. Observe: one application at a time, never two browsers working at once (R-19).
13. Observe: typing is visibly human-paced, not instant (R-19).
14. Each form is filled correctly from the hub data and approved answers; the correct tailored
    resume is attached for each job.
15. **The app stops at the review screen on every one. Verify by watching. Nothing is submitted
    without a human click (R-02).**
16. Introduce a question with no approved answer → the item parks, the exact question text arrives
    in the hub, and it appears in the consultant's Unknowns tab and the recruiter's inbox.
17. Approve that answer in the portal → the next cycle picks the item back up and completes it.
18. Consultant clicks submit on one → the app confirms, reports, and the application record in the
    portal shows status *submitted* with the exact resume and the full Q&A list.
19. Leave one un-submitted → it is reported as *waiting on consultant*, visible to the recruiter.
20. Break a form deliberately (point at a changed/invalid page) → the item skips with a clear error;
    nothing partial is submitted (R-26).
21. Set the daily cap to 2 and queue 5 items → the app stops at 2, locally, even if the hub sent
    more (R-17).
22. After the cycle, inspect the machine: no resume files, no form data, no job text, no answer text
    remain. Only browser profiles and the app (R-20).
23. Attempt a bulk resume fetch from the app's credentials → refused hub-side (R-10).
24. Confirm every resume fetch produced a hub audit row with time, person, and machine (R-11).

*Packaging (4E)*
25. Install on a genuinely clean machine from the installer alone and complete test items 2, 8, 11,
    and 18 with no developer help, following only the written guide.
26. Repeat on the second operating system.

### Exit criteria
- All 26 gate items pass on both operating systems and are logged.
- R-02 has been visually verified, not just asserted: a human watched the app stop at the review
  screen for every application in a multi-item cycle.
- A non-technical person completed installation and first application using the written guide alone.

---

# PHASE 5 — Job Discovery Engine

**Duration guide:** 1.5–2 weeks.

### Objective
Replace the Simulation Panel as the source of queue items: every 4 hours, find new postings, throw
away duplicates and implausible ones cheaply, match the rest against each consultant's criteria, and
populate queues within each consultant's daily cap.

### Modules delivered

- **M5.1 Cycle orchestrator** (4-hour schedule, run record, resumable, non-overlapping)
- **M5.2 Source connectors** — the source families named in spec §3.1: public company career-page
  feeds (three named feed platforms), job-alert emails parsed by the system, and a paid search feed
  for coverage. Each connector is independent and individually disableable.
- **M5.3 Normaliser** — every source's output is converted to one common posting shape
- **M5.4 De-duplication engine** (fingerprint: company + title + location)
- **M5.5 Keyword pre-filter** (title + location, cheap, runs before any AI call)
- **M5.6 AI matching stage** (match / no-match against each relevant consultant's criteria)
- **M5.7 Work-type classifier** (contract / full-time / part-time / C2C / W2)
- **M5.8 Queue assignment engine** (cap-aware, overlap-flagging)
- **M5.9 Run observability** (per-stage counts, errors, cost markers)

### Pipeline

```
  sources ──► normalise ──► FINGERPRINT DEDUPE (company+title+location)   R-15
                                  │  drop anything already seen
                                  │  keep only first-seen-after-last-run
                                  ▼
                          KEYWORD PRE-FILTER (title + location)           R-16
                                  │  ~90% dropped before any AI cost
                                  ▼
                          AI MATCH per relevant consultant
                          + work-type classification
                                  │
                                  ▼
                          per-consultant CAP CHECK                        R-17
                                  │  cap reached? stop assigning
                                  ▼
                          QUEUE ITEM created (status QUEUED)
                          overlap flag set if the same job
                          entered more than one queue
                                  │
                                  ▼
                    hand-off to Phase 6 (tailoring) and Phase 7 (contacts)
```

### Features
1. Runs every 4 hours on a schedule; a run that is still going never overlaps with the next one.
2. Each run creates a run record with start, end, per-stage in/out counts, per-source errors, and
   cost markers.
3. Source connectors pull only from sources that permit it cleanly (spec §3.1). Each records its own
   success/failure without failing the whole run.
4. Job-alert emails are parsed into postings by the system from a dedicated intake mailbox.
5. Every posting is normalised to: source, source URL, company, title, location, work type, pay if
   listed, full description text, portal type, first-seen time.
6. **De-duplication by company + title + location fingerprint** (R-15). Only postings first seen
   after the previous run move forward. A repeat sighting updates last-seen, never creates a second
   row.
7. **Keyword pre-filter runs first and always** (R-16) — title and location matching against each
   consultant's criteria, drastically cutting what reaches the AI stage. The pre-filter's pass rate
   is reported per run so it can be tuned.
8. AI matching decides match / no-match against each relevant consultant's criteria and classifies
   the work type. The decision and a short reason are stored with the match so "why did this
   match?" is always answerable.
9. Criteria fields all participate: titles, keywords (include and exclude), locations, work types,
   minimum pay, excluded companies. Excluded companies are applied as a hard filter before matching,
   never as a soft signal.
10. Paused criteria mean the consultant is skipped entirely for that run.
11. Matched jobs become queue items in that consultant's queue with status QUEUED.
12. **One job matching several consultants appears in each of their queues**, each applying under
    their own name, and the overlap flag is set for dashboard visibility (spec §3.3, R-01, R-03).
13. **Daily caps stop assignment**: once a consultant's cap for the day is reached, the hub stops
    assigning to them; remaining matches are held for the next day rather than discarded (R-17).
14. Failures in any single source, posting, or match do not abort the run; they are recorded and the
    run continues.
15. Owner-visible run history with the ability to inspect any run's counts and errors (surfaces
    fully in Phase 8).
16. The Simulation Panel remains available for manual queueing alongside the engine, clearly marked
    as manual.

### Rules enforced
R-03, R-15, R-16, R-17, plus the matching-cost discipline that makes the pre-filter mandatory.

### Manual test gate
1. Trigger a run manually → a run record is created with per-stage counts.
2. Feed the same posting twice from two sources → one posting row, fingerprint matched, second
   sighting recorded as a repeat (R-15).
3. Change only the location on an otherwise identical posting → treated as a distinct posting
   (fingerprint is company + title + location).
4. Confirm the pre-filter runs before the AI stage and that the run record shows the drop rate
   (R-16). Disable the pre-filter in a test build → the AI-stage input count explodes, proving the
   pre-filter is doing the work.
5. Set a consultant's criteria narrowly → only matching postings enter their queue; check five
   matches and five non-matches by hand against the criteria.
6. Add a company to the excluded list → its postings never appear, regardless of how well they match.
7. Pause a consultant's criteria → they are skipped entirely.
8. Set a cap of 3 and force 10 matches → exactly 3 queue items are created; the rest are held, not
   lost (R-17).
9. Queue the same posting for two consultants → both queues contain it, the overlap flag is set, and
   the recruiter and owner dashboards show the overlap (R-03).
10. Break one source connector deliberately → the run completes, the failure is recorded, other
    sources still deliver.
11. Two runs cannot overlap: trigger a second run while one is going → it is refused or deferred.
12. Every queue item created by the engine is distinguishable in the audit log from one created by
    the Simulation Panel.

### Exit criteria
All 12 gate items pass; a full unattended 24-hour period (six cycles) runs with queues populating
correctly and no duplicate postings.

---

# PHASE 6 — Resume Tailoring Engine

**Duration guide:** 1.5 weeks.

### Objective
Turn each matched job plus the consultant's base resume into a job-specific tailored resume that
rewords and reorders what is already true — and prove, with a second independent check, that nothing
was invented.

### Modules delivered

- **M6.1 Locked instruction set** (server-side only, not exposed, not editable by any portal user)
- **M6.2 Tailoring stage** (job description + base resume → tailored resume)
- **M6.3 Fabrication-check stage** (second, independent comparison against the base resume)
- **M6.4 Document renderer** (output PDF named `Company_Title_Date.pdf`)
- **M6.5 Artifact store & linkage** (file stored in the hub, linked to the queue item and later to
  the application record)
- **M6.6 Flagged-resume router** (flagged resumes go to the recruiter's Phase 2 Tab 5, not to the
  queue)

### Features
1. For each matched job, the tailoring stage receives the job description plus the consultant's base
   resume, under a locked instruction set: **keep the existing format, section order, and voice;
   reorder and reword bullet points to mirror the job description's keywords; surface relevant real
   experience.**
2. **Hard rule, enforced in hub code and not editable by any consultant or recruiter: the model may
   rephrase and emphasise what is already true, but must never fabricate skills, tools, employers,
   dates, or accomplishments** (R-04, R-05).
3. The instruction set is not readable, retrievable, or overridable through any portal screen or API
   response, at any role level (R-05).
4. A **second, separate, cheaper check** compares the tailored resume against the base resume and
   flags any claim with no basis in the original. This is a distinct call, not a self-check by the
   same step — that separation is the whole point.
5. Clean resumes proceed: the PDF is rendered, named `Company_Title_Date.pdf`, stored in the hub,
   linked to the queue item, and the item becomes available to the desktop app.
6. **Flagged resumes do not enter the queue.** They route to the assigned recruiter's Resume Review
   tab with the specific flagged claims and the checker's reasoning (spec §3.2).
7. Recruiter decisions from Phase 2 Tab 5 are honoured: approve-to-queue creates the queue item;
   reject-and-regenerate triggers one fresh tailoring attempt; reject-and-skip skips the job with a
   reason.
8. Repeated regeneration is bounded — after a set number of failed attempts the job is skipped and
   the recruiter is told, so nothing loops forever.
9. Every tailored resume stores its own provenance: which base resume version, which job, when
   generated, the checker's verdict, and the flagged-claim list if any.
10. **Resumes are delivered per job only. There is no bulk resume download anywhere in the system**
    (R-10) — re-verified here because this phase is what creates the files.
11. Every generation and every delivery is audited (R-11).
12. Repeated identical inputs (same base resume, same rules) are handled efficiently so cost stays
    proportional to jobs, not to re-sent context.
13. Model selection per stage is a configuration value, changeable without a rebuild (spec §8 notes
    the tailoring stage may be upgraded later as a one-line change).

### Rules enforced
R-04 and R-05 (the defining rules of this phase), R-08, R-10, R-11.

### Manual test gate
1. Queue a job for a consultant whose base resume you know verbatim → a tailored PDF is produced,
   named `Company_Title_Date.pdf`, linked to the queue item.
2. Read the tailored resume against the base: format, section order, and voice are preserved;
   bullets are reordered and reworded toward the job's keywords.
3. **Ground-truth fabrication test:** using a base resume with no mention of a specific tool, confirm
   the tailored version never claims it. Run this across at least 20 jobs and read every one (R-04).
4. **Checker test:** deliberately inject a fabricated claim into a tailored resume before the check
   → the checker flags it, the resume does not enter the queue, and it appears in the recruiter's
   Resume Review tab with the claim highlighted (spec §3.2).
5. Recruiter approves a flagged resume → the queue item is created and the desktop app can use it.
6. Recruiter rejects and regenerates → a new attempt is produced; after the attempt limit, the job
   skips with a clear reason.
7. Attempt to view or modify the instruction set as owner, recruiter, and consultant, through every
   screen and every API response → not present anywhere (R-05).
8. Attempt any bulk resume download as every role → refused (R-10).
9. Confirm every generation and delivery wrote an audit event (R-11).
10. Confirm the tailored resume attached by the desktop app in Phase 4 is byte-identical to the one
    later stored on the application record (R-08).

### Exit criteria
All 10 gate items pass; **zero fabricated content found across a 20-resume manual read**, which is
also the pilot's headline success gate (spec §11).

---

# PHASE 7 — Contact Discovery Engine

**Duration guide:** 1.5–2 weeks.

### Objective
For every job that enters a queue, attach the person to contact — using the local store first,
licensed providers second, and never scraping.

### Modules delivered

- **M7.1 Poster extractor** (read the posting for a named person)
- **M7.2 Contact store lookup** (90-day reuse, de-duplicated by name + company)
- **M7.3 Enrichment connector — email** (licensed provider, by person + company)
- **M7.4 Enrichment connector — phone** (licensed providers, fallback order)
- **M7.5 Fallback search** (two active talent-acquisition contacts at that company in that work
  location, ranked by seniority match to the role)
- **M7.6 Contact linking** (one contact, many jobs)
- **M7.7 Do-not-contact enforcement**
- **M7.8 Credit ledger & monthly budget cutoff**

### The waterfall (spec §3.6) — stops at the first step that produces a usable contact

```
 job enters a queue
        │
 ┌──────▼───────────────────────────────────────────────────────────┐
 │ STEP 1 — Read the posting.                                       │
 │ Some portals name the poster; others do not.                     │
 │ Personal name found? carry it to step 2.                         │
 └──────┬───────────────────────────────────────────────────────────┘
        │
 ┌──────▼───────────────────────────────────────────────────────────┐
 │ STEP 2 — Check the contact store FIRST.  ZERO COST.              │
 │ That person — or, if no poster was named, that company +         │
 │ location — already pulled within 90 days? REUSE IT.              │
 │ This is the default path once the store fills up.        R-13    │
 └──────┬───────────────────────────────────────────────────────────┘
        │ miss, or older than 90 days
 ┌──────▼───────────────────────────────────────────────────────────┐
 │ STEP 3 — Enrich through the licensed provider.                   │
 │ Look the person up by name + company → business email.           │
 │ Then spend phone credits → phone number.                         │
 │ Store the result with source and date.                           │
 └──────┬───────────────────────────────────────────────────────────┘
        │ no personal name at all ("HR Team" / blank)
 ┌──────▼───────────────────────────────────────────────────────────┐
 │ STEP 4 — Fallback. Search the provider for TWO active            │
 │ talent-acquisition / recruiting people at that company in        │
 │ that work location, ranked by seniority match to the role.       │
 │ Enrich both. Both attach to the job.                             │
 └──────┬───────────────────────────────────────────────────────────┘
        ▼
   contact(s) linked to the job; visible on the queue item

 GATES APPLIED THROUGHOUT:
   • do-not-contact flagged?  → never attach, never re-pull, permanently   R-14
   • monthly credit budget reached? → REUSE-ONLY MODE, no external pulls   R-25
   • never scrape LinkedIn; licensed provider interfaces only              R-12
```

### Features
1. Runs immediately after job matching, for every job that enters a queue.
2. Poster extraction reads the posting text for a named individual and distinguishes a personal name
   from a generic one ("HR Team", "Recruiting", blank).
3. Store-first lookup is always attempted before any paid call — by person + company when a name is
   known, by company + location when it is not (R-13).
4. The 90-day rule: a contact pulled within 90 days is reused at zero cost; a re-pull is only
   permitted after 90 days (R-13).
5. Email enrichment through the licensed provider by person + company.
6. Phone enrichment through the phone-credit providers, with a defined fallback order between them.
7. Fallback search returns exactly two talent-acquisition contacts at that company in that work
   location, ranked by seniority match to the role; both are enriched and both attach.
8. Every contact stores: person name, title, company, work location, business email, phone, data
   source, date pulled, do-not-contact flag.
9. **De-duplication by person name + company** — one person contacted for five jobs is one contact
   record linked five times, not five pulls (R-13).
10. Contact links record which contact attaches to which job and when.
11. **Do-not-contact is permanent**: flagged once by a recruiter or owner, the system stops attaching
    that person to any job, forever, and never spends credits on them again (R-14).
12. **The system never scrapes LinkedIn.** All contact data arrives through licensed providers'
    official interfaces. Sales Navigator remains a manual recruiter tool with no connection to the
    system (R-12).
13. **Credit ledger**: every external call records provider, operation, credits consumed, and what it
    was for, with a running monthly total.
14. **Monthly credit budget, set by the owner**: when reached, the system drops into **reuse-only
    mode** — store hits still work, external pulls stop, and jobs without a store hit get no contact
    rather than an over-budget one. The owner is alerted (R-25).
15. Visibility follows the matrix: consultants see contacts on their own queue items only (P-12);
    recruiters and owner see them everywhere and can search the full store (P-13); bulk export is
    owner-only (P-14).
16. **Every contact view is logged** (R-11, spec §4.1).
17. Contact freshness is displayed everywhere a contact appears, so a stale contact is obvious.

### Rules enforced
R-12, R-13, R-14, R-25, R-11, P-12, P-13, P-14.

### Manual test gate
1. Queue a job whose posting names a person → step 1 extracts the name; step 3 enriches; a contact
   record is created with source and date; it appears on the queue item.
2. Queue a second job for the same person at the same company → **step 2 hits the store, zero
   credits spent**, and a second contact link is created against the same single contact record
   (R-13).
3. Age a contact past 90 days in the data → the next job triggers a fresh pull; before 90 days it
   does not (R-13).
4. Queue a job whose posting says "HR Team" → step 4 runs and attaches exactly two talent-acquisition
   contacts at that company and location.
5. Flag a contact do-not-contact → it is removed from future attachment, never re-pulled, and shows
   as DNC everywhere. Queue a new job for that same person → no contact is attached and no credits
   are spent (R-14).
6. Set the monthly credit budget to a value just above current spend → cross it → the system enters
   reuse-only mode, external pulls stop, store hits still work, and the owner is alerted (R-25).
7. Reset the budget for a new month → normal pulling resumes.
8. Review the code and the network activity for any direct LinkedIn profile access → none exists
   (R-12).
9. As a consultant, view the contact on your own queue item → allowed. Attempt the contact store
   search → refused (P-12, P-13).
10. As a recruiter, search the store → allowed. Attempt bulk export → refused (P-14).
11. Confirm every contact view in tests 9 and 10 produced an audit row (R-11).
12. Verify the credit ledger's monthly total matches a hand count of the calls made during testing.

### Exit criteria
All 12 gate items pass; the store demonstrably reduces spend on repeat companies (test 2 spends
nothing); reuse-only mode has been triggered and recovered from.

---

# PHASE 8 — Owner Command Center

**Duration guide:** 2 weeks.

### Objective
Give the owner the single screen from which the whole agency is run and audited — the full-visibility
counterpart to the recruiter and consultant portals.

Note: the owner's *essential* administrative screens (create users, assign consultants, view audit)
shipped in Phase 1 so the earlier phases were operable. This phase delivers the complete command
center: agency-wide analytics, global search, policy controls, budgets, the token console, and the
audit explorer.

### Feature list — tab by tab

#### Tab 1 — Agency Dashboard
1. Applications per day and per week, agency-wide.
2. The same numbers broken down **per recruiter** and **per consultant** (spec §4.1).
3. Overlap flags across the whole bench.
4. **Stalled logins across the entire bench**, grouped by portal, so a portal-wide problem is
   obvious.
5. **Pending salary and work-authorization approvals** — the owner's own action queue (R-07).
6. Flagged-resume count agency-wide.
7. Cap utilisation across the bench: who is at cap, who is well under, which caps are mis-set.
8. Cycle health: last discovery run, last tailoring run, last contact run, with counts and errors.
9. Spend indicators: AI usage trend and contact-credit consumption against the monthly budget.

#### Tab 2 — Global Search
10. **A search box that returns every application ever made for a name or company** (spec §4.1),
    across all consultants and all time.
11. Results carry the resume and answers attached, click-through to the exact submitted PDF and the
    complete Q&A list (P-02).
12. Filters by consultant, recruiter, portal, status, date range.
13. Metadata export of results; **no bulk resume export** (R-10).

#### Tab 3 — Users & Roles
14. Full user list with role, status, assignment, last login, device state.
15. Create, disable, re-enable, and role-change any user (P-01).
16. Force password reset and 2FA reset.
17. Add and remove recruiters, with the guard that consultants must be reassigned first (P-01).

#### Tab 4 — Assignments
18. Assign and reassign consultants to recruiters (P-01).
19. Full assignment history: who moved whom, when, and why.
20. Recruiter load view: how many consultants each recruiter carries and their aggregate queue depth.

#### Tab 5 — Consultants
21. Every consultant, unrestricted (P-02), with all Phase 2 consultant-detail sub-tabs available to
    the owner across the whole bench.
22. Owner may edit search criteria for any consultant (P-10).

#### Tab 6 — Caps & Policy
23. **Set the daily application cap per consultant** (P-06, R-17), with the change taking effect at
    the next cycle and being audited.
24. Bulk cap adjustment across a group of consultants.
25. Portal-conservatism settings, including the LinkedIn limits (R-22).
26. Cycle timing settings (interval and jitter bounds).

#### Tab 7 — Approvals
27. **The owner's approval inbox for salary and work-authorization answers — the only place these can
    be approved** (P-05, R-07).
28. The owner may also approve any ordinary pending answer for any consultant (P-04, "Yes (all)").
29. Two-person rule still applies to the owner: the owner cannot approve an answer they authored
    (R-06).
30. Every decision audited with before/after text.

#### Tab 8 — Contacts
31. Full contact store search (P-13).
32. **Bulk contact export — owner only** (P-14), heavily audited: who exported, what filter, how many
    rows, when.
33. Do-not-contact management and history (R-14).
34. Contact-store health: total contacts, share inside the 90-day window, reuse rate.

#### Tab 9 — Devices & Tokens
35. **Issue a one-time activation token for a consultant** (P-07).
36. Device registry: consultant, machine, activated date, app version, last heartbeat, state.
37. **Revoke any device instantly** (R-21), with the revocation and its effect both audited.
38. Stale-device view: activated but not heard from in N days.
39. Minimum-supported-app-version control.

#### Tab 10 — Budgets & Spend
40. **Monthly contact-credit budget per provider, with the reuse-only cutoff** (R-25, spec §8.3).
41. Credit spend per provider, current month and trend, with the ledger drill-down.
42. AI usage and cost per stage (matching, tailoring, checking, unknown-matching), current month and
    trend.
43. Alerts at configurable thresholds before a budget is reached, not only at the cutoff.

#### Tab 11 — Audit Explorer
44. **Full audit log, owner only** (P-11), filterable by actor, action, target type, target, date
    range, machine, and IP.
45. Pre-built views for the actions the spec calls out explicitly: every login, every resume
    download, every answer approval, every assignment change, every token issued or revoked (spec
    §3.5).
46. Per-record history: pick any application, answer, contact, or user and see its complete audit
    trail.
47. Integrity-check status display, proving the log has not been tampered with (R-09).
48. Export of audit slices for review, with the export itself audited.

#### Tab 12 — System Health
49. Cycle run history with per-stage counts and errors (Phase 5).
50. Source connector health: which feeds are working, which are failing, since when.
51. Provider connector health for contact enrichment.
52. Backup status: last backup, last successful restore test (Phase 10).
53. Queue-wide anomaly indicators: queues not draining, unknowns not falling, skip rate rising.

### Rules enforced
R-07, R-09, R-10, R-11, R-14, R-17, R-21, R-22, R-25, and permission rows P-01, P-02, P-05, P-06,
P-07, P-11, P-13, P-14.

### Manual test gate
1. Every dashboard number reconciles against a hand count of seeded and real data.
2. Global search for a company returns every application ever made to it, across consultants, with
   resume and Q&A attached (P-02).
3. Set a consultant's cap → next cycle honours it → the change is audited (P-06, R-17).
4. A salary answer can be approved **only** here — verified by attempting it as a recruiter and being
   refused (P-05, R-07).
5. Owner attempts to approve an answer they themselves authored → refused (R-06).
6. Issue a token, activate a device, then revoke it → the app dies within one heartbeat; the whole
   sequence appears in the audit explorer (P-07, R-21).
7. Bulk-export contacts as owner → works and is audited with row count. Attempt it as recruiter →
   refused (P-14).
8. Attempt a bulk resume export as owner → refused; there is no such capability for anyone (R-10).
9. Set a contact-credit budget below current spend → reuse-only mode engages and is visible on this
   dashboard (R-25).
10. Audit explorer returns complete trails for a chosen application, answer, contact, and user.
11. Integrity check reports intact; after an out-of-band tamper attempt in a test environment, it
    reports the breach (R-09).
12. Recruiter and consultant both attempt every URL in this section → all refused (P-02, P-11).

### Exit criteria
All 12 gate items pass; the owner can perform every capability in the §2 matrix marked "Owner" from
this one area, and every capability *not* marked for a role is provably blocked for that role.

---

# PHASE 9 — Portal Coverage Expansion

**Duration guide:** 2 weeks.

### Objective
Extend the desktop app's form-filling coverage from the two pilot portal families to the full set,
in the order the spec mandates, with the most restricted portal last and most conservative.

### Order (spec §10.3, §5.4)

| Order | Portal family | Notes |
|---|---|---|
| 1 (Phase 4) | The two simplest feed-based portal families | Already delivered; used for the pilot |
| 2 | Job-board style portal | Standard filler |
| 3 | Enterprise per-company portal | One account per company; account creation is a one-time consultant action; expect a burst of first-time logins |
| 4 | The professional-network portal | **Last, and most conservative** (R-22) |

### Modules delivered
- **M9.1 Filler framework hardening** — a common structure every filler follows: field discovery,
  mapping, validation, fail-safe parking.
- **M9.2 Per-portal fillers** for the portals above.
- **M9.3 Per-portal behaviour profiles** — volume limits, pacing, and challenge handling per portal.
- **M9.4 Filler self-test suite** — a per-portal check that detects a layout change early rather than
  at fill time.

### Features
1. Each filler maps hub-provided data and approved answers onto that portal's form fields.
2. Each filler attaches the tailored resume in that portal's expected way.
3. Each filler stops at the review screen — no exceptions per portal (R-02).
4. **A page-layout failure parks the application with a clear, specific error rather than submitting
   bad data** (R-26, spec §10.3).
5. Enterprise per-company portals: the consultant creates each company account once; the session is
   saved the same way as any other portal; the app never creates accounts itself.
6. **The professional-network portal receives the most conservative treatment: lowest volume, human
   submit always, and the app stops touching it for the remainder of the day on any bot-check
   challenge** (R-22).
7. Per-portal volume limits are configurable by the owner (Phase 8 Tab 6).
8. Filler self-tests run on a schedule and raise an alert when a portal's form appears to have
   changed, before a consultant hits it.
9. A maintenance runbook per filler: what changed, how to detect it, how to fix it — because portals
   change forms without notice and this is the highest-maintenance area of the system (spec §10.3).

### Manual test gate
Per portal, in order:
1. Complete an application on that portal to the review screen, and submit as the human.
2. The full Q&A list is reported and matches what was on the form.
3. Break the page deliberately → the item parks with a clear error and nothing is submitted (R-26).
4. Session expiry on that portal pauses only that portal (R-03).
5. For the professional-network portal specifically: confirm the low volume limit is enforced, and
   simulate a bot-check challenge → the app stops touching that portal for the rest of the day
   (R-22).
6. Filler self-test detects a deliberately altered form.

### Exit criteria
Every portal in the list passes its six gate items; the maintenance runbook exists for each.

---

# PHASE 10 — Security Review, Backup & Pilot

**Duration guide:** 1.5–2 weeks, plus the 2-week pilot.

### Objective
Prove every safety rule holds under deliberate attack, prove the data can be restored, put the
spending limits in place, and then run the controlled pilot that decides whether the system goes
wider.

### 10A — Security review

**Full re-verification of the rules register.** Every rule R-01 … R-27 gets an explicit pass/fail
with evidence. In particular:

1. **Token revocation, end to end** (R-21): revoke mid-cycle, mid-form, and while offline. In every
   case the app stops, wipes working data, and cannot resume.
2. **Audit immutability** (R-09): attempt edit and delete through the application, through the
   application's database credentials, and through an administrative path. Confirm the integrity
   check detects an out-of-band change.
3. **Two-person rule** (R-06): attempt self-approval as consultant, as recruiter for their own
   authored answer, and as owner for their own authored answer. All refused.
4. **Sensitive routing** (R-07): confirm salary and work-authorization answers are approvable only by
   the owner, by attempting every other route.
5. **No bulk resume download** (R-10): attempt as every role, through the portal, through the API,
   and with the desktop app's credentials.
6. **Per-job delivery logging** (R-11): confirm every resume delivery and every contact view in the
   whole test period has an audit row with time, person, and machine.
7. **No portal passwords anywhere** (R-18): search app storage, hub storage, logs, and network
   traffic. None present.
8. **Local cleanup** (R-20): after a cycle, forensically inspect the consultant machine for residual
   resume, job, or answer data. None present.
9. **Scope isolation**: recruiter-to-recruiter, consultant-to-consultant, and consultant-to-store
   access attempts, all refused and audited.
10. **Encryption** (R-24): confirm data at rest is encrypted and all traffic between app, portal, and
    hub is encrypted in transit.
11. **Server hardening** (spec §6): firewall permitting only web traffic, automatic security updates
    enabled.
12. **No LinkedIn scraping** (R-12): code and traffic review confirms all contact data arrives
    through licensed provider interfaces.
13. **Instruction-set protection** (R-05): confirm the no-fabrication rules are not retrievable or
    modifiable from any portal role.

### 10B — Backup and restore

14. Daily encrypted backups of the database and the resume files, stored **off the server**
    (spec §6).
15. **A restore test performed and documented** — restore into a clean environment and verify record
    counts, resume file integrity, and audit-log continuity.
16. A monthly restore test scheduled and assigned to a named person (spec §6).
17. Backup failure alerting.

### 10C — Spending caps

18. Monthly AI spending cap set in the provider's billing console, so a runaway loop can never
    produce a surprise bill (spec §8.2).
19. Monthly contact-credit budget set per provider with the reuse-only cutoff verified live (R-25).
20. Threshold alerts confirmed to fire before the cutoff, not only at it.

### 10D — Pilot rollout (spec §11)

21. **Scope:** one recruiter, three bench consultants, one job category. Load their profiles, base
    resumes, and search criteria.
22. **Duration and limits:** two weeks, the two simplest portal families only, daily cap of **5
    applications per consultant**.
23. **Week one:** the owner and recruiter review **every** tailored resume and **every** submitted
    application.
24. **Week two:** loosen to spot-checks only if quality held in week one.
25. **This is the first phase where real candidate data enters the system** (R-27), and only after
    10A has fully passed and consultants have signed the consent form (spec §12).

**Pilot success gate — all five must hold before wider rollout:**

| # | Gate | Measure |
|---|---|---|
| G1 | Zero fabricated resume content found | Manual review of every tailored resume in week one |
| G2 | At least 90% of queued applications reach the review screen without manual fixes | Count from queue-item states |
| G3 | Unknowns per consultant fall week over week | Answer-bank growth curve |
| G4 | No portal account warnings | Consultant reports plus portal notifications |
| G5 | Contact accuracy above 80% on a recruiter spot-check of 25 pulled contacts | Email deliverable; phone reaches the right company |

26. **After the gate passes:** add the next portal, raise caps, and onboard the bench in groups of
    five consultants per week so support load stays manageable (spec §11.5).

### Exit criteria
- Every rule R-01 … R-27 has a documented pass with evidence.
- A restore has been performed successfully into a clean environment.
- Both spending caps are live and have been demonstrated to cut off.
- All five pilot success gates hold.

---

## 11. Post-launch operating notes

Carried from spec §10.3 and §12 so they are not lost at handover:

- **Form fillers are the ongoing maintenance burden.** Portals change their forms without notice.
  Budget roughly **one developer-day per month** after launch for filler repairs. Every filler is
  built so a layout failure parks the application with a clear error instead of submitting bad data
  (R-26).
- **Consultant consent** must be signed at onboarding, covering processing of resumes and application
  data through the system, and stating plainly that automated interaction sits against some portals'
  terms of service even with a human submit, and that a portal can still restrict an account. Have an
  attorney review the form.
- **The contact store is agency property**, and the consent form should say so.
- **Contact data is business contact information only** — work email, work phone, title. No personal
  home details are stored. The do-not-contact flag is honoured permanently, and pulls happen only
  through licensed providers whose terms permit this use.
- **Provider pricing changes.** Confirm current AI rates and current contact-credit pricing from the
  owner's existing provider plans before launch, and confirm the monthly allowance covers roughly
  1,500–2,500 new-contact pulls in month one at 20 consultants, dropping to a few hundred per month
  thereafter.
- **Owner decisions locked in this version:** indefinite record retention; consultant-fills /
  recruiter-approves answer flow; salary and work-authorization answers to the owner; independent
  consultant queues; human final submit; contacts visible to consultants per queue item only, with
  the full store searchable by owner and recruiters.

---

## 12. Phase dependency map

```
 Phase 0  Setup
    │
 Phase 1  Identity · Roles · RBAC · Assignments · Audit  ◄── everything depends on this
    │
    ├──► Phase 2  RECRUITER PORTAL (+ all core data objects + Simulation Panel)
    │        │
    │        ├──► Phase 3  CONSULTANT WEB PORTAL
    │        │        │
    │        │        └──► Phase 4  CONSULTANT DESKTOP APP  (uses hand-made queue items)
    │        │                 │
    │        │                 └──► Phase 9  More portal fillers
    │        │
    │        ├──► Phase 5  JOB DISCOVERY  ──► replaces manual queue creation
    │        │        │
    │        │        ├──► Phase 6  RESUME TAILORING ──► replaces manual resume upload
    │        │        └──► Phase 7  CONTACT DISCOVERY ──► replaces manual contact creation
    │        │
    │        └──► Phase 8  OWNER COMMAND CENTER (needs 5,6,7 data to be meaningful)
    │
    └──► Phase 10  SECURITY REVIEW · BACKUP · PILOT   ◄── requires everything
```

**The one thing to protect in this plan:** Phases 5, 6, and 7 must not require any change to the
Phase 2, 3, or 4 code. If an engine phase forces portal rework, the producer/consumer boundary was
drawn wrong and should be corrected before continuing.

---

## 13. Signing off a phase

A phase is complete when, and only when:

1. Every numbered feature in its feature list is demonstrable.
2. Every item in its manual test gate has been run **by you**, by hand, and recorded in the
   test-evidence log with date and result.
3. Every rule in its "Rules enforced" list has at least one **negative** test proving the system
   refuses the forbidden action — not merely that it hides the button.
4. Every action the spec requires to be audited produces an audit row, verified by inspection.
5. The exit criteria are all true.

Do not begin the next phase with an open item from the previous one. The rules register is
cumulative: Phase 4's gate re-tests Phase 1's audit coverage, and Phase 10 re-tests everything.
