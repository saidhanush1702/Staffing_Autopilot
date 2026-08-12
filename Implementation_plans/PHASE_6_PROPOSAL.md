# Phase 6 — Application Records & the Working Queue

**Status: proposal, awaiting approval. No code has been written.**

This phase finishes what Phase 5 started. Phase 5 delivered the half that finds
and matches jobs; it deliberately stopped at `QUEUED` because the two halves had
different prerequisites. **§1 is the honest audit of what was left behind** —
read it first, because it is the entire justification for this phase's scope.

---

## 1. What Phase 5 actually left unfinished

Phase 5's own proposal recommended splitting into **5A** (find, match, queue)
and **5B** (application records), and shipping 5A first. That is what happened.
5A is genuinely done. Below is every numbered item from the Phase 5 proposal
that is not.

### Built and working

| Area | State |
|---|---|
| Posting ingestion, normalisation, raw-payload retention | ✅ |
| Fingerprint de-duplication + sightings (R-15) | ✅ |
| Parse-failure quarantine — rows written | ✅ |
| Matching: hard filters, cheap pre-filter (R-16), scoring, reason, criteria version | ✅ |
| Daily caps holding surplus rather than discarding (R-17) | ✅ |
| Overlap flag; no reassignment route anywhere (R-01, R-03) | ✅ |
| Discovery runs, per-stage counts, no-abort-on-failure, no-overlap | ✅ |
| Screens: posting pool, discovery/runs, consultant queue tab | ✅ |

### Not built

| # | Phase 5 item | Reality today |
|---|---|---|
| 8 | Manual entry and CSV import | **Absent.** No `POST /postings`, no import route. The `MANUAL` and `CSV` source rows exist and are unreachable. |
| 9 | Seeded posting set | **Absent.** Matching cannot be demonstrated without a live API key. |
| 17 | Queue state machine enforced server-side | **Partial.** The six states are seeded and the transitions table exists, but `config/queueStates.js` — named in migration `022`'s own comment — was never written. Nothing validates a transition because nothing performs one. |
| 22 | Skip / re-queue / cancel actions | **Absent.** No endpoints. A queue item can only ever be `QUEUED`. |
| 23 | Parked-unknown auto-release | **Absent.** Deferred from Phase 4 (its item 49) pending a queue; the queue now exists. |
| 24–28 | Application records + exact Q&A, append-only | **Absent entirely.** No migration, no table, no controller, no screen. |
| 34 | Consultant Detail → Applications tab | **Absent.** |
| 37 | `/portal/queue` — consultant's own queue | **Absent.** |
| 38 | `/portal/applications` | **Absent.** |

### The consequence, stated plainly

**A queue item today has exactly one state and no verbs.** Discovery puts jobs
in it; nothing takes them out, marks them done, or records that anyone applied.
A recruiter can read the queue and act on it in the real world, but the system
learns nothing from what they did.

That is the gap this phase closes.

---

## 2. What this phase is not

**It is not the desktop application.** Nothing here fills a web form or clicks
submit. That remains a separate, later piece of work.

What Phase 6 does is make the queue **operable by hand** — which is not a
consolation prize. Real staffing firms record applications made manually all
the time, and the schema, the state machine, the permission model and the
evidence trail are identical whether a person or a program drove the
transition. When the submitter arrives it calls the same endpoints this phase
builds, and every screen already works.

```
Phase 5   discovery ──► QUEUED ──╳  (nothing further)

Phase 6   discovery ──► QUEUED ──► FILLED ──► AWAITING_SUBMIT ──► SUBMITTED
                          │           │                              │
                          │           └─► PARKED_UNKNOWN             ▼
                          └─► SKIPPED                        application record
                                                              (permanent)
          ▲ driven by a person, through the UI

later     the desktop app drives exactly the same transitions,
          through exactly the same endpoints
```

---

## 3. Scope

