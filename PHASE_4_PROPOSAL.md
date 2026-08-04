# Phase 4 — Answer Bank & Approvals

**Status: proposal, awaiting approval. Nothing has been built yet.**

Read §6 and §9 before approving. §6 holds the decisions worth arguing with; §9 holds
the one structural problem with building this before Phase 5, and my proposed answer
to it.

---

## 1. What this feature is, in one paragraph

Every job application form asks questions — *"Years of React experience?"*, *"Are you
authorised to work in the US without sponsorship?"*, *"Expected hourly rate?"* — and
the same questions come back on form after form. The answer bank is SmartApply's
memory of how each consultant answers them: the consultant writes the answer, someone
else approves it, and only then may it be used to fill a form. Salary and
work-authorisation answers are routed to the organisation admin rather than the
recruiter, because those two carry legal and commercial consequences a recruiter
should not settle alone.

---

## 2. Why this feature, and why now

**It is the last thing standing between the system and unattended form-filling.**

```
Phase 1  who they are          ─┐
Phase 2  what they look like   ─┤
Phase 3  what they want        ─┼─→  Phase 5  find the jobs
Phase 4  HOW THEY ANSWER       ─┘    Phase 6  tailor the resume
                                      later   the desktop app fills the form
```

A discovery engine can find a job and a tailoring engine can produce a resume, but the
moment a form asks *"Do you require sponsorship?"* the whole pipeline stops unless a
pre-approved answer exists. The answer bank is what lets an application complete
without a human at the keyboard — and the approval workflow is what stops the system
from confidently submitting something untrue.

It also closes the last unimplemented permissions in the canonical matrix: **P-04**
(recruiters approve answers for their consultants), **P-05** (owner approves salary
and work-auth), **P-09** (consultants fill unknown questions, pending approval), plus
rules **R-06** (two-person rule) and **R-07** (sensitive routing).

---

## 3. The workflow

```
A question exists                    → from a real form (Phase 5+), raised by a
        │                              recruiter, or from the org's common-question set
        ▼
CONSULTANT answers it                → status PENDING. Never used to fill anything yet.
        │
        ▼
Routing decided by CATEGORY          → GENERAL      → the assigned recruiter
        │                              SALARY       → ORG_ADMIN only  (R-07)
        │                              WORK_AUTH    → ORG_ADMIN only  (R-07)
        ▼
REVIEWER picks one of three          ┌─ Approve as-is
        │                            ├─ Correct and approve  (edit recorded as theirs)
        │                            └─ Reject with note     (note mandatory)
        ▼
APPROVED answers enter the bank      → only now may a form be filled with them
        │
        └─→ rejected? consultant sees the note, rewrites, resubmits
```

**The consultant never approves their own answer**, and no reviewer can approve an
answer they themselves wrote (R-06). Enforced server-side, not merely hidden.

---

## 4. Scope — what gets built

Numbered so items can be struck before starting.

### The question bank
| # | Item |
|---|---|
| 1 | Canonical questions per organisation, each with the exact wording and a **normalised key** used to recognise the same question asked differently |
| 2 | A **category** per question, which is what decides who may approve it |
| 3 | Automatic category suggestion from the question text, with a reviewer able to override |
| 4 | A recruiter can raise a question for one consultant, or for the whole bench |
| 5 | A seeded set of common questions so the bank is not empty on day one |

### Answering
| # | Item |
|---|---|
| 6 | Consultant sees their unanswered questions, and answers them |
| 7 | Consultant sees their own bank: approved, pending, and rejected-with-note |
| 8 | Re-answering after a rejection creates a new revision, keeping the old |
| 9 | One current answer per consultant per question, enforced by the database |

