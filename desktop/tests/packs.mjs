/**
 * The ATS recipes against their real markup.
 *
 *   node tests/packs.mjs        (a headless browser, no network, no account)
 *
 * The fixtures below are trimmed copies of what was READ off live public
 * application pages -- Greenhouse, Lever and Ashby -- with nothing typed or
 * sent there. They exist because each of these sites broke a different
 * assumption the filler had made, and a fixture is the cheapest way to keep a
 * lesson once it has been paid for.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveBrowser } = require('../src/main/browser/engine.js');
const { describeFields, fillForm } = require('../src/main/browser/filler.js');
const { runApplyFlow, findResumeInput } = require('../src/main/browser/applyFlow.js');
const { tenantFor } = require('../src/main/browser/destinations.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const FAST = { minMs: 1, maxMs: 2, betweenFieldsMs: [1, 2] };
const profile = {
    name: 'Test Candidate', email: 'test@example.invalid', phone: '5550100000',
    city: 'Dallas', state: 'TX', github_url: 'https://github.com/t', current_company: 'Example Co',
};

const { chromium, launchOptions } = resolveBrowser();
const browser = await chromium.launch({ headless: true, ...launchOptions });
const open = async (html) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return page;
};

/* ── Ashby: Yes / No are buttons ─────────────────────────────────────── */

section('Ashby — a Yes/No question made of buttons');
{
    const page = await open(`
      <div class="ashby-application-form-container">
        <div class="ashby-application-form-field-entry">
          <label>Are you currently based in the Bay Area?</label>
          <div class="yesno">
            <button type="submit" aria-pressed="false" id="y">Yes</button>
            <button type="submit" aria-pressed="false" id="n">No</button>
          </div>
        </div>
        <button type="button" aria-pressed="false" id="star">Save</button>
        <script>
          document.querySelectorAll('.yesno button').forEach((b) => b.addEventListener('click', () => {
            document.querySelectorAll('.yesno button').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          }));
        </script>
      </div>`);
    const fields = await describeFields(page, '.ashby-application-form-container');
    const choices = fields.filter((f) => f.type === 'radio');
    check('the two buttons are read as one question', choices.map((f) => f.label), ['Yes', 'No']);
    check('  asked in the page\'s own words', choices[0].groupLabel, 'Are you currently based in the Bay Area?');
    check('  sharing one group', choices[0].groupKey === choices[1].groupKey && choices[0].groupKey !== '', true);
    check('a lone toggle is not a question', fields.some((f) => f.label === 'Save' && f.type === 'radio'), false);

    const bank = [{ question_text: 'Are you currently based in the Bay Area?', answer_text: 'No', question_id: 'q' }];
    const res = await fillForm(page, {
        profile, approvedAnswers: bank, resumePath: null, typing: FAST,
        root: '.ashby-application-form-container',
    });
    check('an approved answer presses the right button', res.qa.map((q) => q.answerText), ['No']);
    check('  and the page agrees it stuck',
        await page.locator('#n').getAttribute('aria-pressed'), 'true');
    check('  while the other stays off', await page.locator('#y').getAttribute('aria-pressed'), 'false');
}

/* ── Lever: no fieldset, generated names ─────────────────────────────── */

