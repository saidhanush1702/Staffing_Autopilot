# Job → consultant matching, v2

**Status: plan. Nothing here is built yet.**
Scope: `backend/config/jobMatcher.js` and the three doors that call it
(`jobspipeListener.js`, `discoveryController.js`, `services/atsIngest.js`), plus the recruiter screen
that links jobs by hand (`postingLinkController.js`).

---

## 1. The problem, measured

Run on the live database with the real matcher (read-only):

| | Molina Staffing | newtestorgmnl |
|---|---|---|
| Consultants | 57 | 3 |
| Consultants the matcher considers | **1** | **1** |
| Recent postings matching nobody | **83 %** | **96 %** |
| Rejected on location text (pre-filter) | 23 of 66 | 272 of 300 |
| Rejected on title words (pre-filter) | 20 of 66 | 28 of 300 |
| Scored 50–69 and silently dropped | many | 82 |

Four causes, in order of size:

1. **The bench is nearly empty.** A consultant is matched only with an *active* criteria set that has a
   saved version, and is not paused. 56 of 57 consultants in Molina have none.
2. **Location is a hard gate made of text matching.** `"TX"` ≠ `"Texas"`, Irving ≠ Dallas, a role that is
   quietly remote is rejected, and `radius_miles` exists in the schema but the matcher never reads it.
3. **The matcher never looks at skills.** It compares the job title and a few keywords against the
   consultant's *wanted titles*. The consultant's recorded skills (`consultant_skills`) are unused, and the
   job's required skills are never extracted. A React developer is rejected for a "Frontend Developer" role
   (scored 57 of a needed 70), and "Frontend Engineer" only gets as far as it does because the word
   "Engineer" also appears in "DevOps Engineer" — a wrong match for the wrong reason.
4. **One cut-off, no middle.** A job scoring 69 is treated exactly like one scoring 5. A recruiter never
   sees it.

Also not checked at all: work authorization ("US citizens only"), which rules out more jobs than location.

---

## 2. Principles

1. **Certain checks first, uncertain ones become scores.** Deal-breakers drop a job early and cheaply.
   Anything open to interpretation (wording, distance, level) adds or removes points; it never silently
   removes a job.
2. **Three outcomes, not two.** *Auto-queue*, *recruiter suggestion*, *drop*.
3. **Every decision carries its reason** in words a recruiter can read months later (kept from today).
4. **Nothing is invented.** A skill is "implied" only through a written map; a consultant's skills are
   what they entered. The matcher reads facts, it does not guess them.
5. **Same door for everyone.** Rules live in one pure module; JobsPipe, the poller, the ATS mirror and
   manual linking all call it, so they cannot drift.

---

## 3. The new flow

```
posting arrives (any door)
   │
   ├─ 0  READ         job skills, role family, level, work authorization, remote/onsite  ← new
   │
   ├─ 1  DEAL-BREAKERS  (hard, per consultant)
   │       excluded company / keyword · work-authorization conflict · employment type
   │       pay below floor (same unit only) · required clearance/cert the consultant lacks
   │
   ├─ 2  LOCATION       (feasibility; hard only for on-site + will not relocate)
   │       remote → pass · hybrid/on-site → distance within radius or open to relocate
   │       normalised places (TX = Texas, Irving ≈ Dallas metro)
   │
   ├─ 3  RELEVANCE SCORE  (the core)
   │       skills coverage 50 · role family & title 25 · seniority 10 · location fit 10 · pay/type 5
   │
   └─ 4  BUCKET
           ≥ 75  → AUTO-QUEUE  (today's behaviour: job_matches + queue_items)
           55–74 → SUGGESTED   (recruiter list: best consultant, reasons, one-click link)
           < 55  → DROP        (counted, with the reason, for the daily report)
```

Thresholds are starting points. They are config, and §8 says how to tune them from real data.

---

## 4. Skills: how "React + Tailwind + frontend + responsive" matches a React/Node/SQL consultant

### 4.1 Read the job
Extract skills from the title and description with the vocabulary that already exists
(`lkp_skills` + `lkp_skill_aliases`, so "ReactJS" = "React", "JS" = "JavaScript"). Mark each as
**required** or **preferred** using the section it appears in (`atsScore.js` already knows
"requirements / must have / nice to have" headings). Also derive a **role family**
(frontend, backend, full-stack, devops, data, mobile, QA…).

### 4.2 Expand what the consultant knows — through a written map
A new table `skill_relations(skill_id, related_skill_id, kind, weight)`:

| kind | meaning | credit | example |
|---|---|---|---|
| `SAME` | alias | 1.0 | ReactJS → React |
| `IMPLIES` | having A means having B | 0.8 | React → JavaScript, HTML/CSS, frontend, UI |
| `RELATED` | close enough to pick up quickly | 0.5 | CSS → Tailwind CSS, Bootstrap |
| `FAMILY` | same role family | 0.3 | Vue ~ React |

Seed ~300 common skills by hand; extend the map from data (skills that co-occur in many postings are
proposed for review, never auto-applied — same rule `lkp_skills.origin` already uses).

### 4.3 Score coverage
`coverage = Σ credit(required) × 2 + Σ credit(preferred)` ÷ `(2 × #required + #preferred)`.
Credit is the best path from any of the consultant's skills to the job's skill (direct 1.0, implied 0.8,
related 0.5, none 0). A missing *required* skill that has no path counts zero.

### 4.4 Worked example (the one that failed)
Job: React, Tailwind CSS, frontend, responsive design. Consultant: React, JavaScript, Node, SQL, MongoDB,
DevOps, CI/CD, GitHub.