### Approving
| # | Item |
|---|---|
| 10 | **Approval inbox** — everything awaiting this reviewer, oldest first, with waiting age |
| 11 | Each row shows consultant, the question **exactly as asked**, the proposed answer |
| 12 | **Approve as-is** |
| 13 | **Correct and approve** — reviewer edits the text; the edit is recorded as theirs, and the consultant's original is kept |
| 14 | **Reject with note** — note mandatory |
| 15 | **Similar-question grouping** — the same normalised question pending for several consultants is grouped, but each is approved and audited individually |
| 16 | **Sensitive items are visible but not actionable** to a recruiter — shown locked, labelled "Owner approval required" (R-07) |
| 17 | **Two-person rule** refused server-side (R-06) |
| 18 | Sidebar badge counting what is waiting on you |
| 19 | Every decision audited with before/after answer text |

### Screens
| # | Screen | Who |
|---|---|---|
| 20 | `/portal/answers` — My Answers | CONSULTANT |
| 21 | `/management/answers` — Approval Inbox | ORG_ADMIN, RECRUITER |
| 22 | Consultant Detail → new **Answers** tab (tabs exist from Phase 3) | ORG_ADMIN, RECRUITER |
| 23 | `/management/questions` — the org's question bank | ORG_ADMIN |

---

## 5. Permission matrix

| Action | SUPER_ADMIN | ORG_ADMIN | RECRUITER | CONSULTANT |
|---|:---:|:---:|:---:|:---:|
| Answer a question | ✗ | ✗ | ✗ | **✓ own only** |
| Approve a GENERAL answer | ✗ | ✓ all | ✓ **assigned only** | ✗ |
| Approve a SALARY answer | ✗ | **✓ only** | ✗ **locked** | ✗ |
| Approve a WORK_AUTH answer | ✗ | **✓ only** | ✗ **locked** | ✗ |
| Correct an answer while approving | ✗ | ✓ | ✓ non-sensitive | ✗ |
| View a consultant's bank | ✗ | ✓ all | ✓ assigned | ✓ own |
| Create or recategorise a question | ✗ | ✓ | ✓ raise only | ✗ |
| Edit an already-approved answer | ✗ | ✓ (new revision) | ✓ assigned, non-sensitive | ✗ propose only |

---

## 6. Design decisions — the ones that matter

### 6.1 Sensitivity is data, not code — and it fails safe

`lkp_question_categories` carries a `requires_owner_approval` flag. Routing reads that
flag; it does not consult a hardcoded list of category names. Adding "Criminal record"
or "Willing to relocate" as owner-only later is a seed change.

**Auto-classification must fail toward caution.** A keyword pass over the question text
suggests the category — *salary, rate, compensation, pay* → SALARY; *visa, sponsorship,
authorised, citizen, H1-B* → WORK_AUTH. When the classifier is unsure, the question is
filed as **owner-approval-required**, not GENERAL.

The asymmetry is deliberate. A GENERAL question wrongly sent to the admin costs one
person thirty seconds. A salary question wrongly marked GENERAL lets a recruiter commit
a rate on the consultant's behalf, which is exactly what R-07 exists to prevent. The
cheap error and the expensive error are not the same size, so the default leans to the
cheap one.

### 6.2 Question normalisation is the crux of the whole feature

Two forms asking *"What is your expected hourly rate?"* and *"Expected hourly rate:"*
are the same question. Recognising that is what makes the bank worth having — and
getting it wrong is the feature's main risk in both directions:

- **too loose** → the system reuses an answer for a question that only looked similar,
  and submits something untrue
- **too tight** → the consultant re-answers the same question for every employer, and
  the bank saves nobody any time

The proposal: lowercase, strip punctuation and collapse whitespace, drop a small
stop-word list, then hash. **Conservative on purpose** — no stemming, no synonyms, no
fuzzy distance. Two questions match only when they are textually the same question.

The consequence to accept up front: some duplicates will survive in the bank. That is
the right failure. A duplicate wastes a little of the consultant's time; a false match
puts words in their mouth on a real application. Fuzzy matching can be added later once
there is real form data to tune against — guessing at it now, with zero real questions
in the database, would be inventing a threshold from nothing.

### 6.3 Answers are revisioned, exactly like criteria

