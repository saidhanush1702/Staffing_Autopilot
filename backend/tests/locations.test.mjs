/**
 * Matching, phase C — where a job is, and whether that is a problem.
 *
 *   node tests/locations.test.mjs
 *
 * Pure. The first group is the live-data failure itself: the rejections v1 made
 * on location text that a recruiter would call plainly wrong.
 */
import { locationFit, workModeOf, stateOf, milesBetween, countryOf } from '../config/locations.js';
import { evaluate } from '../config/jobMatcher.js';
import { evaluateV2 } from '../config/jobMatcherV2.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const at = (city, state = null, workMode = 'ONSITE', radiusMiles = null) => ({ city, state, workMode, radiusMiles });
const fit = (locationText, locations, extra = {}, posting = {}) =>
    locationFit({ locationText, isRemote: false, title: 'Developer', description: '', ...posting }, { locations, ...extra });

section('states, however they are written');
check('abbreviation, name, case, dots', [stateOf('TX'), stateOf('texas'), stateOf('T.X.'), stateOf('Texas ')], ['texas', 'texas', 'texas', 'texas']);
check('a word that is not a state', stateOf('Dallas'), null);
check('Indian states too', stateOf('Telangana'), 'telangana');

section('places that are the same place');
check('Irving is Dallas', fit('Irving, TX', [at('Dallas', 'TX')]).mode, 'LOCAL');
check('  and says so', /same metro/.test(fit('Irving, TX', [at('Dallas', 'TX')]).why), true);
check('Hitec City is Hyderabad', fit('Hitec City, Hyderabad', [at('Hyderabad')]).mode, 'LOCAL');
check('Gurugram is the Delhi area', fit('Gurugram, Haryana', [at('Delhi')]).mode, 'LOCAL');
check('the exact city', fit('Dallas, TX', [at('Dallas', 'TX')]).points, 10);
check('a metro match scores a little less than the exact city',
    fit('Irving, TX', [at('Dallas', 'TX')]).points < fit('Dallas, TX', [at('Dallas', 'TX')]).points, true);
check('a country in the text does not matter', fit('Dallas, Texas, United States', [at('Dallas', 'TX')]).mode, 'LOCAL');

section('radius is read, finally');
check('the same metro counts as local whatever the radius', fit('Fort Worth, TX', [at('Plano', 'TX', 'ONSITE', 5)]).mode, 'LOCAL');
check('Dallas is within a 200 mile radius of Austin', fit('Dallas, TX', [at('Austin', 'TX', 'ONSITE', 200)]).mode, 'NEAR');
check('  and says how far', /miles from austin/i.test(fit('Dallas, TX', [at('Austin', 'TX', 'ONSITE', 200)]).why), true);
check('  not within 100 miles — but it is the same state', fit('Dallas, TX', [at('Austin', 'TX', 'ONSITE', 100)]).mode, 'STATE');
check('  with no radius given, 35 miles is assumed', fit('Dallas, TX', [at('Austin', 'TX')]).mode, 'STATE');
check('a radius does not stretch to another state', fit('Houston, TX', [at('New York', 'NY', 'ONSITE', 100)]).pass, false);
check('distance is real', Math.round(milesBetween({ lat: 32.78, lon: -96.80 }, { lat: 30.27, lon: -97.74 })), 182);

section('the same state is a stretch, not a no');
check('Austin for a Dallas consultant', [fit('Austin, TX', [at('Dallas', 'TX')]).mode, fit('Austin, TX', [at('Dallas', 'TX')]).pass], ['STATE', true]);
check('  scoring half marks', fit('Austin, TX', [at('Dallas', 'TX')]).points, 5);

section('remote');
check('flagged remote', fit('United States', [at('Hyderabad')], {}, { isRemote: true }).mode, 'REMOTE');
check('remote in the location text', fit('Remote - US', [at('Dallas', 'TX')]).mode, 'REMOTE');
check('"fully remote" in the description', workModeOf({ locationText: 'Anywhere', description: 'This is a fully remote role.' }), 'REMOTE');
check('"no remote" is not remote even with the flag', workModeOf({ locationText: 'Dallas, TX', isRemote: true, description: 'On-site only. No remote.' }), 'ONSITE');
check('"remote desktop support" is not a remote job', workModeOf({ locationText: 'Dallas, TX', title: 'IT Support', description: 'Provide remote desktop support to staff.' }), 'ONSITE');
check('hybrid is read', workModeOf({ locationText: 'Dallas, TX (Hybrid)' }), 'HYBRID');
check('a remote job suits someone who wants remote, fully', fit('Remote', [at(null, null, 'REMOTE')]).points, 10);
check('  and still passes for someone who did not ask for it, at reduced marks',
    [fit('Remote', [at('Dallas', 'TX')]).pass, fit('Remote', [at('Dallas', 'TX')]).points], [true, 6]);

