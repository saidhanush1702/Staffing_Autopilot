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