### The queue state machine
| # | Item |
|---|---|
| 1 | `config/queueStates.js` — allowed transitions declared **once**, in one file, as data |
| 2 | Every state write goes through one guard. An illegal transition is **409**, never a silent no-op |
| 3 | `POST /queue/:id/skip` — **reason mandatory**, 422 without one |
| 4 | `POST /queue/:id/requeue` — a skipped item returns to `QUEUED`; both moves stay in history |
| 5 | `POST /queue/:id/transition` — the general move, guarded by the same table |
| 6 | Every transition writes who, when, from, to, why — no exceptions, including machine-driven ones |
| 7 | Queue item detail: the posting, the score, the match reason, the criteria version, and the **full transition history** |

### Application records
| # | Item |
|---|---|
| 8 | `application_records` — **append-only**, trigger + privilege revoke, exactly as `audit_logs` |
| 9 | `application_qa` — the **exact question text as the form asked it**, the exact answer as filled, field type, order |
| 10 | Four final statuses: submitted / waiting-on-consultant / stalled-on-login / skipped-with-reason |
| 11 | Link to the **exact resume file** used |
| 12 | `POST /applications` — record one by hand; the same route the submitter will call later |
| 13 | Reaching `SUBMITTED` and writing the record happen in **one transaction** — neither can exist without the other |
| 14 | **No bulk resume export anywhere** (R-10) — asserted by a test, not just by omission |

### The Phase 4 loop
| # | Item |
|---|---|
| 15 | `queue_items.parked_question_id` — a real foreign key, not a string parsed out of the reason text |
| 16 | Approving an answer **automatically releases** every item that consultant had parked on that question |
| 17 | Rejecting it leaves them parked |
| 18 | Closes Phase 4 proposal item 49, deferred because no queue existed |

### Getting jobs in without the API
| # | Item |
|---|---|
| 19 | `POST /postings` — add a job by hand, attributed to the `MANUAL` source |
| 20 | `POST /postings/import` — CSV, attributed to `CSV`, with a per-row error report |
| 21 | Both go through **the same fingerprint and dedupe path** as discovery — a hand-added duplicate is still a duplicate |
| 22 | A seeded demo posting set, so matching and the queue are demonstrable **with no API key at all** |

### Screens
| # | Screen | Who |
|---|---|---|
| 23 | Queue item **detail drawer** — actions + transition history | ORG_ADMIN, RECRUITER |
| 24 | Consultant Detail → **Applications** tab | ORG_ADMIN, RECRUITER |
| 25 | `/portal/queue` — the consultant's own queue, **read-only** | CONSULTANT |
| 26 | `/portal/applications` — their own history, **read-only** | CONSULTANT |
| 27 | "Add a job" dialog + CSV import on `/management/postings` | ORG_ADMIN, RECRUITER |

---

## 4. The state machine, in full

Declared as data in one file, so the rules are readable in ten seconds and
cannot drift between endpoints.

```
                 ┌──────────────────────────────┐
                 │                              │
   discovery ──► QUEUED ──────────────────► SKIPPED ──┐
                   │                          ▲       │
                   │                          │       │ requeue
                   ▼                          │       │
                 FILLED ─────────────────────►│       │
                   │  ▲                       │       │
     park          │  │  release              │       │
                   ▼  │                       │       │
            PARKED_UNKNOWN ──────────────────►│       │
                   │                          │       │
                   ▼                          │       │
            AWAITING_SUBMIT ─────────────────►┘       │
                   │                                  │
                   ▼                                  │
               SUBMITTED  ◄───────────────────────────┘
              (terminal — writes the application record)
```

| From | May go to |
|---|---|
| `QUEUED` | `FILLED`, `SKIPPED` |
| `FILLED` | `PARKED_UNKNOWN`, `AWAITING_SUBMIT`, `SKIPPED` |
| `PARKED_UNKNOWN` | `FILLED`, `SKIPPED` |
| `AWAITING_SUBMIT` | `SUBMITTED`, `SKIPPED` |
| `SKIPPED` | `QUEUED` *(re-queue — the only way back)* |
| `SUBMITTED` | **nothing.** Terminal. |

