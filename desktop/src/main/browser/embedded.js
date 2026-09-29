/**
 * ── THE BROWSER, INSIDE THE APP ───────────────────────────────────────
 *
 * Same job as session.js — one persistent, signed-in browser per board — but
 * the pages live in Electron views inside the app's own window instead of a
 * separate Chrome that pops up over whatever the consultant was doing.
 *
 * ── HOW PLAYWRIGHT DRIVES ELECTRON'S OWN PAGES ────────────────────────
 *
 * Playwright normally launches the browser it drives, which is exactly what we
 * are trying to avoid. So instead Electron is started with a remote debugging
 * port and Playwright CONNECTS to it. From Playwright's point of view Electron
 * is just a Chromium that somebody else launched; every WebContentsView shows
 * up as an ordinary page, and the whole filling engine works against it
 * unchanged.
 *
 * That last part is the reason for this design. `applyFlow` and `filler` never
 * learn where the page came from, so nothing about the automation had to be
 * rewritten to move it inside the window.
 *
 * ── SESSIONS INSTEAD OF PROFILE DIRECTORIES ───────────────────────────
 *
 * session.js gives each board its own Chromium profile directory. Here each
 * board gets its own Electron session partition (`persist:board-linkedin`),
 * which does the same thing: cookies survive restarts, boards cannot see each
 * other's sign-ins, and none of it touches the consultant's real browser.
 *
 * ── WHAT STAYS THE SAME ───────────────────────────────────────────────
 *
 * The consultant still signs in themselves, in a real browser view, and the app
 * still never sees a password (R-18). Being embedded changes where the window
 * is, not who types the credentials.
 */
const { WebContentsView, BrowserWindow } = require('electron');

const NAV_TIMEOUT = 45_000;
const SETTLE_MS = 2_500;
const LOOKS_LIKE_LOGIN = /\/(login|signin|sign-in|sign_in|auth|authwall)(\/|$)/i;

/** Where a board's view sits when the consultant is not looking at it. */
const OFFSCREEN = { x: -20_000, y: 0, width: 1_000, height: 700 };

class EmbeddedSessions {
    /**
     * @param chromium    Playwright's chromium, used only to CONNECT
     * @param cdpEndpoint the debugging port Electron was started with
     * @param getWindow   returns the BrowserWindow to add views to. A getter
     *   rather than the window itself: sessions are built during start-up,
     *   before the window exists, and a null captured here would never become
     *   the real one.
     */
    constructor({ chromium, cdpEndpoint, getWindow, log = () => {} }) {
        this.chromium = chromium;
        this.cdpEndpoint = cdpEndpoint;
        this.getWindow = getWindow;
        this.log = log;

        this.browser = null;          // the CDP connection to ourselves
        this.views = new Map();          // board -> WebContentsView
        this.signInWindows = new Map();  // board -> the window they sign in on
        this.visible = null;             // the board currently on screen
    }

    /**
     * Connect Playwright to this Electron process.
     *
     * ── WHY IT CHECKS THE PORT FIRST ──────────────────────────────────
     *
     * `connectOverCDP` fails the same way for every cause: a flat thirty-second
     * timeout that says nothing about whether the port was refused, listening
     * but unreachable, or open and rejecting the handshake. Asking
     * /json/version first separates "nothing is listening" from "listening but
     * would not talk to us", and both from a real hang — so the message names
     * the actual problem.
     */
    async #connect() {
        if (this.browser?.isConnected()) return this.browser;

        // Electron opens the port during start-up, so an early first job can
        // arrive before it is ready. Worth a few tries before giving up.
        let version = null;
        for (let attempt = 0; attempt < 10 && !version; attempt += 1) {
            try {
                const res = await fetch(`${this.cdpEndpoint}/json/version`, {
                    signal: AbortSignal.timeout(2_000),
                });
                if (res.ok) version = await res.json();
            } catch { /* not up yet */ }
            if (!version) await new Promise((r) => { setTimeout(r, 500); });
        }

