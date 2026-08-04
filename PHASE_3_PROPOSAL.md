# Phase 3 — Search Criteria

**Status: proposal, awaiting approval. Nothing has been built yet.**

This document explains what Phase 3 is, why it is the right next feature, how it will
work, and what it deliberately does *not* include. Read the decisions in §6 — those are
the ones worth arguing with before any code exists.

---

## 1. What this feature is, in one paragraph

Right now the system knows **who** a consultant is (Phase 1: login, role, org, assignment)
and **what they look like on paper** (Phase 2: phone, location, work authorisation, resume).
It does not know **what job they are actually looking for**. Search Criteria is that missing
record: the per-consultant definition of the jobs worth chasing — titles, keywords, locations,
work types, minimum pay, and companies to avoid — owned and maintained by the recruiter.

It is the last piece of consultant setup. After Phase 3, a consultant record is complete
enough to hand to a machine.

---

## 2. Why this feature, and why now

**It is the input the entire rest of the roadmap consumes.**

```
Phase 1  who they are        ─┐
Phase 2  what they look like ─┼─→  Phase 3  WHAT THEY WANT  ─→  Phase 5  job discovery
                              │                                  Phase 6  resume tailoring
                              └─                                 Phase 7  contact discovery
```

The job discovery engine cannot be built, or even meaningfully designed, until there is a
stored, queryable answer to "what should we be looking for?" Every downstream phase reads
this table. Building it now means Phase 5 starts against real structured data rather than
a placeholder.

**It is also the feature that makes the product demonstrable.** A stakeholder can be shown
a consultant, their criteria, and the audit trail of who changed what — that is a coherent
story. Today the demo stops at "here is a profile."

Two secondary reasons:

- It closes rule **R-23** (consultants are read-only on criteria) and permission **P-10**
  (recruiters edit criteria for their own consultants). Both are on the books and currently
  unimplemented, because there is nothing to be read-only *about*.
- It introduces **versioning**, a pattern nothing in the codebase has yet. Phase 5 needs it
  (§6.2) and it is far cheaper to build it now than to retrofit history onto a live table.

---

## 3. The workflow

```
ORG_ADMIN creates consultant        → empty criteria set auto-created, PAUSED, v0
        │                             (mirrors Phase 2: no read path meets a missing row)
        ▼
RECRUITER opens the consultant      → Consultant Detail → "Search Criteria" tab
        │
Fills in titles, keywords, locations,
work types, min pay, exclusions
        │
Clicks "Save criteria"              → creates VERSION 1 (immutable snapshot)
        │                             previous version stays readable forever
        ▼
Flips "Active"                      → discovery is now allowed for this consultant
        │
        ├─→ CONSULTANT opens portal → sees the criteria READ-ONLY. Cannot edit. (R-23)
        │
        └─→ Later edit               → VERSION 2. v1 still viewable, side-by-side diff.
                                       Every save writes an audit event with the editor.
```

**There is no approval step here.** That is deliberate and is the single biggest difference
from Phase 2 — see §6.1.

---

## 4. Scope — what gets built

Numbered so we can strike items before starting.

### Criteria content
| # | Item | Detail |
|---|---|---|
| 1 | **Job titles** | Ordered list. Order = priority. Add / remove / reorder. |
| 2 | **Keywords — include** | Terms that make a posting interesting. |
| 3 | **Keywords — exclude** | Terms that disqualify a posting outright. |
| 4 | **Locations** | City + state, each tagged `ONSITE` / `HYBRID` / `REMOTE`, with an optional radius in miles. |
| 5 | **Work types** | Multi-select from `CONTRACT`, `FULL_TIME`, `PART_TIME`, `C2C`, `W2`. |
| 6 | **Minimum pay** | Amount + explicit unit (`HOURLY` / `ANNUAL`) + currency. Never a bare number. |
| 7 | **Excluded companies** | Never surface a posting from these. |
| 8 | **Active / paused toggle** | Pauses discovery for this consultant without deleting anything. |

### Versioning
| # | Item | Detail |
|---|---|---|
| 9 | Every save creates a new immutable version | Numbered `v1`, `v2`, … with editor name, role, and timestamp. |
| 10 | Optional change note on save | "Widened to remote after client feedback." |
| 11 | Version history list | Who changed it, when, and a one-line summary of what moved. |
| 12 | Read any old version | Full read-only render of the criteria as they stood. |
| 13 | Side-by-side diff of any two versions | Added terms in green, removed in red. |
| 14 | Every save + every pause/resume writes an audit event | Consistent with Phases 1–2. |

