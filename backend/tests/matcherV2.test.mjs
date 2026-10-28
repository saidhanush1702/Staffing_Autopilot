/**
 * Matching v2 — skills, role families, and the example that failed in v1.
 *
 *   node tests/matcherV2.test.mjs
 *
 * Pure: no database. Every case is a posting a recruiter would recognise, run
 * through the real matcher.
 */
import { evaluate } from '../config/jobMatcher.js';
import { evaluateV2, AUTO_THRESHOLD, SUGGEST_THRESHOLD } from '../config/jobMatcherV2.js';
import {
    extractSkills, expandSkills, coverage, jobSkills, familiesOf, levelOf, levelFromYears, canonicalOf,
} from '../config/skillGraph.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
    if (ok) pass += 1; else fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── reading skills out of text ───────────────────────────────────────── */

section('skills are read out of a posting, whatever they are spelled like');
check('aliases collapse', extractSkills('ReactJS, React.js and react js'), ['react']);
check('punctuation inside a name is respected',
    extractSkills('We use C#, .NET Core, CI/CD and Node.js.').sort(), ['cicd', 'csharp', 'dotnet', 'node']);
check('java is not found inside javascript', extractSkills('JavaScript only'), ['javascript']);
check('.net is not found inside asp.net as a second skill', extractSkills('ASP.NET').length, 1);
check('react native is not also react', extractSkills('React Native apps'), ['reactnative']);
check('a word that is not a skill is ignored', extractSkills('We go the extra mile and express interest'), []);
check('a name as a person types it', [canonicalOf('Node.js'), canonicalOf('Mongo DB'), canonicalOf('K8s'), canonicalOf('Zork')],
    ['node', 'mongodb', 'kubernetes', null]);

section('required and preferred');
{
    const j = jobSkills({
        title: 'Frontend Developer',
        description: 'Requirements:\nReact and JavaScript\nNice to have:\nTypeScript, GraphQL\nWe also use Docker, a plus.',
    });
    check('the title and the requirements are required', ['frontend', 'react', 'javascript'].every((s) => j.required.includes(s)), true);
    check('a nice-to-have heading makes what follows preferred', ['typescript', 'graphql'].every((s) => j.preferred.includes(s)), true);
    check('a sentence that says "a plus" is preferred too', j.preferred.includes('docker'), true);
    check('a preferred skill is not also required', j.required.includes('typescript'), false);
}

/* ── what a skill covers ──────────────────────────────────────────────── */

section('what a consultant is credited with');
{
    const held = expandSkills(['react', 'javascript']);
    check('what they hold is worth full credit', held.get('react').credit, 1);
    check('frontend is implied by React', [held.get('frontend').kind, held.get('frontend').credit], ['IMPLIED', 0.8]);
    check('responsive design is two steps away', Number(held.get('responsive').credit.toFixed(2)), 0.64);
    check('Tailwind is only related, through CSS', [held.get('tailwind').kind, Number(held.get('tailwind').credit.toFixed(2))], ['RELATED', 0.4]);
    check('every credit says which skill earned it', held.get('frontend').via, 'react');
    check('a skill with no path is not credited', held.has('kubernetes'), false);
    check('three steps is too far', held.has('nonexistent'), false);
}

/* ── the example that failed ──────────────────────────────────────────── */

const consultant = {
    jobTitles: ['React Developer', 'MERN Stack Developer', 'Full Stack Developer', 'Node JS Developer', 'DevOps Engineer'],
    keywordsInclude: [], keywordsExclude: [], excludedCompanies: [],
    skills: [
        { name: 'React' }, { name: 'JavaScript' }, { name: 'SQL' }, { name: 'Node.js' }, { name: 'DevOps' },
        { name: 'CI/CD' }, { name: 'GitHub' }, { name: 'MongoDB' },
    ],
    locations: [{ city: 'Hyderabad', state: null, workMode: 'ONSITE' }, { city: null, state: null, workMode: 'REMOTE' }],
    workTypeNames: ['CONTRACT', 'FULL_TIME'], minPay: null, totalYears: 5,
};
const job = (over) => ({
    company: 'Acme', title: 'Frontend Developer', locationText: 'Hyderabad, India', isRemote: false,
    description: 'We need React, Tailwind CSS, responsive design and frontend UI work. JavaScript.', ...over,
});

