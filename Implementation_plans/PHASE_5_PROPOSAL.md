# Phase 5 (v2) — Job Acquisition via Google Jobs, Matching & the Queue

**Supersedes the v1 proposal, which specified direct scraping of five job
boards. That approach was built, probed against the live boards, and does not
work.** §1 is the post-mortem; everything after it is the replacement.

The change is deliberately narrow. **Only the acquisition layer is being
replaced.** De-duplication, matching, daily caps, the queue and its state
machine were never the problem and are not being touched.

---

## 1. Why v1 failed

v1 fetched each board directly: request the search page, harvest detail links,
parse `schema.org/JobPosting` JSON-LD out of each one. The engineering was
sound. The boards simply do not permit it, and the probe results were
unambiguous:

| Board | What actually happens | Verdict |
|---|---|---|
| **LinkedIn** | `robots.txt` is a single site-wide `User-agent: * / Disallow: /`. Every request is refused before it is sent, and an auth wall sits behind it regardless. | **Zero postings, ever** |
| **Wellfound** | Cloudflare answers **403** to every HTTP client — including the sitemap Wellfound declares in its own `robots.txt`. No RSS feed exists. | **Zero postings** |
| **TheLadders** | Cloudflare answers **403** to everything, *including `/robots.txt` itself*. Their crawl policy cannot even be read, so the polite fetcher fails closed. | **Zero postings** |
| **Built In** | Works, partially. `?search=` is disallowed, so entry pages come from their sitemap; most detail pages carry JSON-LD, a minority need a meta-description fallback. | **Low yield, fragile** |
| **CrunchBoard** | Every HTML page is 403; only `/jobs.rss` answers. The feed ignores search terms and carries very few jobs. | **Very low yield** |

**Four of five boards deliver nothing.** The two that respond do so through
side doors — a sitemap and an RSS feed — that were never meant to serve as a
search index, and that either board can close without notice.

The deeper problem is that this is not a bug list. It is the boards working as
intended. Each failure would need a *different* circumvention — a headless
browser for Cloudflare, an authenticated session for LinkedIn — and each of
those is an arms race that has to be won again every time a vendor ships a
detection update. Losing one costs the account.

So the acquisition method changes, and the boards stop being things we crawl.

---

## 2. What replaces it

**Google indexes all five boards already.** Google Jobs is an aggregator whose
entire purpose is to surface postings from LinkedIn, Wellfound, Built In,
TheLadders, CrunchBoard and several hundred others, with an attribution line
saying which board each came from and a direct apply link for each.

We buy that index through a SERP API instead of rebuilding it.

```
       v1 — five crawlers, four walls
  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ LinkedIn │ │Wellfound │ │ Built In │ │TheLadders│ │Crunchbrd │
  │  robots  │ │   403    │ │  partial │ │   403    │ │ rss only │
  └────╳─────┘ └────╳─────┘ └────┬─────┘ └────╳─────┘ └────┬─────┘
                                 └──────────┬─────────────┘
                                        thin trickle

       v2 — one provider, five portals as attribution
  ┌──────────────────────────────────────────────────────────────┐
  │  SerpApi  ·  engine=google_jobs  ·  q + location + pages      │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  jobs_results[]
                                  ▼
                     via: "LinkedIn" │ "Built In" │ "Wellfound" │ …
                     apply_options[]: direct link per portal
                                  │
                                  ▼
                        PORTAL ALLOWLIST (operator-controlled)
                                  │
                                  ▼
                   the pipeline that already works, unchanged
```

The five named boards remain first-class in the product. They stop being
*crawl targets* and become **portals** — the attribution recorded on each
posting, and the allowlist an operator controls. Per-board yield stays
measurable, which was spec item 16's whole purpose.

### Why this is the right shape, not just the working one

- **It is a sanctioned, paid, documented API.** No ToS violation, no bot
  detection, no IP bans, no account at risk. The request is a customer request
  to a vendor that sells exactly this.
- **One parser instead of five.** A single documented JSON contract replaces
  five HTML parsers, a sitemap crawler, an RSS parser, a robots.txt engine and
  a bot-challenge detector. That is roughly 1,100 lines of fragile code deleted
  against ~300 lines of adapter added.
- **It reaches the boards that were unreachable.** LinkedIn and Wellfound
  postings arrive through Google's index. They were structurally impossible in
  v1 — this is not an incremental yield improvement, it is the difference
  between zero and non-zero for the board ranked first.
