/**
 * What the desktop may type about a consultant — the pure parts.
 *
 *   node tests/applicationProfile.test.mjs
 *
 * No database: the query side is thin, and the two things worth proving are the
 * year arithmetic (a wrong "years of experience" goes onto a real application)
 * and that the agent is offered exactly the keys the desktop can resolve.
 */
import { totalYears, yearOf, LEVEL_WORDS } from '../config/applicationProfile.js';
import { PROFILE_KEYS, profileKeysFor } from '../config/agentProtocol.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    ok ? pass += 1 : fail += 1;
};

console.log('— years are read from what the consultant wrote —');
check('a month and a year', yearOf('Mar 2021'), 2021);
check('a bare year', yearOf('2019'), 2019);
check('nothing recognisable', yearOf('last spring'), null);
check('a number that is not a year', yearOf('Level 12345'), null);

console.log('\n— total years comes only from their own history —');
check('first start to last end', totalYears([
    { start_date: 'Jan 2015', end_date: 'Dec 2018', is_current: false },
    { start_date: 'Feb 2019', end_date: 'Mar 2022', is_current: false },
]), 7);
check('a current job runs to now', totalYears([
    { start_date: '2020', end_date: null, is_current: true },
], 2026), 6);
check('no start years means no answer', totalYears([{ start_date: null, end_date: '2020', is_current: false }]), null);
check('an end nobody wrote means no answer', totalYears([{ start_date: '2018', end_date: null, is_current: false }]), null);
check('nothing at all', totalYears([]), null);
check('an absurd span is not offered', totalYears([{ start_date: '1960', end_date: '2026', is_current: false }]), null);

console.log('\n— education wording matches a dropdown —');
check("bachelor's", LEVEL_WORDS.BACHELORS, "Bachelor's Degree");
check('a level with no common wording is not guessed', LEVEL_WORDS.OTHER, null);

console.log('\n— the agent is offered what the profile holds —');
const rich = {
    name: 'Ada Lovelace', email: 'a@x.io', phone: '5550101234', city: 'Dallas', state: 'TX',
    linkedin_url: 'l', work_auth: 'Citizen', github_url: 'g', portfolio_url: 'p', headline: 'h',
    current_company: 'Acme', current_title: 'Engineer', school: 'MIT', degree: 'BS',
    field_of_study: 'CS', education_level: "Bachelor's Degree", graduation_year: 2014, total_years: 9,
};
check('every key is offered for a full profile', profileKeysFor(rich).sort(), [...PROFILE_KEYS].sort());
check('zero years is still a figure', profileKeysFor({ ...rich, total_years: 0 }).includes('yearsExperience'), true);
check('a missing figure is not offered', profileKeysFor({ ...rich, total_years: null }).includes('yearsExperience'), false);
check('an empty profile offers nothing', profileKeysFor({}), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