### Screens
| # | Screen | Who |
|---|---|---|
| 15 | **Consultant Detail → new "Search Criteria" tab** — the editor. `ConsultantDetail.jsx` has no tabs today, so this introduces them. | ORG_ADMIN, RECRUITER (assigned only) |
| 16 | **Version history panel** on that tab | same |
| 17 | **`/portal/criteria`** — read-only view for the consultant, plus a sidebar entry | CONSULTANT |
| 18 | **Criteria status column** on the Consultants list — `Active` / `Paused` / `Not set up` | ORG_ADMIN, RECRUITER |

---

## 5. Permission matrix

| Action | SUPER_ADMIN | ORG_ADMIN | RECRUITER | CONSULTANT |
|---|:---:|:---:|:---:|:---:|
| View criteria | ✗ | all in org | **assigned only** | **own, read-only** |
| Edit criteria | ✗ | ✓ all | **✓ assigned only** | **✗ never** (R-23) |
| Pause / resume | ✗ | ✓ | ✓ assigned | ✗ |
| View version history | ✗ | ✓ | ✓ assigned | own only |
| Propose a change | ✗ | ✗ | ✗ | **✗ — no mechanism exists** |

Enforced at all three existing layers: route guard (`isManagement`), tenant + assignment
scoping in SQL via `utils/scope.js`, and sidebar/route filtering on the client. The
consultant's read-only status is enforced by **there being no write endpoint they can reach**,
not by a hidden button.

---

## 6. Design decisions — the ones that matter

### 6.1 No approval workflow. Recruiters write directly.

Phase 2 established consultant-proposes → recruiter-approves. Phase 3 does **not** reuse it,
and that asymmetry is intentional.

A profile field is a *fact about the consultant* — their phone number is theirs to assert, and
the recruiter is checking it. Search criteria are a *business decision about how to spend the
company's application budget*. The consultant is not the author, so there is nothing to approve.
R-23 says this outright: consultants cannot edit search criteria.

The practical consequence: a recruiter's save takes effect immediately. The safety net is
versioning and audit, not a gate — mistakes are reversible by restoring a prior version, and
always attributable.

> If you want consultants to be able to *request* criteria changes, say so now. It is a
> reasonable product call, it reuses the Phase 2 machinery — and it contradicts R-23, so it
> needs to be a deliberate override rather than something I assume.

### 6.2 Versions are immutable snapshots, not a mutable row with a history log

Two ways to do versioning:

| | Mutable current row + change log | **Immutable versions (recommended)** |
|---|---|---|
| Storage | Smaller | Larger — full copy per save |
| "Show me v3 exactly" | Replay the log and hope | Read one row set |
| Phase 5 can reference the version that matched | Awkward | Natural foreign key |

The spec requires answering *"why did this job match?"* months later. That answer is
"because of the criteria in force at match time" — which only works if that version still
exists verbatim. A change log that has to be replayed will eventually disagree with reality.

Cost is trivial: a criteria set is on the order of 30 rows, and saves are a human action
measured in single digits per consultant per month.

### 6.3 The pause toggle lives on the parent, not on a version

Pausing is not an edit to the criteria — it is an operational state. If pause created a new
version, the history would fill with noise that says nothing about what is being searched for.
So there is a small parent row per consultant holding `is_active` and a pointer to the current
version. Pause is still audited; it just does not fork history.

### 6.4 Empty criteria match **nothing**, not everything

A consultant with no criteria set up must never receive every job on the internet. The parent
row is therefore created **paused**, and an active-but-empty criteria set is treated by
downstream phases as "matches nothing". Fail closed.

This is also why item 18 shows `Not set up` as a distinct state from `Paused` on the list —
they mean different things to a recruiter working their bench.

### 6.5 Minimum pay always carries its unit

`60` is meaningless — it is either an hourly rate or a catastrophic salary expectation. Amount,
unit (`HOURLY` / `ANNUAL`), and currency are stored as three columns and are validated together:
providing an amount without a unit is rejected by the API, not defaulted.

