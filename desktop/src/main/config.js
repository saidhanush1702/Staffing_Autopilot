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
 * The cycle interval is the HUB's decision, not ours — an agency sets it and we
 * are told. These are only the bounds we will accept from it, so a bad value
 * cannot make the app hammer or sleep forever.
 */
const CYCLE_MIN_MS = 15 * 60_000;
const CYCLE_MAX_MS = 24 * 3_600_000;
const CYCLE_DEFAULT_MS = 4 * 3_600_000;

/**
 * A random slice added to every wake, so activity is not machine-timed
 * (spec §5.3). Up to 12 minutes: long enough to break the pattern, short enough
 * that a 4-hour cycle is still a 4-hour cycle.
 */
const JITTER_MAX_MS = 12 * 60_000;

/** Human-paced typing (R-19). Per character, with jitter on top. */
const TYPING = { minMs: 45, maxMs: 140, betweenFieldsMs: [400, 1400] };

module.exports = {
    HUB_URL,
    HEARTBEAT_MS,
    CYCLE_MIN_MS,
    CYCLE_MAX_MS,
    CYCLE_DEFAULT_MS,
    JITTER_MAX_MS,
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
