/**
 * ── THE BROWSER ───────────────────────────────────────────────────────
 *
 * One persistent browser profile per board, so a consultant signs into each
 * board once and the session survives restarts — spec §5.2.
 *
 * ── WHY A SEPARATE PROFILE, NOT THEIR OWN ─────────────────────────────
 *
 * We never touch the consultant's everyday browser profile. Two reasons, both
 * decisive: a browser refuses to open one profile directory twice, so the app
 * would break whenever they had their own browser open; and their profile holds
 * every cookie and saved password they own, none of which is this app's
 * business. They sign in once inside our profile instead.
 *
 * ── WHY THE HUMAN DOES THE LOGGING IN ─────────────────────────────────
 *
 * R-18: the app never holds, stores or transmits a portal password. There is no
 * password field anywhere in this codebase. We open a real window at the login
 * page and step aside; the consultant types their own credentials and handles
 * their own two-factor prompt. We only detect when they are done.
 */
const path = require('node:path');
const fs = require('node:fs');

const NAV_TIMEOUT = 45_000;

class BrowserSessions {
    /**
     * @param chromium injected rather than required at module load, so the
     *   engine can be unit-tested against a fake without Playwright present.
     */
    constructor({ chromium, profilesDir }) {
        this.chromium = chromium;
        this.profilesDir = profilesDir;
        this.contexts = new Map();
    }

    #profileDir(board) {
        const dir = path.join(this.profilesDir, board.toLowerCase());
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /**
     * The persistent context for a board, launched if needed.
     *
     * Always headed. A headless browser cannot be handed to a person to log
     * into, and hiding the automation from the consultant would be the wrong
     * shape for a tool whose whole design point is that they stay in control.
     */
    async context(board) {
        if (this.contexts.has(board)) return this.contexts.get(board);

        const ctx = await this.chromium.launchPersistentContext(this.#profileDir(board), {
            headless: false,
            viewport: null,
            args: ['--disable-blink-features=AutomationControlled'],
        });
        ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
        this.contexts.set(board, ctx);
        return ctx;
    }

    async page(board) {
        const ctx = await this.context(board);
        const [existing] = ctx.pages();
        return existing ?? ctx.newPage();
    }

    /**
     * Is this board signed in?
     *
     * Two-sided on purpose: something that only exists when signed IN, and
     * something that only exists when signed OUT. A single positive check
     * reports success on a cookie banner or an interstitial that happens to
     * contain the selector.
     */
    async isSignedIn(boardDef) {
        const page = await this.page(boardDef.name);
        const { present = [], absent = [] } = boardDef.signedIn ?? {};
        if (present.length === 0 && absent.length === 0) return true;

        for (const sel of absent) {
            if (await page.locator(sel).count() > 0) return false;
        }
        for (const sel of present) {
            if (await page.locator(sel).count() === 0) return false;
        }
        return true;
    }

    /** Has the board challenged us? R-22 turns a true here into a full stop. */
    async isBotChecked(boardDef) {
        const page = await this.page(boardDef.name);
        for (const sel of boardDef.botCheck ?? []) {
            if (await page.locator(sel).count() > 0) return true;
        }
        return false;
    }

    /** Open the login page and leave it to the consultant. */
    async promptSignIn(boardDef) {
        const page = await this.page(boardDef.name);
        await page.goto(boardDef.loginUrl, { waitUntil: 'domcontentloaded' });
        await page.bringToFront();
        return { board: boardDef.name, awaitingHuman: true };
    }

    async openJob(board, url) {
        const page = await this.page(board);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return page;
    }

    async closeAll() {
        for (const [, ctx] of this.contexts) {
            try { await ctx.close(); } catch { /* already gone */ }
        }
        this.contexts.clear();
    }
}

module.exports = { BrowserSessions, NAV_TIMEOUT };
