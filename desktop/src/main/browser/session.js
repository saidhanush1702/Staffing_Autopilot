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
 *
 * ── WHY THE PROFILE DIRECTORY IS NOT ENOUGH ───────────────────────────
 *
 * A persistent profile keeps cookies that have an expiry date. It does NOT keep
 * SESSION cookies -- the ones a site marks as "gone when the browser closes" --
 * and Chromium discards those every time a context closes. Proven, not assumed:
 * plant one of each in a fresh profile, close, reopen, and only the dated one
 * comes back.
 *
 * That is fatal for Workday, which authenticates entirely with session cookies
 * (PLAY_SESSION, CALYPSO_SESSION). A consultant would sign into four employers,
 * quit the app, and be signed out of all four -- forever, no matter how many
 * times they did it. So the cookie jar is saved to disk on the way out and
 * restored on the way in.
 *
 * ── AND WHY THAT IS NOT A TRICK ───────────────────────────────────────
 *
 * It is exactly what "Continue where you left off" does in an ordinary browser,
 * which every consultant already has switched on somewhere. It extends a
 * session across a restart of OUR window; it does not defeat an expiry, forge a
 * credential, or touch anything the site did not already hand this profile.
 * The site can still expire the session server-side whenever it likes, and when
 * it does, `isSignedIn` notices and asks the consultant to sign in again.
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
    constructor({
        chromium, profilesDir, sessionsDir, launchOptions = {}, maxOpenContexts = 2,
    }) {
        this.chromium = chromium;
        this.profilesDir = profilesDir;
        // Session cookies live here, beside the profiles rather than inside
        // them: everything in a profile directory belongs to Chromium, and
        // writing our own file into one invites it to be cleaned up by a
        // browser that considers the directory its own.
        this.sessionsDir = sessionsDir ?? `${profilesDir}-sessions`;
        // Whatever the resolver decided this build needs — nothing for a
        // bundled Chromium, `channel: 'chrome'` when driving an installed one.
        this.launchOptions = launchOptions;
        this.contexts = new Map();
        // ── HOW MANY BROWSERS MAY BE OPEN AT ONCE ─────────────────────
        //
        // Every board and every Workday employer gets its own profile, and a
        // profile is a whole Chromium: one browser process, a GPU process, and
        // a renderer per tab. Four boards plus four Workday tenants is eight
        // Chromiums, and the app kept ALL of them open for the life of the
        // process because nothing ever closed one.
        //
        // On a consultant's actual machine -- 12GB, with their own Chrome
        // already holding 2.5GB across 25 tabs -- that ran the machine out of
        // memory and LinkedIn died with "Aw, Snap! Out of Memory". The board
        // was not at fault; there was simply no memory left to render it.
        //
        // Two is enough because the engine works ONE job at a time (R-19). The
        // second slot exists so a hand-off -- Built In opening a job, then
        // following it through to Workday -- does not close the board it just
        // came from. Closing is cheap now that sessions are saved to disk: the
        // sign-in survives, so a reopened profile is still signed in.
        this.maxOpenContexts = Math.max(1, maxOpenContexts);
        // Least-recently-used first, so the oldest idle browser is the one that
        // goes when room is needed.
        //
        // Ordered by a COUNTER rather than a clock. `Date.now()` has
        // millisecond resolution, and two contexts opened in the same
        // millisecond -- which is ordinary, they are opened back to back --
        // tie, leaving eviction order down to whichever the Map happened to
        // walk first. A counter cannot tie.
        this.lastUsed = new Map();
        this.tick = 0;
    }

    #profileDir(board) {
        const dir = path.join(this.profilesDir, board.toLowerCase());
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    #sessionFile(board) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        return path.join(this.sessionsDir, `${board.toLowerCase()}.json`);
    }

    /**
     * Write this board's cookie jar to disk, session cookies included.
     *
     * Called when a context closes and after a sign-in is detected. Never
     * throws: losing a saved session costs one more sign-in, while an
     * exception here would take down whatever real work was in progress.
     */
    async saveSession(board) {
        const ctx = this.contexts.get(board);
        if (!ctx) return false;
        try {
            const cookies = await ctx.cookies();
            if (cookies.length === 0) return false;
            fs.writeFileSync(this.#sessionFile(board), JSON.stringify(cookies), 'utf8');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Close the least-recently-used browser to stay under the cap.
     *
     * The session is SAVED first, so closing costs the consultant nothing: the
     * profile is still on disk, the cookies are still in a file, and reopening
     * it later finds them both. Without that saving step this would be a
     * memory fix that logged people out, which is no fix at all.
     */
    async #evictIdle() {
        while (this.contexts.size >= this.maxOpenContexts) {
            // Lowest tick first. `lastUsed` is updated on every `context()`
            // call, so the lowest is the one nobody has asked for in longest.
            let oldest = null;
            let oldestAt = Infinity;
            for (const [board] of this.contexts) {
                const at = this.lastUsed.get(board) ?? 0;
                if (at < oldestAt) { oldestAt = at; oldest = board; }
            }
            if (oldest === null) return;

            await this.saveSession(oldest);
            const ctx = this.contexts.get(oldest);
            this.contexts.delete(oldest);
            this.lastUsed.delete(oldest);
            try { await ctx?.close(); } catch { /* already gone */ }
        }
    }

    /** Put a saved cookie jar back, if there is one. */
    async #restoreSession(board, ctx) {
        let cookies;
        try {
            cookies = JSON.parse(fs.readFileSync(this.#sessionFile(board), 'utf8'));
        } catch {
            return false;                      // nothing saved, or unreadable
        }
        if (!Array.isArray(cookies) || cookies.length === 0) return false;
        try {
            await ctx.addCookies(cookies);
            return true;
        } catch {
            // A malformed jar must not stop the board working; the consultant
            // just signs in again.
            return false;
        }
    }

    /** Forget a board's saved session. Used when the device is revoked. */
    forgetSessions() {
        try {
            fs.rmSync(this.sessionsDir, { recursive: true, force: true });
        } catch { /* nothing saved */ }
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
        if (cached) {
            this.tick += 1;
            this.lastUsed.set(board, this.tick);
            return cached;
        }

        // Make room before launching another whole browser, not after.
        await this.#evictIdle();

        const ctx = await this.chromium.launchPersistentContext(this.#profileDir(board), {
            headless: false,
            viewport: null,
            args: [
                '--disable-blink-features=AutomationControlled',
                // ── LIVING WITHIN A CONSULTANT'S MACHINE ──────────────
                //
                // These trim what a background board costs while it sits
                // waiting its turn. None of them changes what a page CAN do --
                // no blocked images, no disabled JavaScript, nothing that would
                // make a form behave differently from how a person sees it.
                //
                // Chromium normally keeps a spare renderer warm to make the
                // next navigation feel instant. Across eight profiles that is
                // eight idle processes bought with memory we do not have.
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=Translate,MediaRouter,OptimizationHints',
                '--disable-back-forward-cache',
            ],
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
            if (this.contexts.get(board) === ctx) {
                this.contexts.delete(board);
                this.lastUsed.delete(board);
            }
        });

        this.contexts.set(board, ctx);
        this.tick += 1;
        this.lastUsed.set(board, this.tick);
        // AFTER the map is set, because `saveSession` reads from it -- and
        // before anyone navigates, so the very first request already carries
        // whatever session the consultant established last time.
        await this.#restoreSession(board, ctx);
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
        for (const [board, ctx] of this.contexts) {
            // Save BEFORE closing: once the context is gone its session
            // cookies are gone with it, which is the whole problem this
            // exists to solve.
            await this.saveSession(board);
            try { await ctx.close(); } catch { /* already gone */ }
        }
        this.contexts.clear();
    }
}

module.exports = { BrowserSessions, NAV_TIMEOUT, LOOKS_LIKE_LOGIN, SETTLE_MS };
