/**
 * Resume length and project points — no database, no model.
 *
 *   node tests/resumeLayout.test.mjs
 *
 * Renders real PDFs for every template and counts their real pages, because
 * "fits one page" is a property of a rendered document and nothing else.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
    careerLevel, LEVELS, splitSentences, topUpProjectPoints, limitsFor,
    applyLimits, projectPointPool, parseWhen, roleMonths,
    formatPeriod, periodFor, projectPeriod, categoriseSkills,
    restoreMissingSkills, shapeTailored,
} from '../config/resumeLayout.js';
import { TEMPLATES, describeTemplate } from '../config/resumeTemplates.js';
import { renderResumePdf } from '../services/resumePdf.js';
import { extractResumeText, appendLinkBlock } from '../utils/resumeText.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const NOW = new Date('2026-09-28T00:00:00Z');

/* ── career level ─────────────────────────────────────────────────────── */

section('career level is read from the employment history');

const role = (title, startDate, endDate) => ({ company: 'Acme', title, startDate, endDate, bullets: [] });

check('no roles is a fresher', careerLevel({ experience: [] }, NOW).level, LEVELS.FRESHER);
check('only internships is an intern',
    careerLevel({ experience: [role('Software Intern', 'Jun 2025', 'Aug 2025')] }, NOW).level, LEVELS.INTERN);
check('a trainee counts as an intern',
    careerLevel({ experience: [role('Graduate Trainee', '2025', '2026')] }, NOW).level, LEVELS.INTERN);
check('ten months of work is entry level',
    careerLevel({ experience: [role('Developer', 'Nov 2025', 'Aug 2026')] }, NOW).level, LEVELS.ENTRY);
check('an internship before a short job is still entry level',
    careerLevel({ experience: [role('Intern', '2024', '2024'), role('Developer', 'Jan 2026', 'Present')] }, NOW).level,
    LEVELS.ENTRY);
check('five years is experienced',
    careerLevel({ experience: [role('Engineer', 'Mar 2021', 'Present')] }, NOW).level, LEVELS.EXPERIENCED);
check('two years exactly is experienced',
    careerLevel({ experience: [role('Engineer', 'Sep 2024', 'Aug 2026')] }, NOW).level, LEVELS.EXPERIENCED);
check('a year range with no months counts to the end of the last year',
    roleMonths(role('Dev', '2019', '2021'), NOW), 36);
check('"03/2021" reads as March 2021', parseWhen('03/2021'), { year: 2021, month: 3 });
check('an unreadable date counts as a year, so a lost date cannot make a veteran a fresher',
    careerLevel({ experience: [role('Dev', 'unknown', 'unknown'), role('Lead', 'n/a', 'n/a')] }, NOW).level,
    LEVELS.EXPERIENCED);
check('freshers, interns and entry level are one page; experienced is not',
    [
        careerLevel({ experience: [] }, NOW),
        careerLevel({ experience: [role('Intern', '2025', '2025')] }, NOW),
        careerLevel({ experience: [role('Dev', 'Jan 2026', 'Present')] }, NOW),
        careerLevel({ experience: [role('Dev', '2015', 'Present')] }, NOW),
    ].map((c) => c.onePage),
    [true, true, true, false]);

/* ── project points ───────────────────────────────────────────────────── */

section('a project is explained, from its own facts only');

check('a paragraph becomes one point per sentence',
    splitSentences('Built a task manager for teams. Added drag and drop boards. Deployed it on Vercel.'),
    ['Built a task manager for teams.', 'Added drag and drop boards.', 'Deployed it on Vercel.']);
check('"e.g." does not split a sentence',
    splitSentences('Used state libraries, e.g. Redux for the cart. Added unit tests for reducers.').length, 2);
check('a pasted list becomes points',
    splitSentences('• Built the login flow\n• Added password reset by email').length, 2);

