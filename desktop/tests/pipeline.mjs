/**
 * The one apply pipeline — routing, ordering, and no cap on the queue.
 *
 *   node tests/pipeline.mjs
 */
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BOARDS, boardForPortal } = require('../src/main/browser/boards.js');
const { DESTINATIONS, tenantFor } = require('../src/main/browser/destinations.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

section('where a job lands decides which flow takes it');
{
    const name = (url) => tenantFor(url)?.system ?? null;
    check('Greenhouse', name('https://boards.greenhouse.io/acme/jobs/1'), 'GREENHOUSE');
    check('Lever', name('https://jobs.lever.co/acme/abc'), 'LEVER');
    check('Ashby', name('https://jobs.ashbyhq.com/acme/abc'), 'ASHBY');
    check('Workday', name('https://acme.wd5.myworkdayjobs.com/en-US/x/job/y'), 'WORKDAY');
    check('an unknown company site has no written flow', name('https://careers.example.org/apply/9'), null);
    check('LinkedIn is a board of its own', boardForPortal('LINKEDIN')?.name, 'LINKEDIN');
    check('an unknown portal has no board', boardForPortal('SOMETHING_ELSE') ?? null, null);
}

section('submit policy');
{
    check('Greenhouse, Lever and Ashby follow the consultant\'s choice',
        ['GREENHOUSE', 'LEVER', 'ASHBY'].map((n) => Boolean(DESTINATIONS[n].neverAutoSubmit)),
        [false, false, false]);
    check('Workday never auto-submits', Boolean(DESTINATIONS.WORKDAY.neverAutoSubmit), true);
    check('  a Lever tenant follows the consultant', tenantFor('https://jobs.lever.co/a/b').neverAutoSubmit, false);
    check('  a Workday tenant never auto-submits', tenantFor('https://a.wd5.myworkdayjobs.com/x/job/y').neverAutoSubmit, true);
}

section('no cap on the queue');
{
    const src = fs.readFileSync(path.join(import.meta.dirname, '../../backend/controllers/deviceController.js'), 'utf8');
    const q = src.slice(src.indexOf('deviceQueue'));
    const end = q.indexOf('approvedAnswers') > 0 ? q.indexOf('Approved answers') : 4000;
    check('the hub sends the whole queue, with no LIMIT on it', /LIMITs+d+/.test(q.slice(0, end)), false);
}

for (const b of Object.values(BOARDS)) void b;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
