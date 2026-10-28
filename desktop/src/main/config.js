/**
 * Everything the app needs to know about where it lives and how it behaves.
 *
 * The hub URL is the one setting a consultant might legitimately need to change
 * (staging vs production), so it is an environment override with a sane default
 * rather than a compiled constant.
 */
const path = require('node:path');
const os = require('node:os');

const pkg = require('../../package.json');

// Order: an explicit env override (dev, staging), then the URL baked into
// package.json at build time by release-desktop.yml (production installers),
// then localhost for running from source.
const HUB_URL = process.env.SMARTAPPLY_HUB ?? pkg.hubUrl ?? 'http://localhost:5001/api';

/** How often we prove the device is still allowed to exist. */
const HEARTBEAT_MS = 60_000;

/**
 * ── THE APP IS NOT ON A SCHEDULE ──────────────────────────────────────
 *
 * The four-hour cycle belongs to the HUB, and it governs one thing: how often
 * new jobs are DISCOVERED. The desktop app is not on that clock. It works
 * whenever the consultant's queue has something in it, which is what a person
 * would do, and it goes quiet when the queue is empty.
 *
 * So this is a polling interval, not a cycle length. It is short, because work
 * that has been waiting an hour for no reason is work the consultant could have
 * had; and it is jittered, because a poll landing on the same second forever is
 * a pattern (spec §5.3).
 */
const POLL_MS = 90_000;
const POLL_JITTER_MS = 60_000;

/** How long we wait, once, for a queue that has gone quiet to refill. */
const IDLE_POLL_MS = 5 * 60_000;

/**
 * How long the app waits for a consultant to finish signing in manually before
 * giving up on that board for now.
 *
 * It waits at all because abandoning the board the moment a login is needed
 * would mean the work sits untouched until the next poll, even though the
 * person is right there looking at the window we just opened for them.
 */
const SIGNIN_WAIT_MS = 5 * 60_000;
const SIGNIN_POLL_MS = 3_000;

/**
 * ── HOW LONG A RUN MAY WAIT FOR A PERSON ──────────────────────────────
 *
 * The short windows above are how long the app holds still and watches. Once
 * they run out the job is no longer abandoned: it is put on hold (see runs.js)
 * and the rest of the queue carries on.
 *
 * A day, because Workday and LinkedIn both keep a draft that long, and because
 * the person who has to act may be away from the machine.
 */
const GATE_TTL_MS = 24 * 60 * 60_000;
/**
 * How long a site is left alone after a person did not come back to it.
 *
 * The job goes to the BACK of the queue, and the next jobs on the same site are
 * not prompted straight away either — one sign-in window, not twenty. A human
 * check gets longer, because trying again soon is what turns a temporary
 * challenge into a blocked account (R-22).
 */
const GATE_RETRY_MS = 30 * 60_000;
const GATE_COOLDOWN_MS = { BOT_CHECK: 2 * 60 * 60_000 };
/** Times a job may time out waiting for a person before it is given up on. */
const MAX_GATE_ATTEMPTS = 3;

/**
 * Which sites keep a written (scripted) flow. Everything else goes to the AI
 * agent, which reads each page as it is. Only LinkedIn Easy Apply for now: the
 * scripted Workday flow stalled on multi-page forms (it kept scrolling and
 * re-asking for a field it had already filled), and the agent handles that
 * better. Names are board names; 'SITES' is the Workday/Greenhouse/Lever/Ashby
 * recipes; '*' means all (used by the test suites). Override with
 * SMARTAPPLY_BOT_FLOWS="LINKEDIN,SITES".
 */
const BOT_FLOWS = new Set(
    (process.env.SMARTAPPLY_BOT_FLOWS ?? 'LINKEDIN').split(',').map((s) => s.trim()).filter(Boolean),
);
/** Nudges after the wait begins; the last interval then repeats. */
const GATE_REMINDER_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const GATE_REMINDER_REPEAT_MS = 2 * 60 * 60_000;

/**
 * ── SUBMITTING WITHOUT A HUMAN ────────────────────────────────────────
 *
 * The system was built so the machine fills and a person presses submit. The
 * owner has changed that: the app now completes the application itself.
 *
 * The reason was practical as well as preferential. The app drives ONE browser
 * page per board, so as soon as it moved on to the next job the previous
 * application's form was gone from the screen — and the review screen's Submit
 * button had nothing left to press. Review-then-submit only works if the app
 * stops after every single job and waits, which is not what anyone wants from
 * a tool that works a queue.
 *
 * What this costs is real and worth stating where the switch lives: an answer
 * the app got wrong now reaches an employer under the consultant's name with
 * nobody having read it first. The protections that remain are the ones that
 * refuse rather than guess — a required question with no approved answer still
 * parks the application instead of inventing one.
 *
 * Set SMARTAPPLY_AUTO_SUBMIT=false to go back to stopping for review.
 */
