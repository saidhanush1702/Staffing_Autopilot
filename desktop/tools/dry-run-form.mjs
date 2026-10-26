/**
 * ── FILL A REAL FORM WITHOUT SENDING IT ───────────────────────────────
 *
 *   npm run dry-run:form -- https://job-boards.greenhouse.io/<company>/jobs/<id>
 *
 * Opens a public application page in a throwaway headless browser, runs the
 * same `runApplyFlow` the app runs against it with a made-up applicant, and
 * prints what it did: the outcome, every field it filled, every question it
 * could not answer, and a picture of the result.
 *
 * ── WHAT MAKES THIS SAFE ──────────────────────────────────────────────
 *
 *   · Nothing is submitted. `runApplyFlow` finds the submit control to STOP at
 *     it and never presses it — the same guard the app depends on.
 *   · No resume is attached. Some sites upload a file the moment it is chosen,
 *     which would send a stranger's file to a company that never asked for it.
 *   · The applicant is obviously fake (an .invalid address). Nothing typed here
 *     is anyone's data, and it stays in the page: no form was sent.
 *   · Only hosts the app has a recipe for are accepted.
 *   · A site that shows a human check ends the run; this never works round one.
 *
 * It is how a recipe in destinations.js earns `verified: true`: someone runs
 * this, reads the output, and agrees the fields it filled are the right ones.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { tenantFor } = require('../src/main/browser/destinations.js');
const { runApplyFlow } = require('../src/main/browser/applyFlow.js');
const { describeFields } = require('../src/main/browser/filler.js');

const url = process.argv[2];
const tenant = url ? tenantFor(url) : null;
if (!tenant) {
    console.error('\nUsage: npm run dry-run:form -- <application or job url>');
    console.error('The host must be one the app has a recipe for (Workday, Greenhouse, Lever, Ashby).\n');
    process.exit(1);
}

const PROFILE = {
    name: 'Test Candidate',
    email: 'test.candidate@example.invalid',
    phone: '5550100000',
    city: 'Dallas',
    state: 'TX',
    linkedin_url: 'https://www.linkedin.com/in/test-candidate',
    github_url: 'https://github.com/test-candidate',
    portfolio_url: 'https://test-candidate.example.invalid',
    work_auth: 'Citizen',
    current_company: 'Example Co',
    current_title: 'Engineer',
    total_years: 5,
    skills: [{ name: 'React', years: 4 }],
};
const FAST = { minMs: 5, maxMs: 15, betweenFieldsMs: [20, 60] };

const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1800 } })).newPage();

try {
    console.log(`\n── ${tenant.label} ──────────────────────────────────────`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2_500);

    const result = await runApplyFlow(
        page, { ...tenant, verified: true },
        { profile: PROFILE, approvedAnswers: [], resumePath: null, typing: FAST },
        { canFill: true, log: (m) => console.log(`  · ${m}`) },
    );

    console.log(`\noutcome: ${result.outcome} — ${result.detail}\n`);
    console.log(`filled (${result.qa.length})`);
    for (const q of result.qa) {
        console.log(`  ${q.questionText.slice(0, 60).padEnd(60)} → ${String(q.answerText).slice(0, 40)}  [${q.source}]`);
    }
    console.log(`\nleft for a person (${result.unknown.length})`);
    for (const u of result.unknown) {
        console.log(`  ${u.required ? '*' : ' '} ${u.questionText.slice(0, 70)}  (${u.fieldType}${u.reason ? `; ${u.reason}` : ''})`);
    }

    const root = tenant.apply?.dialog;
    const after = (await describeFields(page, root ?? null))
        .filter((f) => f.visible && !f.disabled && !['hidden', 'submit', 'button'].includes(f.type));
    const unlabelled = after.filter((f) => !f.label).length;
    console.log(`\nfields the filler sees: ${after.length}  (without a readable label: ${unlabelled})`);

    const shot = path.join(os.tmpdir(), `dry-run-${tenant.system}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`picture: ${shot}\n`);
} catch (err) {
    console.error(`\ndry run failed: ${String(err.message).split('\n')[0]}\n`);
    process.exitCode = 1;
} finally {
    await browser.close();
}