### 6.6 Copy-on-write means the save is one transaction

A save writes a new version header, copies in all its child rows, and flips the parent's
current-version pointer — in a **single transaction**, matching the Phase 2 rule that approval
and application never come apart. A partial version is never visible.

A partial unique index enforces the invariant in the database, mirroring Phase 2's
`uq_one_pending_request_per_consultant`:

```sql
CREATE UNIQUE INDEX uq_one_current_version_per_consultant
    ON search_criteria_versions (consultant_id) WHERE is_current;
```

---

## 7. Data model

Six new tables. Migrations `016`–`018` (last applied is `015`).

| Table | Purpose | Mutability |
|---|---|---|
| `lkp_work_types` | `CONTRACT`, `FULL_TIME`, `PART_TIME`, `C2C`, `W2` | seeded lookup |
| `search_criteria` | **Parent**, one row per consultant. Holds `is_active`, `current_version_id`. | mutable |
| `search_criteria_versions` | Immutable snapshot header: `version_no`, min-pay amount/unit/currency, `change_note`, `created_by`, `created_at`, `is_current`. | **append-only** |
| `search_criteria_terms` | Titles, include keywords, exclude keywords, excluded companies — one table discriminated by `kind`, with a `position` for ordering. | per-version, immutable |
| `search_criteria_locations` | `city`, `state`, `work_mode`, `radius_miles`. | per-version, immutable |
| `search_criteria_work_types` | version × work type. | per-version, immutable |

**Why one `search_criteria_terms` table instead of four.** Titles, include keywords, exclude
keywords and excluded companies are all "an ordered list of strings attached to a version."
Four near-identical tables would mean four near-identical queries, four insert paths, and four
places to fix a bug. One `kind`-discriminated table with a `position` column handles all of
them, and adding a fifth list type later costs one enum value. Locations and work types are
genuinely different shapes, so they stay separate.

All tables carry the house conventions: `CHAR(36)` UUID PKs, `lookup_id INT GENERATED ALWAYS AS
IDENTITY`, `organization_id NOT NULL` with `ON DELETE CASCADE`, audit columns, composite
`(organization_id, …)` indexes.

---

## 8. Endpoints

```
GET    /api/management/consultants/:id/criteria                    current version, fully expanded
PUT    /api/management/consultants/:id/criteria                    save → creates a new version
POST   /api/management/consultants/:id/criteria/toggle-active      pause / resume
GET    /api/management/consultants/:id/criteria/versions           history list
GET    /api/management/consultants/:id/criteria/versions/:versionId   one version, read-only
POST   /api/management/consultants/:id/criteria/versions/:versionId/restore
                                                                   copy an old version forward as a new one
GET    /api/portal/criteria                                        CONSULTANT — own, read-only
GET    /api/lookups                                                extended with workTypes
```

Restore **copies forward** rather than rewinding the pointer — history stays strictly
append-only, and "we reverted to v2 on Tuesday" remains visible as v5.

---

## 9. Explicitly out of scope

Stated plainly so there is no surprise at sign-off.

| Not building | Why |
|---|---|
| **The "how many of the last 7 days' postings would have matched" preview** (plan item 25) | There are no job postings in the database. It depends on Phase 5 and would have to be faked, and a fake number on a real screen is worse than no number. |
| Any actual job matching or discovery | Phase 5. Phase 3 stores the criteria; nothing consumes them yet. |
| Consultant-proposed criteria changes | Contradicts R-23 — see §6.1. |
| Bulk-applying one criteria set to several consultants | Not in the spec; easy to add later on top of this schema. |
| Criteria templates / presets by role | Same. |

**The honest caveat:** at the end of Phase 3 nothing *reads* these criteria — the consuming
engine is Phase 5. This phase delivers a complete, audited, versioned editor and the data model
underneath it. If the priority is a feature that visibly does something end-to-end today, say
so and I will propose an alternative before starting.

---

## 10. Manual test gate

Following the project rule that every restriction needs a **negative** test proving the server
refuses, not merely that the button is hidden.

