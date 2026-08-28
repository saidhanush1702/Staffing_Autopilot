/**
 * ── WHERE A JOB BOARD SENDS YOU ───────────────────────────────────────
 *
 * A board is where a job is FOUND. A destination is where it is APPLIED TO,
 * when those are not the same place — and on Built In they never are: all 21
 * postings examined hand off to the employer's own applicant tracking system.
 *
 * Workday, SmartRecruiters, Zoho Recruit, Ashby, Greenhouse, Lever. A handful
 * of systems carry a very large share of hiring, so recognising one is worth
 * far more than recognising any single employer.
 *
 * ── A DESTINATION IS A BOARD IN EVERY WAY THAT MATTERS ────────────────
 *
 * `tenantFor` returns an object with the same shape a board has — `name`,
 * `loginUrl`, `signedIn`, `botCheck`, `apply`, `verified` — because everything
 * the engine already owns is written against that shape. Sessions, the sign-in
 * gate, the bot-check stop, the apply flow and the filler all work on a
 * destination unchanged, and none of them had to learn a new concept.
 *
 * ── WHY A "TENANT" AND NOT JUST A DESTINATION ─────────────────────────
 *
 * Workday is not one site. Every employer runs their own copy —
 * blackbaud.wd1, jda.wd5, syneoshealth.wd12, vanguard.wd5 — with its own
 * accounts and its own cookies. An account on one is worth nothing on the next.
 *
 * So the SESSION is per host while the RECIPE is per system: one set of
 * selectors, a separate browser profile and a separate sign-in for each
 * employer. Sharing a profile across tenants would have meant signing in once
 * and appearing signed out forever after.
 *
 * ── EVERYTHING HERE IS UNVERIFIED, AND THAT IS NOT A PLACEHOLDER ──────
 *
 * `verified: false` on all of them. The public parts were measured — the apply
 * button, the modal it opens, the sign-in control — but the application form
 * itself sits behind an account, and nobody has watched this fill one. Until
 * they have, the engine classifies and hands over; it will not type.
 */

