/**
 * Read-back and confirmation — "it took" and "it landed" have to be seen, not assumed.
 *
 *   node tests/verify.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readBack } = require('../src/main/browser/filler.js');
const { confirmationEvidence } = require('../src/main/browser/applyFlow.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const box = (value) => ({ inputValue: async () => value });

section('a typed value has to be in the box afterwards');
check('the value is there', (await readBack(box('mj@example.com'), 'text', 'mj@example.com')).ok, true);
check('an empty box did not take', (await readBack(box(''), 'text', 'mj@example.com')).ok, false);
check('a phone mask is not a mismatch', (await readBack(box('(555) 010-1234'), 'text', '5550101234')).ok, true);
check('a URL that gained https:// is not a mismatch',
    (await readBack(box('https://github.com/ada'), 'text', 'github.com/ada')).ok, true);
check('a typeahead that replaced the text with its choice is fine',
    (await readBack(box('Dallas, Texas, United States'), 'text', 'dallas', 'Dallas, Texas, United States')).ok, true);
check('something unrelated means it landed in the wrong box',
    (await readBack(box('mj@example.com'), 'text', '5550101234')).ok, false);
check('  and says why', (await readBack(box(''), 'text', 'x')).reason, 'the form did not keep what was typed');

section('a chosen option has to stay chosen');
check('checked', (await readBack({ isChecked: async () => true }, 'choice')).ok, true);
check('not checked', (await readBack({ isChecked: async () => false }, 'choice')).ok, false);

section('a control that cannot be read does not block the page');
check('no way to read a value', (await readBack({}, 'text', 'x')).ok, true);
check('reading throws', (await readBack({ inputValue: async () => { throw new Error('detached'); } }, 'text', 'x')).ok, true);

section('"sent" needs something the page says');
const pageWith = ({ confirmCount = 0, url = 'https://x.io/apply', markerVisible = false } = {}) => ({
    url: () => url,
    locator: (sel) => ({
        count: async () => (sel.startsWith('text=/thank') ? confirmCount : (markerVisible ? 1 : 0)),
        first() { return this; },
        isVisible: async () => markerVisible,
    }),
});
check('a thank-you message',
    await confirmationEvidence(pageWith({ confirmCount: 1 }), { urlBefore: 'https://x.io/apply' }), 'a confirmation message');
check('the recipe\'s own marker',
    await confirmationEvidence(pageWith({ markerVisible: true }), { marker: '.done' }), 'the site’s own confirmation marker');
check('a move to a confirmation address',
    await confirmationEvidence(pageWith({ url: 'https://x.io/apply/thank-you' }), { urlBefore: 'https://x.io/apply' }), 'a confirmation page');
check('a button simply going away is nothing',
    await confirmationEvidence(pageWith(), { urlBefore: 'https://x.io/apply' }), null);
check('a move to a login page is nothing',
    await confirmationEvidence(pageWith({ url: 'https://x.io/login' }), { urlBefore: 'https://x.io/apply' }), null);
check('staying on the same address that happens to say success is nothing',
    await confirmationEvidence(pageWith({ url: 'https://x.io/success' }), { urlBefore: 'https://x.io/success' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