| Job skill | Why it counts | Credit |
|---|---|---|
| React | direct | 1.0 |
| Frontend | implied by React + JavaScript | 0.8 |
| Responsive design | implied by frontend / CSS | 0.8 |
| Tailwind CSS | related to CSS, not listed | 0.5 |

Coverage ≈ 0.78 → ~39 of 50 points, plus role family (frontend ≈ React developer) ≈ 20 of 25, plus
location/seniority → **≈ 78: auto-queue**, reason shown as
*"React ✔; frontend, responsive design implied by React/JavaScript; Tailwind CSS related to CSS (not
listed)"*. A job asking for Kubernetes + Go + Java scores ≈ 10 and is dropped, as it should be.

### 4.5 Titles stop being word overlap
Normalise titles to a role family + level ("SDE II", "Software Developer", "Software Engineer" → backend/
full-stack, mid). This removes the "Engineer" false match and lets "UI Developer" meet "React Developer".

---

## 5. Location

- Normalise places once (state abbreviations, "Greater X area", country). A small `places` table or a
  library — no live geocoding call on the hot path.
- **Remote** (job flagged remote *or* description says so) passes for anyone who accepts remote.
- **Hybrid/on-site**: pass if within `radius_miles` (already in the schema, currently ignored) or the
  consultant is *open to relocate* (new boolean on criteria locations/profile).
- It is a hard fail only for on-site + outside radius + will not relocate. Everything else scores
  10 points at most.

## 6. Deal-breakers worth adding
Work authorization (compare the job's "must be a US citizen / GC / no sponsorship" with
`consultant_profiles.work_auth_status_id`), employment type (W2 / C2C / contract), pay floor (same unit
only — unchanged), clearance/certifications. Each reports a precise reason ("job requires US citizen;
consultant is H1B").

## 7. Fix the bench first (largest win, smallest code)

1. **Auto-draft criteria** for every consultant from data we already hold — wanted titles from their
   experience titles, skills from `consultant_skills`, location from their city — saved as a *draft*
   version for the consultant/recruiter to approve. Fail-closed stays: nothing is matched until approved.
2. **"Not matchable" list** for admins: consultants with no active/approved criteria, paused, or with
   criteria that say nothing positive — with the reason and a one-click fix. Shown on the dashboard.
3. **Re-match on change.** When criteria are approved or edited, evaluate the existing pool (recent
   postings) once, so a consultant activated today is not blind to last week's jobs. (I found no such
   backfill today — to be confirmed before building.)

## 8. The recruiter screen (where the middle bucket goes)

A "Suggested matches" list: one row per job showing the best 1–3 consultants, score, and the reason in
plain words, with **Link** (reuses `postingLinkController` / `releaseItemToReady`) and **Not a fit**
(feeds back as a negative signal for that consultant/job family). Unmatched-by-everyone jobs show the
dominant blocker ("no consultant in Dallas", "needs US citizen").

---

## 9. Build order

| Phase | What | Why this order |
|---|---|---|
| **A** | Bench fixes: auto-draft criteria, "not matchable" list, re-match on approval | Biggest effect, no matcher change; 1 → ~57 consultants |
| **B** | Skills: job-skill extraction, `skill_relations` seed, coverage score, role-family titles | Fixes the React/frontend case and the false "Engineer" matches |
| **C** | Location: normalisation, radius, relocation, remote detection | Removes the 70 % location rejections |
| **D** | Deal-breakers: work authorization, employment type, clearance | Stops sending impossible jobs |
| **E** | Three-way bucket + Suggested-matches screen + feedback | Turns near-misses into recruiter work instead of lost jobs |

Each phase is shippable alone and leaves the previous behaviour intact behind a config flag
(`MATCHER_VERSION=1|2`), so it can be switched per organisation.

## 10. Testing and measuring

- **Golden set.** Pull ~200 real postings × the consultants' criteria, have a recruiter label match / not
  a match once, and keep it as a fixture. Every change is scored against it (precision and recall).
- **Unit tests** per rule: the React example above, "Engineer" false match, `TX`/`Texas`, Irving/Dallas,
  remote-but-unflagged, citizen-only vs H1B, unit-mismatched pay.
- **Shadow mode first.** Run v2 beside v1 for a week, log differences, change nothing; only then switch.
- **Metrics:** share of postings linked to ≥ 1 consultant (today 17 % / 4 %), recruiter acceptance rate of
  suggestions, auto-queued jobs later rejected by the consultant (false positives), time from posting to
  link.

## 11. Risks

- **Over-matching** — implied skills inflate scores. Mitigation: required skills with no path score zero;
  thresholds tuned on the golden set; shadow mode.
- **A hand-written skill map goes stale.** Mitigation: propose additions from posting co-occurrence for
  human approval.
- **Work-authorization text is messy** ("US persons", "no C2C", "EAD ok"). Start with a short list of
  explicit phrases; unknown wording does not block, it only lowers the bucket to *suggested*.
- **Cost** — all of this is deterministic, no model call per job. An optional LLM re-rank of the
  55–74 band can come later and only touches that band.

## 12. Open decisions

1. Thresholds: auto-queue ≥ 75, suggest 55–74 — keep, or start more cautious?
2. Is "open to relocate" a per-consultant setting or per location row?
3. Should *auto-draft criteria* go live for consultants immediately, or only after a recruiter approves?
4. Who sees the Suggested-matches screen: recruiters only, or org admins too?