const AUTO_SUBMIT = process.env.SMARTAPPLY_AUTO_SUBMIT !== 'false';

/**
 * ── WHERE THE BROWSER APPEARS ─────────────────────────────────────────
 *
 * ── AND WHY IT IS NOT EMBEDDED TODAY ──────────────────────────────────
 *
 * `embedded` puts each board's page in a view inside our own window. It is
 * built (browser/embedded.js) and it does not work, for one reason that no
 * amount of finishing will fix:
 *
 *     PLAYWRIGHT CANNOT ATTACH TO ELECTRON OVER CDP.
 *
 * Measured, not assumed. Electron opens the debugging port, answers
 * /json/version, publishes a browser-level webSocketDebuggerUrl and lists each
 * WebContentsView as a page — and `connectOverCDP` still times out, given
 * either the HTTP endpoint or the websocket URL directly. Electron's browser
 * target does not implement the auto-attach behaviour Playwright expects.
 *
 * Driving embedded views therefore means not using Playwright for them:
 * Electron's own `webContents.debugger` speaks CDP, but every locator call in
 * filler.js and applyFlow.js would need an adapter behind it. That is a real
 * piece of work, not a switch.
 *
 * So the default is a separate browser window, which works. The embedded code
 * is left in place, wired and reachable, for when that adapter exists.
 *
 * Set SMARTAPPLY_BROWSER=embedded to use it anyway.
 */
const EMBED_BROWSER = process.env.SMARTAPPLY_BROWSER === 'embedded';

/** The port Electron opens so Playwright can drive its own views. */
const CDP_PORT = Number(process.env.SMARTAPPLY_CDP_PORT ?? 9223);

/**
 * Human-paced typing (R-19). Per character, with jitter on top.
 *
 * The two numbers are trimmed on different schedules, deliberately.
 * `minMs`/`maxMs` stays at {15, 40} — a per-character delay is the part that
 * most looks like a person actually typing, and there was nothing wrong with
 * its pace, only with how much of the total it was contributing next to
 * `betweenFieldsMs`. That is the one that keeps shrinking: {400, 1400}, then
 * {150, 500}, then {60, 180}, then {25, 75}, and now this — close to the
 * floor a gap can be and still be two distinct, randomised numbers rather
 * than a constant. Below here there stops being room for the jitter itself
 * to do anything, which is the point past which R-19 stops being served by
 * cutting further.
 */
const TYPING = { minMs: 15, maxMs: 40, betweenFieldsMs: [8, 25] };

module.exports = {
    HUB_URL,
    HEARTBEAT_MS,
    POLL_MS,
    POLL_JITTER_MS,
    IDLE_POLL_MS,
    SIGNIN_WAIT_MS,
    SIGNIN_POLL_MS,
    GATE_TTL_MS,
    GATE_RETRY_MS,
    GATE_COOLDOWN_MS,
    MAX_GATE_ATTEMPTS, BOT_FLOWS,
    GATE_REMINDER_MS,
    GATE_REMINDER_REPEAT_MS,
    AUTO_SUBMIT,
    EMBED_BROWSER,
    CDP_PORT,
    TYPING,
    APP_VERSION: pkg.version,
    // Resolved lazily: app.getPath('userData') is unavailable until Electron is
    // ready, and the pure modules are unit-tested without Electron at all.
    paths(userDataDir) {
        return {
            userData: userDataDir,
            state: path.join(userDataDir, 'state.json'),
            outbox: path.join(userDataDir, 'outbox.json'),
            // Browser profiles persist; everything in `work` is deleted every
            // cycle (R-20).
            profiles: path.join(userDataDir, 'profiles'),
            // Saved cookie jars, kept OUT of the profile directories --
            // those belong to Chromium, which is entitled to tidy them.
            sessions: path.join(userDataDir, 'sessions'),
            work: path.join(userDataDir, 'work'),
            // A picture of each filled form, for the review screen. Personal
            // data, so it lives only as long as the application is waiting and
            // is swept at the start of every pass (see cycle.js).
            evidence: path.join(userDataDir, 'evidence'),
            // The shape of pages a run could not finish -- labels, never values.
            fixtures: path.join(userDataDir, 'fixtures'),
            logs: path.join(userDataDir, 'logs'),
        };
    },
    machineLabel: () => `${os.hostname()} · ${os.type()} ${os.release()}`,
};
