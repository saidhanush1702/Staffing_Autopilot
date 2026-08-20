/**
 * ── KEEPING THE APP CURRENT ───────────────────────────────────────────
 *
 * Consultants run this on their own machines. There is no IT department to
 * push a new build, and a board recipe that has gone stale is the most likely
 * reason a version needs replacing quickly — so updates install themselves.
 *
 * ── WHY IT INSTALLS ON QUIT, NOT ON DOWNLOAD ──────────────────────────
 *
 * `autoInstallOnAppQuit` rather than an immediate restart. The app is usually
 * mid-pass: it may have a browser open on a half-filled application that a
 * consultant is about to read. Restarting under them would throw that away and
 * leave a leased item to time out. Waiting until they quit costs nothing —
 * the next launch is the new version.
 *
 * ── WHY THIS IS ALL IN A TRY/CATCH ────────────────────────────────────
 *
 * Updates only exist for a packaged, published build. Running from source, and
 * running a build nobody has published a feed for, are both normal — during
 * development they are the only cases. Neither should produce an error the
 * consultant sees, so a missing module or a missing feed is logged and ignored.
 */

const SIX_HOURS = 6 * 3_600_000;

/**
 * Start checking for updates, if this build is in a position to receive any.
 *
 * @returns a stop() function, or null when updates do not apply here
 */
const startUpdater = ({ app, log = () => {}, record = () => {} }) => {
    if (!app.isPackaged) {
        log('updates: not a packaged build — skipping');
        return null;
    }

    let autoUpdater;
    try {
        // Required lazily so running from source never needs the module at all.
        // eslint-disable-next-line global-require
        ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
        record('updaterUnavailable', err.message);
        return null;
    }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('update-available', (info) => log(`update ${info.version} downloading`));
    autoUpdater.on('update-downloaded', (info) => {
        log(`update ${info.version} ready — it installs when you quit`);
    });
    autoUpdater.on('error', (err) => {
        // An unreachable update feed is an ordinary offline condition, not a
        // fault worth putting in front of a consultant.
        record('updateCheckFailed', err?.message ?? String(err));
    });

    const check = () => {
        autoUpdater.checkForUpdates().catch((err) => {
            record('updateCheckFailed', err?.message ?? String(err));
        });
    };

    check();
    const timer = setInterval(check, SIX_HOURS);
    return () => clearInterval(timer);
};

module.exports = { startUpdater, SIX_HOURS };