section('a React developer and a frontend role (the case v1 refused)');
{
    const v1 = evaluate(job({}), consultant, { workTypeName: 'CONTRACT' });
    const v2 = evaluateV2(job({}), consultant, { workTypeName: 'CONTRACT' });
    check('v1 turns it down', [v1.matched, v1.score < 70], [false, true]);
    check('v2 queues it', [v2.matched, v2.bucket], [true, 'AUTO']);
    check('  with a score that clears the bar', v2.score >= AUTO_THRESHOLD, true);
    check('  and says why, in words', /React ✔/.test(v2.reason) && /Tailwind CSS ≈ via React/.test(v2.reason), true);
    check('  the skills implied rather than listed are shown as such', /Frontend ≈ via React/.test(v2.reason), true);
    check('  the detail shows what earned the points',
        v2.detail.points.coverage > 30 && v2.detail.points.family === 25, true);
}

section('the same consultant, jobs that should NOT match');
{
    const none = (j) => evaluateV2(j, consultant, { workTypeName: 'CONTRACT' });
    check('an accountant', none(job({ title: 'Accountant', description: 'Books, tax and audit.' })).bucket, 'DROP');
    check('  and it says it had nothing in common', none(job({ title: 'Accountant', description: 'Books.' })).reason, 'No skill or role overlap');
    const kgj = none(job({ title: 'Platform Developer', description: 'Kubernetes, Go and Java microservices on Kafka.' }));
    check('Kubernetes, Go and Java is not a React developer\'s job', kgj.matched, false);
    check('a skill is not invented for them', /Kubernetes/.test(kgj.reason) && !/Kubernetes ✔/.test(kgj.reason), true);
    check('"Engineer" in two titles is not a match', none(job({ title: 'Mechanical Engineer', description: 'CAD and thermodynamics.' })).bucket, 'DROP');
}

section('titles stop being word overlap');
{
    const base = (title) => evaluateV2(job({ title }), consultant, { workTypeName: 'CONTRACT' });
    check('UI Developer meets React Developer', base('UI Developer').matched, true);
    check('Frontend Engineer meets it too', base('Frontend Engineer').matched, true);
    check('Software Engineer with the same stack still fits', base('Software Engineer').bucket !== 'DROP', true);
}

section('required counts more than nice-to-have');
{
    const only = (desc) => evaluateV2(job({ title: 'Developer', description: desc }), consultant, { workTypeName: 'CONTRACT' });
    const reqMissing = only('Requirements:\nReact\nKubernetes\nGo\nNice to have:\nJavaScript');
    const prefMissing = only('Requirements:\nReact\nJavaScript\nNice to have:\nKubernetes\nGo');
    check('a missing REQUIRED skill costs more than a missing preferred one', reqMissing.score < prefMissing.score, true);
}

section('words that are vocabulary elsewhere');
{
    // Found on the live pool: a chip-design posting that says "front-end and
    // back-end design" scored 84 for a full-stack developer, because those two
    // words are also skills in the graph.
    const chip = evaluateV2(job({
        title: 'ASIC Physical Design Engineer', locationText: 'Austin, TX',
        description: 'Responsible for front-end and back-end design of ASICs, including RTL and place-and-route. Some Python scripting.',
    }), consultant, { workTypeName: 'CONTRACT' });
    check('a chip-design role is not a full-stack role', chip.bucket === 'AUTO', false);
    check('  and the words frontend/backend are not credited from its description',
        !(chip.detail?.matched ?? []).some((m) => m.skill === 'frontend'), true);
    const real = jobSkills({ title: 'Developer', description: 'We use React and JavaScript, on the frontend.' });
    check('the same words next to real tools still count', real.required.includes('frontend'), true);
    check('a concept in the TITLE always counts', jobSkills({ title: 'Frontend Engineer', description: '' }).required.includes('frontend'), true);
}

section('what a title says on its own');
{
    const fs = jobSkills({ title: 'Full Stack Developer I', description: 'Collaborate with advisors and mentor junior developers.' });
    check('"full stack" in a title wants both halves', ['frontend', 'backend'].every((s) => fs.required.includes(s)), true);
    const v = evaluateV2(job({ title: 'Full Stack Developer I', description: 'Collaborate with advisors and mentor junior developers.' }), consultant, { workTypeName: 'CONTRACT' });
    check('so a full-stack consultant fits it, though the description names no tool', v.bucket !== 'DROP', true);

    const php = evaluateV2(job({ title: 'PHP Full Stack Developer', description: 'PHP, MySQL, JavaScript, HTML and CSS.' }), consultant, { workTypeName: 'CONTRACT' });
    check('a tool the title names and they lack is a question for a recruiter, not a queue item', php.bucket, 'SUGGEST');
    check('  and says so', /the title asks for PHP/.test(php.reason), true);
    const react = evaluateV2(job({ title: 'React Developer' }), consultant, { workTypeName: 'CONTRACT' });
    check('a title tool they DO have is no concern', /the title asks/.test(react.reason), false);
}

