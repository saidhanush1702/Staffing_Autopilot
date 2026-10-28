# One apply pipeline — the intended flow, what exists, what to change

**Status: analysis and plan. Nothing in this document is built yet.**
Scope: `desktop/src/main/cycle.js`, `attention.js`, `agent/*`, the Work and Boards screens, and the
small hub changes the queue needs.

---

## 1. The flow you want

```
all matched jobs ──► desktop queue
                       │   (resume tailored on request; the job comes back with its own resume)
                       ▼
        Start applying ──► for each job, in order:
                              open the URL
                              ┌───────────────────────────────────────────────┐
                              │ is there a written flow for this page?        │
                              │ (LinkedIn Easy Apply, Workday, Greenhouse …)  │
                              └──────────┬────────────────────────┬───────────┘
                                   yes   │                        │  no
                                         ▼                        ▼
                                  the BOT fills it       follow the external link if
                                                         there is one, then the AI AGENT
                                                         continues on that page
                              ▼
                       fills every field from the profile and approved answers
                       unknown answer / login / bot check ──► ask the person, with a timer
                              │                                   │
                              │                       answered ◄──┘   timer ran out ─► job goes to the BACK of the queue
                              ▼
                  submit automatically (if switched on) or stop for review
```

One pipeline. The job is not "a bot job" or "an agent job"; it is a job, and the engine decides
what to do with the page it lands on.

## 2. Where the current system already matches

| Your step | Today |
|---|---|
| Every matched job reaches the desktop app | **Yes.** `deviceQueue` serves BOT, AGENT and HUMAN lanes alike (`channel IN ('BOT','AGENT','HUMAN')`). The lane is only a label. |
| Tailoring is chosen by a person, then the job returns with its own resume | **Yes.** `READY → PREPARING → READY` carries `tailored_resume_artifact_id`; `deviceResume` serves the tailored one first, else the base resume. |
| Bot first, agent when the bot cannot | **Mostly.** A recipe runs; on `EXTERNAL_APPLY`, `NO_APPLY_FLOW`, `NOT_VERIFIED` or `INCOMPLETE` the agent takes over (`AGENT_WORTHY`, `#agentForFlow`, `#tryAgent`). |
| Fill from the profile and approved answers | **Yes**, and wider since the profile work. |
| Submit automatically if switched on | **Yes** (`finishAgentFill`, `pressSubmit`), with exceptions — see 4.8. |
| Ask the person for unknowns, logins, bot checks | **Yes**, through `attention.js`. |

## 3. Where it differs, and why it feels like two systems

| # | Difference | Where | Effect on you |
|---|---|---|---|
| D1 | The path depends on the **board the job was found on**, not on the page it opens. `boardForPortal(item.portal)` → `#workOne`; no board → `tenantFor(url)` → `#workDestination` or `#workWithAgentOnly`. Three code paths. | `cycle.js` run loop | The same Greenhouse job behaves differently depending on where it was discovered. |
| D2 | The agent runs in a **separate browser session** (`agentSession(host)`) when it follows a link, with its own profile. | `#agentForFlow` | Sign-ins made for the bot are not visible to the agent, and two windows appear. |
| D3 | The agent is a **toggle** ("Let the AI agent take over") and a separate "AI agent" card. | `Controls.jsx`, `boardsForDisplay` | Looks optional; hides what the agent did. |
| D4 | The Boards screen is **one tab per board** (Wellfound, Built In, CrunchBoard, LinkedIn, AI agent). | `Boards.jsx` | Five tabs to read one story. |
| D5 | When a person does not answer in time, the job is **parked at the hub** (questions), **held up to a day with the lane blocked** (sign-in, account wall — Phase 0), or **the board is stopped for the day** (bot check). | `#askUnanswered`, `#defer`, R-22 | Not "back of the queue". Three different outcomes for the same event. |
| D6 | The device asks the hub for **25 jobs**, best score first. | `deviceQueue … LIMIT 25` | A consultant with 239 queued sees 25. |
| D7 | `neverAutoSubmit` on Workday, Greenhouse, Lever, Ashby and Built In **overrides** the auto-submit switch. | `destinations.js`, `boards.js` | Switch is on and nothing is submitted, with no explanation on screen. |

## 4. Problems found, with causes

### 4.1 The "I've done it" button does not release the agent  *(your reported bug)*

What happens: the agent asks 10 questions, the person answers in the browser form, presses
**I've done it**, the button turns to "Checking…" and the timer keeps running.

Cause, in order:
1. `Attention.raise` treats the press as "look again", **not** as a claim: it re-runs `check()` and, if it is
   false, `continue`s the countdown (`attention.js`, the `continueAsked` branch). The comment there
   records that as a deliberate choice.
