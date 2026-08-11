# SmartApply — Complete System Workflow

**What this document is.** A single, plain-language map of the whole system:
what each part does, who touches it, how the pieces connect, and what is built
versus still to come. Every diagram below renders in GitHub, GitLab and most
Markdown viewers.

**Read §1 and §2 first.** They give you the shape of the whole thing in two
diagrams. Everything after that is detail on one part.

---

## Table of contents

| § | Section |
|---|---|
| 1 | [What the system does, in one picture](#1-what-the-system-does-in-one-picture) |
| 2 | [The end-to-end journey](#2-the-end-to-end-journey) |
| 3 | [Who uses it](#3-who-uses-it) |
| 4 | [Phase 1 — Accounts, roles and tenant isolation](#4-phase-1--accounts-roles-and-tenant-isolation) |
| 5 | [Phase 2 — Consultant profiles and approvals](#5-phase-2--consultant-profiles-and-approvals) |
| 6 | [Phase 3 — Search criteria](#6-phase-3--search-criteria) |
| 7 | [Phase 4 — The answer bank](#7-phase-4--the-answer-bank) |
| 8 | [Phase 5 — Job discovery, matching and the queue](#8-phase-5--job-discovery-matching-and-the-queue) |
| 9 | [The queue state machine](#9-the-queue-state-machine) |
| 10 | [What comes next](#10-what-comes-next) |
| 11 | [The security model](#11-the-security-model) |
| 12 | [The data model](#12-the-data-model) |
| 13 | [Build status](#13-build-status) |

---

## 1. What the system does, in one picture

A staffing firm represents consultants. Each consultant wants a particular kind
of job. The system finds those jobs, works out who each one suits, and queues
them for application under that consultant's own name — keeping a permanent
record of exactly what was sent, to whom, and why.

```mermaid
flowchart TB
    subgraph SETUP["SET UP ONCE PER CONSULTANT"]
        direction LR
        P1["<b>Accounts &amp; roles</b><br/>who may see what"]
        P2["<b>Profile</b><br/>who they are"]
        P3["<b>Search criteria</b><br/>what they want"]
        P4["<b>Answer bank</b><br/>how they answer forms"]
    end

    subgraph ENGINE["RUNS EVERY 4 HOURS, OR ON DEMAND"]
        direction TB
        D1["<b>Find jobs</b><br/>Google Jobs via search API"]
        D2["<b>De-duplicate</b><br/>one row per real job"]
        D3["<b>Match</b><br/>score against each consultant"]
        D4["<b>Queue</b><br/>respecting the daily cap"]
        D1 --> D2 --> D3 --> D4
    end

    subgraph OUTPUT["THE RESULT"]
        direction LR
        Q["<b>Per-consultant queue</b><br/>jobs worth applying to"]
        R["<b>Application record</b><br/>permanent evidence trail"]
    end

    P2 --> D3
    P3 --> D3
    P3 --> D1
    P4 --> D4
    SETUP --> ENGINE
    D4 --> Q
    Q --> R

    style SETUP fill:#eef2ff,stroke:#6366f1
    style ENGINE fill:#ecfdf5,stroke:#10b981
    style OUTPUT fill:#fff7ed,stroke:#f59e0b
```

**The one-sentence version:** four things are set up per consultant, an engine
runs on a schedule, and the output is a queue of relevant jobs plus a permanent
record of every application made.

---

## 2. The end-to-end journey

One consultant, from the day they are added to the day an application is
recorded. Colour tells you what exists today.

```mermaid
flowchart TD
    A["Admin creates the consultant<br/><i>account + empty profile</i>"] --> B["Consultant fills in their profile"]
    B --> C{"Reviewer checks<br/>each field"}
    C -->|"Rejected with a note"| B
    C -->|"Approved"| D["Profile values go <b>live</b><br/><i>only now usable for matching</i>"]

    D --> E["Recruiter sets the search criteria<br/><i>titles, keywords, locations, pay floor</i>"]
    E --> F["Recruiter activates discovery"]

    D --> G["Consultant answers standard questions"]
    G --> H{"Reviewer checks<br/><i>salary &amp; work-auth go to admin only</i>"}
    H -->|"Rejected"| G
    H -->|"Approved"| I["Answer enters the bank<br/><i>only now usable to fill a form</i>"]

    F --> J["<b>Discovery run</b><br/>searches Google Jobs"]
    J --> K["Jobs de-duplicated<br/>and scored per consultant"]
    K --> L{"Under the<br/>daily cap?"}
    L -->|"No"| M["<b>Held</b> for the next run<br/><i>never discarded</i>"]
    M --> L
    L -->|"Yes"| N["Job enters the consultant's <b>queue</b>"]

    N --> O["Resume tailored to the job"]
    I --> P
    O --> P["Application form filled"]
    P --> Q{"A question with<br/>no approved answer?"}
    Q -->|"Yes"| R["<b>Parked</b> until it is answered"]
    R --> G
    Q -->|"No"| S["Consultant reviews and submits"]
    S --> T["<b>Application record</b> written<br/><i>permanent, never editable</i>"]

    classDef built fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef planned fill:#f1f5f9,stroke:#94a3b8,color:#475569,stroke-dasharray: 5 3
    class A,B,C,D,E,F,G,H,I,J,K,L,M,N built
    class O,P,Q,R,S,T planned
```

> **Green** = built and working today.
> **Grey dashed** = designed, not yet built. See [§10](#10-what-comes-next).

The three approval gates are the spine of the product. Nothing about a
consultant is used to represent them until a human has approved it:

| Gate | What it protects |
|---|---|
| Profile approval | No unverified personal detail reaches an employer |
| Criteria activation | No job search runs until a recruiter says the criteria are right |
| Answer approval | No form is filled with an unapproved answer — salary and work authorisation go to an admin, never a recruiter |

---

## 3. Who uses it

Four roles, three separate portals.

```mermaid
flowchart LR
    subgraph SA["SUPER ADMIN"]
        SA1["Creates organisations<br/>Creates their first admin"]
        SA2["<b>Cannot see any</b><br/><b>tenant data at all</b>"]
    end

    subgraph MG["MANAGEMENT PORTAL"]
        direction TB
        OA["<b>Org Admin</b><br/>Everything in their firm<br/>Triggers discovery runs<br/>Approves salary &amp; work-auth answers<br/>Hires, suspends, terminates"]
        RC["<b>Recruiter</b><br/><b>Only their assigned consultants</b><br/>Sets search criteria<br/>Approves general answers<br/>Manages queues"]
    end

    subgraph CP["CONSULTANT PORTAL"]
        CN["<b>Consultant</b><br/>Own profile — edit, submit for approval<br/>Own criteria — <b>read-only</b><br/>Own answers — write, then wait<br/>Own queue — <b>read-only</b>"]
    end

    SA -.->|"creates"| MG
    OA -->|"assigns consultants to"| RC
    RC -->|"represents"| CN

    style SA fill:#fef2f2,stroke:#dc2626
    style MG fill:#eff6ff,stroke:#2563eb
    style CP fill:#f0fdf4,stroke:#16a34a
```

**Two rules that are enforced by absence, not by a permission check:**

- **A consultant can never edit their own search criteria.** There is no such
  screen and no such API route.
- **A queued job can never be moved to a different consultant.** No endpoint
  exists to do it. Each person applies under their own name.

---

## 4. Phase 1 — Accounts, roles and tenant isolation

Two staffing firms use the same installation and must never see each other's
data. This is the foundation everything else sits on.

```mermaid
sequenceDiagram
    participant U as User
    participant F as Browser
    participant G as Route guard
    participant Q as Database query
    participant DB as PostgreSQL

    U->>F: Log in
    F->>G: Email + password
    G->>DB: Verify, check account is active
    DB-->>G: User + role + organisation
    G-->>F: Signed JWT in an httpOnly cookie

    Note over F,G: The organisation is inside the signed token.<br/>It is never read from the URL or the request body.

    U->>F: Open a page
    F->>G: Request with the cookie
    G->>G: Layer 1 — is this role allowed here?
    G->>Q: Layer 2 — scope every query to the organisation in the token
    Q->>DB: Scoped query
    DB-->>U: Only this firm's data
```

Every account action is written to an append-only audit log: who did it, when,
from what IP, and what changed. The application's own database user has no
permission to modify or delete those rows.

---

## 5. Phase 2 — Consultant profiles and approvals

The consultant maintains their own details, but nothing they type goes live
until a reviewer approves it — field by field.

```mermaid
flowchart LR
    A["Consultant edits<br/>their profile"] --> B["Submits for approval"]
    B --> C["<b>Only the changed fields</b><br/>become a request"]

    C --> D["Live values stay<br/><b>completely untouched</b>"]

    C --> E{"Reviewer opens<br/>the Approvals tab"}
    E -->|"Approve this field"| F["That field goes live"]
    E -->|"Reject this field"| G["Note is <b>mandatory</b>"]
    G --> H["Consultant sees the note"]
    H --> A
    F --> I["Live profile<br/><i>used for matching</i>"]

    style D fill:#fef9c3,stroke:#ca8a04
    style I fill:#dcfce7,stroke:#16a34a
```

**Why field-by-field?** A consultant who updates five things and gets one wrong
should not have the other four blocked. Each field is judged on its own.

**The employment lifecycle** runs alongside it, and it is deliberately
asymmetric:

```mermaid
stateDiagram-v2
    [*] --> ACTIVE: Account created
    ACTIVE --> SUSPENDED: Suspend
    SUSPENDED --> ACTIVE: Reinstate
    ACTIVE --> TERMINATED: Terminate
    SUSPENDED --> TERMINATED: Terminate
    TERMINATED --> [*]

    note right of SUSPENDED
        Reversible.
        Session revoked immediately.
        Queue is held, not cancelled.
    end note

    note right of TERMINATED
        Permanent — no way back.
        Criteria deactivated.
        Queue cancelled.
        Application records KEPT.
    end note
```

Suspending is reversible; terminating is not. In both cases the person's live
session is killed on the next request — a disabled account cannot keep working
because it already had a valid token.

---

## 6. Phase 3 — Search criteria

What kind of job this consultant wants. Owned by the recruiter, visible to the
consultant, editable by neither without a trace.

```mermaid
flowchart TD
    A["Recruiter opens the<br/>Search Criteria tab"] --> B["Fills in:<br/>job titles in priority order<br/>keywords to include / exclude<br/>locations + remote or on-site<br/>work types<br/>minimum pay<br/>companies to never apply to"]
    B --> C["Save"]
    C --> D["<b>Version 1</b> — a frozen snapshot"]
    D --> E{"Activate<br/>discovery?"}
    E -->|"No"| F["Paused — this consultant<br/>is skipped entirely by every run"]
    E -->|"Yes"| G["Live — the engine now<br/>searches on their behalf"]

    G --> H["Later edit"]
    H --> I["<b>Version 2</b><br/>v1 still readable, diffable, restorable"]

    G -.->|"read-only"| J["Consultant can see it<br/>but never change it"]

    style D fill:#e0e7ff,stroke:#4f46e5
    style I fill:#e0e7ff,stroke:#4f46e5
    style J fill:#f0fdf4,stroke:#16a34a
```

**Why freeze every version?** Because six months from now, someone will ask
"why was this job sent to this person?" Each queued job stores the exact
criteria version that matched it — a snapshot that still exists word for word,
not whatever the criteria happen to say today.

---

## 7. Phase 4 — The answer bank

Application forms ask the same questions over and over. The consultant answers
them once; a reviewer approves; the approved answer is then available to fill
any form.

```mermaid
flowchart TD
    A["A question exists<br/><i>standard set, raised by a recruiter,<br/>or asked by a real form</i>"] --> B["Consultant answers it"]
    B --> C["<b>PENDING</b><br/>never used to fill anything"]

    C --> D{"Routed by<br/><b>category</b>"}
    D -->|"General"| E["The assigned recruiter"]
    D -->|"<b>Salary</b>"| F["<b>Org Admin only</b>"]
    D -->|"<b>Work authorisation</b>"| F
    D -->|"Uncategorised"| F

    E --> G{"Reviewer decides"}
    F --> G
    G -->|"Approve as-is"| H["<b>APPROVED</b><br/>enters the bank"]
    G -->|"Correct, then approve"| I["Edit recorded as the reviewer's<br/><b>original text kept</b>"]
    I --> H
    G -->|"Reject"| J["Note is <b>mandatory</b>"]
    J --> B

    H --> K["Available to fill forms"]

    style F fill:#fef2f2,stroke:#dc2626
    style H fill:#dcfce7,stroke:#16a34a
    style C fill:#fef9c3,stroke:#ca8a04
```

**Why do salary and work-authorisation answers skip the recruiter?** They are
the two answers with legal and commercial consequences. A recruiter who could
quietly adjust a stated salary expectation or a visa status is a risk the
design removes rather than monitors. Anything uncategorised also goes to the
admin — the safe default.

---

## 8. Phase 5 — Job discovery, matching and the queue

This is the engine. It was rebuilt: the original design crawled five job boards
directly, and four of them block automated access outright. It now reads
**Google's index of those same boards** through a paid search API.

### 8.1 Why the change

```mermaid
flowchart TB
    subgraph OLD["ORIGINAL DESIGN — five crawlers"]
        direction LR
        O1["LinkedIn<br/><b>blocked</b><br/>site-wide robots.txt"]
        O2["Wellfound<br/><b>blocked</b><br/>Cloudflare 403"]
        O3["Built In<br/>partial"]
        O4["TheLadders<br/><b>blocked</b><br/>Cloudflare 403"]
        O5["CrunchBoard<br/>RSS trickle"]
    end

    subgraph NEW["CURRENT DESIGN — one provider"]
        direction TB
        N1["<b>Google Jobs</b><br/>via search API"]
        N2["Google already indexes<br/><b>all five boards</b><br/>plus Indeed, Glassdoor, Dice,<br/>Greenhouse, company sites"]
        N1 --- N2
    end

    OLD -->|"replaced by"| NEW

    style OLD fill:#fef2f2,stroke:#dc2626
    style NEW fill:#dcfce7,stroke:#16a34a
```

| | Old | New |
|---|---|---|
| Boards actually reachable | 2 of 5, partially | All 5, plus many more |
| Legal position | Against every board's terms | A paying customer of a documented API |
| Parsers to maintain | 5 HTML parsers + sitemap + RSS + robots engine | 1 JSON contract |
| Risk | Account bans, arms race with bot detection | A metered bill |
| Code | ~1,200 lines | ~400 lines |

**Everything the API returns is kept.** The five named boards are the
*priority set* — the coverage we guarantee — not a filter. A strong role from
Indeed or an employer's own careers page is a real lead and goes into the same
queue.

### 8.2 The discovery pipeline

```mermaid
flowchart TD
    A["<b>Run starts</b><br/>every 4 hours, or on demand"] --> B{"Another run<br/>in progress?"}
    B -->|"Yes"| B1["<b>Refused</b> — two runs never overlap"]
    B -->|"No"| C["Collect job titles from every<br/>active consultant's criteria"]

    C --> D["Rank by how many consultants<br/>want each title, cap the list<br/><i>every search term costs money</i>"]
    D --> E["<b>Search Google Jobs</b><br/>page by page, within a hard call ceiling"]

    E --> F["<b>Store the raw response</b><br/><i>API key stripped out first</i>"]
    F --> G{"Can each result<br/>be read?"}
    G -->|"No"| G1["<b>Quarantined</b> with the raw data<br/><i>never silently dropped</i>"]
    G -->|"Yes"| H["Work out two things:<br/><b>which board listed it</b><br/><b>which system you apply through</b>"]

    H --> I{"Is that board<br/>switched on?"}
    I -->|"No"| I1["Rejected, and <b>counted</b><br/><i>so low volume is explainable</i>"]
    I -->|"Yes"| J["<b>Fingerprint</b><br/>company + title + location"]

    J --> K{"Seen this<br/>job before?"}
    K -->|"Yes"| K1["Record another sighting<br/>update 'last seen'<br/><b>no second row</b>"]
    K -->|"No"| K2["New posting stored"]

    K1 --> L["<b>MATCHING</b>"]
    K2 --> L

    L --> M{"Company on their<br/>excluded list?"}
    M -->|"Yes"| M1["<b>Hard no</b> — however well it scores"]
    M -->|"No"| N{"Rough title and<br/>location fit?"}
    N -->|"No"| N1["Dropped cheaply<br/><i>the cheap filter runs first, by design</i>"]
    N -->|"Yes"| O["<b>Score it</b><br/>titles, keywords, work type, pay"]

    O --> P["Match stored with its score,<br/>a readable reason, and the exact<br/>criteria version that matched"]
    P --> Q{"Consultant under<br/>their daily cap?"}
    Q -->|"No"| Q1["<b>HELD</b> — reconsidered next run<br/><i>never thrown away</i>"]
    Q -->|"Yes"| R["<b>Queued</b>"]
    R --> S{"Already in another<br/>consultant's queue?"}
    S -->|"Yes"| S1["Flagged as an overlap<br/><b>allowed — never blocked</b>"]
    S -->|"No"| T["Done"]

    style B1 fill:#fef2f2,stroke:#dc2626
    style G1 fill:#fef9c3,stroke:#ca8a04
    style Q1 fill:#fef9c3,stroke:#ca8a04
    style M1 fill:#fef2f2,stroke:#dc2626
    style R fill:#dcfce7,stroke:#16a34a
```

### 8.3 The five design rules the pipeline enforces

| Rule | What it means in practice |
|---|---|
| **One row per real job** | The same job found twice becomes one posting with two sightings — never two queue items, never a duplicate application |
| **Cheap filter before expensive work** | An obvious non-match is dropped on a title comparison, not after a full scoring pass |
| **Caps hold, they do not discard** | A great job found on a busy day waits for tomorrow instead of being lost to the hour it arrived |
| **Overlap is visible, not prevented** | One job can legitimately suit three consultants; each applies under their own name and a recruiter can see the overlap |
| **Nothing fails the whole run** | A broken search, an unreadable result, a board that is switched off — each is recorded and the cycle carries on |

### 8.4 Cost control

The search API is metered: **every page of results is one credit.**

```mermaid
flowchart LR
    A["Search terms<br/><i>default 6</i>"] --> C["<b>Credits per run</b>"]
    B["Pages per term<br/><i>default 2</i>"] --> C
    C --> D["12 per run"]
    D --> E["~72 per day<br/><i>on the 4-hour cycle</i>"]
    E --> F["~2,200 per month"]

    G["<b>Hard ceiling per run</b><br/><i>default 20 calls</i>"] -.->|"caps it regardless"| C

    style G fill:#fef2f2,stroke:#dc2626
    style F fill:#fef9c3,stroke:#ca8a04
```

Three protections: a cap on search terms, a cap on pages per term, and a hard
per-run call ceiling that applies no matter what the first two are set to. Each
run records what it spent, so cost is visible on the screen rather than
discovered on an invoice.

---

## 9. The queue state machine

Once a job is queued, it moves through a fixed set of states. Illegal jumps are
refused by the server, not merely hidden in the interface.

```mermaid
stateDiagram-v2
    [*] --> QUEUED: Matched by a discovery run
    QUEUED --> FILLED: Form filled from the answer bank
    QUEUED --> SKIPPED: Skipped — reason mandatory
    FILLED --> PARKED_UNKNOWN: Form asked something with no approved answer
    PARKED_UNKNOWN --> FILLED: That answer gets approved
    FILLED --> AWAITING_SUBMIT: Ready for the consultant
    AWAITING_SUBMIT --> SUBMITTED: Consultant submits
    AWAITING_SUBMIT --> SKIPPED: Changed their mind — reason mandatory
    SKIPPED --> QUEUED: Re-queued
    SUBMITTED --> [*]: Application record written

    note right of PARKED_UNKNOWN
        This is the loop back to the answer bank.
        Approving the missing answer automatically
        releases every item waiting on it.
    end note

    note right of SUBMITTED
        The application record is permanent.
        Nobody can edit or delete it —
        not an admin, not through the database.
    end note
```

Every single move writes a row: who moved it, when, from what state to what
state, and why. That history is the answer to "what happened to this
application?"

---

## 10. What comes next

```mermaid
flowchart LR
    subgraph DONE["BUILT"]
        direction TB
        A["Accounts &amp; roles"]
        B["Profiles &amp; approvals"]
        C["Search criteria"]
        D["Answer bank"]
        E["Discovery, matching &amp; queue"]
    end

    subgraph NEXT["NEXT"]
        direction TB
        F["<b>Resume tailoring</b><br/>a version of the CV per job"]
        G["<b>Contacts</b><br/>recruiter contacts per posting<br/>plus a do-not-contact list"]
    end

    subgraph LATER["LATER"]
        direction TB
        H["<b>Consultant desktop app</b><br/>fills and submits the actual forms"]
        I["<b>Application records</b><br/>every question and answer, as sent"]
        J["Two-step verification<br/>Forgot-password email"]
    end

    DONE --> NEXT --> LATER

    style DONE fill:#dcfce7,stroke:#16a34a
    style NEXT fill:#fef9c3,stroke:#ca8a04
    style LATER fill:#f1f5f9,stroke:#94a3b8
```

### The one honest gap

Nothing yet fills or submits a form. That is the desktop app, and it is a
separate piece of work. Until it exists:

- Queue items reach **QUEUED** and stop there.
- The states beyond it are defined and enforced, but nothing drives an item
  through them.
- Application records can be entered by hand — which is what staffing firms do
  anyway when someone applies manually — and become automatic once a submitter
  exists.

This is deliberate and was flagged from the start. The queue is genuinely
useful on its own: it tells a recruiter exactly which jobs are worth this
person's time today, and why.

> **A note on numbering.** The two planning documents number the remaining
> phases differently — one has Contacts as Phase 6, the other has Resume
> Tailoring there. The scope is the same either way; only the labels differ.

---

## 11. The security model

Three independent layers. The third is convenience; the first two are the real
protection.

```mermaid
flowchart TD
    A["Request arrives"] --> B["<b>Layer 1 — Route guard</b><br/>Is this role allowed on this route at all?"]
    B -->|"No"| B1["403 Forbidden"]
    B -->|"Yes"| C["<b>Layer 2 — Tenant scoping</b><br/>Every query is filtered by the organisation<br/><b>taken from the signed token</b>"]
    C --> D{"Recruiter?"}
    D -->|"Yes"| E["Narrowed again to<br/><b>only their assigned consultants</b>"]
    D -->|"No"| F["Whole organisation"]
    E --> G["Query runs"]
    F --> G
    G --> H["<b>Layer 3 — Interface</b><br/>Menus and buttons hidden<br/><i>convenience only, never trusted</i>"]

    style C fill:#dbeafe,stroke:#2563eb
    style B fill:#dbeafe,stroke:#2563eb
    style H fill:#f1f5f9,stroke:#94a3b8
```

**The detail that matters:** the organisation is read from the signed login
token — never from the URL, the request body, or a query parameter. A user
cannot ask for another firm's data by editing a request, because the part of
the request that decides which firm they belong to is not theirs to edit.

**Append-only records.** Audit logs and application records are protected at
the database level, not just in code: the account the application connects as
has had its permission to update or delete those rows revoked. Even a
successful SQL injection could not rewrite that history.

---

## 12. The data model

The main tables and how they relate.

```mermaid
erDiagram
    ORGANIZATION ||--o{ USER : "employs"
    USER ||--o| CONSULTANT_PROFILE : "has"
    USER ||--o{ PROFILE_CHANGE_REQUEST : "submits"
    USER ||--o| SEARCH_CRITERIA : "has"
    SEARCH_CRITERIA ||--o{ CRITERIA_VERSION : "frozen snapshots"
    USER ||--o{ ANSWER : "gives"
    QUESTION ||--o{ ANSWER : "is answered by"

    JOB_SOURCE ||--o{ JOB_POSTING : "surfaced"
    JOB_POSTING ||--o{ POSTING_SIGHTING : "seen again"
    JOB_POSTING ||--o{ JOB_MATCH : "suits"
    USER ||--o{ JOB_MATCH : "matched to"
    CRITERIA_VERSION ||--o{ JOB_MATCH : "matched by"

    JOB_MATCH ||--o| QUEUE_ITEM : "promoted to"
    QUEUE_ITEM ||--o{ QUEUE_TRANSITION : "every move"
    QUEUE_ITEM ||--o| APPLICATION_RECORD : "results in"
    APPLICATION_RECORD ||--o{ APPLICATION_QA : "exact Q and A"

    DISCOVERY_RUN ||--o{ JOB_POSTING : "found"
    DISCOVERY_RUN ||--o{ SOURCE_PAYLOAD : "raw responses kept"
```

Three deliberate choices worth calling out to anyone reviewing this:

1. **A match and a queue slot are different things.** A job can suit a
   consultant without there being room for it today. Keeping them separate is
   what makes "held, not discarded" possible.
2. **Criteria versions are frozen, and each match points at one.** That is how
   "why did this person get this job?" stays answerable years later.
3. **Raw API responses are retained.** If the way we read results turns out to
   be wrong next month, the fix can be replayed over the stored history instead
   of losing everything that arrived while it was broken.

---

## 13. Build status

| Phase | Scope | Status |
|---|---|---|
| **1** | Multi-tenant accounts, 4 roles, 3 portals, audit log | ✅ Complete |
| **2** | Consultant profiles, field-by-field approval, resume upload | ✅ Complete |
| **2.1** | Employment lifecycle, session revocation, lockout | ✅ Complete |
| **3** | Search criteria, immutable versioning, pause/activate | ✅ Complete |
| **4** | Answer bank, category routing, approvals | ✅ Complete *(one admin screen deferred)* |
| **5** | Job discovery via search API, de-duplication, matching, daily caps, queue | ✅ Built — **needs an API key to go live** |
| **6** | Resume tailoring per job | ⬜ Planned |
| **7** | Contacts and do-not-contact list | ⬜ Planned |
| **later** | Consultant desktop app, automatic application records, two-step verification, password reset by email | ⬜ Planned |

### What is needed to switch Phase 5 on

1. A **search API account** and its key, added to the server configuration.
2. A decision on the **plan tier**, which sets the credit budget — that in turn
   sets how often the cycle runs and how deep each search goes.
3. Turning the provider **on** from the discovery screen. It ships switched off
   deliberately, so the first request and the first credit spent are somebody's
   decision rather than a side effect of installing the software.

Until then, discovery runs still complete: they fetch nothing, say so plainly,
and match against whatever is already in the pool.
