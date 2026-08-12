# SmartApply — Complete System Architecture

**What this document is.** The full picture of the system: what each part does,
how the parts connect, the technology each is built on, and the rules that
govern them. It covers the central hub, the web portal, the AI services, the
four-hour discovery cycle, and the consultant desktop application.

Read **§1** and **§2** first — they give the shape of the whole thing in two
diagrams. Everything after that is detail on one part.

---

## Contents

| § | Section |
|---|---|
| 1 | [The system in one picture](#1-the-system-in-one-picture) |
| 2 | [Four independent stages](#2-four-independent-stages) |
| 3 | [The end-to-end journey](#3-the-end-to-end-journey) |
| 4 | [Who uses it](#4-who-uses-it) |
| 5 | [Setting up a consultant](#5-setting-up-a-consultant) |
| 6 | [Stage 1 — Discovery, every four hours](#6-stage-1--discovery-every-four-hours) |
| 7 | [Stage 2 — AI preparation](#7-stage-2--ai-preparation) |
| 8 | [The queue: two lanes](#8-the-queue-two-lanes) |
| 9 | [Stage 3 — Application](#9-stage-3--application) |
| 10 | [The desktop application](#10-the-desktop-application) |
| 11 | [Stage 4 — The permanent record](#11-stage-4--the-permanent-record) |
| 12 | [Operating limits](#12-operating-limits) |
| 13 | [Security model](#13-security-model) |
| 14 | [Data model](#14-data-model) |
| 15 | [Technology stack](#15-technology-stack) |

---

## 1. The system in one picture

A staffing firm represents consultants. Each consultant wants a particular kind
of job. The system finds those jobs across the whole market, works out who each
one suits, prepares a tailored application, and helps the consultant submit it
under their own name — keeping a permanent record of exactly what was sent.

```mermaid
flowchart TB
    subgraph HUB["CENTRAL HUB — cloud server owned by the agency"]
        direction TB
        H1["<b>Discovery</b><br/>finds jobs across the market"] ~~~ H2["<b>Matching</b><br/>works out who each job suits"] ~~~ H3["<b>AI preparation</b><br/>tailors the resume, scores the fit"] ~~~ H4["<b>Record store</b><br/>permanent, never edited"]
    end

    subgraph PORTAL["WEB PORTAL — served by the hub"]
        direction TB
        P1["<b>Owner</b><br/>runs the firm"] ~~~ P2["<b>Recruiter</b><br/>runs their consultants"] ~~~ P3["<b>Consultant</b><br/>own profile and queue"]
    end

    subgraph APP["DESKTOP APP — on each consultant's machine"]
        direction TB
        A1["<b>Fills the forms</b><br/>using the consultant's own logins"] ~~~ A2["<b>Stops for review</b><br/>the consultant clicks submit"]
    end

    HUB -->|"jobs, resumes,<br/>approved answers"| APP
    APP -->|"outcomes and<br/>question-answer records"| HUB
    HUB <-->|"everything, by role"| PORTAL

    style HUB fill:#e8ecfa,stroke:#37418c,color:#151923
    style PORTAL fill:#e6f4ec,stroke:#17754a,color:#151923
    style APP fill:#fbf1de,stroke:#96620a,color:#151923
```

**Sensitive material flows one way.** The hub sends each consultant only the
jobs, resume files and approved answers needed for the work in front of them.
The desktop app sends back status and question-and-answer records. Consultant
machines keep no permanent data.

---

## 2. Four independent stages

This is the most important idea in the architecture. The system is **four
separate stages, each with its own trigger, its own failure behaviour, and its
own retry**. No stage can stall another.

```mermaid
flowchart LR
    S1["<b>1 · DISCOVERY</b><br/>every 4 hours<br/><br/>find jobs<br/>de-duplicate<br/>match to consultants<br/>create queue items<br/><br/><i>no AI, no browser</i>"]
    S2["<b>2 · PREPARATION</b><br/>continuous worker<br/><br/>tailor the resume<br/>score the fit<br/>gather answers<br/>mark item ready<br/><br/><i>AI only, retries safely</i>"]
    S3["<b>3 · APPLICATION</b><br/>every 4 hours<br/><br/>fill the form<br/>consultant reviews<br/>consultant submits<br/><br/><i>on the consultant's machine</i>"]
    S4["<b>4 · RECORD</b><br/>on submission<br/><br/>permanent record<br/>exact questions<br/>exact answers<br/><br/><i>append-only, forever</i>"]

    S1 -->|"queue item<br/>not yet ready"| S2
    S2 -->|"queue item<br/>ready"| S3
    S3 -->|"submitted"| S4

    style S1 fill:#e8ecfa,stroke:#37418c,color:#151923
    style S2 fill:#f3e8fa,stroke:#6b3fa0,color:#151923
    style S3 fill:#fbf1de,stroke:#96620a,color:#151923
    style S4 fill:#e6f4ec,stroke:#17754a,color:#151923
```

### Why the separation matters

| If this happens | What does **not** happen |
|---|---|
| The AI provider has an outage | Discovery keeps finding and matching jobs. Prepared items keep being applied to. |
| A search provider fails | Preparation and application carry on with everything already in the pool. |
| A consultant's laptop is off for a week | Discovery, matching and preparation continue. The work is waiting when they return. |
| Discovery takes longer than usual | Nothing else waits on it. The next cycle simply starts later. |

**The four-hour cycle never calls an AI model and never opens a browser.** It
fetches, de-duplicates, matches, and stops. Everything expensive or slow happens
in a stage that can fail and retry on its own.

---

## 3. The end-to-end journey

One consultant, from the day they join to a submitted application.

```mermaid
flowchart TD
    A["Consultant is added<br/><i>account and empty profile created</i>"] --> B["Consultant fills in their profile"]
    B --> C{"Reviewer checks<br/>each field"}
    C -->|"Rejected with a note"| B
    C -->|"Approved"| D["Profile goes <b>live</b><br/><i>only now used for matching</i>"]

    D --> E["Recruiter sets the search criteria<br/><i>titles, keywords, locations, pay floor</i>"]
    E --> F["Recruiter activates discovery"]

    D --> G["Consultant answers standard questions"]
    G --> H{"Reviewer checks<br/><i>salary and work authorisation<br/>go to the owner only</i>"}
    H -->|"Rejected"| G
    H -->|"Approved"| I["Answer enters the bank"]

    F --> J["<b>Discovery</b> finds jobs<br/>and scores them per consultant"]
    J --> K["Job enters the consultant's queue<br/><i>not yet ready</i>"]

    K --> L["<b>AI preparation</b><br/>tailors the resume, scores the fit"]
    I --> L
    L --> M["Item marked <b>ready</b>"]

    M --> N{"Which lane?"}
    N -->|"One of the 5 boards"| O["<b>Desktop app</b> fills the form"]
    N -->|"Anywhere else"| P["<b>Portal</b> shows it<br/>consultant applies directly"]

    O --> Q{"A question with<br/>no approved answer?"}
    Q -->|"Yes"| R["<b>Parked</b> until it is answered"]
    R --> G
    Q -->|"No"| S["Consultant reviews and <b>submits</b>"]
    P --> S

    S --> T["<b>Permanent record</b><br/><i>every question, every answer, the exact resume</i>"]

    style D fill:#e6f4ec,stroke:#17754a,color:#151923
    style I fill:#e6f4ec,stroke:#17754a,color:#151923
    style L fill:#f3e8fa,stroke:#6b3fa0,color:#151923
    style S fill:#fbf1de,stroke:#96620a,color:#151923
    style T fill:#e8ecfa,stroke:#37418c,color:#151923
```

### The gates

Nothing about a consultant is used to represent them until a human has approved it.

| Gate | What it protects |
|---|---|
| **Profile approval** | No unverified personal detail reaches an employer |
| **Criteria activation** | No searching happens until a recruiter confirms the criteria |
| **Answer approval** | No form is filled with an unapproved answer. Salary and work authorisation go to the owner, never a recruiter |
| **Submit** | **The consultant clicks submit on every single application.** The machine never does |

---

## 4. Who uses it

Four roles, three separate portals.

```mermaid
flowchart LR
    subgraph SA["PLATFORM"]
        direction TB
        SA1["<b>Super Admin</b><br/>creates agencies and their first owner"] ~~~ SA2["<b>Sees no agency data<br/>of any kind</b>"]
    end

    subgraph MG["MANAGEMENT PORTAL"]
        direction TB
        OA["<b>Owner</b><br/>everything in the agency<br/>sets daily caps<br/>approves salary and work-authorisation answers<br/>issues and revokes desktop app access<br/>hires, suspends, terminates"] ~~~ RC["<b>Recruiter</b><br/><b>only their assigned consultants</b><br/>sets search criteria<br/>approves general answers<br/>manages queues"]
    end

    subgraph CP["CONSULTANT PORTAL"]
        direction TB
        CN["<b>Consultant</b><br/>own profile — edit, submit for approval<br/>own criteria — read-only<br/>own answers — write, then wait<br/>own queue — view and apply"]
    end

    SA -.->|"creates"| MG
    OA -->|"assigns consultants to"| RC
    RC -->|"represents"| CN

    style SA fill:#fbeaea,stroke:#a02a32,color:#151923
    style MG fill:#e8ecfa,stroke:#37418c,color:#151923
    style CP fill:#e6f4ec,stroke:#17754a,color:#151923
```

**Two rules enforced by absence rather than by a permission check:**

- **A consultant can never edit their own search criteria.** No screen, no route.
- **A job can never be moved to a different consultant.** No endpoint exists.
  Each person applies under their own name.

---

## 5. Setting up a consultant

Four things are configured once per consultant. Everything downstream reads them.

```mermaid
flowchart LR
    A["<b>Profile</b><br/>who they are<br/><i>approved field by field</i>"] --> E["Ready for<br/>discovery"]
    B["<b>Search criteria</b><br/>what they want<br/><i>frozen as a version on every save</i>"] --> E
    C["<b>Answer bank</b><br/>how they answer forms<br/><i>two-person approval</i>"] --> E
    D["<b>Base resume</b><br/>the source of truth<br/><i>never invented from</i>"] --> E

    style E fill:#e6f4ec,stroke:#17754a,color:#151923
```

**Criteria are versioned and immutable.** Every save creates a new frozen
version; older ones stay readable, comparable and restorable. Each job that
reaches a consultant records the exact criteria version that matched it — so
"why was this job sent to this person?" is answerable years later against a
snapshot that still exists word for word.

---

## 6. Stage 1 — Discovery, every four hours

Runs on a schedule, or on demand. **It calls no AI model and opens no browser.**

```mermaid
flowchart TD
    A["<b>Cycle starts</b>"] --> B{"Another cycle<br/>still running?"}
    B -->|"Yes"| B1["<b>Refused</b> — cycles never overlap"]
    B -->|"No"| C["Collect job titles from every active<br/>consultant's live criteria"]

    C --> D["Rank by how many consultants want each,<br/>de-duplicate, cap the list"]
    D --> E["<b>Ask the search provider</b><br/>page by page, newest first"]

    E --> F["<b>Store the raw response</b><br/><i>credentials removed before storage</i>"]
    F --> G{"Readable?"}
    G -->|"No"| G1["<b>Quarantined</b> with the raw data<br/><i>never silently dropped</i>"]
    G -->|"Yes"| H["Identify <b>which board listed it</b><br/>and <b>which system you apply through</b>"]

    H --> I["<b>Fingerprint</b><br/>company + title + location"]
    I --> J{"Seen<br/>before?"}
    J -->|"Yes"| J1["Record another sighting<br/><b>no duplicate job</b>"]
    J -->|"No"| J2["New job stored"]

    J1 --> K["<b>MATCHING</b>"]
    J2 --> K

    K --> L{"Company on the<br/>excluded list?"}
    L -->|"Yes"| L1["<b>Hard no</b> — however well it scores"]
    L -->|"No"| M{"Rough title and<br/>location fit?"}
    M -->|"No"| M1["Dropped cheaply<br/><i>the cheap check runs first, by design</i>"]
    M -->|"Yes"| N["<b>Score</b> on titles, keywords,<br/>work type and pay"]

    N --> O["Match recorded with its score,<br/>a readable reason, and the exact<br/>criteria version that matched"]
    O --> P["<b>Queue item created</b><br/><i>not yet ready — see Stage 2</i>"]

    style B1 fill:#fbeaea,stroke:#a02a32,color:#151923
    style G1 fill:#fbf1de,stroke:#96620a,color:#151923
    style L1 fill:#fbeaea,stroke:#a02a32,color:#151923
    style P fill:#e8ecfa,stroke:#37418c,color:#151923
```

### Coverage: everything is ingested

The system takes **every job the provider returns** — the five named boards, the
large aggregators, applicant tracking systems, and employers' own careers pages.
A good role is a good role wherever it was listed.

Each job records two separate facts, because they are usually different:

| Recorded | Question it answers | Example |
|---|---|---|
| **Source** | Which board *listed* it | LinkedIn |
| **Portal** | Which system you *apply through* | Greenhouse |

That distinction decides which lane the job enters (§8) and is why per-board
yield stays measurable.

### The rules the cycle enforces

| Rule | In practice |
|---|---|
| **One row per real job** | The same job found twice becomes one job with two sightings — never a duplicate application |
| **Cheap check before expensive work** | An obvious non-match is dropped on a title comparison, not after full scoring |
| **Caps hold, never discard** | A strong job found on a busy day waits for tomorrow rather than being lost to the hour it arrived |
| **Overlap is visible, never blocked** | One job can suit three consultants; each applies under their own name and the overlap is flagged |
| **Nothing fails the whole cycle** | A failed search, an unreadable result, a disabled board — each is recorded and the cycle continues |

### Search providers

The provider is a swappable component. The system is built to run **one or
several** providers side by side; results from all of them pass through the same
de-duplication, so overlap between providers collapses automatically.

Because provider calls are metered, three limits bound spend: search terms per
cycle, result pages per term, and a hard ceiling on calls per cycle. Every cycle
records what it spent and what it declined to spend.

---

## 7. Stage 2 — AI preparation

A **continuous background worker**, entirely separate from the four-hour cycle.
It picks up queue items that are not yet ready, does the expensive work, and
marks them ready.

```mermaid
flowchart TD
    A["Queue item created<br/><b>not ready</b>"] --> B["<b>Preparation worker</b> picks it up"]

    B --> C["<b>Tailor the resume</b><br/>reword and reorder true content<br/>for this specific job"]
    C --> D{"<b>Fabrication check</b><br/>second pass compares the tailored<br/>resume against the base resume"}
    D -->|"Invented content found"| D1["<b>Rejected</b> — retried, then escalated.<br/>Never sent."]
    D -->|"Clean"| E["<b>Score the fit</b><br/>how well this consultant<br/>matches this posting"]

    E --> F["<b>Gather the approved answers</b><br/>likely needed for this form"]
    F --> G["Item marked <b>READY</b><br/><i>now, and only now, a daily cap slot is taken</i>"]

    B --> X{"Preparation<br/>fails?"}
    X -->|"Retry with backoff"| B
    X -->|"Still failing"| Y["Attach the <b>approved base resume</b><br/>and mark ready anyway<br/><i>a job is never lost to an outage</i>"]
    Y --> G

    style D1 fill:#fbeaea,stroke:#a02a32,color:#151923
    style G fill:#e6f4ec,stroke:#17754a,color:#151923
    style Y fill:#fbf1de,stroke:#96620a,color:#151923
```

### The no-fabrication rule

**Tailoring may reword and reorder true content. It may never invent a skill, a
tool, an employer, a date, or an accomplishment.**

This is enforced twice: in the instruction set given to the model, and by a
**second pass that compares the tailored resume against the base resume** and
rejects anything that appears in one and not the other.

The instruction set lives in hub code only. **No portal user at any level — owner
included — can view, edit or weaken it.**

### Why preparation is a separate stage

- **A model outage costs nothing.** Discovery keeps working; prepared items keep
  being applied to; unprepared items retry.
- **Cost is bounded by the daily cap**, because preparation only runs for items
  that will actually be applied to.
- **A slot is taken when an item becomes ready, not when it is queued.** A
  failed preparation therefore never consumes a consultant's day.
- **Scoring improves selection over time.** Jobs held back by the cap are scored
  too, so the next cycle fills the queue best-first using what the AI learned —
  without the four-hour cycle ever calling a model.

---

## 8. The queue: two lanes

Every job that reaches a consultant enters one of two lanes, decided
automatically by **which system you apply through**.

```mermaid
flowchart TD
    A["<b>Ready queue item</b>"] --> B{"Apply through one of<br/>the five automated boards?"}

    B -->|"Yes"| C["<b>BOT LANE</b><br/>LinkedIn · Wellfound · Built In<br/>TheLadders · CrunchBoard"]
    B -->|"No"| D["<b>HUMAN LANE</b><br/>Greenhouse · Lever · Workday<br/>company careers pages · everywhere else"]

    C --> E["Desktop app opens the job,<br/>fills the form, stops at review"]
    D --> F["Portal shows the job.<br/>Consultant opens and applies directly"]

    E --> G["<b>Consultant submits</b>"]
    F --> G
    G --> H["<b>Permanent record</b>"]

    style C fill:#fbf1de,stroke:#96620a,color:#151923
    style D fill:#e8ecfa,stroke:#37418c,color:#151923
    style H fill:#e6f4ec,stroke:#17754a,color:#151923
```

**Every job is worked either way.** The lane decides *who does the typing*, never
whether the job is pursued. Both lanes end in the same permanent record, and the
same daily cap governs both — an employer sees one person regardless of how the
form was filled.

### Queue item states

Movement between states is checked on every write. An illegal jump is refused by
the server, not merely hidden in the interface.

```mermaid
stateDiagram-v2
    [*] --> QUEUED: Matched by discovery
    QUEUED --> PREPARING: Preparation worker picks it up
    PREPARING --> READY: Resume tailored, checked, cap slot taken
    PREPARING --> QUEUED: Preparation failed, will retry
    READY --> FILLING: App is filling the form
    FILLING --> AWAITING_REVIEW: Form filled, waiting on the consultant
    FILLING --> PARKED: Form asked something with no approved answer
    PARKED --> READY: That answer gets approved
    AWAITING_REVIEW --> SUBMITTED: Consultant clicks submit
    AWAITING_REVIEW --> SKIPPED: Consultant declines, reason required
    READY --> SKIPPED: Skipped, reason required
    SKIPPED --> QUEUED: Re-queued
    SUBMITTED --> [*]: Permanent record written

    note right of PREPARING
        A cap slot is taken on reaching READY,
        never before. A failed preparation
        costs the consultant nothing.
    end note

    note right of PARKED
        The loop back to the answer bank.
        Approving the missing answer releases
        every item waiting on it.
    end note
```

Every single move records who did it, when, from what state to what state, and
why. That history is the answer to *"what happened to this application?"*

---

## 9. Stage 3 — Application

### The bot lane

```mermaid
sequenceDiagram
    participant App as Desktop app
    participant Hub as Hub
    participant Browser as The consultant's browser
    participant Person as Consultant

    Note over App: Wakes every 4 hours,<br/>with a random offset

    App->>Hub: Give me my ready items
    Hub-->>App: Jobs, resumes, approved answers<br/>(only for these items)

    loop One application at a time, never parallel
        App->>Hub: Reserve this item
        App->>Browser: Open the job with the saved session
        Browser-->>App: The form

        alt A question with no approved answer
            App->>Hub: Here is the unknown question
            App->>Hub: Park this item
        else All questions answerable
            App->>Browser: Fill at human typing speed
            App->>Browser: Attach the tailored resume
            App->>Hub: Filled, awaiting review
        end
    end

    App->>Person: "3 applications ready to review"
    Person->>App: Reads every question and answer
    Person->>Browser: Clicks submit
    App->>Hub: Submitted, with the full question-and-answer list
```

### The human lane

The portal shows the job with everything the consultant needs — the tailored
resume, the match reason, and their approved answers for reference. They open
the job and apply directly. The application is then recorded, either by the
desktop app if it witnessed it, or by the consultant marking it applied.

Records carry **how they were made**, so reporting stays honest about what it
actually knows:

| Recorded as | Meaning |
|---|---|
| `DESKTOP_BOT` | The app filled it; the consultant submitted; the app witnessed it |
| `DESKTOP_ASSISTED` | The consultant filled it in the app's browser; the app witnessed it |
| `PORTAL_SELF_REPORTED` | The consultant's own account of an application made elsewhere |

---

## 10. The desktop application

A small program on the consultant's own machine. **It is a filling assistant
with a human gate, not an auto-applier.**

### What the consultant sees

| Surface | Purpose |
|---|---|
| **Tray icon** | Always running, quietly. Idle / working / needs you / paused. |
| **Activation** | Once, ever. A one-time code issued by the owner. |
| **Sign-in prompts** | The first time a board is needed, a normal browser window opens and the app steps aside. |
| **Ready to review** | The main screen. Each filled application with its job, attached resume, and every question and answer. A submit button per row. |
| **Needs you** | Jobs paused on an unanswered question, and jobs whose form lives on a site the app does not fill. |
| **Notifications** | Two only: *"3 applications ready to review"* and *"Your session expired — please sign in again."* |

### How sign-in works

```mermaid
flowchart LR
    A["App needs a board<br/>for the first time"] --> B["Opens a <b>real browser window</b><br/>and steps aside"]
    B --> C["<b>The consultant logs in themselves</b><br/>including any code sent to their phone"]
    C --> D["The session is saved<br/>on their machine only"]
    D --> E["Later runs reuse it silently"]
    E --> F{"Session<br/>expires?"}
    F -->|"Yes"| G["That board pauses,<br/>the consultant is asked to sign in,<br/>the stall shows on the dashboards"]
    G --> B

    style C fill:#e6f4ec,stroke:#17754a,color:#151923
```

**The app has no password field and no code path that reads one.** It never
holds, stores or transmits a portal password.

### Built-in behaviour limits

- **One application at a time.** Never parallel, across all boards.
- **Human-paced typing** with realistic delays and pauses between fields.
- **The daily cap is enforced on the machine as well as at the hub.**
- **A random offset on each wake**, so activity is never machine-timed.
- **LinkedIn receives the most conservative treatment:** lowest volume, and the
  app stops touching LinkedIn for the rest of the day on any bot-check.
- **A filling failure parks the application with a clear error.** It never
  submits partial or wrong data.

### What stays on the machine

**Permanently:** the device token and the saved browser sessions. Nothing else.

**For one cycle:** the resume for each job, deleted at the end of the cycle and
again on startup, so a crash cannot leave one behind.

**Reports survive interruption.** Every outcome is written to local storage
before it is sent, and retried until the hub confirms it — so an application
submitted just as the network drops still reaches the permanent record.

---

## 11. Stage 4 — The permanent record

For every application, kept indefinitely:

- **The record** — consultant, job, company, portal, date and time, how it was
  submitted, and its final status.
- **The exact resume file** that was submitted, linked to the record.
- **Every question the form asked and the exact answer given**, in order, stored
  as the form worded it.
- **A full audit trail** — every login, resume delivery, answer approval,
  assignment change, and device token issued or revoked, with who, what, when
  and from which machine.

**These records are append-only, enforced at the database itself.** The account
the application runs as has had its permission to modify or delete them revoked.
Nobody edits an application record — not a recruiter, not an owner, not through
direct database access.

Questions are stored **as the form worded them**, not as a link to the question
bank. The bank is editable; an application record is a statement about what a
specific employer asked on a specific day, and must stay true even after the
canonical wording changes.

---

## 12. Operating limits

Three independent budgets, each visible and each enforced.

```mermaid
flowchart TB
    subgraph CAP["DAILY APPLICATION CAP"]
        direction TB
        C1["Set per consultant by the owner"] ~~~ C2["Governs <b>both lanes</b>"] ~~~ C3["Taken when an item becomes ready"] ~~~ C4["Surplus is <b>held</b>, never discarded"]
    end

    subgraph SEARCH["SEARCH PROVIDER BUDGET"]
        direction TB
        S1["Terms per cycle · pages per term"] ~~~ S2["Hard ceiling per cycle"] ~~~ S3["Monthly ceiling, with a reserve<br/>held back for manual runs"]
    end

    subgraph AI["AI BUDGET"]
        direction TB
        A1["Bounded by the daily cap —<br/>preparation only runs for items<br/>that will be applied to"] ~~~ A2["Cost recorded per item"]
    end

    style CAP fill:#e6f4ec,stroke:#17754a,color:#151923
    style SEARCH fill:#e8ecfa,stroke:#37418c,color:#151923
    style AI fill:#f3e8fa,stroke:#6b3fa0,color:#151923
```

**The daily cap is a quality and safety limit, not a throughput limit.** It
protects the consultant's own reputation with employers, keeps the human review
manageable, keeps the pacing credible, and bounds AI cost. It resets on the
agency's own timezone.

---

## 13. Security model

Three independent layers. The third is convenience; the first two are the real
protection.

```mermaid
flowchart TD
    A["Request arrives"] --> B["<b>Layer 1 — Route guard</b><br/>Is this role allowed here at all?"]
    B -->|"No"| B1["Refused"]
    B -->|"Yes"| C["<b>Layer 2 — Tenant scoping</b><br/>Every query filtered by the agency<br/><b>taken from the signed token</b>"]
    C --> D{"Recruiter?"}
    D -->|"Yes"| E["Narrowed again to<br/><b>only their assigned consultants</b>"]
    D -->|"No"| F["Whole agency"]
    E --> G["Query runs"]
    F --> G
    G --> H["<b>Layer 3 — Interface</b><br/>menus and buttons hidden<br/><i>convenience only, never trusted</i>"]

    style B fill:#e8ecfa,stroke:#37418c,color:#151923
    style C fill:#e8ecfa,stroke:#37418c,color:#151923
    style H fill:#eef1f6,stroke:#8d97ab,color:#151923
```

**The agency is read from the signed login token** — never from the URL, the body
or a query parameter. A user cannot request another agency's data by editing a
request, because the part that decides which agency they belong to is not theirs
to edit.

### Desktop app access

- **One device token per consultant per machine**, issued by the owner and bound
  to both the person and that machine.
- **Only the owner grants access.** A token cannot be reused on a second machine.
- **Revocation is immediate.** On the next call the app wipes its local data,
  clears its token, and returns to the activation screen.

### Further controls

- Resumes are delivered **per job only**. There is no bulk resume download
  anywhere in the system, for any role.
- Every resume delivery is logged with time, person and machine.
- **Two-person rule on every reusable answer:** one person fills it, a different
  person approves it. A consultant can never approve their own.
- All data encrypted at rest; all traffic between app, portal and hub encrypted
  in transit.
- Daily encrypted backups kept off the server, with a monthly restore test.
- **No real candidate data enters the system until the security review is
  complete.** All build and test work uses seeded fictional data.

---

## 14. Data model

```mermaid
erDiagram
    AGENCY ||--o{ USER : "employs"
    USER ||--o| CONSULTANT_PROFILE : "has"
    USER ||--o{ PROFILE_CHANGE_REQUEST : "submits"
    USER ||--o| SEARCH_CRITERIA : "has"
    SEARCH_CRITERIA ||--o{ CRITERIA_VERSION : "frozen snapshots"
    USER ||--o{ ANSWER : "gives"
    QUESTION ||--o{ ANSWER : "is answered by"

    SEARCH_PROVIDER ||--o{ DISCOVERY_RUN : "queried by"
    DISCOVERY_RUN ||--o{ JOB_POSTING : "found"
    DISCOVERY_RUN ||--o{ RAW_RESPONSE : "retained"
    JOB_SOURCE ||--o{ JOB_POSTING : "listed"
    JOB_POSTING ||--o{ POSTING_SIGHTING : "seen again"
    JOB_POSTING ||--o{ JOB_MATCH : "suits"
    USER ||--o{ JOB_MATCH : "matched to"
    CRITERIA_VERSION ||--o{ JOB_MATCH : "matched by"

    JOB_MATCH ||--o| QUEUE_ITEM : "promoted to"
    QUEUE_ITEM ||--o| TAILORED_RESUME : "prepared with"
    QUEUE_ITEM ||--o{ QUEUE_TRANSITION : "every move"
    QUEUE_ITEM ||--o| APPLICATION_RECORD : "results in"
    APPLICATION_RECORD ||--o{ APPLICATION_QA : "exact Q and A"

    USER ||--o{ DEVICE : "activates"
    DEVICE ||--o{ APPLICATION_RECORD : "witnessed"
    AGENCY ||--o{ AUDIT_LOG : "records everything"
```

Four deliberate choices worth calling out:

1. **A match and a queue slot are different things.** A job can suit a consultant
   without there being room for it today. Keeping them separate is what makes
   "held, not discarded" possible.
2. **Criteria versions are frozen, and each match points at one.** That is how
   "why did this person get this job?" stays answerable years later.
3. **Raw provider responses are retained.** If the way results are read turns out
   to be wrong, the fix can be replayed over stored history instead of losing
   everything that arrived meanwhile.
4. **Source and portal are separate columns.** One says which board listed the
   job; the other says which system you apply through. They are usually
   different, and conflating them would make both the lane routing and the
   per-board reporting wrong.

---

## 15. Technology stack

| Part | Technology | Why |
|---|---|---|
| **Hub service** | Node.js · Express | One language across hub, portal and desktop app. |
| **Database** | PostgreSQL | Handles the record store and audit log for years without attention. Append-only enforcement at the database level. |
| **Scheduler** | Node cron in the hub process | The four-hour cycle and the preparation worker. |
| **Web portal** | React · Vite · Tailwind | Served by the hub. Shares its design system and API client with the desktop app. |
| **Resume storage** | Object storage, encrypted | Keeps large files out of the database. |
| **Job discovery** | Search provider API | Swappable; the system supports one or several running side by side. |
| **AI** | Large language model API | Resume tailoring and fit scoring, with the no-fabrication check as a second pass. |
| **Desktop app** | Electron · Playwright · SQLite | Electron for the tray, installer and review screen. Playwright drives the consultant's own installed browser, which is what makes saved logins work. SQLite for the local queue cache and the report outbox. |
| **App packaging** | electron-builder | Signed installer with automatic updates. Windows first; the codebase is cross-platform. |
| **Transport** | HTTPS/TLS throughout | Between app, portal, hub and every external service. |

### Why one language across all three parts

The hub, the portal and the desktop app are all JavaScript. The API client,
validation rules, shared types and design system are written once and used
everywhere. A change to an endpoint contract is a change in one place, and one
developer can move between all three parts without switching toolchains.

### Where the heavy work happens

The hub stays deliberately light — it fetches, matches, prepares and records.
**The browser work happens on consultant machines**, using their own logins and
their own sessions, which is both what makes the applications genuinely theirs
and what keeps the server small.
