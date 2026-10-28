/**
 * What kind of page is this — and the pages the model is never asked about.
 *
 *   node tests/pagekind.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyPage } = require('../src/main/agent/pageKind.js');
const { runAgent } = require('../src/main/agent/runAgent.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const obs = (o = {}) => ({
    url: 'https://x.io/apply', title: '', headings: [], errors: [], fields: [], controls: [], text: '', ...o,
});
const ctl = (...texts) => texts.map((text, i) => ({ ref: `c${i}`, kind: 'button', text }));
const fld = (n) => Array.from({ length: n }, (_, i) => ({ ref: `f${i}`, type: 'text', label: `Field ${i}`, value: '' }));

section('each kind of page is recognised from its own words');
check('a challenge outranks everything', classifyPage(obs({ challenge: true, fields: fld(5) })), 'CHALLENGE');
check('a verification-code page', classifyPage(obs({
    headings: ['Verify your email'], text: 'Enter the code we sent to you', fields: fld(1), controls: ctl('Verify'),
})), 'EMAIL_VERIFY');
check('  but a long form that mentions a code is not one', classifyPage(obs({
    text: 'We will send a verification code later', fields: fld(9), controls: ctl('Next'),
})), 'FORM_STEP');
check('a closed posting', classifyPage(obs({ headings: ['This job is no longer available'], controls: ctl('Back to jobs') })), 'CLOSED');
check('  not from running text about agencies', classifyPage(obs({
    text: 'We are not accepting applications from agencies.', controls: ctl('Apply'),
})), 'JOB_PAGE');
check('a login', classifyPage(obs({ passwordField: true, fields: fld(2) })), 'LOGIN');
check('a confirmation', classifyPage(obs({ headings: ['Thank you for applying'], text: 'We have received it' })), 'CONFIRMATION');
check('an error page', classifyPage(obs({ title: '404 Page not found' })), 'ERROR');
check('a posting with an apply button', classifyPage(obs({ controls: ctl('Apply now', 'Save job') })), 'JOB_PAGE');
check('a form step', classifyPage(obs({ fields: fld(4), controls: ctl('Save and continue', 'Back') })), 'FORM_STEP');
check('a final step with only a submit control', classifyPage(obs({ fields: fld(3), controls: ctl('Submit application') })), 'REVIEW');
check('nothing recognisable', classifyPage(obs({ text: 'Hello' })), 'UNKNOWN');

section('the agent loop does not spend a model call on them');
{
    let asked = 0;
    const hub = { agentStep: async () => { asked += 1; return { ok: false, detail: 'should not be called' }; } };
    const make = (o) => async () => ({ observation: obs(o), registry: new Map(), signature: JSON.stringify(o) });

    const closed = await runAgent({}, { hub, runId: 'r' }, {
        observe: make({ headings: ['This job is no longer available'], controls: ctl('Back') }),
        execute: async () => ({ ok: true }),
    });
    check('a closed posting ends as closed', closed.outcome, 'CLOSED');
    check('  with no model call', asked, 0);

    const gated = await runAgent({}, { hub, runId: 'r' }, {
        observe: make({ text: 'Enter the code we sent to your email', fields: fld(1), controls: ctl('Verify') }),
        execute: async () => ({ ok: true }),
    });
    check('a verification page with nobody to help is an account wall', [gated.outcome, gated.gateKind], ['ACCOUNT_WALL', 'EMAIL_VERIFY']);
    check('  still with no model call', asked, 0);

    let waited = 0;
    let seenKind = null;
    let calls = 0;
    const flip = async () => {
        calls += 1;
        // The first look is the verification page; once the person has dealt
        // with it, the page is something else and the loop asks the model.
        return calls <= 1
            ? { observation: obs({ text: 'Enter the code we sent to your email', fields: fld(1) }), registry: new Map(), signature: 'a' }
            : { observation: obs({ headings: ['Application'], fields: fld(2), controls: ctl('Next') }), registry: new Map(), signature: 'b' };
    };
    const cleared = await runAgent({}, {
        hub: { agentStep: async () => ({ ok: true, action: { action: 'stop', kind: 'blocked', reason: 'end' } }) },
        runId: 'r',
        waitForGate: async (_p, { kind }) => { waited += 1; seenKind = kind; return true; },
    }, { observe: flip, execute: async (_p, a) => ({ terminal: { outcome: 'BLOCKED', detail: a.reason } }) });
    check('with a person who clears it, the loop carries on', [waited, seenKind], [1, 'EMAIL_VERIFY']);
    check('  to the model, once the page is something else', cleared.outcome, 'BLOCKED');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
