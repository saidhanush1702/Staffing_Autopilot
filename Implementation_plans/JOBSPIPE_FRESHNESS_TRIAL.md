# JobsPipe Freshness Trial — Measured Results

**Date:** 2026-09-12 · **Credits spent:** 3 JobsPipe of 100, 6 SerpApi of 250 · **Branch:** `feature/webapplication`

The question this answers: **SerpApi is not returning recently-posted jobs. Is
JobsPipe actually faster, and by how much?**

Two live calls were made. Nothing was written to the database — the probe is
read-only by construction.

---

## 1. The answer in one line

**Yes, but the speed comes entirely from the underlying board, not from
JobsPipe.** Direct-ATS postings arrived **6 minutes** after publication;
Indeed-relayed postings took **7.7 hours** and carry a timestamp too coarse to
measure. Filtering to direct-ATS sources is where the whole advantage lives.

---

## 2. What was asked for

| # | Filters | Returned | Pool (`total_results`) |
|---|---|---|---|
| 1 | last 24h, no other filter | 25 | **408,677** |
| 2 | last 24h, `US`, 10 IT titles | 25 | **3,097** |

`limit: 100` was requested both times and **25** came back. The Free Tier caps
a page at 25, so **1 credit = at most 25 jobs** — 100 credits/month is a
ceiling of ~2,500 jobs/month.

---

## 3. Freshness, by source

This is the finding that matters. Call 2, all 25 jobs:

| Source | n | Median lag (published → JobsPipe saw it) | Fastest |
|---|---:|---:|---:|
| **greenhouse** (direct ATS) | 1 | **0.10 h (6 min)** | 6 min |
| **indeed** (aggregator relay) | 24 | **7.67 h** | 4.44 h |

### The timestamp problem

24 of 25 Indeed jobs carried the **identical** `date_posted`:

```
2026-09-12T05:00:00+00:00   × 24      ← one daily batch stamp
2026-09-12T08:04:39-04:00   × 1       ← greenhouse, real to the second
```

Indeed's `date_posted` has **daily granularity**. So the "median age 9.0h"
headline is an artefact of a midnight-ish stamp, not a real measurement. Only
direct-ATS rows carry a usable publication time.

**Consequence:** if you take the whole feed, you inherit Indeed's ~7.7h delay
*and* lose the ability to tell how old anything is. If you filter to direct ATS
(`source_or`), you get minute-level freshness — which is the thing SerpApi
cannot do at all.

---

## 4. `date_posted` is unusable on 44% of the unfiltered feed

Call 1, 11 of 25 jobs had `date_posted` **later than** `discovered_at` — a
posting discovered before it was published:

```
posted 2026-09-21T00:00:00Z   discovered 2026-08-11T00:22:42Z    (FR, indeed)
posted 2026-09-15T00:00:00Z   discovered 2026-08-05T12:11:35Z    (FR, indeed)
```

On those rows the field is a **deadline or refresh date**, not a publication
date. Left uncorrected this breaks two things:

- **the trial's own number** — a future date reads as *negative* age, so the
  worst rows sort to the top as "the freshest jobs in the feed";
- **posting ageing** — `posted_at` drives `is_active = false` after N days, so
  a future-dated posting never ages out and sits in the pool for ever.

`resolvePostedAt()` in `connectors/jobspipeSearch.js` detects the impossible
ordering and falls back to `discovered_at`, flagging the row as `suspectDate`.
After the country filter, **0%** of call 2 was suspect — the bad rows were all
non-US Indeed relays.

---

## 5. Geography makes or breaks it

| Call | US | SE | IN | FR |
|---|---:|---:|---:|---:|
| 1 — unfiltered | **1** | 14 | 6 | 4 |
| 2 — `job_country_code_or: ['US']` | **25** | — | — | — |

Unfiltered, **4% of a paid credit was US work.** `job_country_code_or` is not
optional for this bench.

---

## 6. Two findings that affect whether this fits the business at all

### ~~It returned no contract roles~~ — CORRECTED 2026-09-12

The unfiltered sample contained none:

```
employment_statuses:  { full_time: 23 }        contract: 0
```

**That was an artefact of not filtering, and the conclusion drawn from it was
wrong.** A third call with `employment_type_or: ['contract']` returned **14 of
14 contract roles**, and two of them carried genuine **HOURLY** rates:

