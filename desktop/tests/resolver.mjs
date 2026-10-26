/**
 * The answer resolver — what the app will and will not type.
 *
 *   node tests/resolver.mjs
 *
 * Pure string work, like the rest of answers.js. The cases that matter most are
 * the ones that must NOT answer: a wrong "years of experience" or a stranger's
 * job title in a work-history row goes onto a real application.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    buildAnswerBook, resolveAnswer, resolveEeo,
} = require('../src/main/browser/answers.js');

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const profile = {
    name: 'Ada Lovelace', email: 'ada@x.io', phone: '5550101234', city: 'Dallas', state: 'TX',
    linkedin_url: 'https://linkedin.com/in/ada', github_url: 'https://github.com/ada',
    portfolio_url: 'https://ada.dev', headline: 'Engineer',
    current_company: 'Acme', current_title: 'Staff Engineer', school: 'MIT', degree: 'BS Computer Science',
    field_of_study: 'Computer Science', education_level: "Bachelor's Degree", graduation_year: 2014,
    total_years: 9,
    skills: [
        { name: 'React', years: 5 }, { name: 'Node.js', years: 6 }, { name: 'Python', years: 5 },
        { name: 'Go', years: null }, { name: 'C++', years: 3 }, { name: 'Java', years: 4 },
    ],
};
const book = buildAnswerBook({ profile });
const ask = (q, b = book) => resolveAnswer(q, b)?.value ?? null;

section('new profile facts are answered by whole phrases');
check('GitHub', ask('GitHub URL'), 'https://github.com/ada');
check('portfolio', ask('Portfolio'), 'https://ada.dev');
check('current employer', ask('Current employer'), 'Acme');
check('current job title', ask('Current job title'), 'Staff Engineer');
check('school', ask('University'), 'MIT');
check('field of study', ask('Field of study'), 'Computer Science');
check('education level', ask('Highest level of education'), "Bachelor's Degree");
check('graduation year', ask('Graduation year'), 2014);
check('total experience', ask('Total years of experience'), 9);

section('and NOT by a looser guess');
check('a bare "Job title" is one row of a history, not the current job', ask('Job title'), null);
check('a bare "Company" likewise', ask('Company'), null);
check('"Company website" is not the portfolio', ask('Company website'), null);
check('phone country code is still not a phone number', ask('Phone country code'), null);

section('years of a named skill come from the consultant\'s own figure');
check('React', ask('How many years of experience do you have with React?'), '5');
check('worded the other way', ask('Years of experience in Node.js'), '6');
check('Python', ask('Years of Python experience using Python'), '5');
check('two skills with different figures are left to a person',
    ask('Years of experience with React and Node.js'), null);
check('two skills with the same figure are answered',
    ask('Years of experience with React and Python'), '5');
check('a skill with no figure is not guessed', ask('How many years of experience do you have with Go?'), null);
check('a skill the consultant does not list', ask('How many years of experience do you have with Rust?'), null);
check('C++ is believed when it is what is asked about',
    ask('Years of experience with C++'), '3');
check('a skill name inside another word is not a match',
    ask('Years of experience with JavaScript'), null);
check('the question must actually be about years', ask('Do you know React?'), null);

section('an approved answer still beats the profile');
{
    const b = buildAnswerBook({
        profile,
        approvedAnswers: [{ question_text: 'Total years of experience', answer_text: '10+', question_id: 'a1' }],
    });
    check('the reviewed wording wins', resolveAnswer('Total years of experience', b)?.value, '10+');
}

section('sensitive questions only when the consultant says so');
{
    const asking = buildAnswerBook({ profile });
    const declining = buildAnswerBook({ profile: { ...profile, eeo_policy: 'DECLINE' } });
    const options = ['Male', 'Female', 'Non-binary', 'I prefer not to say'];

    check('off by default', resolveEeo('Gender', asking, options), null);
    check('on: the decline option is chosen', resolveEeo('Gender', declining, options), 'I prefer not to say');
    check('  for race too', resolveEeo('Race / Ethnicity', declining, ['Asian', 'Decline to self-identify']), 'Decline to self-identify');
    check('  a dropdown whose options are unknown yet gets a pattern', resolveEeo('Veteran status', declining) instanceof RegExp, true);
    check('on, but no decline option offered: left to a person',
        resolveEeo('Gender', declining, ['Male', 'Female']), null);
    check('two decline-like options is ambiguous: left to a person',
        resolveEeo('Gender', declining, ['Prefer not to say', 'Decline to answer']), null);
    check('a question that is not about a protected trait is untouched',
        resolveEeo('Are you willing to relocate?', declining, ['Yes', 'No', 'Prefer not to say']), null);
    check('an unrecognised policy value means ask',
        buildAnswerBook({ profile: { ...profile, eeo_policy: 'yes please' } }).eeoPolicy, 'ASK');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
