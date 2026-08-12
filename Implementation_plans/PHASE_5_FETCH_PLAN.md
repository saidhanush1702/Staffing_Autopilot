# Fetch Plan — getting only the newest jobs, every 4 hours

**Status: plan, awaiting approval. No code written against it yet.**

Goal, as stated: *run every 4 hours and get only the jobs posted in those 4
hours.* This document says what part of that is achievable, what part is not,
and what to build instead so the outcome is the same.

---

## 1. The hard constraint

**Google Jobs has no four-hour filter. Its narrowest recency window is 24
hours.** From the API documentation, the `Date posted` filter offers exactly
four options and nothing finer:

| Option | Window |
|---|---|
| **Yesterday** | past ~24 hours ← **the narrowest that exists** |
| Last 3 days | 72 hours |
| Last week | 7 days |
| Last month | 30 days |

No reseller can offer better, because none of them have it — this is Google's
own filter vocabulary, not SerpApi's. So "ask for the last 4 hours" is not
expressible in the request, at any price, on any plan.

### Two parameters I had wrong

Reading the documentation properly corrected two things:

| Parameter | Status | Consequence |
|---|---|---|
| `chips=date_posted:today` | **Deprecated by Google** | The recency filter currently in the code **does nothing.** It is silently ignored — which is the worst failure mode, because it looks configured. |
| `ltype=1` (work from home) | **Deprecated by Google** | Not used by us, but not available if we wanted it. |
| `uds` | **Live** | The real mechanism. Details in §4. |

That first row is a live defect and gets fixed regardless of which plan is chosen.

---

## 2. What replaces it: freshness in three layers

The four-hour goal is met **after** the request, not in it.

```
  ┌─ LAYER 1 ─ REQUEST ────────────────────────────────────────────┐
  │  uds filter = "Yesterday"  (past 24h — narrowest Google has)    │
  │  Purpose: make page 1 full of RECENT jobs instead of            │
  │           whatever ranks highest, which is usually old.         │
  └────────────────────────┬───────────────────────────────────────┘
                           ▼
  ┌─ LAYER 2 ─ FINGERPRINT DE-DUPLICATION (already built, R-15) ───┐
  │  company + title + location, normalised.                        │
  │  Seen before?  →  record a sighting, do NOT create a posting.   │
  │  THIS is what makes each run yield only genuinely new jobs.     │
  └────────────────────────┬───────────────────────────────────────┘
                           ▼
  ┌─ LAYER 3 ─ AGE BACKSTOP ───────────────────────────────────────┐
  │  posted_at ("3 hours ago") → absolute timestamp.                │
  │  Older than MAX_JOB_AGE_DAYS (default 7)?  →  ignore.           │
  │  A safety net, not the primary filter. See §3 for why.          │
  └────────────────────────────────────────────────────────────────┘
```

**The outcome you asked for is delivered by Layer 2, not Layer 1.** Each
four-hour run surfaces exactly the jobs that were not in the pool before —
which, run every four hours, is "the jobs from the last four hours" in every
respect that matters operationally.

---

## 3. The trap to avoid: "reject anything posted before the last run"

This is the obvious implementation of your request, and it would quietly lose
real jobs. It must not be built.

**Google's index lags the job boards by hours.** A posting goes live at 10:00
and Google indexes it at 12:30.

```
10:00   Employer posts the job
        │
12:00   ── RUN ──  we search. Google has not indexed it yet. We see nothing.
        │
12:30   Google indexes it, carrying posted_at = "2 hours ago" (= 10:00)
        │
16:00   ── RUN ──  we search. NOW it appears, with posted_at = 10:00.
        │
        └─ With a "posted since the last run (12:00)" gate:
           10:00 < 12:00  →  REJECTED.  The job is lost permanently.
```

The job was never too old. It was too *late*. A clock-based gate cannot tell
those apart.

**De-duplication can.** It asks "have we seen this before?" — a question about
our own records, not about Google's timing. A job that appears late is simply
new to us, and gets queued. That is the correct behaviour, and it is already
built and tested.

So: **posted_at is used for display, ordering, and a generous 7-day backstop.
It is never a hard gate against the last run time.**

---

## 4. The `uds` mechanism, and why it is nearly free

`uds` is an opaque, Google-generated filter string. Two properties decide the design:

**It is query-specific.** Comparing the two examples in the documentation, the
same "Last 3 days" filter produces different strings for different queries:

```
q = "Barista"           →  AOm0WdE2fekQnsyfYEw8JPYozOKz9gQYSoNMFjnsJA1yb9yQ…
q = "barista new york"  →  ADvngMhDW9mUe_qvPvPBAc7NjGxhKErDl1XdGENLcQiARxw…
```

Within one query the prefix is shared across filters and only the tail differs,
which is consistent with it encoding *query + filter* together. **It cannot be
hard-coded.**

**It arrives free in every response.** Every search returns a `filters` array
containing each available filter with its `uds` and a rewritten `q`. So:

```
FIRST time we search a term
    └─ one normal call  →  returns jobs (we keep them)
                        →  AND the "Yesterday" uds (we cache it)
                           ↑ nothing extra is spent; the call was happening anyway

EVERY later run for that term
    └─ call with the cached uds  →  filtered to the last 24h
                                    same one credit as before
```

**Filtering therefore costs nothing.** The discovery call is a call we were
making regardless, and it yields jobs as well as the handle.