section('Lever — questions that are only near their fields');
{
    const page = await open(`
      <form id="application-form">
        <ul>
          <li class="q"><label><div class="application-label">Are you legally authorized to work here?</div>
            <div class="application-field"><ul>
              <li><label><input type="radio" name="cards[a][field0]" value="Yes">Yes</label></li>
              <li><label><input type="radio" name="cards[a][field0]" value="No">No</label></li>
            </ul></div></label></li>
          <li class="q"><div class="application-label">Which university did you attend?</div>
            <div class="application-field"><select name="cards[b][field0]">
              <option value="">Select</option><option>MIT</option><option>Other</option></select></div></li>
          <li class="q"><div class="application-label">Language skill(s) ✱</div>
            <div class="application-field"><ul>
              <li><label><input type="checkbox" name="cards[c][field0]" required>English</label></li>
              <li><label><input type="checkbox" name="cards[c][field0]" required>Spanish</label></li>
              <li><label><input type="checkbox" name="cards[c][field0]" required>French</label></li>
            </ul></div></li>
          <li><label>Current location ✱<span>No location found. Try again</span><input name="location" type="text"></label></li>
        </ul>
      </form>`);
    const fields = await describeFields(page, '#application-form');
    const radios = fields.filter((f) => f.type === 'radio');
    check('same-named radios form one question', radios[0].groupLabel, 'Are you legally authorized to work here?');
    check('  not one called "Yes"', radios.every((r) => r.groupLabel !== 'Yes'), true);
    const select = fields.find((f) => f.tag === 'select');
    check('a select takes its question from the field\'s container', select.label, 'Which university did you attend?');

    const res = await fillForm(page, {
        profile, approvedAnswers: [], resumePath: null, typing: FAST, root: '#application-form',
    });
    const asked = res.unknown.map((u) => u.questionText);
    check('forty checkboxes would have been forty questions; this is one',
        asked.filter((q) => /language/i.test(q)).length, 1);
    check('  required only because the question itself is marked so, not the boxes',
        res.unknown.find((u) => /language/i.test(u.questionText)).required, true);
    check('  the question has no asterisk or status text in it',
        asked.some((q) => /✱|No location/.test(q)), false);
    check('the location was filled from the profile, label noise and all',
        res.qa.some((q) => q.answerText === 'Dallas'), true);
}

/* ── Greenhouse: the form is already open ────────────────────────────── */

section('Greenhouse — the form is on the page, so nothing is pressed to open it');
{
    const page = await open(`
      <button type="button" id="apply-top">Apply</button>
      <form id="application-form">
        <label for="first_name">First Name*</label><input id="first_name" aria-label="First Name" required>
        <label for="last_name">Last Name*</label><input id="last_name" aria-label="Last Name" required>
        <label for="email">Email*</label><input id="email" aria-label="Email" required>
        <input type="file" id="resume">
        <button type="submit">Submit application</button>
      </form>
      <script>window.__pressed = []; document.addEventListener('click', (e) => window.__pressed.push(e.target.textContent), true);</script>`);
    const tenant = { ...tenantFor('https://job-boards.greenhouse.io/acme/jobs/1'), verified: true };
    check('the host is recognised', tenant.system, 'GREENHOUSE');

    const res = await runApplyFlow(page, tenant, {
        profile, approvedAnswers: [], resumePath: null, typing: FAST,
    }, { canFill: true });
    check('three fields filled from the profile', res.qa.map((q) => q.questionText), ['First Name', 'Last Name', 'Email']);
    check('  and the form is left at its submit step', res.outcome, 'READY_TO_SUBMIT');
    const pressed = await page.evaluate(() => window.__pressed);
    check('  nothing was pressed to open the form', pressed.includes('Apply'), false);
    check('  and Submit was never pressed', pressed.includes('Submit application'), false);
}

/* ── which file box is the resume? ───────────────────────────────────── */

section('a form with an autofill box above the real resume field');
{
    const page = await open(`
      <div class="ashby-application-form-autofill-pane"><input type="file" id="auto"></div>
      <label for="_systemfield_resume">Resume</label><input type="file" id="_systemfield_resume">`);
    const box = await findResumeInput(page);
    check('the CV goes to the box called resume', await box.getAttribute('id'), '_systemfield_resume');
}
{
    const page = await open(`<input type="file" id="a"><input type="file" id="b">`);
    check('two unnamed boxes: none is chosen for a person', await findResumeInput(page), null);
}
{
    const page = await open(`<input type="file" id="only">`);
    check('one lone box is the resume box', await (await findResumeInput(page)).getAttribute('id'), 'only');
}
{
    const page = await open(`<div class="autofill"><input type="file" id="only"></div>`);
    check('a lone box that auto-fills the form is not fed a CV', await findResumeInput(page), null);
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