```
Principal Full Stack Engineer  @ Eliassen Group    CONTRACT   69.00–73.00 HOURLY
Full Stack Engineer (Only W2)  @ Infojini Inc      CONTRACT   44.00–80.00 HOURLY
Sr. React Developer (80% FE)   @ Synechron         CONTRACT   no pay
Full Stack Engineer            @ Ampcus Inc        CONTRACT   no pay
```

Eliassen, Synechron, InfoVision, Infojini, Ampcus — these are IT staffing
firms, which is precisely this bench's market. So the hourly-rate parsing in
`parsePay` is load-bearing after all, and the earlier "every salary is annual"
finding only held for full-time listings.

**The lesson is about the measurement, not the feed:** an unfiltered page of a
global aggregator says nothing about what a filtered query returns, and the
first two calls were spent learning that.

### One employer dominated the page

```
JPMorganChase 21 · Scout Motors 1 · LangChain 1 · Realign 1 · PathAI 1
```

Sorted by date, a page is whatever one large employer bulk-posted. Without
`company_name_not`-style spreading, a credit can buy 21 near-identical
JPMorgan listings.

---

## 7. The schema the webhook adapter was guessing at

The real response carries **~75 fields**, not the 40 in the published SDK
types. Three of `connectors/jobspipe.js`'s `ACCEPTED_PATHS` guesses do not
survive contact with it — and the same feed backs both doors, so these are
wrong in the **webhook** path too:

| Webhook adapter looks for | The API actually sends | Effect |
|---|---|---|
| `salary.min` / `salary_min` | `min_annual_salary` | — |
| `salary.interval` | **nothing** (`salary_type` = provenance, not unit) | `parsePay` returns null → **every pushed job has no pay** |
| `employment_type` | `employment_statuses` (an **array**) | work type always null |
| `source` | `sources[]` (`{provider, url, seen_at}`) | attribution silently lost |

Also newly known and unused: `salary_type` (`observed` \| `estimated` \| null),
`estimated_*_annual_salary_usd`, `expires_at`, `status`, `ghost_score`,
`last_seen_at`, `work_arrangement`, `esco_skills`, `occupation_label`.

**`salary_type` matters for correctness.** It distinguishes an advertised
salary from JobsPipe's own model output. `parsePay` now **refuses anything not
`observed`** — filtering a real job out, or letting a bad one through, on a
guessed salary is a decision made on invented data that nothing downstream
could detect. Call 2 contained `estimated` rows, so this guard is doing real
work.

---

## 8. What was built

### New (5)

| File | Purpose |
|---|---|
| `backend/connectors/jobspipeApi.js` | REST client for `POST /v1/jobs/search`; filter allowlist, key redaction, no retry on plain 4xx |
| `backend/connectors/jobspipeSearch.js` | Adapter: the real flat schema → the posting shape the pipeline consumes |
| `backend/scripts/jobspipe-freshness.mjs` | This report's probe. Read-only, 1 credit, saves the raw body |
| `backend/jobs/jobspipePoller.js` | Scheduled pull + budget guard. **Off by default** |
| `backend/db/migrations/044_jobspipe_polling.sql` | `organization_providers` row + `jobspipe_poll_runs` credit ledger |
| `backend/tests/jobspipeSearch.test.mjs` | 101 assertions, pure |

### Modified (4)

| File | Change |
|---|---|
| `backend/controllers/jobspipeListener.js` | `ingestJob` split → `ingestAdapted`, so both doors share one pipeline. Plus a `via` label |
| `backend/server.js` | Import + `startJobsPipePoller()` |
| `backend/package.json` | 3 scripts |
| `backend/.env` / `.env.example` | Key + 7 documented settings |

**Webhook and SerpApi paths are untouched.**

### Tests

```
jobspipeSearch  101 passed, 0 failed      ← new
jobspipe         90 passed, 0 failed      discovery  133 passed, 0 failed
worker           34 passed, 0 failed      tailoring   59 passed, 0 failed
contacts        108 passed, 0 failed      llm         59 passed, 0 failed
```

584 assertions, no regressions from the `ingestAdapted` refactor.

---

## 9. Credit arithmetic — why the poller defaults to six-hourly

1 credit = 1 request, 25 jobs max, 100 credits/month.

