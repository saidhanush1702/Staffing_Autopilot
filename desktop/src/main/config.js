/**
 * Everything the app needs to know about where it lives and how it behaves.
 *
 * The hub URL is the one setting a consultant might legitimately need to change
 * (staging vs production), so it is an environment override with a sane default
 * rather than a compiled constant.
 */
const path = require('node:path');
const os = require('node:os');

const HUB_URL = process.env.SMARTAPPLY_HUB ?? 'http://localhost:5001/api';

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
 * `embedded` puts each board's page in a view inside the app's own window, on
 * the Boards tab. `window` launches a separate Chrome, which is how this
 * worked first and is kept as a fallback: driving Electron's own pages needs a
 * debugging port, and if that cannot be opened there has to be somewhere to
 * land.
 *
 * Set SMARTAPPLY_BROWSER=window to go back to a separate browser.
 */
const EMBED_BROWSER = process.env.SMARTAPPLY_BROWSER !== 'window';

/** The port Electron opens so Playwright can drive its own views. */
const CDP_PORT = Number(process.env.SMARTAPPLY_CDP_PORT ?? 9223);

/** Human-paced typing (R-19). Per character, with jitter on top. */
const TYPING = { minMs: 45, maxMs: 140, betweenFieldsMs: [400, 1400] };

module.exports = {
    HUB_URL,
    HEARTBEAT_MS,
    POLL_MS,
    POLL_JITTER_MS,
    IDLE_POLL_MS,
    SIGNIN_WAIT_MS,
    SIGNIN_POLL_MS,
    AUTO_SUBMIT,
    EMBED_BROWSER,
    CDP_PORT,
    TYPING,
    APP_VERSION: require('../../package.json').version,
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
            work: path.join(userDataDir, 'work'),
            logs: path.join(userDataDir, 'logs'),
        };
    },
    machineLabel: () => `${os.hostname()} · ${os.type()} ${os.release()}`,
};