2. `check()` for questions is true only if **every** asked question is in the approved bank, **or** every
   visible required field in the form has a value. Typing into the browser fills the second case, but
   `describeFields` reports required fields that can never be satisfied: a file input, a hidden-but-visible
   upload box, and on Lever **every checkbox of a group is `required`** (one language box ticked leaves
   thirty-nine "empty required" fields).
3. Nothing tells the person why it did not proceed, and the button stays disabled
   (`Attention.jsx` resets `busy` only when `kind` or `until` changes).

### 4.2 The agent sees a checkbox group as dozens of questions
`agent/observe.js` groups radios but not checkboxes, so the Lever "languages" list reaches the model as ~40
separate fields; `ask_human` then lists them, producing "10 questions need answers" for one real question.
The filler fixed this for recipes (`fillForm`) and the agent's reader did not get the same rule.

### 4.3 Two rounds, then parked
`#runAgentOn` asks questions at most twice (`round >= 2`), then parks the job at the hub. A form with a
second page of new questions ends the run even though the person is sitting there.

### 4.4 A timed-out gate has three different endings (D5)
No single rule for "the person did not come back".

### 4.5 Boards and Work screens describe the old model (D3, D4)

### 4.6 Queue size (D6)

### 4.7 Agent runs only when the org allows it
`agent_mode` OFF / SHADOW / budget exhausted means a job with no recipe cannot be applied to. The other
session changed this to "wait for the next pass", which is right, but the screen should say why.

### 4.8 Auto-submit is not honoured everywhere (D7)
Decide per site whether the switch is allowed to submit (see §8).

## 5. The target design

### 5.1 One runner
Replace `#workOne` / `#workDestination` / `#workWithAgentOnly` with a single `applyToJob(item)`:

1. **Open** the job URL in the session for its host (one profile per host, as Workday tenants already are).
2. **Route** by the page, not by the portal: `routeFor(page)` asks the recipe registry —
   LinkedIn Easy Apply, Workday, Greenhouse, Lever, Ashby, … — "is this yours?" Each recipe answers from
   the URL and a cheap probe of the page. First yes wins.
3. **Run the recipe** if there is one (`runApplyFlow` + `fillForm`, unchanged).
4. **If it is not a recipe's page, or the recipe stops** (external link, no apply flow, form it does not
   understand): **follow the link in the same session**, then run the **agent on the current page**,
   carrying everything the recipe already filled (`prior`, as today).
5. **Fill, gate, finish** — same gates for both (§5.3), same auto-submit rule.

`item.portal` stops deciding the path. The hub's `channel` becomes display-only.

### 5.2 One board in the UI
- **Boards** screen → one view, **"Applying"**: the live browser page of the job being worked and a scrolling
  log of every step (open, recipe chosen, each field, gate, submit). Bot and agent lines are interleaved with
  a small "bot" / "agent" tag so you can see who did what.
- The per-board tabs go. Sign-in prompts and "needs you" rows keep their board name in the text.
- **Work** screen: remove "Let the AI agent take over". The agent is always the fallback; the
  organisation setting stays the only master switch, and the screen says so when it is off.

### 5.3 One rule for every gate
`UNKNOWN_QUESTIONS`, `SIGN_IN`, `ACCOUNT_WALL`, `EMAIL_VERIFY`, `BOT_CHECK`, `LEGAL_GATE` all behave alike:

1. The page comes to the front, a notification fires, the banner shows a countdown.
2. **"I've done it" always releases.** It means "go on now": the engine re-reads the page and carries on. If
   something is still missing, the *next* turn of the loop deals with it (asks again, or stops). It never
   silently keeps counting. For gates the app can verify (login, challenge) it still checks once and, if the
   check fails, **says what it sees** ("still showing a human check") and offers **Continue anyway** and
   **Skip this job**.
3. **Timer ends → the job goes to the back of the queue.** It is not lost and not parked at the hub. It is
   retried after the fresh jobs, up to **3 attempts**, then skipped with the reason written on it
   (consistent with the no-hand-over model).
4. **Cool-down per site.** If a gate on a site timed out, the next jobs on that site are *not* prompted again
   straight away; they wait their turn at the back too. This keeps the benefit of Phase 0's lane hold
   (one sign-in window, not twenty) with a short window (default 30 min) instead of a day.

### 5.4 Questions: ask once, ask well
- The agent's reader groups checkbox sets like the filler (§4.2) → "10 questions" becomes the real number.
- No two-round cap while the person is answering; the cap is on *total time and attempts*, not rounds.
- Answers typed in the browser are banked (existing `#bankTypedAnswers`) so the next job is not asked again.