const BASE_PROJECTS = [{
    name: 'Ledger Reconciler',
    description: null,
    bullets: [
        'Built a nightly job that reconciles payment ledgers.',
        'Flagged mismatches for review in a simple dashboard.',
        'Technologies used: Python, PostgreSQL, Docker',
        'Wrote the deployment scripts and documentation.',
    ],
}];

const thin = { projects: [{ name: 'Ledger Reconciler', description: null, bullets: ['Built a nightly job that reconciles payment ledgers.'] }] };
const topped = topUpProjectPoints(thin, { projects: BASE_PROJECTS });
check('a project the model cut to one line is brought back to three points',
    topped.projects[0].bullets.length, 3);
check('  using the base project’s own points, in the base’s order',
    topped.projects[0].bullets.slice(1), BASE_PROJECTS[0].bullets.slice(1, 3));

const wordy = { projects: [{ name: 'Ledger Reconciler', bullets: ['a1 long point', 'b2 long point', 'c3 long point', 'd4 long point', 'e5 long point'] }] };
check('a fifth point is cut', topUpProjectPoints(wordy, { projects: [] }).projects[0].bullets.length, 4);
check('nothing is invented when the base has nothing to add',
    topUpProjectPoints({ projects: [{ name: 'Unknown', bullets: [] }] }, { projects: [] }).projects[0].bullets, []);
check('duplicates are not restored twice',
    projectPointPool({ bullets: ['Built a nightly job that reconciles ledgers today.'], description: 'Built a nightly job that reconciles ledgers today.' }).length, 1);

const limitsOne = limitsFor(TEMPLATES.MODERN, careerLevel({ experience: [] }));
check('a one-page resume works to tighter ceilings than the template’s', limitsOne.bulletsPerRole <= 4, true);
check('  and still shows three or four projects', [limitsOne.projects >= 3, limitsOne.projects <= 4], [true, true]);
check('applyLimits cuts what is over the ceiling',
    applyLimits({ experience: [{ bullets: [1, 2, 3, 4, 5, 6] }], projects: [1, 2, 3, 4, 5, 6] }, limitsOne).experience[0].bullets.length, 4);
check('the model is told the level and the one-page rule',
    /ONE page/.test(describeTemplate('MODERN', careerLevel({ experience: [] }))), true);
check('an experienced candidate is told they have more than one page',
    /more than one page/.test(describeTemplate('CLASSIC', careerLevel({ experience: [role('Dev', '2015', 'Present')] }, NOW))), true);

/* ── rendered pages ───────────────────────────────────────────────────── */

const CONTACT = { name: 'Aarav Sharma', email: 'aarav@example.com', phone: '+91 90000 00000', location: 'Hyderabad, India', links: ['linkedin.com/in/aarav', 'github.com/aarav'] };
const SKILLS = [
    { category: 'Languages', items: ['JavaScript', 'Python', 'Java', 'SQL'] },
    { category: 'Frameworks', items: ['React', 'Node.js', 'Express', 'Spring Boot'] },
    { category: 'Tools', items: ['Git', 'Docker', 'Postman', 'VS Code'] },
];
const EDU = [{ institution: 'JNTU Hyderabad', degree: 'B.Tech', field: 'Computer Science', startDate: '2021', endDate: '2025', details: '8.4 CGPA' }];
const CERTS = [{ name: 'AWS Cloud Practitioner', issuer: 'Amazon', date: '2025' }, { name: 'Python for Everybody', issuer: 'Coursera', date: '2024' }];

const project = (name, meta, points) => ({ name, description: meta, bullets: points });
const PROJECTS = [
    project('Task Manager App', 'Role: Full stack developer · Team of 4 · Jan 2025 – Apr 2025', [
        'Built a task management web application where teams create boards, lists and cards.',
        'Developed the front end in React and the REST API in Node.js and Express.',
        'Stored users, boards and tasks in MongoDB with authentication using JWT.',
        'Technologies used: React, Node.js, Express, MongoDB, JWT',
    ]),
    project('Ledger Reconciler', 'Role: Backend developer · 3 months', [
        'Built a nightly job that reconciles payment ledgers against bank statements.',
        'Flagged mismatches in a small review dashboard for the finance team.',
        'Technologies used: Python, PostgreSQL, Docker',
    ]),
    project('Weather Dashboard', 'Personal project · Live: weather.example.com', [
        'Built a responsive dashboard that shows current weather and a five-day forecast.',
        'Integrated a public weather API and cached responses to limit repeat requests.',
        'Technologies used: JavaScript, HTML, CSS',
    ]),
];

