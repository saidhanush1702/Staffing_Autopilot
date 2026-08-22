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
const { WebContentsView } = require('electron');

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
        this.views = new Map();       // board -> WebContentsView
        this.visible = null;          // the board currently on screen
    }

    async #connect() {
        if (this.browser?.isConnected()) return this.browser;
        this.browser = await this.chromium.connectOverCDP(this.cdpEndpoint);
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

    async isBotChecked(boardDef) {
        const page = await this.page(boardDef.name);
        for (const sel of boardDef.botCheck ?? []) {
            if (await page.locator(sel).count() > 0) return true;
        }
        return false;
    }

    /**
     * Open the board's login page and leave it to the consultant.
     *
     * The view is brought on screen, because a sign-in prompt the person cannot
     * see is a stall with no explanation.
     */
    async promptSignIn(boardDef) {
        const page = await this.page(boardDef.name);
        await page.goto(boardDef.loginUrl, { waitUntil: 'domcontentloaded' });
        this.log(`${boardDef.label}: sign in on the Boards tab`);
        return { board: boardDef.name, awaitingHuman: true };
    }

    async openJob(board, url) {
        const page = await this.page(board);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return page;
    }

    async closeAll() {
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
