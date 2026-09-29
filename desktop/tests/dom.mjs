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
    CLOSED_SELECTOR, EXTERNAL_SELECTOR, APPLIED_SELECTOR, describeObstruction,
    destinationOf,
    dismissUploadToast, whichAppears, runApplyFlow,
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

    section('a job that says "not currently accepting" is closed, not "applies elsewhere"');

    // Read off a real listing: LinkedIn's second wording for a shut job, and a
    // link wrapping the "people clicked apply" line that points back at the
    // very same job page. The first is what the closed check missed; the
    // second is what the generic Apply search then mistook for a hand-off, so
    // the AI agent opened it in a second, signed-out browser window.
    const NOT_CURRENTLY = `<h1>Senior DevOps Engineer</h1>
      <a href="/jobs/view/123/?trk=x"><span>Reposted 1 week ago · 26 people clicked apply</span></a>
      <div><span>Not currently accepting applications</span></div>`;
    const AGENCY_NOTE = `<h1>Platform Engineer</h1>
      <button aria-label="Easy Apply to Platform Engineer">Easy Apply</button>
      <p>Note: we are not accepting applications from staffing agencies.</p>`;
    const LINK_HOST = 'https://board.test';

    page = await load(browser, NOT_CURRENTLY);
    check('"Not currently accepting applications" is matched as closed',
        await page.locator(CLOSED_SELECTOR).first().isVisible(), true);

    page = await load(browser, AGENCY_NOTE);
    check('  a sentence that merely says "not accepting applications" is not',
        await page.locator(CLOSED_SELECTOR).count(), 0);

    // Served from a real address, so a link to "this same page" can be told
    // from a link somewhere else — a data: URL has no host to compare.
    const served = async (html, path = '/jobs/view/123/') => {
        const p = await (await browser.newContext()).newPage();
        await p.route(`${LINK_HOST}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
        await p.goto(`${LINK_HOST}${path}`);
        return p;
    };
    const board = { name: 'T', label: 'Test', loginUrl: `${LINK_HOST}/login`, apply: {
        open: '#no-such-open', dialog: '#no-such-dialog', next: '#n', submit: '#s',
    } };
    const flowOn = (p) => runApplyFlow(p, board, { profile: {}, approvedAnswers: [] }, { canFill: false });

    let served1 = await served(NOT_CURRENTLY);
    check('the whole flow calls it CLOSED, without waiting out the opener',
        (await flowOn(served1)).outcome, 'CLOSED');

    // With no closed notice at all, that same self-link must still not be
    // taken for somewhere to apply.
    const SELF_LINK_ONLY = `<h1>Senior DevOps Engineer</h1>
      <a href="/jobs/view/123/?trk=x"><span>26 people clicked apply</span></a>`;
    served1 = await served(SELF_LINK_ONLY);
    check('a link back to the same job is not an external apply',
        (await flowOn(served1)).outcome, 'NO_APPLY_FLOW');

    // …and the real thing keeps working, in both shapes it comes in.
    const BUTTON = '<h1>Dev</h1><button>Apply</button><button>Save</button>';
    check('a plain Apply button is still an external apply',
        (await flowOn(await served(BUTTON))).outcome, 'EXTERNAL_APPLY');

    const REDIRECT = `<h1>Dev</h1><a href="/jobs/view/externalApply/123?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F1">Apply</a>`;
    const viaRedirect = await flowOn(await served(REDIRECT));
    check('  so is the site’s own redirect to the employer', viaRedirect.outcome, 'EXTERNAL_APPLY');
    check('    with the link made absolute for whoever follows it',
        viaRedirect.externalUrl.startsWith(`${LINK_HOST}/jobs/view/externalApply/`), true);

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

    // The status block a finished application leaves behind, as measured on a
    // real applied job: no apply button anywhere on the page.
    page = await load(browser, `
      <h1>React and NextJS Developer</h1>
      <p>Application status</p><p>Application submitted</p><p>20 minutes ago</p>`);
    check('a finished application is matched by its status block',
        await whichAppears(page, {
            resumable: 'button:has-text("Continue applying")',
            applied: APPLIED_SELECTOR,
            closed: CLOSED_SELECTOR,
            open: 'button[aria-label*="Easy Apply" i]',
        }, 5_000), 'applied');
    check('  and an expired posting is still told apart from it',
        await page.locator(CLOSED_SELECTOR).count(), 0);

    page = await load(browser, `
      <h1>A job</h1><button aria-label="Easy Apply to A job">Easy Apply</button>`);
    check('an unapplied Easy Apply page matches neither',
        await page.locator(APPLIED_SELECTOR).count()
            + await page.locator(CLOSED_SELECTOR).count(), 0);

    page = await load(browser, '<h1>A job</h1><button>Apply</button>');
    check('a page with none of them answers nothing at all',
        await whichAppears(page, {
            applied: 'button:has-text("Continue applying")',
            closed: CLOSED_SELECTOR,
            open: 'button[aria-label*="Easy Apply" i]',
        }, 2_000), null);
    check('  and its plain Apply is what gets found next',
        await page.locator(EXTERNAL_SELECTOR).first().isVisible(), true);
    section('a Built In posting is classified from what it actually is');

    const { BOARDS } = require('../src/main/browser/boards.js');
    const BI = BOARDS.BUILTIN.apply;

    // Measured on a live Built In job: every apply control is this shape.
    page = await load(browser, `
      <h1>Senior React Native Mobile Developer</h1>
      <a aria-label="Apply to job" target="_blank"
         href="https://algoleap.zohorecruit.com/jobs/careers/66052300014716">APPLY</a>`);
    check('the hand-off link is found by its label',
        await page.locator(BI.externalApply).first().isVisible(), true);
    check('  and the system it leads to is named',
        await destinationOf(page.locator(BI.externalApply).first()), 'Zoho Recruit');
    check('Built In has no in-page flow to open',
        await page.locator(BI.open).count(), 0);

    for (const [host, expected] of [
        ['https://blackbaud.wd1.myworkdayjobs.com/ExternalCareers/job/x', 'Workday'],
        ['https://jobs.smartrecruiters.com/BlueSpireInc1/7439998459152', 'SmartRecruiters'],
        ['https://jobs.ashbyhq.com/plane/188f905e', 'Ashby'],
        ['https://techblocks.keka.com/careers/jobdetails/7637', 'Keka'],
        // Not a system anybody has heard of — reported as itself rather than
        // guessed at.
        ['http://careers.hupcfl.com/apply/k3eToF4RNb', 'careers.hupcfl.com'],
    ]) {
        page = await load(browser, `<a aria-label="Apply to job" href="${host}">APPLY</a>`);
        check(`  ${expected}`,
            await destinationOf(page.locator(BI.externalApply).first()), expected);
    }

    // A control with no link at all is not a destination.
    page = await load(browser, '<button>Apply</button>');
    check('a button with no href names nowhere',
        await destinationOf(page.locator('button').first()), null);

    // Built In's own wording for a dead posting, measured.
    page = await load(browser, `
      <h1>React Developer</h1>
      <p>Sorry, this job was removed at 08:23 p.m. (UTC) on Tuesday, Aug 11, 2026</p>`);
    check('a removed Built In posting reads as expired',
        await page.locator(CLOSED_SELECTOR).first().isVisible(), true);

    section('Workday’s own gate, mid-flow, as measured on a live tenant');

    const WD_APPLY = require('../src/main/browser/destinations.js').DESTINATIONS.WORKDAY.apply;

    // Read off a real "Apply Manually" click: Email Address, Password, Verify
    // New Password, and a honeypot with no visible label -- a field meant to
    // trap a script that fills every input it can find, and never a person.
    const WORKDAY_GATE = `
      <h1>Application Engineer - III</h1>
      <h2>Create Account</h2>
      <label>Email Address*<input type="text" data-automation-id="email"></label>
      <label>Password*<input type="password" data-automation-id="password"></label>
      <label>Verify New Password*<input type="password" data-automation-id="verifyPassword"></label>
      <input type="text" data-automation-id="beecatcher"
             aria-label="Enter website. This input is for robots only, do not enter anything here.">
      <button>Sign In</button>
      <button>Create Account</button>`;

    page = await load(browser, WORKDAY_GATE);
    check('the gate is recognised by its password field',
        await page.locator(WD_APPLY.accountWall).count() > 0, true);

    const gateFields = await describeFields(page);
    const honeypot = gateFields.find((f) => f.label?.toLowerCase().includes('robots'));
    check('the honeypot is on the page, named by its aria-label',
        Boolean(honeypot), true);

    // `fillForm` alone has no idea this page is a gate rather than a real
    // step -- that judgement is `runApplyFlow`'s (proven in run.mjs: nothing
    // past an accountWall is ever touched, because `fillForm` is never even
    // called while one is showing). What IS a `fillForm`-level guarantee,
    // holding regardless of context, is R-18's absolute refusal of a password
    // field, and never inventing a value for an unlabelled honeypot.
    const outOfGate = await fillForm(page, {
        profile: { name: 'Sai Dhanush', email: 'sd@example.com' },
        approvedAnswers: [], resumePath: null, typing: NO_PAUSE,
    });
    check('the honeypot is never filled, even though nothing marks it as one to a script',
        await page.locator('[data-automation-id="beecatcher"]').inputValue(), '');
    check('neither password field is ever touched (R-18)',
        outOfGate.refusals.filter((r) => /password/i.test(r.reason)).length, 2);

    // The real "My Information" step that follows has no password field at
    // all -- which is exactly why `password`, not `email`, is what the
    // selector keys off. An `email`-based check would misfire here the moment
    // a later step legitimately asked for one.
    const MY_INFORMATION = `
      <h1>My Information</h1>
      <label>Given Name(s)*<input type="text" data-automation-id="legalNameSection_firstName"></label>
      <label>Family Name*<input type="text" data-automation-id="legalNameSection_lastName"></label>
      <label>Phone Number*<input type="text" data-automation-id="phone-number"></label>
      <button>Save and Continue</button>`;
    page = await load(browser, MY_INFORMATION);
    check('the real information step is never mistaken for the gate',
        await page.locator(WD_APPLY.accountWall).count(), 0);
    section('Workday dropdowns, as measured on a live application');

    /**
     * Read off a real Workday "My Information" step. The accessible name runs
     * the question, the current value and sometimes "Required" together, and
     * the listbox is rendered in a portal at the end of <body> — not inside
     * the control, and not inside the form.
     */
    const WORKDAY_DROPDOWNS = `
      <div data-automation-id="applyFlowPage">
        <button aria-haspopup="listbox" aria-label="Country India Required">India</button>
        <button aria-haspopup="listbox" aria-label="State Select One">Select One</button>
        <button aria-haspopup="listbox" aria-label="Phone Device Type Mobile Required">Mobile</button>
        <label for="pc">Postal Code</label><input id="pc" value="502319">
      </div>
      <div id="portal"></div>
      <script>
        // What Workday does: open a listbox elsewhere in the document, and
        // write the chosen option back onto the button.
        const STATES = ['Select One', 'Andhra Pradesh', 'Assam', 'Delhi', 'Telangāna'];
        document.querySelectorAll('button[aria-haspopup="listbox"]').forEach((b) => {
          b.addEventListener('click', () => {
            const portal = document.getElementById('portal');
            portal.innerHTML = '';
            const lb = document.createElement('div');
            lb.setAttribute('role', 'listbox');
            for (const t of STATES) {
              const o = document.createElement('div');
              o.setAttribute('role', 'option');
              o.textContent = t;
              o.addEventListener('click', () => {
                b.textContent = t;
                b.setAttribute('aria-label',
                  b.getAttribute('aria-label').split(' ')[0] + ' ' + t);
                portal.innerHTML = '';
              });
              lb.appendChild(o);
            }
            portal.appendChild(lb);
          });
        });
      </script>`;

    page = await load(browser, WORKDAY_DROPDOWNS);
    const wdRoot = '[data-automation-id="applyFlowPage"]';
    let wdFields = await describeFields(page, wdRoot);
    const drops = wdFields.filter((f) => f.type === 'dropdown');

    check('all three dropdowns are seen at all', drops.length, 3);
    check('the question is peeled out of the accessible name',
        drops.map((d) => d.label), ['Country', 'State', 'Phone Device Type']);
    check('a chosen value reads as the value',
        drops.find((d) => d.label === 'Country')?.value, 'India');
    check('"Select One" reads as EMPTY, not as an answer',
        drops.find((d) => d.label === 'State')?.hasValue, false);
    check('  which is what stops it being skipped as already-answered',
        drops.find((d) => d.label === 'State')?.value, '');
    check('"Required" in the name makes it required',
        drops.filter((d) => d.required).map((d) => d.label), ['Country', 'Phone Device Type']);

    // Filling: the answered one is chosen, the unanswerable one is reported.
    out = await fillForm(page, {
        profile,
        approvedAnswers: [{ question_text: 'State', answer_text: 'Telangāna', question_id: 'S1' }],
        resumePath: null,
        typing: NO_PAUSE,
        root: wdRoot,
    });

    check('the dropdown with an answer is chosen from',
        await page.locator('button[aria-label^="State"]').innerText(), 'Telangāna');
    check('  and recorded as a real answer',
        out.qa.find((q) => q.questionText === 'State')?.answerText, 'Telangāna');
    check('a dropdown the portal already set is left alone, with its value shown',
        out.qa.find((q) => q.questionText === 'Country')?.answerText, 'India');
    // Already reading "Mobile", so the portal has answered it -- the same rule
    // as any pre-filled field, and the reason it is recorded rather than asked.
    check('a dropdown the portal set is recorded with its value',
        out.qa.find((q) => q.questionText === 'Phone Device Type')?.answerText, 'Mobile');
    check('  and left untouched',
        await page.locator('button[aria-label^="Phone"]').innerText(), 'Mobile');

    // An answer that matches nothing in the list must choose NOTHING — a wrong
    // state on somebody's application is worse than an empty one.
    page = await load(browser, WORKDAY_DROPDOWNS);
    out = await fillForm(page, {
        profile,
        approvedAnswers: [{ question_text: 'State', answer_text: 'Atlantis', question_id: 'S2' }],
        resumePath: null,
        typing: NO_PAUSE,
        root: wdRoot,
    });
    check('an answer matching no option chooses nothing',
        await page.locator('button[aria-label^="State"]').innerText(), 'Select One');
    check('  and is reported as unanswered instead',
        out.unknown.some((u) => u.questionText === 'State'), true);

    section('one answer creating the next question');

    /**
     * Workday's cascade: choosing a Country rebuilds the step with a State
     * dropdown that did not exist before. The pass that caused it cannot see
     * it, because `fillForm` reads the whole step once and then acts.
     */
    const CASCADE = `
      <div data-automation-id="applyFlowPage">
        <button id="c" aria-haspopup="listbox" aria-label="Country Select One">Select One</button>
        <div id="grown"></div>
        <button id="next">Save and Continue</button>
      </div>
      <div id="portal"></div>
      <script>
        const open = (btn, items, onPick) => btn.addEventListener('click', () => {
          const portal = document.getElementById('portal');
          portal.innerHTML = '';
          const lb = document.createElement('div');
          lb.setAttribute('role', 'listbox');
          for (const t of items) {
            const o = document.createElement('div');
            o.setAttribute('role', 'option');
            o.textContent = t;
            o.addEventListener('click', () => {
              btn.textContent = t;
              btn.setAttribute('aria-label',
                btn.getAttribute('aria-label').replace(/ .*$/, '') + ' ' + t);
              portal.innerHTML = '';
              onPick(t);
            });
            lb.appendChild(o);
          }
          portal.appendChild(lb);
        });

        open(document.getElementById('c'), ['Select One', 'India', 'Canada'], (picked) => {
          // Answering Country GROWS the State dropdown.
          if (picked !== 'India') return;
          const grown = document.getElementById('grown');
          grown.innerHTML =
            '<button id="s" aria-haspopup="listbox" aria-label="State Select One">Select One</button>';
          open(document.getElementById('s'), ['Select One', 'Telangāna', 'Delhi'], () => {});
        });
      </script>`;

    page = await load(browser, CASCADE);
    const cascadeRoot = '[data-automation-id="applyFlowPage"]';

    // One pass sees only Country — the proof that a second pass is needed.
    let onePass = await fillForm(page, {
        profile,
        approvedAnswers: [
            { question_text: 'Country', answer_text: 'India', question_id: 'C1' },
            { question_text: 'State', answer_text: 'Telangāna', question_id: 'S1' },
        ],
        resumePath: null, typing: NO_PAUSE, root: cascadeRoot,
    });
    check('a single pass answers only what was on screen when it started',
        onePass.qa.map((q) => q.questionText), ['Country']);
    check('  and the field it created is left unanswered',
        await page.locator('#s').innerText(), 'Select One');

    // The flow goes round again, so the grown field is answered too.
    page = await load(browser, CASCADE);
    const cascadeBoard = {
        name: 'CASCADE',
        label: 'Cascade Test',
        apply: {
            open: '#nothing', dialog: cascadeRoot,
            next: '#next', submit: '#nothing-submits', maxSteps: 1,
        },
    };
    // `runApplyFlow` expects to open the flow itself; this drives its step loop
    // directly by pointing `open` at something already present.
    cascadeBoard.apply.open = cascadeRoot;

    const cascaded = await runApplyFlow(page, cascadeBoard, {
        profile,
        approvedAnswers: [
            { question_text: 'Country', answer_text: 'India', question_id: 'C1' },
            { question_text: 'State', answer_text: 'Telangāna', question_id: 'S1' },
        ],
        resumePath: null,
    }, { canFill: true });

    check('the flow re-reads the step and answers what appeared',
        await page.locator('#s').innerText(), 'Telangāna');
    check('  and both answers are recorded',
        cascaded.qa.filter((q) => q.fieldType === 'dropdown').map((q) => q.answerText).sort(),
        ['India', 'Telangāna']);

    section('Workday\u2019s "How Did You Hear About Us?" prompt');

    /**
     * Measured on a live Syneos application. The control is an <input> with a
     * "Search" placeholder inside a multiselect widget — so the filler used to
     * TYPE into it, which filters the list and selects nothing. The widget then
     * still reads "0 items selected" and the form refuses to move.
     *
     * Two levels deep: every category opens a list of specific sources.
     */
    const PROMPT = `
      <div data-automation-id="applyFlowPage">
        <div data-automation-id="formField-source">
          <label for="source--source"><span>How Did You Hear About Us?<abbr>*</abbr></span></label>
          <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
            <div data-automation-id="multiselectInputContainer">
              <input id="source--source" data-uxi-widget-type="selectinput"
                     placeholder="Search" aria-required="true" value="">
              <div data-automation-id="promptSelectionLabel"></div>
              <div data-automation-id="promptAriaInstruction">0 items selected</div>
            </div>
          </div>
        </div>
      </div>
      <div id="portal"></div>
      <script>
        const SOURCES = {
          'Employee Referral': ['A colleague', 'A friend'],
          'Job Board': ['LinkedIn', 'Indeed', 'Built In'],
          'Website': ['Careers site'],
        };
        const show = (items, onPick) => {
          const portal = document.getElementById('portal');
          portal.innerHTML = '';
          const lb = document.createElement('div');
          lb.setAttribute('role', 'listbox');
          lb.setAttribute('data-automation-id', 'activeListContainer');
          for (const t of items) {
            const o = document.createElement('div');
            o.setAttribute('role', 'option');
            o.setAttribute('data-automation-id', 'menuItem');
            o.textContent = t;
            o.addEventListener('click', () => onPick(t));
            lb.appendChild(o);
          }
          portal.appendChild(lb);
        };
        const input = document.getElementById('source--source');
        const chosenLabel = document.querySelector('[data-automation-id="promptSelectionLabel"]');
        input.addEventListener('click', () => {
          show(Object.keys(SOURCES), (cat) => {
            // A CATEGORY selects nothing on its own — it opens the next list.
            show(SOURCES[cat], (leaf) => {
              chosenLabel.textContent = cat + ' > ' + leaf;
              document.getElementById('portal').innerHTML = '';
            });
          });
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.getElementById('portal').innerHTML = '';
        });
      </script>`;

    page = await load(browser, PROMPT);
    const promptRoot = '[data-automation-id="applyFlowPage"]';
    let promptFields = await describeFields(page, promptRoot);
    const prompt = promptFields.find((f) => f.label.startsWith('How Did You Hear'));

    check('the search box is understood as a dropdown, not a text field',
        prompt?.type, 'dropdown');
    check('  its question comes straight from its own <label>',
        prompt?.label, 'How Did You Hear About Us?*');
    check('  nothing chosen reads as empty', prompt?.hasValue, false);
    check('  and aria-required makes it required', prompt?.required, true);

    // A one-level answer cannot finish a two-level prompt, and saying so is
    // better than leaving a category selected that the form will reject.
    out = await fillForm(page, {
        profile,
        approvedAnswers: [{
            question_text: 'How Did You Hear About Us?', answer_text: 'Job Board', question_id: 'H1',
        }],
        resumePath: null, typing: NO_PAUSE, root: promptRoot,
    });
    check('a half-answer to a two-level prompt is reported, not left half-made',
        out.unknown.some((u) => u.questionText.startsWith('How Did You Hear')), true);
    check('  and nothing was left selected',
        await page.locator('[data-automation-id="promptSelectionLabel"]').innerText(), '');

    // The path form walks both levels.
    page = await load(browser, PROMPT);
    out = await fillForm(page, {
        profile,
        approvedAnswers: [{
            question_text: 'How Did You Hear About Us?',
            answer_text: 'Job Board > LinkedIn',
            question_id: 'H2',
        }],
        resumePath: null, typing: NO_PAUSE, root: promptRoot,
    });
    check('an answer naming the path walks both lists',
        await page.locator('[data-automation-id="promptSelectionLabel"]').innerText(),
        'Job Board > LinkedIn');
    check('  and is recorded as what was actually chosen',
        out.qa.find((q) => q.questionText.startsWith('How Did You Hear'))?.answerText,
        'Job Board > LinkedIn');
    check('  with nothing left unanswered', out.unknown.length, 0);

    // A path whose second step does not exist must choose nothing at all.
    page = await load(browser, PROMPT);
    out = await fillForm(page, {
        profile,
        approvedAnswers: [{
            question_text: 'How Did You Hear About Us?',
            answer_text: 'Job Board > Monster',
            question_id: 'H3',
        }],
        resumePath: null, typing: NO_PAUSE, root: promptRoot,
    });
    check('a path that dead-ends selects nothing',
        await page.locator('[data-automation-id="promptSelectionLabel"]').innerText(), '');
    check('  and is reported as unanswered',
        out.unknown.some((u) => u.questionText.startsWith('How Did You Hear')), true);

    /* ── the AI agent, against real markup ────────────────────────── */

    /**
     * Every earlier section leaves its pages open, and by this point in the
     * suite that is a lot of Chromium. These sections close the page they are
     * done with before opening the next, so adding them does not tip a machine
     * with little free memory into a crashed renderer.
     */
    const swap = async (next) => {
        await page?.close().catch(() => {});
        page = await next();
        return page;
    };

    const { observe } = require('../src/main/agent/observe.js');
    const { executeAction, pressAgentSubmit } = require('../src/main/agent/actions.js');
    const { runAgent } = require('../src/main/agent/runAgent.js');
    const { buildAnswerBook } = require('../src/main/browser/answers.js');

    /** A career-site form no recipe knows: every kind of field, and two traps. */
    const AGENT_FORM = `
      <main>
        <h1>Apply — Data Engineer</h1>
        <form id="apply" onsubmit="event.preventDefault(); document.body.dataset.sent = '1';
            const p = document.createElement('p'); p.textContent = 'Thank you for applying';
            document.body.appendChild(p);">
          <label for="fn">First name *</label><input id="fn" name="fn" required>
          <label for="em">Email *</label><input id="em" name="em" type="email" required value="already@portal.example">
          <fieldset>
            <legend>Are you legally authorised to work in the United States? *</legend>
            <label><input type="radio" name="auth" value="y"> Yes</label>
            <label><input type="radio" name="auth" value="n"> No</label>
          </fieldset>
          <label for="yrs">How many years have you worked with React.js?</label>
          <select id="yrs"><option value="">Select…</option><option>0-2</option><option>3-5</option><option>6+</option></select>
          <label for="cv">Resume</label><input id="cv" type="file">
          <label for="pw">Create a password</label><input id="pw" type="password">
          <button type="button" id="next">Next</button>
          <button type="submit" id="send">Submit application</button>
        </form>
        <a href="/logout">Sign out</a>
      </main>`;

    const approved = [
        { question_id: 'q-auth', question_text: 'Are you authorized to work in the US?', answer_text: 'Yes' },
        { question_id: 'q-react', question_text: 'Years of experience with React', answer_text: '3-5' },
    ];
    const agentProfile = { name: 'Sai Dhanush', email: 'sd@example.com', phone: '+91 90000 00000' };
    const byLabel = (s, re) => s.observation.fields.find((f) => re.test(f.label));
    const ctl = (s, re) => s.observation.controls.find((c) => re.test(c.text));
    const ctxFor = (s, extra = {}) => ({
        registry: s.registry,
        errors: s.observation.errors,
        book: buildAnswerBook({ profile: agentProfile, approvedAnswers: approved }),
        approvedAnswers: approved,
        resumePath: null,
        attachedResume: false,
        filledCount: 0,
        typing: NO_PAUSE,
        ...extra,
    });
    const doIt = (s, action, extra) => executeAction(page, {
        ref: '', source: '', refs: [], kind: '', reason: '', ...action,
    }, ctxFor(s, extra));

    section('AI agent — what it sees');

    await swap(() => load(browser, AGENT_FORM));
    let seen = await observe(page);
    check('every field on the form is described',
        ['First name', 'Email', 'authorised', 'React', 'Resume', 'password']
            .every((w) => seen.observation.fields.some((f) => f.label.includes(w))), true);
    check('a radio group is ONE question with its options', byLabel(seen, /authorised/)?.options, ['Yes', 'No']);
    check('  marked required', byLabel(seen, /authorised/)?.required, true);
    check('a select brings its options', byLabel(seen, /React/)?.options, ['Select…', '0-2', '3-5', '6+']);
    check('a pre-filled text field says only that it is filled', byLabel(seen, /Email/)?.value, '(filled)');
    check('  its contents appear nowhere in what the model is sent',
        JSON.stringify(seen.observation).includes('already@portal.example'), false);
    check('a password field is flagged', seen.observation.passwordField, true);
    check('controls are listed by what they say',
        [Boolean(ctl(seen, /^Next$/)), Boolean(ctl(seen, /Submit application/)), Boolean(ctl(seen, /Sign out/))],
        [true, true, true]);
    const again = await observe(page);
    check('refs survive a second look', byLabel(again, /First name/)?.ref, byLabel(seen, /First name/)?.ref);

    section('AI agent — what its hands will and will not do');

    let r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /First name/).ref, source: 'profile:firstName' });
    check('a profile value goes into the field it was pointed at', [r.ok, await page.inputValue('#fn')], [true, 'Sai']);
    check('  recorded as the agent’s match', [r.qa?.source, r.qa?.matchedBy], ['PROFILE', 'AGENT']);

    seen = await observe(page);
    r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /First name/).ref, source: 'profile:lastName' });
    check('a field that already holds something is left alone', [r.ok, await page.inputValue('#fn')], [false, 'Sai']);

    r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /React/).ref, source: 'answer:not-a-real-id' });
    check('an answer this consultant does not have is refused', [r.ok, await page.inputValue('#yrs')], [false, '']);

    r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /password/).ref, source: 'profile:email' });
    check('a password field is never filled (R-18)', [r.ok, await page.inputValue('#pw')], [false, '']);

    r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /authorised/).ref, source: 'answer:q-auth' });
    check('a differently-worded approved answer picks the radio option',
        [r.ok, await page.isChecked('input[name=auth][value=y]')], [true, true]);

    r = await doIt(seen, { action: 'fill', ref: byLabel(seen, /React/).ref, source: 'answer:q-react' });
    check('  and the matching option in a select', [r.ok, await page.inputValue('#yrs')], [true, '3-5']);

    seen = await observe(page);
    r = await doIt(seen, { action: 'press', ref: ctl(seen, /Submit application/).ref }, { filledCount: 3 });
    check('a submit button is never pressed by the agent',
        [r.ok, await page.evaluate(() => document.body.dataset.sent ?? null)], [false, null]);
    r = await doIt(seen, { action: 'press', ref: ctl(seen, /Sign out/).ref });
    check('nor is signing out', r.ok, false);

    r = await doIt(seen, { action: 'ask_human', refs: [byLabel(seen, /React/).ref] });
    check('ask_human hands a question over with its options',
        [r.terminal?.outcome, (r.terminal?.unknown?.[0]?.options ?? []).includes('3-5')], ['INCOMPLETE', true]);

    const resumeFile = require('node:path').join(require('node:os').tmpdir(), `sa-agent-${Date.now()}.pdf`);
    require('node:fs').writeFileSync(resumeFile, '%PDF-1.4 test');
    r = await doIt(seen, { action: 'upload_resume', ref: byLabel(seen, /Resume/).ref });
    check('no resume for the job means nothing is uploaded', r.ok, false);
    r = await doIt(seen, { action: 'upload_resume', ref: byLabel(seen, /Resume/).ref }, { resumePath: resumeFile });
    check('  with one, it goes into the file field',
        [r.ok, await page.evaluate(() => document.getElementById('cv').files.length)], [true, 1]);

    await swap(() => load(browser, AGENT_FORM));
    seen = await observe(page);
    r = await doIt(seen, { action: 'ready', ref: ctl(seen, /Submit application/).ref });
    check('"ready" is not believed while required fields are empty',
        [r.ok, /First name/.test(r.error ?? '')], [false, true]);
    await page.fill('#fn', 'Sai');
    await page.check('input[name=auth][value=y]');
    seen = await observe(page);
    r = await doIt(seen, { action: 'ready', ref: ctl(seen, /^Next$/).ref });
    check('  nor when the button it names does not send anything', r.ok, false);
    r = await doIt(seen, { action: 'ready', ref: ctl(seen, /Submit application/).ref });
    check('  and is, once the page agrees', r.terminal?.outcome, 'READY_TO_SUBMIT');

    await swap(() => load(browser, `
      <main><h1>Data Engineer</h1><p>A great job.</p>
        <button id="go" onclick="document.body.dataset.opened = '1'">Apply now</button></main>`));
    seen = await observe(page);
    r = await doIt(seen, { action: 'press', ref: ctl(seen, /Apply now/).ref }, { filledCount: 0 });
    check('"Apply now" on a job page is pressed, to open the form',
        [r.ok, await page.evaluate(() => document.body.dataset.opened ?? null)], [true, '1']);
    r = await doIt(await observe(page), { action: 'press', ref: ctl(seen, /Apply now/).ref }, { filledCount: 2 });
    check('  but not once answers are in, when it could send them', r.ok, false);

    section('AI agent — a form inside an iframe');

    await swap(() => browser.newPage());
    await page.route('https://jobs.example.test/**', (route) => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><html><body>${AGENT_FORM}</body></html>`,
    }));
    await page.route('https://careers.example.test/**', (route) => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><h1>Careers</h1>'
            + '<iframe src="https://jobs.example.test/embed" width="900" height="900"></iframe></body></html>',
    }));
    await page.goto('https://careers.example.test/job/1');
    await page.frameLocator('iframe').locator('#fn').waitFor();
    seen = await observe(page);
    const framed = byLabel(seen, /First name/);
    check('fields inside an embedded application are seen', Boolean(framed), true);
    check('  with a ref that names their frame', String(framed?.ref).startsWith('F1'), true);
    r = await doIt(seen, { action: 'fill', ref: framed.ref, source: 'profile:firstName' });
    check('  and can be filled there',
        [r.ok, await page.frameLocator('iframe').locator('#fn').inputValue()], [true, 'Sai']);

    section('AI agent — the whole loop, on a two-step form');

    const TWO_STEP = `
      <main>
        <form id="apply" onsubmit="event.preventDefault(); document.body.dataset.sent = '1';
            const p = document.createElement('p'); p.textContent = 'Thank you for applying';
            document.body.appendChild(p);">
          <div id="s1">
            <h2>Your details</h2>
            <label for="fn">First name *</label><input id="fn" required>
            <label for="em">Email *</label><input id="em" type="email" required>
            <button type="button" onclick="document.getElementById('s1').style.display = 'none';
                document.getElementById('s2').style.display = 'block';">Next</button>
          </div>
          <div id="s2" style="display:none">
            <h2>Eligibility</h2>
            <fieldset><legend>Are you legally authorised to work in the United States? *</legend>
              <label><input type="radio" name="auth" value="y"> Yes</label>
              <label><input type="radio" name="auth" value="n"> No</label></fieldset>
            <button type="submit">Submit application</button>
          </div>
        </form>
      </main>`;

    // Stands in for the model: a small rule over the same observation the
    // real one reads. What is under test is everything around it.
    const policy = (o) => {
        const act = (action, ref, source = '') => ({
            ok: true, action: { action, ref, source, refs: [], kind: '', reason: action },
        });
        const empty = o.fields.find((f) => f.required && !f.value);
        if (empty && /first name/i.test(empty.label)) return act('fill', empty.ref, 'profile:firstName');
        if (empty && /email/i.test(empty.label)) return act('fill', empty.ref, 'profile:email');
        if (empty && /authorised/i.test(empty.label)) return act('fill', empty.ref, 'answer:q-auth');
        const next = o.controls.find((c) => /^next$/i.test(c.text));
        if (next) return act('press', next.ref);
        return act('ready', o.controls.find((c) => /submit/i.test(c.text))?.ref ?? '');
    };
    const sentToHub = [];
    const policyHub = {
        agentStep: async (runId, body) => { sentToHub.push(body.observation); return policy(body.observation); },
    };

    await swap(() => load(browser, TWO_STEP));
    const agentRun = await runAgent(page, {
        hub: policyHub,
        runId: 'dom-run',
        fillOptions: { profile: agentProfile, approvedAnswers: approved, resumePath: null },
        typing: NO_PAUSE,
    });
    check('the agent walks a two-step form to its submit button', agentRun.outcome, 'READY_TO_SUBMIT');
    check('  filling the name, the email and the eligibility question',
        agentRun.qa.map((q) => q.answerText), ['Sai', 'sd@example.com', 'Yes']);
    check('  and sending nothing', await page.evaluate(() => document.body.dataset.sent ?? null), null);
    check('  the model never saw the consultant’s email',
        sentToHub.some((o) => JSON.stringify(o).includes('sd@example.com')), false);

    const pressed = await pressAgentSubmit(page, agentRun.submit);
    check('pressing the submit button it found sends the application',
        [pressed.ok, await page.evaluate(() => document.body.dataset.sent ?? null)], [true, '1']);
    check('  and the thank-you is read as confirmation', pressed.confirmed, true);

    section('the review screen shows what was actually filled in');

    page = await load(browser, `
      <div id="app">
        <label for="em">Email address</label><input id="em" value="sd@example.com">
        <label for="pw">Password</label><input id="pw" type="password" value="hunter2">
      </div>`);
    out = await fillForm(page, {
        profile: {}, approvedAnswers: [], resumePath: null, typing: NO_PAUSE, root: '#app',
    });
    check('a portal-filled field reports its VALUE, not a note about itself',
        out.qa.find((q) => /email/i.test(q.questionText))?.answerText, 'sd@example.com');
    check('and a password is still never carried anywhere (R-18)',
        out.qa.some((q) => /hunter2/.test(q.answerText ?? '')), false);
} finally {
    await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
