/**
 * ── THE FILLER AGAINST REAL MARKUP ────────────────────────────────────
 *
 *   node tests/dom.mjs        (no hub, no network, no board account)
 *
 * run.mjs proves the filler's DECISIONS with fake field descriptors. This
 * proves the descriptors themselves, which is where the actual bugs were: the
 * page said one thing and `describeFields` reported another, so every rule
 * downstream was reasoning about a form that did not exist.
 *
 * ── WHY THE FIXTURES LOOK LIKE THAT ───────────────────────────────────
 *
 * The LinkedIn block below is not invented. It was read off a live Easy Apply
 * screening step with a probe and pasted here with only the class attributes
 * stripped — they are build-hashed and change between page loads, which is
 * exactly why nothing in the app may depend on them.
 *
 * It is worth keeping because three separate bugs lived in it at once:
 *
 *   · the native <input> is 0×0 and transparent, so `check()` could not click it
 *   · its <label for> is EMPTY, so the option's name had to come from the proxy
 *   · an unchecked radio still reports value "on", so every option looked
 *     already-answered and none of them was ever filled in
 *
 * A page served from a data: URL rather than a server: this needs a DOM, not a
 * network.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveBrowser } = require('../src/main/browser/engine.js');
const { describeFields, fillForm } = require('../src/main/browser/filler.js');
const {
    CLOSED_SELECTOR, EXTERNAL_SELECTOR, describeObstruction,
    dismissUploadToast, whichAppears,
} = require('../src/main/browser/applyFlow.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── fixtures ─────────────────────────────────────────────────────────── */

/**
 * What React does on the real page, in six lines.
 *
 * Without it the fixture is inert: clicking the proxy div moves nothing,
 * because the only thing connecting it to the hidden input is a handler. A
 * test that leaves that out is not testing the same page — it would report a
 * correct proxy click as a failure, which is exactly what it did first time.
 */
const PROXY_BEHAVIOUR = `<script>
  document.querySelectorAll('[role="radio"]').forEach((proxy) => {
    proxy.addEventListener('click', () => {
      const input = proxy.querySelector('input[type="radio"]');
      if (!input) return;
      document.querySelectorAll('input[name="' + input.name + '"]').forEach((s) => {
        s.checked = false;
        s.closest('[role="radio"]')?.setAttribute('aria-checked', 'false');
      });
      input.checked = true;
      proxy.setAttribute('aria-checked', 'true');
    });
  });
</script>`;

/**
 * A LinkedIn screening step, as measured. Two radio groups rather than the one
 * that was on screen, because the bug that merged groups only shows with two.
 */
const LINKEDIN = `
<div data-sdui-screen="com.linkedin.jobs.easyapply.Screen">
  <div>
    <p>We must fill this position urgently. Can you start immediately?*</p>
    <fieldset aria-describedby="error-message-a" role="radiogroup">
      <div>
        <div role="radio" tabindex="0" aria-label="Yes" aria-checked="false">
          <div><div><input id="«r10»" type="radio" name="radio-group-a"><label for="«r10»"></label></div><div><p>Yes</p></div></div>
        </div>
        <div role="radio" tabindex="0" aria-label="No" aria-checked="false">
          <div><div><input id="«r11»" type="radio" name="radio-group-a"><label for="«r11»"></label></div><div><p>No</p></div></div>
        </div>
      </div>
    </fieldset>
  </div>
  <div>
    <p>Have you completed the following level of education: Bachelor's Degree?*</p>
    <fieldset aria-describedby="error-message-b" role="radiogroup">
      <div>
        <div role="radio" tabindex="0" aria-label="Yes" aria-checked="false">
          <div><div><input id="«r12»" type="radio" name="radio-group-b"><label for="«r12»"></label></div><div><p>Yes</p></div></div>
        </div>
        <div role="radio" tabindex="0" aria-label="No" aria-checked="false">
          <div><div><input id="«r13»" type="radio" name="radio-group-b"><label for="«r13»"></label></div><div><p>No</p></div></div>
        </div>
      </div>
    </fieldset>
  </div>
  <div>
    <p>How many years of work experience do you have with React.js?*</p>
    <input id="«r14»" type="text" aria-label="How many years of work experience do you have with React.js?" maxlength="20">
  </div>
</div>
<style>
  /* As LinkedIn styles them: present, focusable, and impossible to click. */
  [role="radio"] input[type="radio"] { opacity: 0; width: 0; height: 0; display: block; }
</style>
${PROXY_BEHAVIOUR}`;

