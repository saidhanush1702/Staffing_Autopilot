# Desktop form filling — audit and a robust workflow

Scope: `desktop/src/main/**` (cycle, browser/*, agent/*, attention) and the hub side of the agent
(`backend/controllers/agentController.js`, `backend/config/agentProtocol.js`).
Constraint from the brief: no change of infrastructure and no rewrite of the current flow. Everything
below is an addition or a tightening of what already exists.

---

## 1. How it works today

```
queue item
  → open job in the board's persistent Chrome profile             (session.js)
  → classify: closed / already applied / Easy Apply / external     (applyFlow.js)
  → recipe path   LinkedIn Easy Apply, Workday  (only `verified: true` boards may type)
       runApplyFlow → fillForm (label → profile/approved answer, exact normalised match)
  → on failure / unknown site → AI agent                            (agent/*)
       observe page (text, no screenshot) → hub asks the LLM for ONE action → check → do it → repeat
  → unknown required question → "attention" gate: notify + wait 2 min/question → bank answer
  → READY_TO_SUBMIT → review screen → consultant presses Submit
```

Good, deliberate things worth keeping: the submit wall (two guards plus `HARD_SUBMIT`), the model only
*picks* a source and never writes text, stamped element refs instead of positional indexes, strict
option matching (wrong state is worse than blank), per-employer Workday profiles, saved cookie jars,
humans always do login and CAPTCHA, answers typed in the browser are banked.

Test state: `tests/dom.mjs` 137 passed / 0 failed; `tests/run.mjs` printed no failures. These are
fixture tests. **I did not run a live application.** The code comments themselves say how far live
verification went: Workday only to step 1 (`submit` is "GUESSED"), LinkedIn to page 4 of 5 ("Nothing
has yet watched this fill a LinkedIn application to the end"), Wellfound/Built In/CrunchBoard
`verified: false` (Built In has no in-house form at all).

## 2. Verdict: why it feels fragile

The unit tests being green does not contradict your feeling. The fragility is in design gaps, not in
typos:

1. **The answer book is tiny.** `buildAnswerBook` knows 9 profile facts (name, email, phone, city, state,
   LinkedIn, work auth). The agent's catalogue is the same 9 keys plus approved answers
   (`agentProtocol.js` `PROFILE_KEYS`). No address/zip/country, phone country code, education, employer
   history, years of experience, salary, notice period, start date, relocation, EEO/voluntary
   disclosures, portfolio/GitHub, "how did you hear". Workday's "My Experience" and "Voluntary
   Disclosures" steps therefore *always* stop for a human. This, more than selectors, is why it can't
   fill "any job".
2. **"User in between" is a blocking wait with a timeout, not a pause.** `attention.js`: 60 s bot check,
   120 s per question, 300 s sign-in. On timeout the item is parked or handed over and the browser
   moves to the next job (one page per board), so the half-filled form is gone. A person who is away
   for 10 minutes loses the application. While waiting, the whole queue is blocked (one job at a time).
   Nothing is persisted: no step, no fields done, no resume point; a restart loses it.
3. **The agent is slow and blind.** One hub round-trip plus one LLM call per single action (cap ~25–40
   per job), text-only observation (no screenshot), 80 fields / 45 controls / ~1.2k chars of text.
   Custom widgets (date pickers, multi-selects, repeaters like "Add education") only work where a
   special case was hand-written. `querySelectorAll` in `observe.js`/`describeFields` does not pierce
   shadow DOM.
4. **Nothing is learned from a success.** The same Workday tenant or Greenhouse board costs the same
   LLM calls next time. Failures are tallied as text reasons, not as capturable fixtures.
5. **Post-fill verification is thin.** `ready` checks that required fields have *some* value and no
   error text shows. It does not read back that the value that landed equals the value intended, or that
   a dropdown holds the option chosen.
6. **Submit confirmation can lie.** `pressSubmit`: with no `submitted` selector, "confirmed" = the submit
   button is gone. `pressAgentSubmit`: `thanked || gone`. Any navigation or re-render counts as
   success, and that flows into the hub's permanent record.
7. **Gate coverage is incomplete.** Handled: sign-in, account wall, CAPTCHA/DataDome, legal notice,
   unknown question. Not detected as gates: email verification / OTP, "create account" mid-wizard on
   other ATSs, upload failures, session timeout mid-form, cover-letter/essay prompts (they're just
   "unknown question").
8. **Coverage is two recipes plus an LLM.** Greenhouse, Lever, Ashby, SmartRecruiters, iCIMS, Taleo,
   SuccessFactors, Oracle are only known by name (`ATS_NAMES`) — every one of them goes to the paid,
   slow agent.

## 3. What the industry does (and what is and isn't known)

Evidence is mostly vendor pages and blogs; I found no internal engineering write-ups for Simplify or
the auto-apply bots, so treat the "how" below as inferred from public behaviour.

- **Simplify Copilot** (the category leader for autofill): runs as an extension *inside the user's own
  tab and session* (so login, CAPTCHA and bot-checks are never its problem), advertises 100+ portals
  incl. Workday, Greenhouse, Lever, iCIMS, Taleo, SmartRecruiters, fills by **matching labels** against
  saved values, saves custom-question answers and reuses them, optionally drafts unique answers from
  the profile, and **always ends with the user reviewing and submitting**; multi-page forms need
  Autofill per page unless a setting is on. Users report it misses fields and skips free-text prompts.
  [help center](https://help.simplify.jobs/articles/2415391-using-copilot-to-autofill-applications),
  [saved answers](https://help.simplify.jobs/article/18-saving-custom-questions),
  [Jobscan comparison](https://www.jobscan.co/blog/jobscan-vs-simplify/).
- **Full auto-appliers (LazyApply, Sonara, …)**: cloud bots submitting at volume. The only numbers
  available (40 % failed applications, <2 % response) come from a competitor's marketing and are
  unverified, but the pattern — hands-off tools are untrusted and fail silently — matches why the
  successful products keep a human at the submit step. Sonara reportedly uses human staff for some
  free-text. [scale.jobs tests](https://scale.jobs/blog/auto-apply-tools-30-day-test-results).
- **General browser agents** (OpenAI CUA, Perplexity Comet, browser-use, Stagehand): perception is
  *accessibility-tree first, screenshot as fallback* (a login form ≈3.8k tokens as an a11y tree vs
  15k+ as HTML); targeting by role/label/intent rather than CSS; a **recovery ladder** when an action
  fails (attribute → semantic → vision); and **caching of resolved actions** so repeat runs skip the LLM
  and only re-infer when the recorded selector breaks (Stagehand `act/observe` caching + self-heal).
  [arXiv survey](https://arxiv.org/pdf/2511.19477),
  [Stagehand docs](https://docs.stagehand.dev/v4/best-practices/caching).
- **Human hand-off pattern**: treat the pause as a *named workflow state*; human and script share the
  **same live browser session**; show what is pending; **re-observe the page before resuming** because
  it changes while a person works; gate before risky actions, not after.
  [Cloudflare Browser Run HITL](https://developers.cloudflare.com/browser-run/features/human-in-the-loop).
- **ATS APIs**: Greenhouse's job-board API can accept applications, but only with the *employer's* API
  key, so it is not an option for a third party. Per-ATS form handling is therefore the industry norm.

Takeaways: (a) assist-and-review beats auto-submit; (b) breadth comes from per-ATS adapters on top of a
generic label-matching core, not from one clever agent; (c) the saved-answer bank is the moat; (d)
LLM only where heuristics fail, with caching; (e) the human step is a first-class, resumable state.

## 4. Proposed workflow (additive)

Keep the current spine (open → classify → fill → gate → review → human submit). Strengthen each layer.

### 4.1 Durable `ApplicationRun` (fixes gap 2, 7)

Persist (the app already has `store.js`/SQLite) per attempt: `itemId, host/tenant, url, stepIndex,
answeredFields[], status`, where status ∈ `RUNNING | WAITING_USER(gate) | READY | SUBMITTED | FAILED`.

- A gate **does not time out into abandonment.** The timer becomes a *reminder* (5 min, 30 min, 2 h),
  and the run stays `WAITING_USER` up to a long TTL (e.g. 24–48 h; Workday and LinkedIn keep drafts).
- The tab stays open and is brought to front; an in-page banner says what is needed.
- **Lanes**: a waiting run blocks only its own board/tenant lane, never the whole queue. `maxOpenContexts`
  (2) already bounds browsers; a waiting run holds one slot.
- **Resume = re-observe, never replay**: on "Continue" (button in app, or the page changing), run
  `observe` → classify page → reconcile what is already filled → carry on. Works after an app restart
  by reopening the URL and relying on the same reconcile step.

### 4.2 Typed gates (fixes gap 7)

`LOGIN · ACCOUNT_CREATE · EMAIL_VERIFY/OTP · CAPTCHA/BOT · TERMS_CONSENT · UNKNOWN_QUESTIONS ·
ESSAY (cover letter / free text) · UPLOAD_PROBLEM · SESSION_EXPIRED`. One deterministic page-kind
classifier (`JOB_PAGE, LOGIN, FORM_STEP, REVIEW, CONFIRMATION, CLOSED, CHALLENGE, ERROR`) runs on every
observation; LLM+screenshot only when it returns UNKNOWN. Unknown questions are batched per step and
shown in the app *and* answerable in-page; answers go to the bank (existing `#bankTypedAnswers`).

### 4.3 Answer resolution cascade (fixes gap 1)

Per field, first hit wins, and every fill records its **source** (already true today):
1. Field already has a value → keep.
2. **Expanded profile** — add: address/zip/country, phone country code, links (GitHub/portfolio),
   education[] and experience[] (parsed from the resume once, *approved by the consultant once*),
   years-of-experience per skill, salary, notice period, start date, relocation/remote, work-auth and
   sponsorship, EEO preferences ("decline to self-identify" as the default). Raise the same
   `profileKeys` on the hub so the agent can reference them.
3. Approved bank, exact normalised question (today).
4. **Semantic match to the bank**, picking only *from* approved answers with a confidence score and a
   cache by normalised question. (`#matchBlockingWithAI` exists but runs late; move it into the
   cascade so the agent and recipes share it.)
5. Draft suggestion for free text → **never typed automatically**, shown as "suggested — approve".
6. Ask the consultant.

Rule that stays: no invented facts. Below a confidence threshold, ask.

### 4.4 Universal form model + read-back verification (fixes gaps 3, 5)

- Make `describeFields` the single reader and extend it: shadow-DOM piercing, repeater sections
  ("Add education/experience" is already partly handled in `findRevealControl`), date pickers,
  multi-selects, consent checkboxes, file inputs.
- Every action = **act → read back → compare → ladder**: locator → label → keyboard → (agent+screenshot)
  → else mark that field `NEEDS_USER`. Never advance past an unverified required field.
- Per-ATS code shrinks to a **quirk pack**: widget drivers, page-kind hints, next/submit selectors.
  Order by the tally the app already keeps in hand-over reasons: Greenhouse, Lever, Ashby,
  SmartRecruiters, iCIMS, then Oracle/Taleo/SuccessFactors.

### 4.5 Faster, cheaper agent (fixes gaps 3, 4)

- Plan per **page**, not per click: one model call returns a list of `fill` actions (still validated
  one by one by `executeAction`), cutting ~25 round-trips to ~3–5 per application.
- Add an optional screenshot to the observation when the DOM view is ambiguous.
- **Playbook cache** per `(ATS, host, step signature)`: after a verified-good run, store
  field-label → answer-source mapping and the step sequence; next run replays deterministically and
  calls the model only on a diff (Stagehand-style).

### 4.6 Submission you can trust (fixes gap 6)

- Confirmation requires *positive* evidence: a confirmation text/URL/marker. "Button gone" alone →
  status `SUBMITTED_UNCONFIRMED`, shown distinctly, never written to the hub as confirmed.
- Save a screenshot per step and one of the final review state; show it on the review screen. This
  also gives the consultant a fast visual check instead of reading a Q&A list.
- Keep: the consultant presses Submit (Simplify, the market leader, does the same).

### 4.7 Feedback loop and guardrails

- On any failed/hand-over run, capture sanitised page HTML (labels only, no values) as a fixture for
  `tests/dom.mjs`; telemetry on top unknown labels and failing widgets per ATS.
- Hub-side kill switch per ATS when its failure rate spikes. Keep jitter, one active run per host,
  and the existing stop-on-bot-check rule. No evasion work: CAPTCHA and bot-checks stay a human step.
- Live-conformance script that walks public demo/test forms to the review step and never submits.

## 5. Order of work

| P | Item | Why first |
|---|------|-----------|
| 0 | 4.1 durable runs, long-lived gates, lanes | biggest user-visible failure |
| 0 | 4.3 steps 2 + 4 (expanded profile, earlier semantic match) | unlocks Workday/Greenhouse steps |
| 0 | 4.6 strict confirmation + screenshots | stops false "submitted" records |
| 1 | 4.2 page-kind classifier, typed gates (OTP/email verify) | removes silent stalls |
| 1 | 4.4 read-back, shadow DOM, repeaters, date/multi-select | field coverage |
| 1 | 4.5 per-page planning | speed and cost |
| 2 | Greenhouse, Lever, Ashby, SmartRecruiters quirk packs; playbook cache | breadth |
| 2 | 4.7 fixture capture, kill switch, conformance script | keeps it robust |

Measure per ATS: % fields auto-filled, % runs reaching READY with zero interruptions, interruptions
per application, **wrong-value rate (target 0)**, submit-confirmed rate, median time.

## 6. Open decisions for you

1. Gate TTL: how long may a run wait for a person (suggest 24 h)?
2. Experience/education from the resume: OK to auto-extract and ask the consultant to approve once?
3. Free-text/essay answers: suggestion-only (recommended) or auto-filled after approval?
4. Keep the isolated Chrome profile (current, safer) or attach to the consultant's everyday Chrome
   (better trust signals, but touches their personal profile)?

---

## 7. Final target architecture (consolidated)

**Hub (cloud):** Run store (queue, caps, leases), LLM gateway (page-level planning and semantic
matching; model never writes facts), Data vault (structured resume facts, preferences, approved answer
bank), Telemetry (failure fixtures, per-ATS stats, kill switch).

**Desktop engine:** Run manager (durable state) → Page reader (fields + page kind) → Answer resolver
(cascade) → Fill and verify (act, read back, retry ladder) → Gate manager (typed human handoffs).

**Run lifecycle:** `QUEUED → OPENING → READING → FILLING → (WAITING_USER ⇄ READING) → READY →
SUBMITTED | SUBMITTED_UNCONFIRMED | FAILED | SKIPPED`. WAITING_USER keeps the tab open, persists
`{url, step, answered fields}`, reminds at 5 min / 30 min / 2 h, expires after a configurable TTL, and
always resumes by re-reading the page.

**Decisions taken from the pasted proposal:** adopt the structured vault and page-level LLM planning;
reject raw `.value` injection (use real typing/clicks), reject unreviewed generated essays (suggest +
approve), reject the direct ATS API fast-track (needs employer keys; no human review).

**Build order:** Phase 0 run manager + long gates + lanes; Phase 1 vault/profile schema + resolver
cascade; Phase 2 verify + strict submit confirmation + screenshots; Phase 3 page-level agent planning +
Greenhouse/Lever/Ashby/SmartRecruiters packs; Phase 4 playbook cache + telemetry/fixtures.

## 8. Phase 0 — built

- `desktop/src/main/runs.js` — `RunLedger`: persisted record of applications waiting on a person
  (status, gate kind, lane, `since`, attempts, reminders). 24 h TTL, retry every 10 min, reminders at
  5 min / 30 min / 2 h then every 2 h, crash recovery.
- `cycle.js` — a gate whose short window runs out is **deferred, not abandoned** (board sign-in, Workday
  tenant sign-in, wizard account wall, terms, agent account wall). The lane is held so the next job on
  that board/tenant does not reopen the same window; **other boards keep running**. Held jobs resume
  when sign-in is seen, when the person presses "I've done it", or on the retry timer, and are handed
  over only after the TTL. Resume re-opens and re-reads the page; nothing is replayed.
- UI: "On hold" panel with an "I've done it" button (`WaitingRuns.jsx`, IPC `runResume`).
- Not changed: the short blocking windows themselves, unknown-question parking (the hub already
  re-queues those on answer), and the rule that only one application is actively driven at a time.
- Tests: `tests/runs.mjs` (44 checks). `npm test` now runs it.

## 9. Phases 1–4 — built

**Phase 1 — profile and resolver.** `backend/config/applicationProfile.js` builds one profile for both the
device queue and the agent catalogue from data the consultant already enters (education, work history,
per-skill years, GitHub/portfolio). New answerable facts: GitHub, portfolio, headline, current
company/title, school, degree, field, education level, graduation year, total years, and *years of a named
skill* (answered only when the question names skills that all carry the same recorded figure). Bare
"Job title"/"Company" are deliberately not answered (they are rows of a history). Voluntary
gender/race/veteran/disability questions get the form's "prefer not to say" option only if the
consultant switches that on at Start; the default leaves them to a person.

**Phase 2 — verification.** Read-back after every typed value / chosen option (empty, wrong-box and
unselected are caught); "submit pressed" is no longer "sent" without evidence (message, marker or
confirmation URL) — unconfirmed ones stay on the review list and are never reported to the hub as sent;
a screenshot of each filled form is kept for review and swept afterwards; the resume goes only to a
file box that is the resume (never an "autofill from resume" box).

**Phase 3 — breadth.** Deterministic page-kind classifier (challenge, email-verification, closed, login,
confirmation, error, job page, form step, review); verification-code pages are a typed human gate; closed
postings cost no model call. `fill_many` lets the agent fill a page's fields in one reply (each entry
validated like a single fill). Greenhouse, Lever and Ashby recipes were measured on live public postings;
the filler now also reads button-style Yes/No (Ashby), same-named radios/checkboxes without a fieldset and
label-less selects (Lever), and treats a row of checkboxes as one question. Jobs whose address is on a
known system skip the agent and go straight to the recipe.

**Phase 4 — feedback.** Failed runs save the page *shape* (labels/button text, no values) under
`fixtures/`; per-system outcome tallies are kept in the store (`siteStats`). `npm run dry-run:form -- <url>`
fills a public posting with a fake applicant and stops short of sending.

Not built: caching of resolved agent actions per site. The hub already banks an AI-matched wording as an
answer, and `fill_many` removes most of the per-click cost, so the remaining benefit did not justify the
added staleness risk yet; `siteStats` will say whether it is needed.
