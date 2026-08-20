/**
 * ── FINDING A BROWSER TO DRIVE ────────────────────────────────────────
 *
 * Two ways this app can end up with a Chromium, and they are not the same in a
 * packaged build:
 *
 *   `playwright`       ships its own Chromium, downloaded at install time.
 *                      Present on a development machine. Roughly 150MB, and a
 *                      devDependency — so it is NOT in the installer.
 *   `playwright-core`  the same driver with no browser attached. Small, a real
 *                      dependency, and therefore what a packaged build has.
 *                      It drives the Chrome already on the machine.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ─────────────────────────────────────
 *
 * The main process used to `require('playwright')` directly. That works
 * everywhere it was ever run — from source — and fails on the first machine
 * that installs the packaged app, with a missing-module crash at startup and
 * nothing on screen to explain it. The failure could not appear until the app
 * was packaged, which is exactly the kind of bug that reaches a consultant
 * rather than a developer.
 *
 * So the choice is made explicitly, in one place, and the fallback path names
 * what it needs: Google Chrome, installed normally.
 */

/**
 * @returns {{chromium: object, launchOptions: object, source: string}}
 * @throws when neither a bundled browser nor an installed Chrome is available
 */
const resolveBrowser = () => {
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        const { chromium } = require('playwright');
        return { chromium, launchOptions: {}, source: 'bundled' };
    } catch { /* not a development machine — fall through */ }

    try {
        // eslint-disable-next-line global-require
        const { chromium } = require('playwright-core');
        // `channel: 'chrome'` means the consultant's own installed Chrome. It
        // still gets its own profile directory, so their everyday browsing,
        // cookies and saved passwords are untouched — see session.js.
        return { chromium, launchOptions: { channel: 'chrome' }, source: 'system-chrome' };
    } catch (err) {
        throw new Error(
            'No browser is available to drive. Install Google Chrome, or run a '
            + `build with a bundled Chromium. (${err.message})`,
        );
    }
};

module.exports = { resolveBrowser };
