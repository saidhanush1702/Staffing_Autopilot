/**
 * ── PROVING A BOARD RECIPE ────────────────────────────────────────────
 *
 *   npm run verify:board -- LINKEDIN
 *
 * Every recipe in boards.js ships with `verified: false`, and the engine
 * refuses to FILL an unverified board — it only opens the job and hands it to
 * the consultant. That flag is the thing standing between a guessed CSS
 * selector and a wrong answer typed into a real employer's form.
 *
 * This script is how the flag earns being flipped. It opens the board in the
 * same browser profile the app uses, waits for you to sign in exactly as a
 * consultant would, and then checks each selector against the live page:
 *
 *   signedIn.present   must be FOUND once you are signed in
 *   signedIn.absent    must be MISSING once you are signed in
 *   botCheck           must be MISSING on a normal page
 *
 * A recipe that passes all three has been observed working. One that has not
 * been through this has only been reasoned about, and reasoning about markup
 * you cannot see is guessing.
 *
 * ── IT CHANGES NOTHING BY ITSELF ──────────────────────────────────────
 *
 * The script never edits boards.js. It prints what it found and leaves the
 * decision to a person, because "the selector matched once" and "this recipe is
 * safe to type into strangers' forms" are not the same claim, and only one of
 * them can be made by a script.
 *
 * Optional second argument: a job URL to open after signing in, so the fields
 * the filler would see are listed too.
 *
 *   npm run verify:board -- LINKEDIN https://www.linkedin.com/jobs/view/123
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BOARDS } = require('../src/main/browser/boards.js');
const { describeFields } = require('../src/main/browser/filler.js');

const [boardName, jobUrl] = process.argv.slice(2);

if (!boardName || !BOARDS[boardName]) {
    console.error(`\nUsage: npm run verify:board -- <BOARD> [jobUrl]\n`);
    console.error(`Known boards: ${Object.keys(BOARDS).join(', ')}\n`);
    process.exit(1);
}

const board = BOARDS[boardName];
const tick = (ok) => (ok ? '  OK  ' : ' FAIL ');

/** Wait for the person at the keyboard, rather than for a selector. */
const waitForEnter = (prompt) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
});

const main = async () => {
    const { chromium } = require('playwright');

    // The same profile shape the app uses, but under a scratch directory: a
    // verification run must not disturb a consultant's real saved session.
    const profileDir = path.join(os.tmpdir(), 'smartapply-verify', boardName.toLowerCase());
    fs.mkdirSync(profileDir, { recursive: true });

    console.log(`\n── ${board.label} ──────────────────────────────────────────`);
    console.log(`profile:  ${profileDir}`);
    console.log(`login:    ${board.loginUrl}\n`);

    const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = ctx.pages()[0] ?? await ctx.newPage();

    try {
        await page.goto(board.loginUrl, { waitUntil: 'domcontentloaded' });

        await waitForEnter(
            'Sign in in the browser window that just opened.\n'
            + 'This script never sees your password — it only looks at the page afterwards.\n'
            + 'Press Enter here once you are signed in… ',
        );

        const results = [];

        for (const sel of board.signedIn?.present ?? []) {
            const count = await page.locator(sel).count();
            results.push({ ok: count > 0, kind: 'present', sel, count });
        }
        for (const sel of board.signedIn?.absent ?? []) {
            const count = await page.locator(sel).count();
            results.push({ ok: count === 0, kind: 'absent', sel, count });
        }
        for (const sel of board.botCheck ?? []) {
            const count = await page.locator(sel).count();
            results.push({ ok: count === 0, kind: 'botCheck', sel, count });
        }

        console.log('\nselectors\n');
        if (results.length === 0) {
            console.log('  this recipe declares no selectors — nothing to check');
        }
        for (const r of results) {
            const expectation = r.kind === 'present'
                ? 'should be found when signed in'
                : 'should be missing';
            console.log(`  [${tick(r.ok)}] ${r.kind.padEnd(8)} ${r.sel}`);
            console.log(`           ${expectation}; found ${r.count}`);
        }

        if (jobUrl) {
            console.log(`\nopening ${jobUrl}\n`);
            await page.goto(jobUrl, { waitUntil: 'domcontentloaded' });
            await waitForEnter(
                'Navigate to the APPLICATION FORM itself, then press Enter… ',
            );

            const fields = (await describeFields(page))
                .filter((f) => f.visible && !f.disabled
                    && !['hidden', 'submit', 'button', 'reset', 'image'].includes(f.type));

            console.log(`\nfields the filler would see (${fields.length})\n`);
            for (const f of fields) {
                const flags = [f.required ? 'required' : null, f.type]
                    .filter(Boolean).join(', ');
                console.log(`  ${(f.label || '(no label)').slice(0, 70)}`);
                console.log(`      ${flags}${f.options.length ? ` — options: ${f.options.join(' | ')}` : ''}`);
            }

            const unlabelled = fields.filter((f) => !f.label).length;
            if (unlabelled > 0) {
                console.log(`\n  ${unlabelled} field(s) have no readable label. The filler treats`);
                console.log('  those as unanswerable and will park the application rather than');
                console.log('  guess, so a form full of them is not worth marking verified.');
            }
        }

        const allOk = results.length > 0 && results.every((r) => r.ok);
        console.log(`\n── verdict ────────────────────────────────────────────────`);
        if (allOk) {
            console.log('  Every selector behaved as the recipe claims.');
            console.log(`  If the field list above also looks right, set verified: true on`);
            console.log(`  BOARDS.${boardName} in src/main/browser/boards.js.`);
        } else {
            console.log('  At least one selector did not behave as the recipe claims.');
            console.log(`  Leave BOARDS.${boardName}.verified as false and correct the selectors first.`);
        }
        console.log('');
    } finally {
        await ctx.close();
    }
};

main().catch((err) => {
    console.error(`\nverification failed: ${err.message}\n`);
    process.exit(1);
});
