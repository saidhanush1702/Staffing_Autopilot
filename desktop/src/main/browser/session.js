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

/** How long to let a client-side redirect finish before believing the URL. */
const SETTLE_MS = 2_500;

/** A path a board sends you to when it wants you to sign in. */
const LOOKS_LIKE_LOGIN = /\/(login|signin|sign-in|sign_in|auth|authwall)(\/|$)/i;

class BrowserSessions {
    /**
     * @param chromium injected rather than required at module load, so the
     *   engine can be unit-tested against a fake without Playwright present.
     */
    constructor({ chromium, profilesDir, launchOptions = {} }) {
        this.chromium = chromium;
        this.profilesDir = profilesDir;
        // Whatever the resolver decided this build needs — nothing for a
        // bundled Chromium, `channel: 'chrome'` when driving an installed one.
        this.launchOptions = launchOptions;
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
        const cached = this.contexts.get(board);
        if (cached) return cached;

        const ctx = await this.chromium.launchPersistentContext(this.#profileDir(board), {
            headless: false,
            viewport: null,
            args: ['--disable-blink-features=AutomationControlled'],
            ...this.launchOptions,
        });
        ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);

        // A consultant closing the window is ORDINARY, not a fault: they signed
        // in, they are done, they tidy up. Without this the map would keep
        // handing back a dead context, and every later call would fail with
        // "Target page, context or browser has been closed" until the app was
        // restarted. Evicting on close means the next call simply relaunches —
        // and the profile lives on disk, so the sign-in survives.
        ctx.on('close', () => {
            if (this.contexts.get(board) === ctx) this.contexts.delete(board);
        });

        this.contexts.set(board, ctx);
        return ctx;
    }

    async page(board) {
        const ctx = await this.context(board);
        try {
            const [existing] = ctx.pages();
            return existing ?? await ctx.newPage();
        } catch (err) {
            // The window was closed between the cache check and this call — a
            // race a person can win by clicking X at the wrong moment. Drop the
            // dead context and try once with a fresh one.
            if (!/closed/i.test(err.message)) throw err;
            this.contexts.delete(board);
            const fresh = await this.context(board);
            const [existing] = fresh.pages();
            return existing ?? await fresh.newPage();
        }
    }

    /**
     * Is this board signed in?
     *
     * ── THE BOARD ITSELF IS THE BEST WITNESS ──────────────────────────
     *
     * This used to be selectors only, and every one of them was wrong. A
     * consultant with three live sessions was told all three had expired,
     * because `#global-nav`, `[data-test="AccountMenu"]` and
     * `a[href*="/user/logout"]` were written from guesswork and never checked
     * against a real page.
     *
     * So the primary signal is no longer a guess about markup. It is what the
     * board DOES: ask for a page that needs a session, and see whether it
     * bounces you to a login screen. That is behaviour every board implements,
     * it needs no knowledge of anyone's HTML, and it does not rot when they
     * redesign.
     *
     * Selectors remain as an optional second opinion for boards that serve
     * their signed-out page without redirecting — BuiltIn does exactly that,
     * which is why it still declares one.
     */
    async isSignedIn(boardDef) {
        const page = await this.page(boardDef.name);
        const url = boardDef.sessionProbeUrl ?? boardDef.loginUrl;

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // Boards redirect from JavaScript as often as from the server, so the
        // URL right after domcontentloaded is not yet the final answer.
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

module.exports = { BrowserSessions, NAV_TIMEOUT, LOOKS_LIKE_LOGIN, SETTLE_MS };