**Invalidation matters.** The two examples above have different prefixes
(`ADvngM…` from the 2024 docs, `AOm0Wd…` from a 2026 response) — Google rotates
these. So the cache needs a TTL (propose 7 days) and must re-discover
automatically when a filtered call errors or returns nothing.

---

## 5. Cost model

Confirmed pricing:

| Plan | Price | Searches/month |
|---|---:|---:|
| Free | $0 | 250 |
| Starter | $25 | 1,000 |
| **Developer** | **$75** | **5,000** |
| Production | $150 | 15,000 |
| Big Data | $275 | 30,000 |

**One credit = one page of results.** Not one job, not one run.

A four-hour cycle is **6 runs/day = 180 runs/month**, so:

```
monthly credits  =  search terms  ×  pages per term  ×  180
```

| Terms | Pages | Worst case/month | Typical with early-exit | Fits |
|---:|---:|---:|---:|---|
| 6 | 2 | 2,160 | ~1,100–1,400 | **Developer** ✓ |
| 6 | 1 | 1,080 | 1,080 | **Developer** ✓ |
| 5 | 1 | 900 | 900 | Starter — no headroom |
| 3 | 1 | 540 | 540 | Starter ✓ |
| 6 | 2 | 2,160 | — | Free (250) ✗ **8× over** |

**The free plan cannot support a four-hour cycle.** 250/month is ~8 credits per
*day*; a single 6-term run costs 6. You would exhaust the month in roughly 36
hours.

### Recommendation: **Developer, $75/month**

- 6 terms × 2 pages × 4-hour cycle = 2,160 worst case, comfortably inside 5,000
- Early exit (already built) should hold real usage nearer 1,100–1,400
- Leaves 2,800+ for manual runs, extra locations, and adding consultants
- Starter ($25) only works with ≤5 terms at 1 page and zero headroom — one busy
  month of manual runs breaks it

### Two things that are free

- **Repeat searches within 1 hour are cached and not counted.** A manual "Run
  discovery now" straight after a scheduled run costs nothing.
- **Errored and failed searches are not counted.** A provider outage costs no
  credits.

---

## 6. What gets built

| # | Item | Why |
|---|---|---|
| 1 | **Replace `chips` with `uds`** | `chips` is deprecated and currently does nothing. This is a live defect. |
| 2 | **`provider_filter_cache` table** | One row per (org, query, location, window) holding the uds, its rewritten `q`, and when it was fetched. 7-day TTL. |
| 3 | **Auto re-discovery** | A filtered call that errors or returns zero results invalidates the cached uds and falls back to an unfiltered call, which re-seeds it. Never gets permanently stuck on a rotated string. |
| 4 | **Monthly credit budget guard** | `SUM(provider_calls)` for the calendar month against a configured quota. At 90% it warns; at 100% it stops fetching and the run still does its matching half. **Nothing in the system currently prevents a runaway month.** |
| 5 | **Manual-run reserve** | A slice of the monthly quota (default 10%) that scheduled runs may not touch, so a person pressing the button at month-end is never blocked by the cycle. |
| 6 | **Age backstop** | `MAX_JOB_AGE_DAYS`, default 7. Applied to parsed `posted_at`. Never compared against last-run time (§3). |
| 7 | **Budget on screen** | Credits used this month, remaining, projected month-end, and which plan tier that implies. |
| 8 | **Retune defaults** | `DISCOVERY_CYCLE_HOURS=4`, `MAX_QUERIES=6`, `MAX_PAGES=2`, `MONTHLY_BUDGET=5000`. |

Roughly one migration, changes to two connector files and the orchestrator, and
one panel on the discovery screen.

---

## 7. Honest caveats

**A four-hour cycle is faster than Google's index.** Given the lag in §3, a
meaningful share of four-hourly runs will find nothing new and stop after page
one. That is not waste — it is the early-exit rule working — but the *floor*
cost is still 6 credits per run (one page per term) whether or not anything is
found. 6-hourly would cut the bill by a third for very little freshness loss.
Your call; the design supports either, and it is one environment variable.

**"Yesterday" is a 24-hour window, so consecutive runs overlap heavily.** That
is intentional and harmless — de-duplication collapses the overlap — but it
means the filter is not what makes runs cheap. Early exit is.

**`posted_at` is approximate.** Google reports "3 hours ago", not a timestamp.
Fine for ordering and a 7-day backstop; not fine for a four-hour gate, which is
the second reason §3's approach is wrong.

**The `google_jobs_listing` endpoint is not worth using.** Its uptime is
currently ~51%, and `apply_options`, `salaries` and `similar_jobs` have been
removed from it. Everything we need is already in the main response. The
`provider_job_id` column stays, but as a record rather than a fetch handle.

---

## 8. Decisions needed from you

1. **Upgrade to Developer ($75/mo)?** Required for a true 4-hour cycle. Free
   cannot do it and Starter has no headroom.
2. **Cycle interval — 4h or 6h?** 4h is what you asked for and is affordable on
   Developer. 6h costs ~a third less for marginal freshness loss, given the
   index lag.
3. **Recency window — "Yesterday" (24h) or "Last 3 days"?** I propose 24h now
   that de-duplication is doing the real work. 3 days is the safer choice if
   you would rather over-fetch and let dedupe sort it out.
4. **Monthly budget figure to enforce.** Propose setting it to the plan quota
   with a 10% manual reserve — so 5,000 with 500 held back.