        if (!version) {
            throw new Error(
                `No debugging port on ${this.cdpEndpoint}. The app needs it to show `
                + 'boards inside the window — set SMARTAPPLY_BROWSER=window to use a '
                + 'separate browser instead.',
            );
        }

        this.browser = await this.chromium.connectOverCDP(this.cdpEndpoint, {
            timeout: 20_000,
        });
        this.log(`attached to ${version.Browser ?? 'Electron'}`);
        return this.browser;
    }

    /** The Electron view for a board, created on first use. */
    #view(board) {
        if (this.views.has(board)) return this.views.get(board);

        const view = new WebContentsView({
            webPreferences: {
                // Its own cookie jar, kept across restarts.
                partition: `persist:board-${board.toLowerCase()}`,
                // This view shows job boards — untrusted pages. It gets no
                // preload, no Node, and no access to anything of ours.
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });

        view.setBounds(OFFSCREEN);
        this.getWindow()?.contentView.addChildView(view);
        this.views.set(board, view);
        return view;
    }

    /**
     * The Playwright page for a board's view.
     *
     * Matched by the view's own URL rather than by index: views are created
     * lazily and Electron's target list contains the app's own window too, so
     * position tells us nothing.
     */
    async page(board) {
        const view = this.#view(board);

        // A brand-new view has no URL, and an empty target cannot be matched.
        if (!view.webContents.getURL()) {
            await view.webContents.loadURL(`about:blank#${board.toLowerCase()}`);
        }

        const browser = await this.#connect();
        const url = view.webContents.getURL();

        for (const context of browser.contexts()) {
            for (const page of context.pages()) {
                if (page.url() === url) {
                    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
                    return page;
                }
            }
        }
        throw new Error(`Could not attach to the ${board} view`);
    }

    /** Put a board's view on screen, at the position the card reported. */
    show(board, bounds) {
        const view = this.#view(board);
        if (this.visible && this.visible !== board) this.hide(this.visible);
        view.setBounds({
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
        });
        this.visible = board;
    }

    hide(board) {
        const view = this.views.get(board);
        if (!view) return;
        // Moved away rather than destroyed: the page keeps its state, and an
        // application half-filled while the card was open is still there when
        // it is reopened.
        view.setBounds(OFFSCREEN);
        if (this.visible === board) this.visible = null;
    }

    hideAll() {
        for (const board of this.views.keys()) this.hide(board);
    }

    /* ── the same questions session.js answers ───────────────────────── */

    async isSignedIn(boardDef) {
        const page = await this.page(boardDef.name);
        const url = boardDef.sessionProbeUrl ?? boardDef.loginUrl;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(SETTLE_MS);

        if (LOOKS_LIKE_LOGIN.test(new URL(page.url()).pathname)) return false;

        const { present = [], absent = [] } = boardDef.signedIn ?? {};
        for (const sel of absent) {
            if (await page.locator(sel).count() > 0) return false;
        }
        for (const sel of present) {
            if (await page.locator(sel).count() === 0) return false;
        }
        return true;
    }

    /**
     * Is this board signed in, judged from the page ALREADY on screen?
     *
     * ── WHY THIS EXISTS SEPARATELY FROM isSignedIn ────────────────────
     *
     * `isSignedIn` navigates: it asks for a page that needs a session and sees
     * whether the board bounces it to a login screen. That is the right test
     * when nobody is looking at the window.
     *
     * It is exactly the wrong test while somebody is signing in. The wait loop
     * polls every few seconds, so navigating would reload the login form —
     * clearing half-typed credentials and any code the consultant had just been
     * sent — over and over until they gave up. Which is what it did.
     *
     * This one only looks at what is there.
     */
    async isSignedInNow(boardDef) {
        // While a sign-in window is open, that window IS the truth — the view
        // behind it still shows whatever was loaded before the session existed.
        const signInWin = this.signInWindows.get(boardDef.name);
        if (signInWin && !signInWin.isDestroyed()) {
            try {
                const url = new URL(signInWin.webContents.getURL());
                return !LOOKS_LIKE_LOGIN.test(url.pathname);
            } catch {
                return false;
            }
        }

        const page = await this.page(boardDef.name);
        let here;
        try {
            here = new URL(page.url());
        } catch {
            return false;                       // about:blank, or nothing loaded
        }
        if (LOOKS_LIKE_LOGIN.test(here.pathname)) return false;

        const { present = [], absent = [] } = boardDef.signedIn ?? {};
        for (const sel of absent) {
            if (await page.locator(sel).count() > 0) return false;
        }
        for (const sel of present) {
            if (await page.locator(sel).count() === 0) return false;
        }
        // Nothing says signed out, and we are not on a login page.
        return true;
    }

    async isBotChecked(boardDef) {
        const page = await this.page(boardDef.name);
        for (const sel of boardDef.botCheck ?? []) {
            if (await page.locator(sel).count() > 0) return true;
        }
        return false;
    }

    /**
     * Open the board's login page in a real window and leave it to the person.
     *
     * ── WHY A WINDOW, AND NOT THE EMBEDDED VIEW ───────────────────────
     *
     * Signing in inside the automation's own view kept failing: it is a panel
     * a few hundred pixels wide, with no address bar, no back button and no
     * room for the two-factor and consent steps boards throw at you. A login is
     * the one part of this app that is genuinely a person browsing, and it
     * deserves an actual browser window.
     *
     * ── WHY NOT A SEPARATE CHROMIUM ───────────────────────────────────
     *
     * Because it would not work, in a way that looks like it did. A separate
     * Chromium has its own cookie jar: the consultant would sign in, see the
     * board's home page, close the window — and the automation would still be
     * signed out, with nothing to explain why.
     *
     * This window is given the SAME session partition as the board's view. It
     * is a real browser window over the same cookies, so signing in here signs
     * in the automation.
     */
    async promptSignIn(boardDef) {
        const board = boardDef.name;
        const open = this.signInWindows.get(board);
        if (open && !open.isDestroyed()) {
            open.focus();
            return { board, awaitingHuman: true };
        }

        const win = new BrowserWindow({
            width: 1100,
            height: 820,
            title: `Sign in to ${boardDef.label}`,
            autoHideMenuBar: true,
            webPreferences: {
                // The same cookie jar the automation uses. This one line is the
                // whole reason signing in here has any effect.
                partition: `persist:board-${board.toLowerCase()}`,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });

        this.signInWindows.set(board, win);
        win.on('closed', () => { this.signInWindows.delete(board); });

        await win.loadURL(boardDef.loginUrl);
        this.log(`${boardDef.label}: sign in in the window that just opened`);
        return { board, awaitingHuman: true };
    }

    /**
     * Close a board's sign-in window and let its view pick up the new session.
     *
     * The view was loaded while signed out, so it is still showing that page —
     * the cookies changed underneath it. Reloading is what makes the automation
     * see the session the consultant just created.
     */
    async finishSignIn(board) {
        const win = this.signInWindows.get(board);
        if (win && !win.isDestroyed()) win.close();
        this.signInWindows.delete(board);

        const view = this.views.get(board);
        try { await view?.webContents.reload(); } catch { /* nothing loaded */ }
    }

    async openJob(board, url) {
        const page = await this.page(board);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return page;
    }

    async closeAll() {
        for (const [, win] of this.signInWindows) {
            try { if (!win.isDestroyed()) win.close(); } catch { /* already gone */ }
        }
        this.signInWindows.clear();

        for (const [board, view] of this.views) {
            try {
                this.getWindow()?.contentView.removeChildView(view);
                view.webContents.close();
            } catch { /* already gone */ }
            this.views.delete(board);
        }
        try { await this.browser?.close(); } catch { /* not connected */ }
        this.browser = null;
        this.visible = null;
    }
}

module.exports = { EmbeddedSessions, OFFSCREEN, LOOKS_LIKE_LOGIN };