**`QUEUED → SUBMITTED` is refused**, and that refusal is the point. A status
column with no transition rules is how "submitted" ends up preceding "filled"
in a history nobody can explain — and this history is the evidence trail behind
a real application sent to a real employer in someone's name.

---

## 5. Design decisions

### 5.1 One guard, not one per endpoint

Every route that changes a queue item calls the same function. It loads the
current state, checks the transition table, writes the row and the history
entry in one transaction, or throws a 409.

The alternative — each endpoint knowing which states it may act on — is how
`requeue` and `transition` end up disagreeing about whether a submitted item
can be reopened. The rule lives in one place and every caller obeys it,
including the desktop app when it arrives.

### 5.2 Application records are append-only at the database, not in code

Same enforcement as `audit_logs`, and for the same reason:

```sql
-- A trigger that refuses the operation outright …
CREATE TRIGGER trg_application_records_immutable
    BEFORE UPDATE OR DELETE ON application_records
    FOR EACH ROW EXECUTE FUNCTION application_records_immutable();

-- … and a privilege revoke, so app_role cannot do it even through SQL
-- injection. Two independent mechanisms, because this is the table that
-- answers "what was sent to an employer in this person's name".
REVOKE UPDATE, DELETE, TRUNCATE ON application_records FROM app_role;
GRANT  INSERT, SELECT                ON application_records TO   app_role;
```

Nobody deletes an application record. Not a recruiter, not an org admin, not a
super admin — there is no endpoint, and the database would refuse one.

### 5.3 The exact question text is stored, not a foreign key to the question

`application_qa` stores the question **as the form worded it**, alongside the
answer as filled. It does not merely point at a row in `questions`.

This looks like denormalisation and is deliberate, matching the choice already
made in `audit_logs` for `performed_by_name`. The question bank is editable; an
application record is a statement about what a specific employer asked on a
specific day. If someone later rewords the canonical question, every historical
record must still say what was actually asked. A foreign key would silently
rewrite history the moment the bank changed.

A nullable link to `questions.id` is kept alongside, for analytics — but the
text is the record.

### 5.4 Parking links to a question, not to a sentence

Phase 5 stores `park_reason` as free text. Releasing an item by pattern-matching
that string would be fragile in the way that eventually strands a real
consultant's queue item forever.

So: `queue_items.parked_question_id`, a proper foreign key. The Phase 4 approval
handler gets a hook — when an answer is approved, one indexed query finds every
item that consultant has parked on that question and returns them to `FILLED`,
writing a transition row for each with the reason "answer approved".

`park_reason` stays as the human-readable sentence. The link is what the machine
uses.

### 5.5 Manual entry uses the same pipeline, not a shortcut

A hand-added posting is fingerprinted and de-duplicated exactly like a
discovered one, and produces a sighting against the `MANUAL` source.

Tempting to skip: it is one insert, and the person typing it presumably knows
whether it is a duplicate. But a manual posting that bypasses R-15 is a posting
that can be queued to a consultant who already has it — and a duplicate
application is visible to the employer.

### 5.6 A seed set, so the system demos without spending a credit

Twenty realistic postings, seeded and attributed to `MANUAL`, matching the demo
consultants' criteria with a deliberate spread: some obvious matches, some
near-misses that should be pre-filtered out, one excluded company, one duplicate
of another with different punctuation.

This is not decoration. Right now the entire matching engine is undemonstrable
without a paid API key, and `ISSUES.md` **L-6** already records that the demo
database has degraded past being a good demo. A fixed bench of postings makes
the cap logic, the overlap flag and the pre-filter drop rate all inspectable in
a fresh checkout.

### 5.7 Consultants stay read-only, still

`/portal/queue` and `/portal/applications` show, and do nothing else. No skip,
no re-queue, no "not interested". R-23 has held through every phase and holds
here.

The one thing a consultant *can* do that moves a queue item is answer a parked
question — and that goes through the Phase 4 approval gate first. They never
touch the queue directly.

---

## 6. Data model

**Three tables, one lookup, one column.** Small, because Phase 5 built the hard
part.