/** Turn a host into something safe to use as a directory name. */
const profileKey = (system, host) => `${system}-${host}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

const DESTINATIONS = {
    WORKDAY: {
        name: 'WORKDAY',
        label: 'Workday',
        // Every tenant is <employer>.wdN.myworkdayjobs.com. Matched on the
        // suffix so a new employer needs no change here.
        match: /(^|\.)myworkdayjobs\.com$/i,

        // ── MEASURED ON FOUR TENANTS, IDENTICALLY ────────────────────
        //
        // Workday marks its controls with `data-automation-id`, which is a
        // stable, semantic, documented attribute — the exact opposite of
        // LinkedIn's build-hashed classes, and a pleasure to write against.
        // These four were seen on blackbaud.wd1, jda.wd5, syneoshealth.wd12
        // and vanguard.wd5 without variation:
        //
        //   utilityButtonSignIn   Sign In, shown only while signed out
        //   adventureButton       Apply
        //   → opens "Start Your Application" with three choices:
        //   autofillWithResume · applyManually · useMyLastApplication
        //
        // What is behind those choices has NOT been measured: it is an account
        // wall, and creating an account is not something this app may do.
        signedIn: {
            present: [],
            absent: ['[data-automation-id="utilityButtonSignIn"]'],
        },
        botCheck: [],
        // ── WHAT IS MEASURED HERE, AND WHAT IS STILL A GUESS ──────────
        //
        // Read off Vanguard's tenant, signed in as a real candidate:
        //   `open`      opens "Start Your Application"                MEASURED
        //   `chooser`   that modal is a [role="dialog"]               MEASURED
        //   `start`     "Apply Manually" -- clicked, it navigated     MEASURED
        //   `dialog`    [data-automation-id="applyFlowPage"] holds
        //               all 11 inputs of step 1                       MEASURED
        //   `next`      "Save and Continue"                           MEASURED
        //   `accountWall` its fields were read off the real gate       PARTLY
        //   `submit`    step 5 of 5 was never reached                 GUESSED
        //
        // The wizard is five steps -- My Information, My Experience,
        // Application Questions, Voluntary Disclosures, Review -- and takes
        // roughly EIGHT SECONDS to render each one, showing "Loading" first.
        // That is why the engine waits for a VISIBLE field rather than a fixed
        // settle: at 1.8s it filled an empty page, and waiting merely for an
        // "attached" field was no better, because hidden inputs are present
        // from the first paint.
        //
        // ── WHY THIS IS VERIFIED, AND WHAT IS STILL MISSING ───────────
        //
        // Verified against the live site through `runApplyFlow` itself -- the
        // same function the cycle calls, not a hand-rolled walk. On Vanguard's
        // step 1 it filled six fields from the profile (given/family name,
        // local name, city, phone), read the long multi-line Vanguard radio
        // question correctly, and stopped on three unanswered required
        // questions instead of guessing. That is the whole contract working.
        //
        // What it still cannot do: Workday renders "Country" and "Phone Device
        // Type" as BUTTONS with a popup listbox, not <select> elements, and
        // the filler has no vocabulary for those. Both are required, so a
        // Workday application will fill most of a step, park on what it cannot
        // answer, and eventually hand over when the form refuses to advance.
        // Better than never trying -- and honest about where it stops.
        //
        // `submit` remains a guess, which costs nothing here: `neverAutoSubmit`
        // means nothing in this app ever presses it.
        apply: {
            open: '[data-automation-id="adventureButton"]',
            // ── THE CHOOSER AND THE FORM ARE DIFFERENT ELEMENTS ────────
            //
            // Apply opens a small modal ("Start Your Application") holding the
            // three choices. Picking one NAVIGATES to the wizard, which is a
            // different container entirely. Treating them as one selector was
            // wrong in both directions: waiting for the wizard right after
            // Apply timed out, and scoping the fill to the modal found an
            // empty element.
            chooser: '[role="dialog"]',
            // "Apply Manually" is the one that leads to a form we could fill.
            // Autofill-with-résumé would have Workday parse the CV and invent
            // answers we never approved, which is the opposite of the rule that
            // the app types only what it was given.
            start: '[data-automation-id="applyManually"]',
            // The wizard itself, and the root every field is filled within.
            // ONE selector, never a comma list: `fillForm` scopes by string
            // prefix, so "A, B" would expand to "A, B input, A, B textarea"
            // and quietly match the whole page instead of the form.
            dialog: '[data-automation-id="applyFlowPage"]',
            next: '[data-automation-id="bottom-navigation-next-button"], '
                + 'button:has-text("Save and Continue"), button:has-text("Continue")',
            submit: '[data-automation-id="bottom-navigation-next-button"]:has-text("Submit"), '
                + 'button:has-text("Submit")',
            // ── THE GATE INSIDE THE WIZARD ─────────────────────────────
            //
            // Clicking "Apply Manually" can land on Workday's OWN sign-in --
            // separate from the header's -- rather than the form. Read off the
            // real page:
            //
            //   Email Address*      @email
            //   Password*           @password
            //   Verify New Password* @verifyPassword
            //   (a honeypot, unlabelled to a person: "Enter website. This
            //    input is for robots only, do not enter anything here.")     @beecatcher
            //
            // `password` is what actually distinguishes this from the real
            // "My Information" step, which asks for no password at all --
            // `email` alone was tried first and is too loose, since a later
            // step could legitimately ask for one too.
            accountWall: '[data-automation-id="password"], '
                + '[data-automation-id="createAccountLink"], '
                + '[data-automation-id="signInLink"]',
            maxSteps: 10,
        },
        // ── A LEGAL GATE IS A DECISION, NOT A STEP ───────────────────
        //
        // Syneos serves `legalNoticeAcceptButton` / `legalNoticeDeclineButton`
        // before anything else. Accepting terms on somebody's behalf is not the
        // app's to do, so it is recognised and handed over rather than clicked.
        legalGate: '[data-automation-id="legalNoticeAcceptButton"]',
        neverAutoSubmit: true,
        // Switched on because filling was WATCHED working through the engine
        // against the real site, which is what this flag has always meant.
        verified: true,
    },

    SMARTRECRUITERS: {
        name: 'SMARTRECRUITERS',
        label: 'SmartRecruiters',
        match: /(^|\.)smartrecruiters\.com$/i,

        // ── STOPPED BY A BOT CHECK, DELIBERATELY LEFT STOPPED ────────
        //
        // SmartRecruiters postings do have an in-page "Easy apply" — the first
        // page read showed the wording and a file input. The second read, and
        // every one after it, served a DataDome challenge instead:
        //
        //     iframe geo.captcha-delivery.com   "Input 1 out of 6" … "Verify"
        //
        // The site is telling us it has noticed. R-22's answer to that is to
        // stop, and it is the right answer for a second reason: working around
        // a challenge is what turns a temporary block into a permanent one, on
        // the consultant's own IP and their own everyday browsing.
        //
        // So there is no apply recipe here. The challenge is recognised, and
        // then — unlike a board's bot check, which is R-22's "stop for the
        // day" — this one gives a person thirty seconds to clear it before
        // giving up.
        //
        // ── WHY THIS IS NOT THE SAME RULE AS R-22 ─────────────────────
        //
        // R-22 exists because working AROUND a challenge — retrying, rotating
        // something, pretending to be different traffic — is what turns a
        // temporary block into a permanent one. That is not what happens here.
        // The window is brought to the front and the app waits; if the
        // consultant is sitting at the machine, THEY solve it, the same human
        // act as typing a sign-in password. Nothing here fills a captcha field
        // or clicks its widget. If nobody answers in time, it still hands the
        // job over exactly as it always did.
        botCheck: [
            'iframe[src*="captcha-delivery.com"]',
            'iframe[src*="geo.captcha"]',
            '#datadome-captcha',
        ],
        botCheckWaitMs: 30_000,
        signedIn: { present: [], absent: [] },
        neverAutoSubmit: true,
        verified: false,
    },
};

/**
 * The destination this URL belongs to, as a board-shaped object.
 *
 * @returns a tenant definition, or null when we do not handle this host
 */
const tenantFor = (url) => {
    let here;
    try {
        here = new URL(url);
    } catch {
        return null;
    }
    const host = here.host.replace(/^www\./, '');
    const system = Object.values(DESTINATIONS).find((d) => d.match?.test(host));
    if (!system) return null;

    return {
        // The session key AND the profile directory. Per host, so an account on
        // one employer's Workday is never confused with another's.
        name: profileKey(system.name, host),
        system: system.name,
        label: `${system.label} · ${host}`,
        host,
        // Sign-in happens on the job page itself, where Workday puts its Sign
        // In button. Guessing a login path per tenant would be one more
        // unmeasured selector, and this needs none.
        loginUrl: url,
        sessionProbeUrl: url,
        signedIn: system.signedIn,
        botCheck: system.botCheck ?? [],
        // How long a person gets to clear a challenge before the job is handed
        // over. Zero for anything that does not declare one, which keeps R-22's
        // stop-immediately behaviour as the default for every board.
        botCheckWaitMs: system.botCheckWaitMs ?? 0,
        apply: system.apply,
        legalGate: system.legalGate,
        neverAutoSubmit: system.neverAutoSubmit !== false,
        verified: Boolean(system.verified),
    };
};

module.exports = { DESTINATIONS, tenantFor, profileKey };