| Cadence | Credits/month | Verdict |
|---|---:|---|
| every 15 min (the discovery cycle's rate) | 2,880 | dies on day one |
| hourly | 720 | 7× over |
| **every 6 hours** | **120** | just over — hence the 90 ceiling |
| every 8 hours | 90 | fits |

`JOBSPIPE_MONTHLY_CREDITS=90` leaves 10 for manual probes.
`remainingCredits()` refuses **before** spending; an allowance discovered after
it is gone is not a budget.

---

## 10. Status

### Done since the first draft

- **Migrations 044 and 045 applied.** Verified against the live database.
- **Apollo no longer appears in Job Discovery** — migration 045 gives it
  `fetch_mode = 'ENRICHMENT'`. It had been selected as the *search provider* in
  every org with SerpApi switched off, because `loadProviders` took any
  `PROVIDER` row and "Apollo" sorts before "Google Jobs". Contacts is
  unaffected: it resolves Apollo by name.
- **The `?? providers[0]` fallback** that made that possible is now
  `selectSearchProvider()`, which reports whether it fell back instead of
  silently substituting a disabled provider. It was inlined at **four** sites.
- **SerpApi enabled for manual runs** in Molina Staffing. The 4-hour cycle is
  left **off** at both levels (`DISCOVERY_ENABLED` unset,
  `discovery_schedule_enabled = false`).
- **Full UI for the pull path** — its own panel, its own Run button, an
  Advanced filter form, and a poll history table, on the Job Discovery screen
  beside SerpApi. Verified in the browser.
- **Both doors run end-to-end from the UI.** See §10b.
- **`employment_type_or: ['contract']` tested** — see the correction in §6.

### Still not done

- **Automatic polling is off.** `JOBSPIPE_POLL_ENABLED=false`; the cron never
  starts. The button works regardless, which is the distinction the panel makes.
- Webhook `ACCEPTED_PATHS` **not corrected** — §7 says what is wrong; the fix
  is deliberately left separate so the push path is not changed under you.
- **Nothing is committed.** Still a working tree.
- Only **Molina Staffing** has either provider enabled. Apex, test_new and
  newtestorgmnl are untouched.

---

## 10b. Head-to-head, same bench, same day (2026-09-12)

Both doors were run manually from the Job Discovery screen, minutes apart,
against the same single-consultant bench. This is the comparison the original
complaint was about.

| | **JobsPipe** (1 credit) | **SerpApi** (6 credits) |
|---|---:|---:|
| Postings stored | 14 | 28 |
| CONTRACT | **14 (100%)** | **2 (7%)** |
| Hourly pay parsed | 2 | 0 |
| No pay at all | 10 | 23 |
| **Average posting age** | **108.5 h** | **336.0 h (14 days)** |
| Matched the consultant | **4** | **0** |
| Queued → AI preparation | **4** | 0 |
| Wall time | 5.5 s | 118 s |

SerpApi work-type breakdown: `FULL_TIME 22 · CONTRACT 2 · PART_TIME 1 · none 3`.

**This is the answer to "we are not getting recently uploaded jobs".** SerpApi's
average posting was **two weeks old** and 22 of its 28 results were full-time —
so a contract bench matched **nothing at all** from 28 postings and 6 credits.
JobsPipe, filtered to contract, matched 4 from 14 postings and 1 credit, and all
four reached `READY` (the tailoring worker completed them).

Caveats, stated plainly:

- One consultant, one day, one run each. Directional, not a season's data.
- JobsPipe's 108.5 h average is higher than `posted_at_max_age_days: 1` implies.
  Their "1 day" window is not a strict 24 hours, and `resolvePostedAt` falls
  back to `discovered_at` on rows with an impossible `date_posted` (§4), which
  ages some of them.
- SerpApi's 6 credits bought more raw postings. It is not worse at *volume* —
  it is worse at **recency** and, for this bench, at **relevance**.

---

## 11. Recommendation

Worth continuing, with the filters narrowed:

```js
{
  job_country_code_or: ['US'],
  source_or: ['greenhouse', 'lever', 'ashby'],   // where the 6-minute lag lives
  employment_type_or: ['contract'],              // ← verify this first
  posted_at_max_age_days: 1,
  limit: 25,
}
```

Taking the raw feed buys Indeed's 7.7-hour relay with a daily timestamp, which
is barely better than what SerpApi already gives. The direct-ATS slice is a
genuine improvement on anything currently reachable — **if** it carries
contract roles. One credit answers that.
