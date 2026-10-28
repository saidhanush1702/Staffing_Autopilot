/**
 * What is kept from a failed run — and what must never be.
 *
 *   node tests/fixtures.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    captureFixture, shapeOf, tally, pathPattern, KEEP,
} = require('../src/main/fixtures.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-fix-'));
const observation = {
    title: 'Apply — Acme',
    headings: ['Application'],
    errors: ['Email is required'],
    text: 'Jane Doe lives at 12 Elm Street and her number is 555-0100',
    fields: [
        { type: 'text', label: 'First name', required: true, value: '(filled)' },
        { type: 'select', label: 'Country', value: '', options: ['US', 'IN', 'UK'] },
    ],
    controls: [{ text: 'Next' }, { text: 'Submit application' }],
};

section('the shape of a page, and nothing of the person');
const shape = shapeOf(observation);
check('labels and types are kept', shape.fields.map((f) => [f.label, f.type]), [['First name', 'text'], ['Country', 'select']]);
check('whether a field held something is kept, not what', shape.fields.map((f) => f.filled), [true, false]);
check('option counts are kept, not the options', shape.fields[1].options, 3);
check('button text is kept', shape.controls, ['Next', 'Submit application']);
check('the page\'s body text is not', JSON.stringify(shape).includes('Elm Street'), false);

section('addresses lose their identifiers');
check('a numeric job id', pathPattern('https://job-boards.greenhouse.io/acme/jobs/5183044008?gh_src=x'), 'job-boards.greenhouse.io/acme/jobs/:id');
check('a uuid', pathPattern('https://jobs.lever.co/palantir/ac978161-6f46-4f6b-ad9e-a258e642751c/apply'), 'jobs.lever.co/palantir/:id/apply');
check('a query string is dropped', pathPattern('https://x.io/apply?email=jane@doe.com').includes('jane'), false);

section('the file');
const file = captureFixture({
    dir, system: 'GREENHOUSE', url: 'https://x.io/jobs/123456', outcome: 'HANDED_OVER', detail: 'stuck', observation,
});
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
check('it is written', [saved.system, saved.outcome, saved.where], ['GREENHOUSE', 'HANDED_OVER', 'x.io/jobs/:id']);
check('  and holds no value or body text', /Jane|Elm|555/.test(JSON.stringify(saved)), false);
for (let i = 0; i < KEEP + 5; i += 1) {
    captureFixture({ dir, system: 'S', url: 'https://x.io/', outcome: 'x', detail: '', observation });
}
check('only the newest are kept', fs.readdirSync(dir).length <= KEEP, true);
check('no folder means nothing happens', captureFixture({ dir: null, system: 'S', url: '', observation }), null);

section('the tally');
let stats = {};
stats = tally(stats, 'greenhouse', 'ready');
stats = tally(stats, 'greenhouse', 'ready');
stats = tally(stats, 'greenhouse', 'handedOver');
check('counted per system', stats.GREENHOUSE, { ready: 2, handedOver: 1, onHold: 0, failed: 0 });
check('an unknown result adds nothing', tally(stats, 'greenhouse', 'weird').GREENHOUSE.ready, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