- **Coverage beyond the five, free.** Google also surfaces Indeed, Glassdoor,
  ZipRecruiter, Dice, Greenhouse and Lever boards, and employers' own careers
  pages. **All of it is kept** (§5.1) — the five named boards are the priority
  set, not a filter that throws the rest away.
- **R-22 is satisfied more cleanly than before.** LinkedIn is never contacted.
  We read Google's index of LinkedIn. There is no bot-check to trip and no
  session to lose, which is a stronger form of "most conservative treatment"
  than a slow crawler was.

### The honest costs

| Cost | Detail |
|---|---|
| **It is metered** | Every search page is one API credit. A run of 6 search terms × 2 pages = 12 credits. Four runs a day ≈ 1,440 credits/month. Plans start around 100/month free and 5,000 paid — **the cycle interval and page depth are now budget decisions**, which is why both are configurable (§6). |
| **Coverage is Google's, not ours** | If Google has not indexed a posting, we do not see it. Fresh postings typically appear within hours, not minutes. |
| **The five boards are not equally represented** | LinkedIn and Built In are dense in Google Jobs. Wellfound is moderate. **TheLadders and CrunchBoard are thin** — expect little from them regardless of provider. That is a property of Google's index and no acquisition method fixes it. |
| **Description quality varies** | Most results carry the full description; some carry a truncated one. Keyword matching degrades gracefully rather than failing. |
| **A vendor dependency** | If SerpApi has an outage, discovery finds nothing that cycle. Mitigated by the provider being one swappable module (§4) and by manual entry and CSV import staying first-class. |

### Provider choice

**Default: SerpApi (`serpapi.com`), `engine=google_jobs`.** It is the
best-documented Google Jobs endpoint, and the response shape below is its
documented contract.