section('what the posting leads with matters most');
{
    const j = jobSkills({ title: 'Developer', description: 'React, Node, SQL, Docker, Git, AWS, Kafka, Redis.' });
    check('the title counts most', jobSkills({ title: 'React Developer', description: 'Kafka.' }).weights.get('react'), 3);
    check('early skills count more than the end of a long wish list', j.weights.get('react') > j.weights.get('redis'), true);
    check('preferred skills count least', jobSkills({ title: 'Dev', description: 'React.\nNice to have:\nKafka' }).weights.get('kafka'), 0.5);
    const lead = evaluateV2(job({ title: 'Developer', description: 'React, JavaScript, Node. Also: Kafka, Spark, Airflow, Snowflake, Terraform, Ansible.' }), consultant, { workTypeName: 'CONTRACT' });
    const tail = evaluateV2(job({ title: 'Developer', description: 'Kafka, Spark, Airflow, Snowflake, Terraform, Ansible. Also: React, JavaScript, Node.' }), consultant, { workTypeName: 'CONTRACT' });
    check('the same skills score better when the posting leads with them', lead.score > tail.score, true);
}

section('level');
{
    const lvl = (title) => evaluateV2(job({ title }), { ...consultant, totalYears: 12 }, { workTypeName: 'CONTRACT' }).detail?.points.level;
    check('a very experienced consultant fits a lead role', lvl('Lead Frontend Developer'), 10);
    check('  and is a poor fit for a junior one', lvl('Junior Frontend Developer'), 0);
    check('levels are read from titles', [levelOf('Senior React Developer'), levelOf('Jr Dev'), levelOf('React Developer'), levelOf('Principal Engineer')], [3, 1, null, 4]);
    check('and from years', [levelFromYears(1), levelFromYears(4), levelFromYears(8), levelFromYears(15), levelFromYears(null)], [1, 2, 3, 4, null]);
}

section('role families');
{
    check('a title points at its family', [...familiesOf('Frontend Developer')], ['frontend']);
    check('full stack is both', [...familiesOf('Full Stack Engineer')].sort(), ['backend', 'frontend', 'fullstack']);
    check('skills point at a family when the title does not', [...familiesOf('Consultant', ['kubernetes'])], ['devops']);
}

section('a skill the graph has never heard of still matches itself');
{
    const elixir = { ...consultant, skills: [{ name: 'Elixir' }], jobTitles: ['Backend Developer'] };
    const v = evaluateV2(job({ title: 'Backend Developer', description: 'Elixir and Phoenix.' }), elixir, {});
    check('it is covered', v.detail.matched.some((m) => m.skill === 'lit:elixir'), true);
}

section('the guard rails of v1 are kept');
{
    check('criteria that say nothing match nothing',
        evaluateV2(job({}), { jobTitles: [], keywordsInclude: [], locations: [], workTypeNames: [], skills: consultant.skills }, {}).reason,
        'Criteria describe nothing to look for');
    check('an excluded keyword is still an automatic no',
        evaluateV2(job({ description: 'React. Unpaid internship.' }), { ...consultant, keywordsExclude: ['unpaid'] }, {}).reason,
        'Excluded keyword: unpaid');
    check('an excluded company too',
        evaluateV2(job({ company: 'Acme Staffing LLC' }), { ...consultant, excludedCompanies: ['acme'] }, {}).bucket, 'DROP');
    check('three outcomes, in order', AUTO_THRESHOLD > SUGGEST_THRESHOLD, true);
}

section('the organisation chooses the matcher; v1 is untouched by default');
{
    const p = job({});
    const plain = evaluate(p, consultant, { workTypeName: 'CONTRACT' });
    check('with no setting, v1 answers (and has no bucket)', plain.bucket, undefined);
    const chosen = evaluate(p, { ...consultant, matcherVersion: 2 }, { workTypeName: 'CONTRACT' });
    check('with the setting, v2 answers through the same function', [chosen.bucket, chosen.matched], ['AUTO', true]);
    check('a caller can ask for a version explicitly', evaluate(p, consultant, { version: 2, workTypeName: 'CONTRACT' }).bucket, 'AUTO');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