### 5.5 The queue
- Hub `deviceQueue`: raise `LIMIT 25` to 200, order by score, and add `ORDER BY attempts` (items already
  tried this session go last). New column `queue_items.device_attempts` + `last_attempt_at` so "back of the
  queue" survives a restart and is visible to recruiters.
- Work screen shows the whole queue count, not 25.

## 6. Work plan

| Phase | What | Files | Verified by |
|---|---|---|---|
| **1 Fix the reported bug** | "I've done it" always releases for questions; for verifiable gates, check once, say what is wrong, offer Continue anyway / Skip; stop the button sticking on "Checking…"; group checkboxes in the agent's observation; remove the two-round cap | `attention.js`, `Attention.jsx`, `cycle.js (#askUnanswered, #runAgentOn)`, `agent/observe.js`, `runAgent.js` | unit tests for the gate states; fixture of the Lever page through `observe` (one question, not forty); a manual run on the 15Five Lever job |
| **2 One runner** | `applyToJob`, `routeFor(page)`, same-session follow, delete the three paths | `cycle.js`, new `router.js`, `destinations.js`, `boards.js` | existing engine suite adapted; new routing tests (LinkedIn, Workday, Greenhouse, unknown host, external link) |
| **3 One gate rule** | back-of-queue with attempts, per-site cool-down, replace the 24 h hold and the board-day stop for gate timeouts (R-22 stays for a real bot check *without* a person present) | `cycle.js`, `runs.js`, `attention.js`, hub migration `device_attempts` | `runs.test`-style tests with a fake clock; ordering test in `deviceQueue` |
| **4 One screen** | single "Applying" view with live page + log; remove board tabs and the agent toggle; show why the agent is unavailable | `Boards.jsx`, `Controls.jsx`, `Work.jsx`, `index.js` (`boardsForDisplay`, `startAutomation`) | renderer build; walk-through |
| **5 Queue and submit policy** | 200-item queue, attempts ordering, per-site auto-submit decision, "why nothing happened" line when the switch is on but a site refuses | `deviceController.js`, `destinations.js`, `Review.jsx` | backend queue test; engine test per policy |
| **6 End-to-end** | a scripted run over fixtures of LinkedIn, Workday, Greenhouse, Lever, Ashby and an unknown site, including a gate that times out and a gate answered early; live check on three real postings stopping at review | `tests/pipeline.mjs` | the suite + your live test |

Phase 1 is independent and small; do it first so your testing is not blocked by the timer bug.

## 7. What changes for the person using it

- Start applying: one button, no agent switch.
- Boards: one "Applying" screen showing the page being worked and what the app is doing.
- A question appears with a timer. Answering and pressing **I've done it** continues straight away.
- If nobody answers, the job quietly moves to the back and is tried again later; after three tries it is
  skipped with the reason, where a recruiter can requeue it.

## 8. Decisions needed from you

1. **Auto-submit and `neverAutoSubmit`.** The switch you described should submit everywhere. Today five
   sites ignore it by design (an earlier owner instruction for Built In/Workday; mine for Greenhouse,
   Lever, Ashby). Remove it for sites that have been dry-run (Greenhouse, Lever, Ashby), keep it for Workday
   (its submit step was never reached) until it is proven? *Recommended.*
2. **Attempts before skipping:** 3? And the per-site cool-down: 30 minutes?
3. **Timer lengths:** keep 2 min per question (max 10), 5 min for sign-in, 1 min for a human check, or lengthen?
4. **Unavailable agent** (org setting off, budget out): job waits for the next pass (current) or is skipped
   with a reason after N passes?
5. **Bot check with nobody at the machine:** keep the "stop that site for the day" rule (R-22), or treat it
   like any gate (back of the queue)?

## Status

All phases implemented: gate release ("I've done it" continues at once), single route-by-URL pipeline, back-of-queue with 3-attempt give-up, single "AI agent" view with one activity stream, no agent toggle, no queue cap (LIMIT 25 removed), Greenhouse/Lever/Ashby follow the consultant's auto-submit choice (Workday and SmartRecruiters still never auto-submit).

Tests: desktop run 372, runs 44, gates 24, pipeline 12, resolver 32, verify 17, packs 23, pagekind 18, fixtures 14 pass; renderer builds. `tests/dom.mjs` passes its first 60+ checks, then the headless Chromium crashes ("Target crashed") in this environment. Not exercised live in Electron or on real sites. Migration 060 is still unapplied.
