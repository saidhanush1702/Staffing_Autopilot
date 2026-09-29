/**
 * "Fill with resume" — reading a resume into the profile form.
 *
 *   node tests/resumePrefill.test.mjs
 *
 * Mapping is tested as plain functions; the endpoint is tested with a real PDF
 * generated in memory and the mock model, against the real database. What this
 * exists to prove:
 *
 *   1. The translation from a parsed resume to profile values is right in the
 *      small ways that matter: phone digits, city/state, links, "Present",
 *      degree level, and dropping a row the profile would refuse.
 *   2. Nothing that cannot be read is guessed — work authorization and the
 *      headline are never filled.
 *   3. The endpoint saves NOTHING: no stored file, no base resume, no profile change.
 *   4. It is refused with a plain message when reading is switched off, when
 *      the file is not a resume PDF/DOCX, and past the hourly limit.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';

import PDFDocument from 'pdfkit';
import { randomUUID } from 'node:crypto';
import { query, pool } from '../db.js';
import {
    phoneOf, cityAndState, linksOf, levelOf, mapParsedResume,
} from '../services/resumePrefill.js';
import { prefillFromResume, PREFILLS_PER_HOUR } from '../controllers/profilePrefillController.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const mockRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};
const call = async (handler, req) => {
    const res = mockRes();
    let thrown = null;
    await handler(req, res, (e) => { thrown = e; });
    if (thrown) throw thrown;
    return res;
};

const pdfOf = (lines) => new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const l of lines) doc.text(l);
    doc.end();
});

const PARSED = {
    contact: {
        name: 'Asha Rao', email: 'asha@example.com', phone: '(555) 010-1234',
        location: 'Dallas, TX', links: ['linkedin.com/in/asha-rao', 'github.com/asha', 'asha.dev'],
    },
    sectionOrder: ['summary', 'skills', 'experience', 'education', 'certifications'],
    summary: 'Backend engineer with a focus on data pipelines.',
    skills: [{ category: 'Languages', items: ['Java', 'Python', 'java'] }, { category: null, items: ['SQL'] }],
    experience: [
        {
            company: 'Vector Analytics', title: 'Data Engineer', location: 'Austin, TX',
            startDate: 'Mar 2021', endDate: 'Present', bullets: ['Built ETL jobs.', 'Cut load times.'],
        },
        { company: 'Old Co', title: '', location: null, startDate: '2018', endDate: '2020', bullets: [] },
    ],
    projects: [],
    education: [
        { institution: 'JNTU', degree: 'B.Tech', field: 'Computer Science', startDate: '2014', endDate: '2018', details: null },
    ],
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', date: '2022' }],
    additional: [],
};

const main = async () => {
    /* ── 1. mapping ─────────────────────────────────────────────────── */

    section('phone numbers');
    check('brackets and dashes', phoneOf('(555) 010-1234'), '5550101234');
    check('a US country code is dropped', phoneOf('+1 555 010 1234'), '5550101234');
    check('a number that is not 10 digits is not guessed at', phoneOf('+91 98765 43210'), null);
    check('too short is null', phoneOf('12345'), null);

    section('city and state');
    check('city, state', cityAndState('Dallas, TX'), { city: 'Dallas', state: 'TX' });
    check('a trailing country is ignored', cityAndState('Austin, Texas, USA'), { city: 'Austin', state: 'Texas' });
    check('a city alone', cityAndState('Hyderabad'), { city: 'Hyderabad', state: null });
    check('digits and symbols are stripped, not kept', cityAndState('Dallas 75201, TX'), { city: 'Dallas', state: 'TX' });
    check('nothing is nothing', cityAndState(''), { city: null, state: null });

    section('links');
    const links = linksOf(PARSED.contact.links);
    check('LinkedIn, GitHub and a personal site are sorted apart', Object.keys(links).sort(),
        ['github_url', 'linkedin_url', 'portfolio_url']);
    check('a missing scheme is added', links.linkedin_url, 'https://linkedin.com/in/asha-rao');
    check('a coding profile is recognised', linksOf(['leetcode.com/asha']).coding_profile_url, 'https://leetcode.com/asha');

    section('degree levels');
    for (const [degree, level] of [
        ['B.Tech', 'BACHELORS'], ['Bachelor of Science', 'BACHELORS'], ['M.Sc', 'MASTERS'], ['MBA', 'MASTERS'],
        ['PhD', 'DOCTORATE'], ['Diploma in Electronics', 'DIPLOMA'], ['12th', 'SENIOR_SECONDARY'],
        ['10th', 'SECONDARY'], [null, 'OTHER'],
    ]) check(`${degree ?? '(none)'} is ${level}`, levelOf(degree), level);

    section('the whole mapping');
    const m = mapParsedResume(PARSED);
    check('phone, city, state, summary and the three links are filled',
        Object.keys(m.fields).sort(),
        ['city', 'github_url', 'linkedin_url', 'phone', 'portfolio_url', 'state', 'summary']);
    check('work authorization and headline are NEVER guessed',
        ['work_auth_status_id', 'headline'].some((k) => k in m.fields), false);
    check('skills are de-duplicated ignoring case', m.skills, ['Java', 'Python', 'SQL']);
    check('a current job has no end date and is flagged current',
        [m.experience[0].end_date, m.experience[0].is_current], [null, true]);
    check('a role with no title is dropped, and counted', [m.experience.length, m.report.unreadable], [1, 1]);
    check('education years and level are read',
        [m.education[0].level, m.education[0].start_year, m.education[0].end_year], ['BACHELORS', 2014, 2018]);
    check('certifications are read', m.certifications[0].issued_on, '2022');
    check('the report counts what was found',
        [m.report.skills, m.report.experience, m.report.education, m.report.certifications], [3, 1, 1, 1]);

    /* ── 2. the endpoint ────────────────────────────────────────────── */

    section('the endpoint');

    const { rows: [org] } = await query('SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1');
    const orgId = org.id;
    const consultantId = randomUUID();
    await query(
        `INSERT INTO users (id, organization_id, name, email, role,
                            password_enc, password_iv, password_tag, employment_status)
         VALUES ($1,$2,'Prefill Test','prefill-${consultantId}@example.invalid','CONSULTANT','x','x','x','ACTIVE')`,
        [consultantId, orgId]);
    await query('INSERT INTO consultant_profiles (user_id, organization_id) VALUES ($1,$2)', [consultantId, orgId]);

    const req = (file) => ({
        user: { id: consultantId, orgId, role: 'CONSULTANT' }, file, body: {}, params: {}, query: {},
    });
    const resumeText = [
        'ASHA RAO - Backend Engineer', 'Dallas, TX | asha@example.com | 555-010-1234',
        'Summary: Backend engineer with a focus on data pipelines and reliable batch processing systems.',
        'Experience: Data Engineer at Vector Analytics, March 2021 to present. Built ETL jobs and cut load times.',
        'Education: B.Tech in Computer Science, JNTU, 2014 to 2018. Certification: AWS Solutions Architect, 2022.',
    ];
    const pdf = await pdfOf(resumeText);
    const before = (await query('SELECT count(*)::int n FROM resume_artifacts WHERE organization_id = $1', [orgId])).rows[0].n;

    // The endpoint validates the model's answer strictly, so it gets a valid one
    // (the empty-title role above exists only to test the mapper's own dropping).
    process.env.LLM_MOCK_RESPONSE_PARSE = JSON.stringify({ ...PARSED, experience: [PARSED.experience[0]] });

    let r = await call(prefillFromResume, req(undefined));
    check('no file is a 422', r.statusCode, 422);

    r = await call(prefillFromResume, req({ buffer: Buffer.from('this is plainly not a resume file at all') }));
    check('a file that is not a PDF or DOCX is a 422 with a plain reason', [r.statusCode, /PDF or DOCX/.test(r.body.error)], [422, true]);

    r = await call(prefillFromResume, req({ buffer: pdf }));
    check('a real PDF is read', [r.statusCode, r.body.ok], [200, true]);
    check('  and comes back as form values', [r.body.fields?.phone, r.body.fields?.city, r.body.skills], ['5550101234', 'Dallas', ['Java', 'Python', 'SQL']]);

    const after = (await query('SELECT count(*)::int n FROM resume_artifacts WHERE organization_id = $1', [orgId])).rows[0].n;
    check('NOTHING was stored: no new resume file', after, before);
    const profile = (await query('SELECT base_resume_artifact_id, phone, city FROM consultant_profiles WHERE user_id = $1', [consultantId])).rows[0];
    check('  and the profile is untouched', [profile.base_resume_artifact_id, profile.phone, profile.city], [null, null, null]);

    const ledger = (await query(
        `SELECT stage, verdict FROM resume_tailoring_runs WHERE consultant_id = $1`, [consultantId])).rows;
    check('the read is on the cost ledger against the consultant', ledger, [{ stage: 'parse', verdict: 'CLEAN' }]);

    section('limits and switches');

    const off = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = '';
    r = await call(prefillFromResume, req({ buffer: pdf }));
    check('with reading switched off it is a 503 in plain words', [r.statusCode, /not switched on/.test(r.body.error)], [503, true]);
    process.env.LLM_PROVIDER = off;

    for (let i = 0; i < PREFILLS_PER_HOUR; i += 1) {
        await query(
            `INSERT INTO resume_tailoring_runs (id, organization_id, consultant_id, stage, attempt, provider, model,
                                                prompt_version, cost_usd, verdict)
             VALUES ($1,$2,$3,'parse',1,'mock','mock-model','v1',0,'CLEAN')`,
            [randomUUID(), orgId, consultantId]);
    }
    r = await call(prefillFromResume, req({ buffer: pdf }));
    check('past the hourly limit it is a 429', r.statusCode, 429);

    delete process.env.LLM_MOCK_RESPONSE_PARSE;
    await query('DELETE FROM resume_tailoring_runs WHERE consultant_id = $1', [consultantId]);
    await query('DELETE FROM users WHERE id = $1', [consultantId]);

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch(async (err) => {
    console.error('\nSuite aborted:', err);
    await pool.end().catch(() => {});
    process.exit(1);
});