`answers` holds the current row; `answer_revisions` is append-only. Same shape as
`search_criteria` / `search_criteria_versions`, and the same partial unique index trick
for "one current".

The reason is stronger here than for criteria: the audit question is *"who approved
this specific wording, and when?"* If a consultant later disputes that they claimed
five years of experience, the record has to show the exact text, its author, the
reviewer, and whether the reviewer edited it. A mutable answer row cannot answer that.

### 6.4 "Correct and approve" keeps both texts

When a reviewer edits before approving, the row keeps `proposed_text` (the
consultant's) and `approved_text` (what goes in the bank), plus a `was_corrected` flag.

Overwriting the consultant's words with the reviewer's would make the audit trail lie
about who said what — the same reasoning that made Phase 2.1 add a distinct `CANCELLED`
status rather than reuse `WITHDRAWN`.

### 6.5 The two-person rule is checked even though it looks unreachable

Consultants have no approval endpoint, so R-06 is already structurally satisfied. The
check is added anyway: `reviewer_id != answer author`.

It costs one comparison and it survives refactoring. Structural guarantees that depend
on "there is currently no route" quietly stop being guarantees the moment somebody adds
a route — and this is precisely the rule nobody would think to re-test.

### 6.6 An approved answer can be revised, but never silently

An approved answer is not frozen. A rate changes; work authorisation changes. Either
side may start a revision — but a consultant's revision returns to PENDING and must be
re-approved before it is used, and the previously approved answer stays in force until
then. The bank never has a gap, and it never contains an unreviewed value.

---

## 7. Data model

Six new tables. Migrations `019`–`022` (last applied is `018`).

| Table | Purpose | Mutability |
|---|---|---|
| `lkp_answer_statuses` | `PENDING`, `APPROVED`, `REJECTED`, `SUPERSEDED` — with UI labels | seeded lookup |
| `lkp_question_categories` | `GENERAL`, `SALARY`, `WORK_AUTH`, … each with `requires_owner_approval` | seeded lookup |
| `questions` | Canonical text, `normalised_key`, category, org. Unique on `(organization_id, normalised_key)` | mutable (category only) |
| `consultant_questions` | Which questions are outstanding for which consultant, and what raised it | mutable |
| `answers` | The **current** answer per consultant per question | mutable pointer |
| `answer_revisions` | Append-only: every proposal and every decision, with both texts | **append-only** |

House conventions throughout: `CHAR(36)` UUID PKs, `lookup_id INT GENERATED ALWAYS AS
IDENTITY`, `organization_id NOT NULL … ON DELETE CASCADE`, audit columns, composite
`(organization_id, …)` indexes, `lkp_` lookups served by `GET /api/lookups`.

Two database-enforced invariants, in the same style as Phases 2 and 3:

```sql
-- one live answer per consultant per question
CREATE UNIQUE INDEX uq_one_current_answer
    ON answer_revisions (consultant_id, question_id) WHERE is_current;

-- the same question cannot exist twice in one organisation
CREATE UNIQUE INDEX uq_question_key_per_org
    ON questions (organization_id, normalised_key);
```

---

## 8. Endpoints

```
GET    /api/portal/questions                     outstanding + my bank
POST   /api/portal/answers                       submit or revise an answer
GET    /api/portal/answers/count                 sidebar badge

GET    /api/management/answers                   approval inbox, grouped, recruiter-narrowed
GET    /api/management/answers/count             sidebar badge
POST   /api/management/answers/:id/review        approve | correct+approve | reject
GET    /api/management/consultants/:id/answers   one consultant's bank
POST   /api/management/consultants/:id/questions raise a question for a consultant

GET    /api/management/questions                 the org's question bank
POST   /api/management/questions                 ORG_ADMIN — add a question
PATCH  /api/management/questions/:id             ORG_ADMIN — recategorise
GET    /api/lookups                              extended with answerStatuses, questionCategories
```

Guards follow Phase 3: `isManagement` on the shared routes, narrowed by
`canAccessConsultant`, so an out-of-scope id returns **404** rather than confirming it
exists. Sensitive review is refused inside the controller by category, not by route —
a recruiter must be able to *see* a locked salary item (item 16) while being unable to
act on it.

---

## 9. The problem with building this now, and what I propose

**Phase 4 builds a bank with no depositor.**

Questions are supposed to arrive from real application forms. There are no
applications, no queue, and no desktop app — those are Phase 5 and later. Built
literally, this phase ships an approval inbox that is permanently empty.

Phase 3 had a mild version of this (nothing reads criteria yet). Phase 4's is worse,
because criteria at least have an author on day one; answers do not.

**Three ways forward:**

| Option | What it means |
|---|---|
| **A. Build it with proactive answering** *(recommended)* | Ship a seeded set of ~25 common application questions, plus the ability for a recruiter to raise one. Consultants answer them proactively; reviewers approve. The bank is genuinely populated before any form exists, and Phase 5 arrives to find answers already waiting instead of stalling on its first application. |
| **B. Build the schema and approval engine, defer the UI** | Less throwaway work if the real question shapes turn out different. But an unexercised approval engine is an untested one, and Phase 5 would then carry both risks at once. |
| **C. Reorder — do Phase 5 first** | Real questions arrive first and the bank is built against real data. Costs: Phase 5 has no answers, so every application parks on its first unknown, and you would see the pipeline stall constantly during development. |

**I recommend A.** It is how a staffing firm actually onboards someone — you ask the
standard questions up front rather than waiting for a form to ask them. It makes Phase
4 demonstrable end to end on its own, and it front-loads work Phase 5 would otherwise
have to wait on.

### Also explicitly out of scope

| Not building | Why |
|---|---|
| **Usage counts** ("used 14 times") | Requires application records — Phase 5. Showing 0 everywhere would be worse than omitting the column. |
| **Auto-release of queue items parked on an unknown** (plan item 49) | There is no queue yet. The approval hook is a one-line addition once Phase 5 exists. |
| Fuzzy or semantic question matching | §6.2 — needs real form data to tune against. |
| Bulk approve across consultants | Item 15 groups them for speed, but each is approved individually and audited individually, which the spec requires. |

---

## 10. Manual test gate

Every restriction gets a **negative** test proving the server refuses, not merely that
the control is hidden.

### Answering
| # | As | Do | Expect |
|---|---|---|---|
| 1 | consultant1 | Open My Answers | Seeded common questions listed as unanswered |
| 2 | consultant1 | Answer three | All PENDING; none usable yet |
| 3 | consultant1 | Check the answer bank | Nothing approved appears there yet |
| 4 | consultant1 | Re-submit the same answer unchanged | Refused — no empty revision |
| 5 | consultant1 | Revise a pending answer | New revision; exactly one current |

### Routing (R-07)
| # | As | Do | Expect |
|---|---|---|---|
| 6 | recruiter1 | Open the inbox | Sees GENERAL items for assigned consultants only |
| 7 | recruiter1 | Look at a SALARY item | Visible, **locked**, "Owner approval required" |
| 8 | recruiter1 | `POST /answers/<salary-id>/review` by hand | **403** — refused server-side |
| 9 | recruiter1 | Same for a WORK_AUTH item | **403** |
| 10 | admin@molina | Open the inbox | Sees GENERAL **and** both sensitive kinds |
| 11 | — | Add a question whose category the classifier cannot place | Filed as owner-approval-required, not GENERAL |

### Reviewing
| # | As | Do | Expect |
|---|---|---|---|
| 12 | recruiter1 | Approve as-is | Enters the bank; consultant sees it approved |
| 13 | recruiter1 | Correct and approve | Bank holds the reviewer's text; the consultant's original is still stored |
| 14 | consultant1 | Read that answer | Shown it was edited, by whom |
| 15 | recruiter1 | Reject with no note | Refused — note mandatory |
| 16 | recruiter1 | Reject with a note | Consultant sees the note and can rewrite |
| 17 | recruiter1 | Same question pending for 3 consultants | Grouped in one block, each approvable separately |
| 18 | — | Check the audit after a grouped approval | **3 separate rows**, not one |

### Permissions — negatives
| # | As | Do | Expect |
|---|---|---|---|
| 19 | recruiter2 | Review an answer from recruiter1's consultant | **404** |
| 20 | admin@apex | Any Molina answer id | **404** — cross-tenant |
| 21 | consultant1 | `POST /management/answers/:id/review` | **403** |
| 22 | consultant1 | Read another consultant's bank | No id parameter is accepted |
| 23 | superadmin | Any answers endpoint | **403** |
| 24 | — | Reviewer id == answer author (R-06) | **403**, checked server-side |

### Lifecycle
| # | Do | Expect |
|---|---|---|
| 25 | Terminate a consultant with pending answers | Answers cancelled, mirroring Phase 2.1's rule for change requests |
| 26 | Suspend a consultant with pending answers | Kept, and the inbox flags them suspended |
| 27 | Reassign a consultant mid-review | Their pending items move to the new recruiter's inbox |

> Tests 25–27 exist because Phase 3 got this wrong: terminating a consultant left their
> search criteria active (ISSUES.md **H-1**). Any new per-consultant state has to be
> checked against the lifecycle from the start rather than retrofitted.

---

## 11. Files this will touch

| File | Change |
|---|---|
| `db/migrations/019_answer_lookups.sql` | new — statuses, categories with `requires_owner_approval` |
| `db/migrations/020_questions.sql` | new — question bank + normalised key |
| `db/migrations/021_answers.sql` | new — answers + append-only revisions |
| `db/migrations/022_consultant_questions.sql` | new — what is outstanding for whom |
| `db/seeds/001_lookups_seed.js` | statuses + categories |
| `db/seeds/004_common_questions_seed.js` | **new** — ~25 standard application questions |
| `config/questionNormaliser.js` | **new** — normalisation + category classifier, both unit-testable |
| `controllers/answerController.js` | **new** |
| `controllers/questionController.js` | **new** |
| `controllers/managementController.js` | cancel pending answers on terminate |
| `server.js` | 12 routes |
| `pages/portal/MyAnswers.jsx` | **new** |
| `pages/management/AnswerInbox.jsx` | **new** |
| `pages/management/Questions.jsx` | **new** |
| `pages/management/ConsultantDetail.jsx` | third tab |
| `components/answers/*` | **new** — answer card, review actions, grouping |
| `components/layout/Sidebar.jsx` | two badges |
| `App.jsx` | three routes |

All UI from `design/tokens.js`, dialogs from `ui/Modal.jsx`, statuses and categories
from `LookupContext` — per `DESIGN_SYSTEM.md`. No hardcoded status labels.

Rough shape: 4 migrations, 2 new controllers, ~6 new components, 12 endpoints.

---

## 12. What I need from you

1. **§9 — option A, B or C.** This is the real decision; the rest is detail.
2. **§6.1** — confirm SALARY and WORK_AUTH are owner-only, and say whether anything
   else should be (criminal history? relocation? notice period?).
3. **§6.2** — confirm conservative exact-match normalisation, accepting some duplicate
   questions in exchange for never reusing an answer for a question that merely looked
   similar.
4. **Anything in §4 to cut.** Similar-question grouping (item 15) is the most droppable
   — real, but the largest single piece of inbox UI.

## 13. Before Phase 4 starts

Two items from `ISSUES.md` are worth clearing first, because Phase 4 would inherit both:

- **H-1 / H-2** — terminating a consultant leaves their search criteria active, and
  `toggle-active` has no terminated guard. Phase 4 adds another per-consultant state
  with the same lifecycle question (test 25 above), so the pattern should be right
  before it is copied.
- **M-4** — the test suites live in a scratchpad, not the repo. Phase 4 is the largest
  approval surface yet; it needs re-runnable tests rather than another throwaway script.

Neither blocks Phase 4. Both get more expensive after it.