section('relocation');
check('too far, and unwilling', [fit('Bangalore, India', [at('Hyderabad')]).mode, fit('Bangalore, India', [at('Hyderabad')]).pass], ['FAR', false]);
check('too far, but open to relocate', [fit('Bangalore, India', [at('Hyderabad')], { openToRelocate: true }).mode,
    fit('Bangalore, India', [at('Hyderabad')], { openToRelocate: true }).pass], ['RELOCATE', true]);
check('relocating scores low, so it is a suggestion rather than an automatic queue',
    fit('Bangalore, India', [at('Hyderabad')], { openToRelocate: true }).points <= 3, true);

section('what the posting does not say');
check('no location at all', [fit('', [at('Dallas', 'TX')]).mode, fit('', [at('Dallas', 'TX')]).pass], ['UNKNOWN', true]);
check('a place the table does not know, mentioning the consultant\'s city anyway',
    fit('Dallas Fort Worth Airport Area', [at('Dallas', 'TX')]).mode, 'LOCAL');
check('"in" is not Indiana', fit('Work in the office', [at('Dallas', 'TX')]).mode, 'UNKNOWN');
check('several places: the best one counts', fit('Austin, TX; Dallas, TX | Seattle, WA', [at('Dallas', 'TX')]).mode, 'LOCAL');
check('a consultant with no locations is not held to one', fit('Anywhere, XX', []).pass, true);

section('a country is enough to say a job is out of reach');
// Both of these passed as "location not stated" on the live pool, because the
// city is not in the table: a chip-design role in Shanghai and a bank role in
// London were offered to a consultant in Hyderabad.
check('Shanghai for a Hyderabad consultant', [fit('China, Shanghai', [at('Hyderabad')]).mode, fit('China, Shanghai', [at('Hyderabad')]).pass], ['FAR', false]);
check('London, with a postcode', fit('London E14 5JP', [at('Hyderabad')]).pass, false);
check('Toronto for a Dallas consultant', fit('Toronto, Canada', [at('Dallas', 'TX')]).pass, false);
check('the same country, a city the table does not know, is not held against anyone',
    fit('Visakhapatnam, India', [at('Hyderabad')]).pass, true);
check('countries are read from the text', [countryOf('Bengaluru, India'), countryOf('Dallas, TX'), countryOf('Remote - US'),
    countryOf('Munich, Germany'), countryOf('Nowhere in particular')], ['in', 'us', 'us', 'de', null]);
check('abroad but open to relocate: a suggestion at best',
    [fit('London E14 5JP', [at('Hyderabad')], { openToRelocate: true }).mode, fit('London E14 5JP', [at('Hyderabad')], { openToRelocate: true }).pass], ['RELOCATE', true]);
check('a remote role based abroad is passed on as a question, not queued',
    [fit('Munich, Germany', [at('Hyderabad'), at(null, null, 'REMOTE')], {}, { isRemote: true }).cap,
        fit('Munich, Germany', [at('Hyderabad'), at(null, null, 'REMOTE')], {}, { isRemote: true }).pass], [true, true]);
check('  and says where it is based', /based in DE/.test(fit('Munich, Germany', [at('Hyderabad')], {}, { isRemote: true }).why), true);
check('a remote role in the consultant\'s own country is not capped', fit('Remote - US', [at('Dallas', 'TX'), at(null, null, 'REMOTE')]).cap, undefined);
check('a consultant whose own place is not in the table has no country to guard, so the posting\'s words decide',
    [fit('Visakhapatnam, India', [at('Springfieldtown')]).mode, fit('Visakhapatnam, India', [at('Springfieldtown')]).pass], ['UNKNOWN', true]);

section('what v1 rejected and v2 now accepts');
{
    const consultant = {
        jobTitles: ['React Developer'], keywordsInclude: ['React'], keywordsExclude: [], excludedCompanies: [],
        skills: [{ name: 'React' }, { name: 'JavaScript' }],
        locations: [at('Dallas', 'TX'), at(null, null, 'REMOTE')], workTypeNames: [], minPay: null, totalYears: 5,
    };
    const job = (locationText, extra = {}) => ({
        company: 'Acme', title: 'React Developer', locationText, isRemote: false,
        description: 'React and JavaScript.', ...extra,
    });
    for (const [text, extra] of [['Irving, Texas', {}], ['Plano, TX', {}], ['Anywhere in the US', { isRemote: true }]]) {
        const v1 = evaluate(job(text, extra), consultant, {});
        const v2 = evaluateV2(job(text, extra), consultant, {});
        check(`${text}: v1 ${v1.matched ? 'matched' : 'rejected'}, v2 queues it`, [v2.matched, v2.bucket], [true, 'AUTO']);
    }
    check('a hybrid role in another state is still out of reach',
        evaluateV2(job('Seattle, WA (Hybrid)'), consultant, {}).stage, 'prefilter');
    check('  unless they would move, when it becomes a suggestion at best',
        evaluateV2(job('Seattle, WA (Hybrid)'), { ...consultant, openToRelocate: true }, {}).bucket !== 'AUTO', true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
