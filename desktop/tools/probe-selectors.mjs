/**
 * ── WHAT DO THE RECIPES ACTUALLY SEE? ─────────────────────────────────
 *
 *   npm run probe:selectors                 (close the desktop app first)
 *
 * Opens each board in the SAME browser profile the desktop app uses, so it sees
 * exactly what the app sees when the consultant is already signed in, and
 * reports whether each declared selector matches.
 *
 * ── IT ONLY LOOKS ─────────────────────────────────────────────────────
 *
 * It navigates and counts. It never types, never clicks, never submits, and
 * never touches a form. The point is to find out whether the guesses in
 * boards.js are true before anything is allowed to act on them — the opposite
 * of a tool that changes something.
 *
 * ── WHY THE APP MUST BE CLOSED ────────────────────────────────────────
 *
 * Chromium takes an exclusive lock on a profile directory. A second process
 * opening the same profile fails outright, so this cannot run alongside the
 * app it is inspecting.
 *
 * It also suggests a replacement selector when it can find an obvious one,
 * because "your guess is wrong" is only half an answer.
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BOARDS } = require('../src/main/browser/boards.js');
const { resolveBrowser } = require('../src/main/browser/engine.js');

const PROFILES = process.env.SMARTAPPLY_PROFILES
    ?? path.join(process.env.APPDATA ?? '', 'smartapply-desktop', 'profiles');

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = only.length ? only : Object.keys(BOARDS);

/** Candidates worth reporting when a declared selector misses. */
const SIGNED_IN_HINTS = [
    'nav [href*="logout"]', 'a[href*="logout"]', 'a[href*="sign-out"]',
    '[data-testid*="nav"]', 'img[alt*="Photo"]', 'button[aria-label*="account" i]',
    '[aria-label*="profile" i]', 'header nav',
];
const SIGNED_OUT_HINTS = [
    'input[type="password"]', 'a[href*="/login"]', 'a[href*="signin"]',
    'button[type="submit"]',
];

const count = async (page, sel) => {
    try {
        return await page.locator(sel).count();
    } catch {
        return -1;                       // an invalid selector, not a missing one
    }
};

const main = async () => {
    const { chromium, launchOptions } = resolveBrowser();

    for (const name of targets) {
        const board = BOARDS[name];
        if (!board) { console.log(`\nunknown board ${name}`); continue; }

        const dir = path.join(PROFILES, name.toLowerCase());
        if (!fs.existsSync(dir)) {
            console.log(`\n── ${board.label} ──  no profile at ${dir} — sign in through the app first`);
            continue;
        }

        console.log(`\n── ${board.label} ────────────────────────────────────────`);

        let ctx;
        try {
            ctx = await chromium.launchPersistentContext(dir, {
                headless: false,
                viewport: null,
                args: ['--disable-blink-features=AutomationControlled'],
                ...launchOptions,
            });
        } catch (err) {
            console.log(`  cannot open the profile: ${err.message.split('\n')[0]}`);
            console.log('  (close the SmartApply desktop app and try again)');
            continue;
        }

        try {
            const page = ctx.pages()[0] ?? await ctx.newPage();
            await page.goto(board.loginUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2500);          // let the app shell render

            console.log(`  landed on: ${page.url()}`);
            console.log(`  title:     ${(await page.title()).slice(0, 70)}`);

            let allGood = true;

            for (const sel of board.signedIn?.present ?? []) {
                const n = await count(page, sel);
                const ok = n > 0;
                if (!ok) allGood = false;
                console.log(`  [${ok ? ' OK ' : 'MISS'}] present  ${sel}   found ${n}`);
            }
            for (const sel of board.signedIn?.absent ?? []) {
                const n = await count(page, sel);
                const ok = n === 0;
                if (!ok) allGood = false;
                console.log(`  [${ok ? ' OK ' : 'MISS'}] absent   ${sel}   found ${n}`);
            }
            for (const sel of board.botCheck ?? []) {
                const n = await count(page, sel);
                console.log(`  [${n === 0 ? ' OK ' : 'HIT '}] botCheck ${sel}   found ${n}`);
            }

            if (!allGood) {
                console.log('\n  candidates that DO match on this page:');
                for (const sel of SIGNED_IN_HINTS) {
                    const n = await count(page, sel);
                    if (n > 0) console.log(`     present?  ${sel}   (${n})`);
                }
                console.log('  and things that suggest signed OUT:');
                let anyOut = false;
                for (const sel of SIGNED_OUT_HINTS) {
                    const n = await count(page, sel);
                    if (n > 0) { anyOut = true; console.log(`     absent?   ${sel}   (${n})`); }
                }
                if (!anyOut) console.log('     (none — which is itself evidence of being signed in)');
            } else {
                console.log('\n  every declared selector behaved as the recipe claims.');
            }
        } catch (err) {
            console.log(`  probe failed: ${err.message.split('\n')[0]}`);
        } finally {
            await ctx.close().catch(() => {});
        }
    }

    console.log('\nNothing was typed, clicked or submitted.\n');
};

main().catch((err) => {
    console.error(`\nprobe failed: ${err.message}\n`);
    process.exit(1);
});