| Table | Purpose | Mutability |
|---|---|---|
| `lkp_application_statuses` | submitted / waiting-on-consultant / stalled-on-login / skipped | seeded lookup |
| `application_records` | one permanent record per application | **append-only, privilege-revoked** |
| `application_qa` | exact question, exact answer, field type, order | **append-only, privilege-revoked** |
| `queue_items.parked_question_id` | new column — what the item is waiting on | mutable |

```sql
-- One application per queue item, ever.
CREATE UNIQUE INDEX uq_application_per_queue_item
    ON application_records (queue_item_id);

-- Releasing parked items must not scan the table.
CREATE INDEX idx_queue_parked_on_question
    ON queue_items (consultant_id, parked_question_id)
    WHERE parked_question_id IS NOT NULL;
```

---

## 7. Endpoints

```
POST   /api/management/postings                      add one by hand
POST   /api/management/postings/import               CSV, per-row error report

GET    /api/management/queue/:itemId                 detail + full history
POST   /api/management/queue/:itemId/skip            reason required → 422 without
POST   /api/management/queue/:itemId/requeue
POST   /api/management/queue/:itemId/transition      guarded by the state machine

GET    /api/management/consultants/:id/applications
GET    /api/management/applications/:id              record + the exact Q&A list
POST   /api/management/applications                  record one; the route the
                                                     desktop app will call later

GET    /api/portal/queue                             CONSULTANT — own, read-only
GET    /api/portal/applications                      CONSULTANT — own, read-only
```

**No route moves an item between consultants. No route deletes an application
record.** Both remain enforced by absence, as in Phase 5.

---

## 8. Permission matrix

| Action | SUPER_ADMIN | ORG_ADMIN | RECRUITER | CONSULTANT |
|---|:---:|:---:|:---:|:---:|
| View a queue | ✗ | ✓ all | ✓ assigned | **✓ own, read-only** |
| Skip / re-queue / transition | ✗ | ✓ | ✓ assigned | ✗ |
| Move an item to another consultant | ✗ | **✗** | **✗** | ✗ |
| Add a posting by hand / CSV import | ✗ | ✓ | ✓ | ✗ |
| View application records | ✗ | ✓ all | ✓ assigned | ✓ own |
| Record an application | ✗ | ✓ | ✓ assigned | ✗ |
| Edit an application record | ✗ | **✗ nobody** | ✗ | ✗ |
| Delete an application record | ✗ | **✗ nobody** | ✗ | ✗ |

---

## 9. Manual test gate

Every restriction gets a negative test proving the server refuses — not merely
that the button is hidden.

### The state machine
| # | Do | Expect |
|---|---|---|
| 1 | Skip an item with no reason | **422** — a reason is mandatory |
| 2 | Skip with a reason | `SKIPPED`, reason stored, transition row written |
| 3 | Re-queue it | Back to `QUEUED`; **both** moves in the history |
| 4 | Force `QUEUED → SUBMITTED` by hand | **409** — refused |
| 5 | Force any transition out of `SUBMITTED` | **409** — terminal |
| 6 | Read an item's history | Every transition: who, when, from, to, why |
| 7 | Two people transition the same item at once | One wins; the other gets a clean 409, not a corrupt state |

### Application records
| # | Do | Expect |
|---|---|---|
| 8 | Record an application, then try to edit it | Refused — no route exists |
| 9 | `UPDATE application_records` as `app_role` in psql | **permission denied** |
| 10 | `DELETE FROM application_records` as `app_role` | **permission denied** |
| 11 | Open a record | Exact questions and exact answers, **in order** |
| 12 | Reword the canonical question in the bank, reopen the record | Historical text **unchanged** |
| 13 | Look for a bulk resume export | None anywhere (R-10) |
| 14 | Force a failure midway through submit | **Neither** the SUBMITTED state nor a partial record exists |

### The Phase 4 loop
| # | Do | Expect |
|---|---|---|
| 15 | Park an item on a question with no approved answer | `PARKED_UNKNOWN`, reason names the question, `parked_question_id` set |
| 16 | Approve that answer in the Phase 4 inbox | Item returns to `FILLED` **automatically**, with a transition row |
| 17 | Reject the answer instead | Item stays parked |
| 18 | Two consultants parked on the same question; approve for one | **Only that one** is released |