You said you would supply the API details afterwards. Nothing here is blocked
on that: the key is read from `.env` at run time, and a run with no key
configured **completes cleanly with a note** rather than erroring. If the
details you supply turn out to be a different vendor (SearchApi, Bright Data,
Serper, or Google's own Cloud Talent Solution), the swap is confined to
`connectors/serpapi.js` — the adapter, orchestrator, schema and UI do not
change. §4 exists to make that true.

---

## 3. The provider contract

### Request

```
GET https://serpapi.com/search.json
      ?engine=google_jobs
      &q={search terms}
      &location={city or region}
      &gl=us&hl=en
      &api_key={SERPAPI_KEY}
      [&next_page_token={token}]
```

`start` (offset pagination) **has been discontinued by Google** and is not
used. Pages are walked with `next_page_token`, taken from
`serpapi_pagination.next_page_token`, ten results per page.

### Response, and what we take from it

```jsonc
{
  "jobs_results": [{
    "title":        "Senior React Developer",
    "company_name": "Globex",
    "location":     "  Dallas, TX   ",     // padded; trimmed on read
    "via":          "via LinkedIn",        // → PORTAL
    "description":  "…full text…",         // → keyword matching
    "job_id":       "eyJqb2JfdGl0bGUi…",   // → provider_job_id
    "share_link":   "https://www.google.com/search?…",
    "extensions":   ["3 days ago", "Full-time", "$60–$75 an hour"],
    "detected_extensions": {
      "posted_at":      "3 days ago",      // → posted_at (resolved to a date)
      "schedule_type":  "Full-time",       // → work_type
      "work_from_home": true,              // → is_remote
      "salary":         "$60–$75 an hour"  // → pay_min / pay_max / pay_unit
    },
    "apply_options": [                     // → source_url, portal confirmation
      { "title": "LinkedIn", "link": "https://www.linkedin.com/jobs/view/…" },
      { "title": "Indeed",   "link": "…" }
    ],
    "job_highlights": [{ "title": "Qualifications", "items": ["…"] }]
  }],
  "serpapi_pagination": { "next_page_token": "…" }
}
```

### Field mapping to the existing posting shape

The common shape is **unchanged from v1**, which is why nothing downstream
moves:

| Posting field | Source | Notes |
|---|---|---|
| `company` | `company_name` | Half the R-15 fingerprint — missing ⇒ quarantine |
| `title` | `title` | The other half — missing ⇒ quarantine |
| `locationText` | `location`, trimmed | `"Anywhere"` when `work_from_home` and no location |
| `isRemote` | `detected_extensions.work_from_home`, else a text test | |
| `description` | `description` + `job_highlights` flattened | Highlights appended so qualifications are keyword-matchable |
| `sourceUrl` | best `apply_options[].link`, else `share_link` | **Prefers the link matching the detected portal** |
| `workType` | `detected_extensions.schedule_type` | Full-time → `FULL_TIME`, Contractor → `CONTRACT`, … |
| `payMin/Max/Unit` | `detected_extensions.salary`, else scanned from `extensions` | **Both an amount and a unit, or nothing** — see §5.2 |
| `postedAt` | `detected_extensions.posted_at` | `"3 days ago"` resolved against run time |
| `providerJobId` | `job_id` | Stable handle for re-fetching detail later |
| *source* | `via`, corroborated by `apply_options` | Which board listed it — §5.1 |
| *portal type* | host of the chosen apply link | Which system you apply **through** — §5.1 |

---

## 4. What is deleted, what is added, what is untouched

### Deleted

| File | Lines | Why it goes |
|---|---|---|
| `connectors/http.js` | ~275 | robots.txt engine, per-host throttling, backoff, bot User-Agent. All of it existed to crawl politely. Nothing crawls. |
| `connectors/boards.js` | ~560 | Five board definitions, two-pass crawler, sitemap resolver, block-page detection. |
| `connectors/jsonld.js` | ~245 | `schema.org/JobPosting` extraction from HTML. No HTML is fetched. |
| `connectors/feed.js` | ~135 | RSS/Atom parsing for CrunchBoard's feed. |

Roughly **1,200 lines removed.** Also gone: `SCRAPER_CONTACT` and
`SCRAPER_USER_AGENT` from `.env`, and the `respect_robots` / `search_template`
columns.

> `plain()` — the HTML-to-text helper in `jsonld.js` — is the one thing worth
> keeping; SerpApi descriptions occasionally contain markup. It moves to
> `connectors/text.js`.

### Added

| File | Purpose |
|---|---|
| `connectors/serpapi.js` | **The only file that talks to the network.** Builds the request, paginates, retries 429/5xx with backoff, enforces a per-run call ceiling, redacts the API key from anything stored. Never throws. |
| `connectors/googleJobs.js` | Pure adapter: one `jobs_results` entry → the common posting shape + portal. No I/O, fully unit-testable. |
| `connectors/text.js` | `plain()`, rescued from `jsonld.js`. |

The split is the point. `serpapi.js` is the vendor-shaped half and the only
thing a provider swap touches; `googleJobs.js` is the Google-Jobs-shaped half
and would survive a change of vendor selling the same index.

### Untouched

`config/fingerprint.js`, `config/jobMatcher.js`, `config/discoverySchedule.js`,
every queue table, the state machine, the cap logic, `postingController.js`'s
read side, `ConsultantQueue.jsx`. **The half of Phase 5 that worked is not
being re-litigated.**

---

## 5. Design decisions

### 5.1 Everything is kept. The five boards are the priority set, not a filter.

**This is the decision that shapes the whole phase.** A job is a job. If Google
surfaces a strong role from Indeed, a Greenhouse board or an employer's own
careers page, that is a real lead for a real consultant, and discarding it to
honour a list of five would be the tail wagging the dog.

So the five named boards are the **priority set** — the coverage we make sure
we have — and everything else Google returns flows through the same pipeline
and lands in the same queue.

`lkp_job_sources` keeps one row per board, with new meanings the migration
states explicitly rather than letting old values carry silently:

| `fetch_mode` | Meaning | Rows | Ships |
|---|---|---|---|
| `PROVIDER` | The thing actually fetched. Carries provider health and the credit budget. | `GOOGLE_JOBS` | **disabled** |
| `PORTAL` | Attribution + an accept/reject switch. Never fetched. | the five (flagged `is_priority`), plus Indeed, Glassdoor, ZipRecruiter, Dice, Monster, SimplyHired, Talent.com, Jooble, CareerBuilder, Snagajob, Greenhouse, Lever, and `OTHER` | **enabled** |
| `MANUAL` / `CSV` | Unchanged. Never fetched. | as before | n/a |

`is_priority` drives ordering and a star on the discovery screen — nothing else.
It is presentation, not policy, so the five stay visibly first without the
engine treating them specially.

#### Two different questions, two different fields

Conflating these was the mistake worth avoiding:

| Field | Question | Read from | Example |
|---|---|---|---|
| **source** | Which board *listed* this job? | Google's `via` line | `LINKEDIN` |
| **portal type** | Which system do you *apply through*? | the apply link's host | `GREENHOUSE` |

They are frequently different, and both are already columns on `job_postings`
(`first_source_id`, `portal_type_id`). The first answers "where did this come
from" and makes per-board yield measurable (spec item 16). The second is what
the form-filling phase will need — a Workday form and a Greenhouse form share
nothing — and it is recorded now because recovering it later would mean
re-fetching every posting.

Source detection reads `via` first, then falls back to the apply link's host.
`via` is a display string and Google renders it inconsistently (`"via
LinkedIn"`, `"via Linkedin Jobs"`, `"via Built In"`, `"via BuiltIn Chicago"`),
so the host is the steadier corroborating signal. Portal type reads the host
only, and falls back to `COMPANY_SITE` rather than `OTHER` — an apply link on a
host that is neither a known board nor a known ATS is, overwhelmingly, the
employer's own careers page.

Unrecognised attribution never causes a drop on either axis.

#### The switches still exist

A disabled portal filters at ingest, before the posting is written, and the run
counts what it rejected (`filtered_by_portal`) so that "we found nothing" and
"you filtered everything out" are never the same number. That is there for the
operator who wants it — **it is not the default.**

> **Migration note.** The migration sets `is_enabled = TRUE` on every portal
> row. Under v1 the flag meant "crawl this site", and shipping it off was right
> — the first outbound request should be somebody's decision. Under v2 it means
> "keep postings attributed to this board", which contacts nobody, and carrying
> the old value forward would leave every board silently discarding its own
> postings. The switch that still gates **all** outbound traffic and all
> spending is the `GOOGLE_JOBS` row, and that one is seeded disabled.

### 5.2 Pay is parsed strictly, or not at all

Google states salary as prose: `"$120K–$150K a year"`, `"$60–$75 an hour"`,
`"$95,000 a year"`, `"Up to $180K a year"`.

The parser returns a value **only when it recovers both an amount and a unit.**
This is the same rule v1 applied to JSON-LD, and it exists because the
minimum-pay filter compares numbers: an hourly rate silently compared against
an annual floor drops every good contract role on the board. A `null` costs one
scoring signal; a wrong unit costs the consultant real jobs, invisibly.

`K` suffixes expand. A single figure becomes both min and max. `"Up to"` sets
max only.

### 5.3 Search terms still come from the consultants

Unchanged from v1, and now load-bearing in a way it was not: **every search
term costs a credit.** Terms are the consultants' own job titles, ranked by how
many consultants want each, de-duplicated, and capped (default 6). A term
nobody's criteria contain is never bought.

Location is derived the same way, with `Remote` when the bench wants remote.

### 5.4 Raw payloads are still retained — with the key stripped

`job_source_payloads` keeps every API response, exactly as v1 kept every HTML
page, and for the same reason: an adapter bug found next month can be replayed
over retained history instead of losing the postings that arrived while it was
wrong.

One addition. The request URL contains `api_key`, and that URL is written to
the database. **The key is redacted to `api_key=***` before storage.** A
credential in a table that operators can read through the UI is a credential
that has leaked.

### 5.5 A missing key is a note, not a crash

If `SERPAPI_KEY` is absent, the run starts, records
`"Search provider is not configured — set SERPAPI_KEY"`, finishes cleanly, and
still runs the **matching half** over postings already in the pool. Matching
existing postings against changed criteria is useful work that does not need
the network, and a run that half-works and says so beats a stack trace.

### 5.6 The cost ceiling is enforced in code, not just configured

`max_pages` on the provider row bounds pages per query, and a hard per-run call
ceiling bounds the run overall. A misconfiguration — fifty search terms, ten
pages each — cannot quietly spend a month's credits in one cycle. The run
records `provider_calls` so spend is visible per run rather than discovered on
an invoice.

---

## 6. Configuration

```dotenv
# ── Job discovery (Phase 5) ───────────────────────────────
DISCOVERY_ENABLED=false          # the 4-hour cycle; off unless exactly "true"

# ── Search provider — SerpApi Google Jobs ─────────────────
SERPAPI_KEY=                     # empty ⇒ discovery runs, finds nothing, says so
SERPAPI_BASE_URL=https://serpapi.com/search.json
SERPAPI_TIMEOUT_MS=20000

DISCOVERY_GL=us                  # country
DISCOVERY_HL=en                  # language
DISCOVERY_MAX_QUERIES=6          # search terms per run   ─┐ credits per run =
DISCOVERY_MAX_PAGES=2            # pages per term (10/pg) ─┘ queries × pages
DISCOVERY_MAX_CALLS_PER_RUN=20   # hard ceiling, whatever the above say
```

Per-portal and per-provider settings that an operator should be able to change
at 2am stay in `lkp_job_sources` — a row update, never a redeploy.

---

## 7. Schema changes

One migration, `026_serpapi_provider.sql`. Small, because the data model was
never the problem.

```sql
-- lkp_job_sources: crawl config out, provider semantics in
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS respect_robots;
ALTER TABLE lkp_job_sources DROP COLUMN IF EXISTS search_template;
ALTER TABLE lkp_job_sources ADD COLUMN is_priority BOOLEAN NOT NULL DEFAULT FALSE;
-- fetch_mode gains PROVIDER and PORTAL, loses HTTP
-- rate_limit_ms  → pacing between API calls   (still meaningful)
-- max_pages      → result pages per query     (still meaningful)
UPDATE lkp_job_sources SET is_enabled = TRUE WHERE fetch_mode = 'PORTAL';

-- job_postings: the provider's stable handle for a posting
ALTER TABLE job_postings ADD COLUMN provider_job_id VARCHAR(512);

-- discovery_runs: counters that match what a run now does
ALTER TABLE discovery_runs RENAME COLUMN sources_attempted TO queries_sent;
ALTER TABLE discovery_runs RENAME COLUMN sources_failed    TO queries_failed;
ALTER TABLE discovery_runs ADD COLUMN provider_calls     INT NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN filtered_by_portal INT NOT NULL DEFAULT 0;
```

`sources_attempted` counted boards crawled, which is now always one. The rename
is not cosmetic: leaving a column named "sources" holding a query count is how
a dashboard ends up lying eighteen months from now.

---

## 8. Endpoints

No route is added or removed. Two change shape:

```
GET   /api/management/discovery/sources     + a `provider` block:
                                              { configured, label, lastSuccessAt,
                                                lastError, consecutiveFailures }
PATCH /api/management/discovery/sources/:id   accepts maxPages for the provider
                                              row; isEnabled for portal rows.
                                              Rejects enabling MANUAL / CSV as before.
POST  /api/management/discovery/run           unchanged contract, new engine
```

---

## 9. Screens

`/management/discovery` is reworked; nothing else moves.

| Was | Becomes |
|---|---|
| "Job boards" table with a **Pace** column (`5s gap · 2 pages`) | A **Search provider** card — key present or not, on/off, last success, last error, search terms, pages, and the credit cost of a run — sitting above the boards table |
| One flat board list | **Job boards**, priority five starred and listed first, each showing *Accepting yes/no* and the number of postings actually attributed to it |
| Stage counters `Fetched → Parsed → Quarantined → …` | `API calls → Results → Board-filtered → Quarantined → New → Repeat → …` |
| "Run discovery now?" — *"makes real requests to those boards, deliberately slow"* | *"sends up to N searches to Google Jobs"*, with the credit cost called out |
| Empty state — *"nothing reaches out to the internet until you turn a board on"* | *"no API key — add `SERPAPI_KEY`"*, and separately a warning only if **every** board has been switched off |

The **Run discovery now** button is disabled unless the provider is both
configured and switched on, so the run that cannot possibly work is not offered.

The `SchedulePanel`, the queue tab and the audit panel are unchanged.

---

## 10. Manual test gate

Replaces v1's §10 board-connector table. Everything below the provider section
is carried over verbatim, because those behaviours are unchanged and their
tests still apply.

### The provider
| # | Do | Expect |
|---|---|---|
| A | Run with `SERPAPI_KEY` unset | Run **completes**, note says the provider is unconfigured, matching still runs over existing postings, no crash |
| B | Run with a valid key | Postings arrive with company, title, location, apply URL |
| C | Inspect `job_source_payloads.request_url` | `api_key=***` — **the real key appears nowhere** |
| D | Set an invalid key | Run completes, provider marked failing, error recorded, other stages unaffected |
| E | Set `DISCOVERY_MAX_CALLS_PER_RUN=1` | Exactly one API call, run notes that the ceiling stopped it |
| F | Check `provider_calls` on the run | Matches the number of pages actually fetched |
| G | Force a 429 | Backed off and retried, then recorded as a failure rather than hammered |
| H | Provider times out | Run completes; failure recorded against the provider row |

### Attribution — and that nothing is thrown away
| # | Do | Expect |
|---|---|---|
| I | A result with `via: "via LinkedIn"` | Source `LINKEDIN`, and the stored URL is the **LinkedIn** apply link, not the first one listed |
| J | A result with `via: "via BuiltIn Chicago"` | Source `BUILTIN` — the per-city variant is recognised |
| K | A result from a board on no list at all | Source `OTHER`, **kept and queued** like any other |
| L | A result from Indeed / Dice / a Greenhouse board | Kept, attributed to its own row, counted against it |
| M | `via: LinkedIn` but the apply link is Greenhouse | Source `LINKEDIN` **and** portal type `GREENHOUSE` — the two fields do not collapse |
| N | An apply link on `careers.acme.com` | Portal type `COMPANY_SITE`, not `OTHER` |
| O | A result missing `company_name` | **Quarantined** with its raw fragment — never stored, never silently dropped |
| P | A result with no `apply_options` | Falls back to `share_link`; posting still usable |
| Q | Open the discovery screen | The five named boards are starred and listed first; the rest follow |
| R | Switch the Built In board off, re-run | Its postings are **rejected at ingest**; `filtered_by_portal` counts them |
| S | Switch every board off | Run completes, queues nothing, and the screen says every board is off |

### Pay parsing
| # | Do | Expect |
|---|---|---|
| T | `"$120K–$150K a year"` | 120000 / 150000 / `ANNUAL` |
| U | `"$60–$75 an hour"` | 60 / 75 / `HOURLY` |
| V | `"$95,000 a year"` | 95000 / 95000 / `ANNUAL` |
| W | `"Up to $180K a year"` | null / 180000 / `ANNUAL` — a ceiling, not a range |
| X | `"Competitive salary"` | **null** — not guessed |
| Y | `"$150,000"` with no period | **null** — an amount without a unit is discarded |
| Z | `"$120,000 - $150,000 a year plus 401k matching"` | 120000 / 150000 — the `401k` cannot inflate the maximum |

### De-duplication (R-15) — unchanged from v1
| # | Do | Expect |
|---|---|---|
| 1 | The same posting returned by two search terms | **One** posting row, two sightings, `last_seen` updated |
| 2 | Change only the location | Treated as a **distinct** posting |
| 3 | Same job, different punctuation and casing | Matched as the same posting |
| 4 | The same job surfaced via LinkedIn and via Built In | **One** posting, two sightings, both portals visible |

### Matching, caps, overlap, state machine, permissions, lifecycle

Carried over unchanged from the v1 proposal — tests 5–13 (matching and caps),
14–16 (overlap and R-03 reassignment), 17–20 (state machine), 28–33
(permissions), 38–39 (lifecycle). None of that code is being modified, and the
tests remain the gate on it.

---

## 11. Rough shape

| Area | Estimate |
|---|---|
| Migrations | 1 (`026`) |
| Deleted | 4 connector files, ~1,200 lines |
| Added | 3 connector files, ~400 lines |
| Modified | `discoveryController.js` (acquisition half), `postingController.js` (source patch), `005_job_sources_seed.js`, `JobDiscovery.jsx`, `.env.example` |
| Endpoints | 0 new, 2 reshaped |
| Tests | `discovery.test.mjs` — JSON-LD and board-definition sections replaced by adapter and pay-parser coverage; fingerprint and matching sections kept as-is |

Net **smaller** than what it replaces, which is the strongest evidence that the
v1 design was fighting the problem rather than solving it.

---

## 12. Open questions for you

1. **The API details you mentioned.** Vendor, key, and plan tier. The tier sets
   the credit budget, which sets `DISCOVERY_MAX_PAGES` and the cycle interval.
   Nothing is blocked until you have it — the code ships working and idle.
2. **Everything is kept by default**, per your instruction — the five named
   boards are starred as the priority set, and Indeed, Glassdoor, Dice,
   Greenhouse boards and employers' own careers pages all flow into the same
   queue. The per-board switches exist if you ever want to narrow it; none of
   them start off.
3. **TheLadders and CrunchBoard are thin in Google's index.** Keeping them
   costs nothing. Worth knowing they will stay quiet, so their silence is not
   read later as a bug — the volume will come from LinkedIn, Built In, Indeed
   and Dice.
4. **Cycle interval.** `discoverySchedule.js` is set to 4 hours (6 runs/day). At
   6 terms × 2 pages that is ~72 credits/day, ~2,200/month. If the plan is
   smaller, the interval is the first dial to turn.