const fresher = (extra = {}) => ({
    contact: CONTACT, sectionOrder: [], summary: 'Computer science graduate who builds full stack web applications and enjoys turning ideas into working products.',
    skills: SKILLS, experience: [], projects: PROJECTS, education: EDU, certifications: CERTS, additional: [], ...extra,
});

const bulletsOf = (n, stem) => Array.from({ length: n }, (_, i) => `${stem} number ${i + 1} covering delivery, testing and support of the release for the wider platform team.`);
const experienced = () => ({
    contact: CONTACT, sectionOrder: [], summary: 'Backend engineer with nine years of experience building and running payment platforms.',
    skills: SKILLS,
    experience: ['Acme Payments', 'Globex', 'Initech', 'Umbrella'].map((company, i) => ({
        company, title: 'Senior Software Engineer', location: 'Dallas, TX',
        startDate: `${2016 + i * 2}`, endDate: i === 3 ? 'Present' : `${2018 + i * 2}`,
        bullets: bulletsOf(8, `Item ${i}`),
    })),
    projects: PROJECTS, education: EDU, certifications: CERTS, additional: [],
});

const pagesOf = (bytes) => (bytes.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

const renderAll = async (label, resume, expectPages, minFill = 0.7) => {
    for (const name of Object.keys(TEMPLATES)) {
        const file = await renderResumePdf({
            orgId: 'layout-test', resume, company: 'Acme', title: label, artifactId: randomUUID(), template: name,
        });
        const bytes = fs.readFileSync(file.absolutePath);
        const real = pagesOf(bytes);
        check(`${label} · ${name}: ${expectPages === 1 ? 'exactly one page' : 'more than one page'} (${real})`,
            expectPages === 1 ? real === 1 : real > 1, true);
        check(`  ${name}: the measured page count matches the file`, file.pages, real);
        if (expectPages === 1) {
            check(`  ${name}: the page is a full one (${Math.round(file.fill * 100)}%)`, file.fill >= minFill, true);
        }
        fs.unlinkSync(file.absolutePath);
    }
};

section('intern, fresher and entry level: exactly one full page');
await renderAll('fresher with projects', fresher(), 1);
await renderAll('intern', fresher({ experience: [{ company: 'Startup Labs', title: 'Software Engineering Intern', startDate: 'Jun 2025', endDate: 'Aug 2025', bullets: bulletsOf(3, 'Intern task') }] }), 1);
await renderAll('entry level', fresher({ experience: [{ company: 'Globex', title: 'Software Engineer', startDate: 'Nov 2025', endDate: 'Present', bullets: bulletsOf(5, 'Entry task') }] }), 1);

section('a very short resume is stretched to fill its page, not left at the top of it');
// One project, no summary, no certifications: as little as a resume gets. The
// stretch has a ceiling — past it the text is simply too big — so this one is
// held to 60% rather than 70%.
await renderAll('sparse fresher', fresher({ summary: null, certifications: [], projects: [PROJECTS[1]] }), 1, 0.6);

section('a fresher with too much to say is trimmed onto one page');
await renderAll('overfull fresher', fresher({
    projects: [...PROJECTS, project('Chat App', 'Team of 2', bulletsOf(4, 'Chat point'))],
    experience: [{ company: 'Startup Labs', title: 'Intern', startDate: 'Jun 2025', endDate: 'Aug 2025', bullets: bulletsOf(14, 'Verbose intern task') }],
    additional: [{ heading: 'Achievements', items: bulletsOf(6, 'Achievement')}],
}), 1);

section('experienced: as many pages as the career needs');
await renderAll('experienced', experienced(), 2);

section('the printed projects carry their explanation');
{
    const file = await renderResumePdf({
        orgId: 'layout-test', resume: fresher(), company: 'Acme', title: 'text check', artifactId: randomUUID(), template: 'CLASSIC',
    });
    const read = await extractResumeText(fs.readFileSync(file.absolutePath));
    const text = read.ok ? read.text : '';
    check('the project heading is printed', text.includes('PROJECTS'), true);
    check('each project prints its points, not just its name',
        ['reconciles payment ledgers', 'five-day forecast', 'REST API in Node.js'].every((s) => text.includes(s)), true);
    check('the technologies line is printed', text.includes('Technologies used: React, Node.js'), true);
    check('the role and team line is printed', text.includes('Team of 4'), true);
    fs.unlinkSync(file.absolutePath);
}

/* ── the layout faults seen on a real tailored resume ─────────────────── */

section('bullets hang, dates sit on the title line, education is not repeated');
{
    const resume = {
        contact: { name: 'Sai Dhanush', email: 'consultant@example.com', phone: '9281716151', location: null, links: [] },
        sectionOrder: [], summary: 'Trained software engineer with hands-on experience in web applications.',
        skills: [{ category: 'Backend', items: ['Node.js', 'Express.js'] }],
        experience: [{
            company: 'TechMecha Torque Pvt. Ltd.', title: 'SDE Intern', location: 'Hyderabad',
            startDate: 'Sep 2025', endDate: 'Present',
            bullets: [
                'Performed debugging, unit testing, and production support for backend APIs and frontend components, ensuring stable releases across every environment the team maintained.',
            ],
        }],
        projects: [{ name: 'LearnLoop', description: null, bullets: ['Built secure RESTful APIs and role-based modules using Node.js and Express.js, integrating Supabase for authentication and cloud data management.'] }],
        education: [{
            institution: 'JNTUH College of Engineering, Sultanpur',
            degree: 'B.Tech in Computer Science and Engineering, JNTUH',
            field: 'Computer Science and Engineering', startDate: '2021', endDate: '2025', details: null,
        }],
        certifications: [], additional: [],
    };
    const file = await renderResumePdf({
        orgId: 'layout-test', resume, company: 'Acme', title: 'faults', artifactId: randomUUID(), template: 'CLASSIC',
    });
    const raw = fs.readFileSync(file.absolutePath).toString('latin1');
    const read = await extractResumeText(fs.readFileSync(file.absolutePath));
    const text = read.ok ? read.text : '';

    // Every wrapped line of a bullet starts at the SAME x as the first line's
    // text — read from the content stream rather than judged by eye.
    // CLASSIC's margin is 36pt: markers are drawn at 38, text at 48.
    const xs = [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map((m) => Number(m[1]));
    const markers = xs.filter((x) => x === 38).length;
    const hung = xs.filter((x) => x === 48).length;
    check('every bullet has its marker at the margin', markers, 2);
    // Two bullets, and the first is long enough to wrap: three lines of text,
    // ALL at the hanging indent — none back at the margin under the marker.
    check('every line of bullet text, wrapped ones included, starts at the hanging indent',
        hung >= 3, true);
    check('the education degree is not repeated',
        (text.match(/Computer Science and Engineering/g) ?? []).length, 1);
    check('dates are on the title line, not a line of their own',
        /SDE Intern — TechMecha Torque Pvt\. Ltd\.\s*Sep 2025 – Present/.test(text.replace(/\s+/g, ' ')), true);
    fs.unlinkSync(file.absolutePath);
}

/* ── periods: "(1 yr 2 mos)" next to a date range ─────────────────────── */

section('a date range is shown with how long that is');

check('11 months', formatPeriod(11), '11 mos');
check('exactly one year', formatPeriod(12), '1 yr');
check('one year and change', formatPeriod(14), '1 yr 2 mos');
check('a nice round two years', formatPeriod(24), '2 yrs');
check('under a month is not shown at all', formatPeriod(0), null);

check('a role still in progress gets a period',
    /^\d+ (mo|yr)/.test(periodFor('Sep 2025', 'Present', NOW)), true);
check('a role with only a start date is still measured',
    periodFor('Jan 2020', null, NOW) !== null, true);
check('a role with no readable dates gets no period',
    periodFor(null, null, NOW), null);

check('a project date range gets a period, the same as a role',
    projectPeriod('Jan 2024 – Apr 2024', NOW), '4 mos');
check('a bare duration is not turned into a second, computed one',
    projectPeriod('3 months', NOW), null);
check('a bare year has no period', projectPeriod('2025', NOW), null);

/* ── skills, split into named sub-sections ────────────────────────────── */

section('a flat skills list becomes named sub-sections');

const FLAT = [{ category: null, items: ['Java', 'Python', 'React', 'MySQL', 'Docker', 'Git', 'AWS', 'Zephyr'] }];
const categorised = categoriseSkills(FLAT);
check('more than one sub-section comes out of one flat list', categorised.length > 1, true);
check('every skill is still present, exactly as written',
    categorised.flatMap((g) => g.items).sort(), [...FLAT[0].items].sort());
check('a known tool is recognised and put on its own line',
    categorised.some((g) => g.category === 'Tools & Platforms' && g.items.includes('Git')), true);
check('nothing unrecognised is dropped — it lands in Other',
    categorised.some((g) => g.category === 'Other' && g.items.includes('Zephyr')), true);

const SHORT = [{ category: null, items: ['Java', 'SQL', 'Git'] }];
check('a short list is left as one line — splitting three skills helps nobody',
    categoriseSkills(SHORT), SHORT);

const ALREADY_GROUPED = [
    { category: 'Languages', items: ['Java', 'Python'] },
    { category: 'Cloud & DevOps', items: ['AWS', 'Docker'] },
];
check('a resume that already has its own sub-sections is left exactly as it is',
    categoriseSkills(ALREADY_GROUPED), ALREADY_GROUPED);

/* ── hyperlinks a document embedded without ever printing the address ─── */

section('a hyperlink is not lost just because the visible text does not say it');

check('mailto is never carried as a professional link',
    appendLinkBlock('body text', ['mailto:me@example.com', 'https://linkedin.com/in/me']),
    'body text\n\nHYPERLINKS FOUND IN THE DOCUMENT\nhttps://linkedin.com/in/me');
check('nothing is appended when there is nothing to add',
    appendLinkBlock('body text', ['mailto:me@example.com', 'not a url']), 'body text');
check('duplicates collapse to one line',
    appendLinkBlock('t', ['https://github.com/me', 'https://github.com/me']),
    't\n\nHYPERLINKS FOUND IN THE DOCUMENT\nhttps://github.com/me');

// A real reference file, when one is on this machine: proves extraction
// against an ACTUAL docx rather than a hand-built string, and that a
// mailto: link in a real document never reaches the model as a "hyperlink".
// Skipped, not failed, where the file is not present — this is a machine-local
// fixture, not something the repository ships.
{
    const refPath = 'E:/Personal/Downloads/Hari Resume.docx';
    if (fs.existsSync(refPath)) {
        const read = await extractResumeText(fs.readFileSync(refPath));
        check('a real resume with a mailto: link still extracts cleanly', read.ok, true);
        if (read.ok) {
            check('  its mailto: link was not carried into a hyperlink block',
                /mailto:/i.test(read.text), false);
        }
    } else {
        console.log('  (skipped — reference file not present on this machine)');
    }
}

/* ── the layout requested from the three reference resumes ────────────── */

section('a project shows its date, right-aligned, the way a role does');
{
    const resume = fresher({
        projects: [project('Task Manager App', null, PROJECTS[0].bullets)],
    });
    resume.projects[0].when = 'Jan 2025 – Apr 2025';
    const file = await renderResumePdf({
        orgId: 'layout-test', resume, company: 'Acme', title: 'project date', artifactId: randomUUID(), template: 'CLASSIC',
    });
    const read = await extractResumeText(fs.readFileSync(file.absolutePath));
    const text = (read.ok ? read.text : '').replace(/\s+/g, ' ');
    check('the project date and its period are printed',
        /Task Manager App.*Jan 2025 – Apr 2025 \(4 mos\)/.test(text), true);

    const raw = fs.readFileSync(file.absolutePath).toString('latin1');
    const rightX = [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map((m) => Number(m[1]));
    check('the date sits well to the right of the left margin, not beside the name',
        rightX.some((x) => x > 350), true);
    fs.unlinkSync(file.absolutePath);
}

section('a role shows how long it lasted, next to its dates');
{
    const resume = fresher({
        experience: [{ company: 'Acme', title: 'Software Engineer', location: 'Remote', startDate: 'Jan 2024', endDate: 'Nov 2024', bullets: bulletsOf(2, 'Shipped a feature') }],
    });
    const file = await renderResumePdf({
        orgId: 'layout-test', resume, company: 'Acme', title: 'role period', artifactId: randomUUID(), template: 'MODERN',
    });
    const read = await extractResumeText(fs.readFileSync(file.absolutePath));
    const text = (read.ok ? read.text : '').replace(/\s+/g, ' ');
    check('the period is printed next to the role’s dates',
        /Jan 2024 – Nov 2024 \(11 mos\)/.test(text), true);
    fs.unlinkSync(file.absolutePath);
}

section('an entry never starts on one page and continues on the next');
{
    // Text PER PAGE, read the same way the real extractor reads a PDF —
    // proof of which page something landed on, not just that it exists
    // somewhere in the file.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pagesOfText = async (buffer) => {
        const doc = await pdfjs.getDocument({
            data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
        }).promise;
        const out = [];
        for (let n = 1; n <= doc.numPages; n += 1) {
            const page = await doc.getPage(n);
            const content = await page.getTextContent();
            out.push(content.items.map((i) => i.str).join(' '));
            page.cleanup();
        }
        return out;
    };

    // A summary padded to sit right at the page boundary, so the first
    // role's title would land in the last line or two of page one if entries
    // were not kept together — exactly the split this guards against.
    const resume = experienced();
    resume.summary = bulletsOf(28, 'Padding sentence to push the page boundary right up to the first role').join(' ');
    const file = await renderResumePdf({
        orgId: 'layout-test', resume, company: 'Acme', title: 'no split', artifactId: randomUUID(), template: 'CLASSIC',
    });

    const pages = await pagesOfText(fs.readFileSync(file.absolutePath));
    const firstRole = resume.experience[0];
    const pageOf = (needle) => pages.findIndex((t) => t.includes(needle));

    check('the padded resume actually spans more than one page (the test proves something)',
        pages.length > 1, true);
    check('the first role’s title and its own last bullet are on the SAME page',
        pageOf(firstRole.title), pageOf(firstRole.bullets[firstRole.bullets.length - 1]));
    fs.unlinkSync(file.absolutePath);
}

section('a heading never reads as touching the text under it, even squeezed onto one page');
{
    // Read off a REAL generated file (MODERN, squeezed to fit one page): the
    // heading "TECHNICAL SKILLS" and the line under it sat 13.1pt apart,
    // baseline to baseline — LESS than the 11.0pt gap between two ordinary
    // lines in the very same document. A heading is supposed to be the
    // biggest gap on the page, not the smallest.
    //
    // Reproduced with a resume dense enough to force the same heavy squeeze:
    // three roles with a full bullet list each, three fully-explained
    // projects, certifications and two education entries, on a career level
    // that has to fit one page.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const textItemsOf = async (buffer) => {
        const doc = await pdfjs.getDocument({
            data: new Uint8Array(buffer), disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
        }).promise;
        const page = await doc.getPage(1);
        const content = await page.getTextContent();
        return content.items
            .filter((i) => i.str.trim())
            .map((i) => ({ y: i.transform[5], str: i.str }));
    };

    const dense = fresher({
        experience: [
            { company: 'TechCo', title: 'Software Intern', location: null, startDate: 'Sep 2024', endDate: 'Jan 2025', bullets: bulletsOf(3, 'Shipped a backend feature under close review') },
            { company: 'Digismiths', title: 'Frontend Intern', location: null, startDate: 'Apr 2024', endDate: 'May 2024', bullets: bulletsOf(3, 'Built a reusable interactive component') },
            { company: 'Freelance', title: 'Full Stack Developer', location: null, startDate: 'Mar 2025', endDate: 'Jul 2025', bullets: bulletsOf(4, 'Delivered a client-facing feature end to end') },
        ],
        skills: [{ category: 'Core Tech', items: ['React', 'Node.js', 'Express', 'MySQL', 'JavaScript', 'Tailwind', 'HTML5', 'Firebase'] },
            { category: 'Languages & Tools', items: ['Java', 'C', 'Python', 'Git', 'GitHub'] }],
        certifications: [
            { name: 'Solved 500+ DSA problems', issuer: null, date: null },
            { name: 'Hackathon placements across three events', issuer: null, date: null },
            { name: 'Git & GitHub Workshop', issuer: null, date: null },
        ],
        education: [
            { institution: 'State University', degree: 'B.Tech', field: 'Computer Science', startDate: null, endDate: '2026', details: 'CGPA 8.0' },
            { institution: 'Junior College', degree: 'Intermediate', field: null, startDate: null, endDate: '2021', details: '96.4%' },
        ],
    });

    const file = await renderResumePdf({
        orgId: 'layout-test', resume: dense, company: 'Acme', title: 'dense one-pager', artifactId: randomUUID(), template: 'MODERN',
    });
    check('this is genuinely the squeeze case — it still fits one page', file.pages, 1);

    const items = await textItemsOf(fs.readFileSync(file.absolutePath));
    const yOf = (needle) => items.find((i) => i.str.includes(needle))?.y;

    // Two known ordinary line-to-line gaps, from the summary and from a
    // skills sub-section list — what "close together" looks like on this
    // exact page, at this exact squeeze.
    const bodyGaps = [];
    for (let i = 0; i < items.length - 1; i += 1) {
        if (items[i].str.length > 20 && items[i + 1].str.length > 20
            && !/^(•| )$/.test(items[i + 1].str) && items[i].y !== items[i + 1].y) {
            bodyGaps.push(items[i].y - items[i + 1].y);
        }
    }
    const ordinaryLineGap = Math.min(...bodyGaps.filter((g) => g > 0 && g < 20));

    for (const heading of ['TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE', 'CERTIFICATIONS', 'EDUCATION']) {
        const headingY = yOf(heading);
        const next = items.find((i) => i.y < headingY - 0.5);
        check(`"${heading}" has more air below it than an ordinary line has below IT`,
            headingY - next.y > ordinaryLineGap, true);
    }
    fs.unlinkSync(file.absolutePath);
}

/* ── every skill survives tailoring, and so does the contact block ────── */

section('a skill is never dropped for looking unrelated to the job');

const BASE_SKILLS = [
    { category: 'Languages', items: ['Java', 'Python', 'SQL'] },
    { category: 'Design', items: ['Photoshop', 'Figma'] },
];

check('a fully-complete tailored list is left exactly where the model put it',
    restoreMissingSkills(
        [{ category: 'Languages', items: ['Python', 'Java', 'SQL'] }, { category: 'Design', items: ['Photoshop', 'Figma'] }],
        BASE_SKILLS,
    ),
    [{ category: 'Languages', items: ['Python', 'Java', 'SQL'] }, { category: 'Design', items: ['Photoshop', 'Figma'] }]);

check('a skill the model dropped, because it looked irrelevant, comes back',
    restoreMissingSkills([{ category: 'Languages', items: ['Java', 'Python'] }], BASE_SKILLS)
        .flatMap((g) => g.items).sort(),
    ['Figma', 'Java', 'Photoshop', 'Python', 'SQL'].sort());

check('  restored into the category it came from, not merged into another one',
    restoreMissingSkills([{ category: 'Languages', items: ['Java', 'Python'] }], BASE_SKILLS)
        .find((g) => g.category === 'Design')?.items, ['Photoshop', 'Figma']);

check('a whole category the model dropped comes back as its own category',
    restoreMissingSkills([{ category: 'Languages', items: ['Java', 'Python', 'SQL'] }], BASE_SKILLS)
        .some((g) => g.category === 'Design' && g.items.includes('Photoshop') && g.items.includes('Figma')),
    true);

check('case and spacing differences are still recognised as the same skill',
    restoreMissingSkills(
        [{ category: 'Languages', items: ['  java', 'PYTHON', 'sql'] }, { category: 'Design', items: ['Photoshop', 'Figma'] }],
        BASE_SKILLS,
    ).flatMap((g) => g.items).length, 5);

check('an empty tailored skills list still gets everything back',
    restoreMissingSkills([], BASE_SKILLS).flatMap((g) => g.items).sort(),
    ['Figma', 'Java', 'Photoshop', 'Python', 'SQL'].sort());

section('the contact block is never taken from anywhere but the base');

const BASE_RESUME_FOR_SHAPE = {
    contact: { name: 'Real Person', email: 'real@example.com', phone: '555-0100', location: 'Austin, TX', links: ['https://github.com/real', 'https://linkedin.com/in/real'] },
    skills: BASE_SKILLS, projects: [], experience: [],
};
const driftedTailored = {
    contact: { name: 'Real Person', email: null, phone: null, location: null, links: [] },
    skills: [{ category: 'Languages', items: ['Java'] }],
    projects: [], experience: [],
};
const shaped = shapeTailored(driftedTailored, BASE_RESUME_FOR_SHAPE, null);

check('the tailored resume’s own (thinner) contact block is never used',
    shaped.contact, BASE_RESUME_FOR_SHAPE.contact);
check('every base skill is present after shaping, not just what the model kept',
    shaped.skills.flatMap((g) => g.items).sort(), ['Figma', 'Java', 'Photoshop', 'Python', 'SQL'].sort());

section('a rendered resume shows every skill and every link, even ones the model dropped');
{
    const resume = {
        contact: { name: 'Priya Verma', email: 'priya@example.com', phone: '555-0199', location: 'Seattle, WA',
            links: ['https://github.com/priyav', 'https://linkedin.com/in/priyav'] },
        sectionOrder: [], summary: 'Backend engineer.',
        // What the "model" kept — missing Photoshop/Figma, as if it judged
        // them irrelevant to a backend role.
        skills: [{ category: 'Languages', items: ['Java', 'Python'] }],
        experience: [{ company: 'Acme', title: 'Backend Engineer', location: 'Remote', startDate: 'Jan 2022', endDate: 'Present', bullets: ['Built services.', 'Owned an API.'] }],
        projects: [], education: [{ institution: 'State University', degree: 'B.S.' }], certifications: [], additional: [],
    };
    const base = { ...resume, skills: BASE_SKILLS, contact: resume.contact };
    const finished = shapeTailored(resume, base, null);

    for (const t of ['CLASSIC', 'MODERN', 'TECHNICAL']) {
        const file = await renderResumePdf({
            orgId: 'layout-test', resume: finished, company: 'Acme', title: 'skills+links', artifactId: randomUUID(), template: t,
        });
        const read = await extractResumeText(fs.readFileSync(file.absolutePath));
        const text = read.ok ? read.text : '';
        check(`${t}: every base skill is printed, related to the job or not`,
            ['Java', 'Python', 'SQL', 'Photoshop', 'Figma'].every((s) => text.includes(s)), true);
        check(`${t}: GitHub is printed`, /GitHub/.test(text), true);
        check(`${t}: LinkedIn is printed`, /LinkedIn/.test(text), true);
        check(`${t}: phone is printed`, text.includes('555-0199'), true);
        check(`${t}: email is printed`, text.includes('priya@example.com'), true);
        fs.unlinkSync(file.absolutePath);
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