### Manual entry and import
| # | Do | Expect |
|---|---|---|
| 19 | Add a job by hand | Posting created, attributed to `MANUAL`, sighting recorded |
| 20 | Add the same job again with different casing and punctuation | **One** posting, two sightings (R-15) |
| 21 | Add a job that duplicates a discovered one | Merged, both sources visible |
| 22 | Import a CSV with three good rows and two broken | Three imported, **two reported by row number**, nothing silently dropped |
| 23 | Run discovery after seeding | Seeded postings match, queue fills, cap holds the surplus — **with no API key set** |

### Permissions — negatives
| # | As | Do | Expect |
|---|---|---|---|
| 24 | recruiter | Queue item of an unassigned consultant | **404** |
| 25 | recruiter | Record an application for an unassigned consultant | **404** |
| 26 | consultant | Own queue | Read-only; no actions rendered **and** none accepted |
| 27 | consultant | `POST /queue/:id/skip` by hand | **403** |
| 28 | consultant | Another consultant's application record | **404** |
| 29 | admin@apex | Any Molina queue item or record | **404** |
| 30 | superadmin | Any Phase 6 endpoint | **403** |

### Lifecycle
| # | Do | Expect |
|---|---|---|
| 31 | Terminate a consultant with an open queue | Queue items cancelled; **application records kept** |
| 32 | Suspend a consultant | Queue held, not cancelled — reversible |
| 33 | Terminate one with a parked item | Cancelled cleanly; the parked link does not block it |

> Tests 31–33 exist because this went wrong in Phase 3: terminating a consultant
> left their criteria active (`ISSUES.md` **H-1**). Any new per-consultant state
> gets checked against the lifecycle from the start now.

---

## 10. Rough shape

| Area | Estimate |
|---|---|
| Migrations | 2 (`027` application records, `028` queue actions) |
| Seeds | 1 new (`006` demo postings), 1 updated (`005` application statuses) |
| New backend config | `config/queueStates.js` — pure, unit-testable |
| New controllers | `queueController`, `applicationController`; `postingController` extended |
| Endpoints | 11 |
| New screens | 4, plus a dialog |
| Tests | ~45 assertions, extending `backend/tests/` |

Roughly half of Phase 5, and considerably less risky — there is no new external
dependency and no new failure mode. Most of it is enforcing rules that were
already written down.

---

## 11. Worth clearing first

Two items from `ISSUES.md` get more expensive if this phase lands on top of
them:

- **L-6 — the demo database has degraded.** Item 22 of this proposal (a seeded
  posting set) fixes half of it. The other half is the user bench: Molina holds
  27 terminated users against 8 active, with the primary demo recruiter
  permanently terminated. Testing assigned-recruiter scoping on that is
  unreliable, and tests 24–25 above depend on it.
- **M-5 — screens have never been rendered in a browser.** This phase adds four
  more. The unverified surface is compounding.

Also still open and unrelated to this phase, but worth not forgetting:
**M-6** (Phase 4's question-bank screen), **H-3** (an unassigned consultant's
change request is invisible to every recruiter), **H-4** (a concurrent admin
edit makes the reviewer's diff wrong).

---

## 12. What I need from you

1. **Confirm the scope split.** This phase deliberately excludes resume
   tailoring and contacts. If you would rather have one of those first, say so —
   but the queue having no verbs is the thing most visibly unfinished today.
2. **The four application statuses.** Proposed: submitted / waiting-on-consultant
   / stalled-on-login / skipped-with-reason. If your operators already use
   different words for these, better to seed theirs than to translate later.
3. **CSV column format.** I will define one and document it, unless you already
   have a spreadsheet shape your team uses — in which case send a sample row and
   I will match it.
4. **Who may record an application by hand?** Proposed: ORG_ADMIN and the
   assigned RECRUITER. Tightening it to ORG_ADMIN only is a one-line change if
   you would rather.