/** The resume step: a group the portal has already chosen for. */
const RESUME_STEP = `
<div data-sdui-screen="com.linkedin.jobs.easyapply.Screen">
  <p>Resume*</p>
  <fieldset role="radiogroup">
    <div role="radio" aria-label="vishwa_resume.pdf" aria-checked="true">
      <input id="«r20»" type="radio" name="radio-group-r" checked><label for="«r20»"></label>
    </div>
    <div role="radio" aria-label="older_resume.pdf" aria-checked="false">
      <input id="«r21»" type="radio" name="radio-group-r"><label for="«r21»"></label>
    </div>
  </fieldset>
</div>
<style>[role="radio"] input[type="radio"] { opacity: 0; width: 0; height: 0; display: block; }</style>
${PROXY_BEHAVIOUR}`;

/** An ordinary, well-behaved form. The proxy machinery must not disturb it. */
const PLAIN = `
<div id="app">
  <fieldset>
    <legend>Are you authorised to work in the United States?</legend>
    <label><input type="radio" name="auth" value="y"> Yes</label>
    <label><input type="radio" name="auth" value="n"> No</label>
  </fieldset>
  <label for="e">Email address</label><input id="e" type="email">
</div>`;

const NO_PAUSE = { minMs: 0, maxMs: 0, betweenFieldsMs: [0, 0] };
const profile = { name: 'Sai Dhanush', email: 'sd@example.com', phone: '+91 90000 00000' };

const load = async (browser, html) => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
    return page;
};

/* ── the run ──────────────────────────────────────────────────────────── */

const engine = resolveBrowser();
const browser = await engine.chromium.launch({ headless: true, ...engine.launchOptions });