### Editing and versioning
| # | As | Do | Expect |
|---|---|---|---|
| 1 | admin@molina | Open a consultant → Search Criteria | Empty set, `Not set up`, marked Paused |
| 2 | admin@molina | Add 3 titles, 2 keywords, 1 location, save | `v1` created; editor name and timestamp shown |
| 3 | admin@molina | Edit one title, save | `v2`; `v1` still readable in full |
| 4 | admin@molina | Diff v1 ↔ v2 | Exactly one changed term highlighted |
| 5 | admin@molina | Reorder titles, save | Order persists on reload |
| 6 | admin@molina | Save with no changes | Refused — no empty version created |
| 7 | admin@molina | Restore v1 | Becomes `v3`; v2 still in history, pointer not rewound |
| 8 | — | Check `search_criteria_versions` in DBeaver | Row count only ever grows |

### Pay validation
| # | Do | Expect |
|---|---|---|
| 9 | Enter min pay `60` with no unit | **422** — unit required, not defaulted |
| 10 | Enter `60 / HOURLY`, save, reload | Renders as an hourly rate, not a salary |
| 11 | Enter a negative amount | Refused |

### Pause semantics
| # | Do | Expect |
|---|---|---|
| 12 | Pause an active set | Consultants list shows `Paused`; version count unchanged |
| 13 | Check version history after pausing | **No new version** — but an audit row exists |
| 14 | Resume | Back to `Active` |

### Permissions — the negative tests
| # | As | Do | Expect |
|---|---|---|---|
| 15 | recruiter1 | Open criteria for consultant1 (assigned) | Full editor |
| 16 | recruiter1 | Open criteria for consultant3 (**not** assigned) | **404** — by direct URL too |
| 17 | recruiter1 | `PUT .../consultant3/criteria` by hand | **404**, no write occurs |
| 18 | admin@apex | `GET .../molina-consultant-id/criteria` | **404** — cross-tenant |
| 19 | consultant1 | Open `/portal/criteria` | Read-only. No inputs, no save button |
| 20 | consultant1 | `PUT /api/management/consultants/<own-id>/criteria` | **403** — server refuses |
| 21 | consultant1 | `GET /api/portal/criteria` for another consultant | No id parameter is accepted at all |
| 22 | superadmin | Any criteria endpoint | **403** |
| 23 | recruiter1 | Consultant reassigned away mid-session, retry | Access gone immediately |

### Audit
| # | Do | Expect |
|---|---|---|
| 24 | Save criteria, open Activity log | `Updated Search Criteria` with version number |
| 25 | Pause, check log | `Paused Search Criteria` |
| 26 | Read an audit entry | Names the editor and their role |

---

## 11. Files this will touch

| File | Change |
|---|---|
| `db/migrations/016_work_types_lookup.sql` | new |
| `db/migrations/017_search_criteria.sql` | new — parent, versions, partial unique index |
| `db/migrations/018_search_criteria_children.sql` | new — terms, locations, work types |
| `db/seeds/001_lookups_seed.js` | add the 5 work types |
| `db/seeds/003_demo_org_seed.js` | give 2 demo consultants realistic criteria |
| `config/criteriaSchema.js` | **new** — the shape definition, same registry idea as `profileFields.js` |
| `controllers/criteriaController.js` | **new** |
| `controllers/portalController.js` | read-only criteria for the consultant |
| `controllers/profileController.js` | criteria status on the consultants list |
| `server.js` | 8 routes |
| `utils/scope.js` | reuse — no change expected |
| `pages/management/ConsultantDetail.jsx` | introduce tabs; add the Search Criteria tab |
| `components/criteria/*` | **new** — term list editor, location editor, version history, diff view |
| `pages/portal/MyCriteria.jsx` | **new** |
| `components/layout/Sidebar.jsx` | portal entry |
| `App.jsx` | route |

Rough shape: 3 migrations, ~1 new backend controller, ~5 new frontend components, 8 endpoints.

---

## 12. What I need from you

1. **Approve the phase**, or redirect it — §9's caveat is the honest case against.
2. **§6.1 — no approval workflow.** Confirm consultants are read-only on criteria (matches
   R-23), or tell me you want them to be able to propose changes.
3. **Anything in §4 to cut.** The diff view (item 13) is the most droppable — genuinely useful,
   but the largest single UI piece here.
4. **Item 18's `Not set up` state** — worth surfacing on the Consultants list, or noise?

Once you approve, the first thing I build is the migrations and the seed data, so the schema is
inspectable in DBeaver before any UI exists.