try {
    section('a LinkedIn screening step is read correctly');

    let page = await load(browser, LINKEDIN);
    const root = '[data-sdui-screen*="jobs.easy"]';
    let fields = await describeFields(page, root);
    const radios = fields.filter((f) => f.type === 'radio');

    check('all four options are seen', radios.length, 4);
    check('each option is named by its proxy, not by the group id',
        radios.map((r) => r.label), ['Yes', 'No', 'Yes', 'No']);
    check('the question comes from the paragraph above the group',
        [...new Set(radios.map((r) => r.groupLabel))],
        ['We must fill this position urgently. Can you start immediately?*',
            "Have you completed the following level of education: Bachelor's Degree?*"]);
    check('the two questions are two groups, not one',
        new Set(radios.map((r) => r.groupKey)).size, 2);
    check('an unchecked radio is NOT reported as already answered',
        radios.some((r) => r.hasValue), false);
    check('the asterisk in the question makes the group required',
        radios.every((r) => r.required), true);
    check('a transparent 0x0 input is flagged as unclickable',
        radios.every((r) => r.hittable === false), true);
    check('  but it is still on screen, because its proxy is',
        radios.every((r) => r.visible), true);

    section('unanswered screening questions are reported, not guessed at');

    let out = await fillForm(page, {
        profile, approvedAnswers: [], resumePath: null, typing: NO_PAUSE, root,
    });
    check('both radio questions come back as unknown',
        out.unknown.filter((u) => u.fieldType === 'radio').map((u) => u.questionText),
        ['We must fill this position urgently. Can you start immediately?',
            "Have you completed the following level of education: Bachelor's Degree?"]);
    check('  the required marker is not part of the question',
        out.unknown.every((u) => !u.questionText.endsWith('*')), true);
    check('  and both are required, so the item parks',
        out.unknown.filter((u) => u.fieldType === 'radio').every((u) => u.required), true);
    check('nothing was ticked', await page.locator(`${root} input:checked`).count(), 0);

    section('answered questions are ticked on the real markup');

    page = await load(browser, LINKEDIN);
    out = await fillForm(page, {
        profile,
        approvedAnswers: [
            {
                question_text: 'We must fill this position urgently. Can you start immediately?',
                answer_text: 'Yes',
                question_id: 'Q1',
            },
            {
                question_text: "Have you completed the following level of education: Bachelor's Degree?",
                answer_text: 'No',
                question_id: 'Q2',
            },
            {
                question_text: 'How many years of work experience do you have with React.js?',
                answer_text: '3',
                question_id: 'Q3',
            },
        ],
        resumePath: null,
        typing: NO_PAUSE,
        root,
    });

    check('every question was answered', out.unknown.length, 0);
    check('the first group chose Yes',
        await page.locator('#\\«r10\\»').isChecked(), true);
    check('the second group chose No',
        await page.locator('#\\«r13\\»').isChecked(), true);
    check('  and did not also tick its Yes',
        await page.locator('#\\«r12\\»').isChecked(), false);
    check('the text question was typed',
        await page.locator('#\\«r14\\»').inputValue(), '3');
    check('the record says what was answered',
        out.qa.map((q) => [q.fieldType, q.answerText]),
        [['radio', 'Yes'], ['radio', 'No'], ['text', '3']]);

    section("a group the portal already chose for is left alone");

    page = await load(browser, RESUME_STEP);
    out = await fillForm(page, {
        profile, approvedAnswers: [], resumePath: null, typing: NO_PAUSE, root,
    });
    check('it is not asked about', out.unknown.length, 0);
    check('  and it is recorded as the portal’s own choice',
        out.qa.map((q) => [q.source, q.answerText]), [['PORTAL', 'vishwa_resume.pdf']]);
    check('  with the portal’s selection untouched',
        await page.locator('#\\«r20\\»').isChecked(), true);

    section('an ordinary form still behaves exactly as before');

    page = await load(browser, PLAIN);
    fields = await describeFields(page, '#app');
    const plain = fields.filter((f) => f.type === 'radio');
    check('the legend is the question',
        [...new Set(plain.map((f) => f.groupLabel))],
        ['Are you authorised to work in the United States?']);
    check('the wrapping label names the option', plain.map((f) => f.label), ['Yes', 'No']);
    check('a real radio is clickable as itself', plain.every((f) => f.hittable), true);

    out = await fillForm(page, {
        profile: { ...profile, work_auth: 'Yes' },
        approvedAnswers: [{
            question_text: 'Are you authorised to work in the United States?',
            answer_text: 'Yes',
            question_id: 'Q4',
        }],
        resumePath: null,
        typing: NO_PAUSE,
        root: '#app',
    });
    check('it is answered once', out.qa.filter((q) => q.fieldType === 'radio').length, 1);
    check('  with the right option', await page.locator('#app input[value="y"]').isChecked(), true);
    check('the profile still fills the email',
        await page.locator('#e').inputValue(), 'sd@example.com');
    section('a shut posting is told apart from one that applies elsewhere');

    // The three shapes a LinkedIn job page comes in, as seen on real listings.
    const CLOSED_PAGE = `<h1>React Js Developer</h1>
      <p>Responses managed off LinkedIn</p>
      <span>No longer accepting applications</span>`;
    const EXTERNAL_PAGE = `<h1>React Front end developer</h1>
      <button>Apply</button><button>Save</button>`;
    const EASY_PAGE = `<h1>Full Stack Developer</h1>
      <button aria-label="Easy Apply to Full Stack Developer">Easy Apply</button>`;

    page = await load(browser, CLOSED_PAGE);
    check('a closed posting is matched by its notice',
        await page.locator(CLOSED_SELECTOR).first().isVisible(), true);

    page = await load(browser, EXTERNAL_PAGE);
    check('an open posting is not', await page.locator(CLOSED_SELECTOR).count(), 0);
    check('  and its plain Apply button is found instead',
        await page.locator(EXTERNAL_SELECTOR).first().isVisible(), true);

    page = await load(browser, EASY_PAGE);
    check('an Easy Apply page is not mistaken for closed',
        await page.locator(CLOSED_SELECTOR).count(), 0);
    check('  and its own opener is what matches',
        await page.locator('button[aria-label*="Easy Apply" i]').count(), 1);

    section('a covered button is still pressed');

    // The "Resume uploaded successfully" bar, laid exactly over Review.
    page = await load(browser, `
      <div style="position:relative;height:200px">
        <button id="review" style="position:absolute;top:80px;left:0;width:200px;height:40px"
                onclick="window.__pressed=(window.__pressed||0)+1">Review</button>
        <div role="status" style="position:absolute;top:70px;left:0;width:300px;height:60px;background:#0a0">
          Resume uploaded successfully
        </div>
      </div>`);

    const review = page.locator('#review');
    check('an ordinary click is genuinely blocked',
        await review.click({ timeout: 1_500 }).then(() => 'clicked', () => 'blocked'), 'blocked');
    check('  and the obstruction can be named',
        await describeObstruction(review), 'Resume uploaded successfully');

    await review.focus();
    await review.press('Enter');
    check('  but the keyboard reaches it anyway',
        await page.evaluate(() => window.__pressed), 1);
    section('the upload message is closed, and only ever that');

    /**
     * The résumé step as it looks a second after an upload: the flow's own
     * Dismiss at the top, the confirmation bar at the bottom. Two X buttons on
     * one screen, and pressing the wrong one abandons the application.
     */
    const AFTER_UPLOAD = `
      <div data-sdui-screen="com.linkedin.jobs.easyapply.Screen">
        <button aria-label="Dismiss" onclick="window.__abandoned=true">×</button>
        <h2>Resume</h2>
        <div><button>Back</button><button>Review</button></div>
      </div>
      <div role="status">
        Resume uploaded successfully
        <button aria-label="Dismiss" onclick="this.closest('[role=status]').remove()">×</button>
      </div>`;

    page = await load(browser, AFTER_UPLOAD);
    check('the confirmation bar is closed',
        await dismissUploadToast(page), true);
    check('  it is really gone', await page.locator('[role="status"]').count(), 0);
    check('  and the application was NOT abandoned',
        await page.evaluate(() => window.__abandoned ?? false), false);
    check('  the flow’s own Dismiss is still there',
        await page.locator('[data-sdui-screen] button[aria-label="Dismiss"]').count(), 1);

    // The guard that does the work: a container holding Next/Review/Submit is
    // the flow itself, whatever else it says.
    page = await load(browser, `
      <div role="status">
        Resume uploaded successfully
        <button aria-label="Dismiss" onclick="window.__abandoned=true">×</button>
        <button>Review</button>
      </div>`);
    check('a "message" that also holds Review is left alone',
        await dismissUploadToast(page), false);
    check('  so nothing was pressed',
        await page.evaluate(() => window.__abandoned ?? false), false);

    // Nothing to close is not a failure.
    page = await load(browser, '<div role="status">Saving…</div>');
    check('an unrelated status message is not touched',
        await dismissUploadToast(page), false);

    section('the page decides its own verdict, however late it says so');

    // Exactly the shape that got this wrong: the notice is rendered by script
    // after load, so a glance taken on arrival sees an empty page.
    page = await load(browser, `
      <h1>React Js Developer</h1>
      <script>
        setTimeout(() => {
          const p = document.createElement('span');
          p.textContent = 'No longer accepting applications';
          document.body.appendChild(p);
        }, 1200);
      </script>`);
    check('a glance on arrival misses a notice that has not rendered',
        await page.locator(CLOSED_SELECTOR).count(), 0);
    check('  but the race waits for it',
        await whichAppears(page, {
            applied: 'button:has-text("Continue applying")',
            closed: CLOSED_SELECTOR,
            open: 'button[aria-label*="Easy Apply" i]',
        }, 5_000), 'closed');

    page = await load(browser, `
      <h1>Full Stack Developer</h1>
      <button aria-label="Easy Apply to Full Stack Developer">Easy Apply</button>`);
    check('an Easy Apply page answers "open"',
        await whichAppears(page, {
            applied: 'button:has-text("Continue applying")',
            closed: CLOSED_SELECTOR,
            open: 'button[aria-label*="Easy Apply" i]',
        }, 5_000), 'open');

    page = await load(browser, '<h1>A job</h1><button>Apply</button>');
    check('a page with none of them answers nothing at all',
        await whichAppears(page, {
            applied: 'button:has-text("Continue applying")',
            closed: CLOSED_SELECTOR,
            open: 'button[aria-label*="Easy Apply" i]',
        }, 2_000), null);
    check('  and its plain Apply is what gets found next',
        await page.locator(EXTERNAL_SELECTOR).first().isVisible(), true);
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
