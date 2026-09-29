/**
 * Phase 8 — building a resume from the structured profile.
 *
 *   node tests/profileResume.test.mjs
 *
 * Runs the real pipeline against the real database with the mock model
 * provider, in PROFILE mode: profile rows in, tailored PDF out.
 *
 * ── WHAT THIS IS ACTUALLY CHECKING ────────────────────────────────────
 *
 * That swapping the source changed nothing downstream. Tailoring, the
 * fabrication check, the ATS scorer, the renderer and the review gate are the
 * same code paths BASE_RESUME mode uses — the only difference is where
 * `{ sections, rawText }` came from. If that claim is wrong, this suite is
 * where it shows.
 *
 * Everything created here is removed at the end.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';

import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { buildProfileResume, profileGaps } from '../services/profileResume.js';
import { handle as tailorHandler, KIND } from '../jobs/handlers/tailorResume.js';
import { getTemplate } from '../config/resumeTemplates.js';
import { resolveSkill } from '../config/skills.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

const JD = `Senior Backend Engineer.

Requirements:
- Strong Java and Spring Boot
- SQL and database performance tuning
- Test automation and CI/CD`;

const created = {
    consultants: [], postings: [], queueItems: [], files: [], orgId: null,
    originalSource: null, originalTemplate: null,
};

/* ── fixture ──────────────────────────────────────────────────────────── */

const makeConsultant = async (orgId, { withProfile }) => {
    const id = randomUUID();
    await query(
        `INSERT INTO users (id, organization_id, name, email, role,
                            password_enc, password_iv, password_tag, employment_status)
         VALUES ($1,$2,$3,$4,'CONSULTANT','x','x','x','ACTIVE')`,
        [id, orgId, withProfile ? 'Priya Nair' : 'Empty Profile',
            `phase8-${id}@example.invalid`],
    );
    await query(
        `INSERT INTO consultant_profiles
            (user_id, organization_id, phone, city, state, linkedin_url,
             github_url, portfolio_url, summary)
         VALUES ($1,$2,'555-0100','Dallas','TX',
                 'https://linkedin.com/in/example',
                 'https://github.com/example', NULL,
                 $3)`,
        [id, orgId, withProfile ? 'Backend engineer building payment services.' : null],
    );
    created.consultants.push(id);
    if (!withProfile) return id;

    for (const name of ['Java', 'Spring Boot', 'SQL', 'Docker']) {
        const skill = await resolveSkill(name);
        await query(
            `INSERT INTO consultant_skills
                (id, organization_id, consultant_id, skill_id, position)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [randomUUID(), orgId, id, skill.id, 0],
        );
    }

    await query(
        `INSERT INTO consultant_experience
            (id, organization_id, consultant_id, company, title, location,
             start_date, end_date, is_current, bullets, tech_used, position)
         VALUES ($1,$2,$3,'Acme Payments','Senior Backend Engineer','Dallas, TX',
                 'Mar 2020', NULL, TRUE, $4::jsonb, $5::jsonb, 0)`,
        [randomUUID(), orgId, id,
            JSON.stringify([
                'Built and maintained the billing service using Java and Spring Boot.',
                'Wrote automated tests for the payment reconciliation pipeline.',
            ]),
            JSON.stringify(['Java', 'Spring Boot'])],
    );

    await query(
        `INSERT INTO consultant_education
            (id, organization_id, consultant_id, level, institution, board,
             degree, field_of_study, start_year, end_year, score, score_type, position)
         VALUES ($1,$2,$3,'BACHELORS','State University','State Board',
                 'B.Tech','Computer Science',2016,2020,'8.7','CGPA',0)`,
        [randomUUID(), orgId, id],
    );

    await query(
        `INSERT INTO consultant_projects
            (id, organization_id, consultant_id, name, description, duration,
             team_size, role, repo_url, bullets, tech_used, position)
         VALUES ($1,$2,$3,'Ledger Reconciler','Nightly reconciliation tool',
                 '3 months', 4, 'Lead developer','https://github.com/example/ledger',
                 $4::jsonb, $5::jsonb, 0)`,
        [randomUUID(), orgId, id,
            JSON.stringify(['Cut manual reconciliation effort for the finance team.']),
            JSON.stringify(['Java'])],
    );

    await query(
        `INSERT INTO consultant_certifications
            (id, organization_id, consultant_id, kind, name, issuer, issued_on, position)
         VALUES ($1,$2,$3,'CERTIFICATION','AWS Solutions Architect','Amazon','2023',0),
                ($4,$2,$3,'AWARD','Runner-up, internal hackathon','Acme','2022',1)`,
        [randomUUID(), orgId, id, randomUUID()],
    );

    return id;
};

const makePosting = async (orgId) => {
    const id = randomUUID();
    await query(
        `INSERT INTO job_postings
            (id, organization_id, company, title, location_text, is_remote,
             description, source_url, fingerprint)
         VALUES ($1,$2,'Testco','Senior Backend Engineer','Dallas, TX',FALSE,$3,$4,$5)`,
        [id, orgId, JD, `https://example.invalid/phase8/${id}`,
            createHash('sha256').update(`phase8-${id}`).digest('hex')],
    );
    created.postings.push(id);
    return id;
};

const makeItem = async (orgId, consultantId, postingId) => {
    const id = randomUUID();
    await query(
        `INSERT INTO queue_items
            (id, organization_id, consultant_id, posting_id, status_id, channel)
         VALUES ($1,$2,$3,$4,
                 (SELECT id FROM lkp_queue_statuses WHERE name='PREPARING'),'HUMAN')`,
        [id, orgId, consultantId, postingId],
    );
    created.queueItems.push(id);
    return id;
};

const itemState = async (id) => {
    const { rows } = await query(
        `SELECT st.name AS status, q.tailoring_state, q.tailoring_skip_reason,
                q.tailored_resume_artifact_id
           FROM queue_items q JOIN lkp_queue_statuses st ON st.id = q.status_id
          WHERE q.id = $1`, [id],
    );
    return rows[0];
};

const fakeJob = (orgId, queueItemId, attempts = 1, maxAttempts = 3) => ({
    id: randomUUID(), organization_id: orgId, kind: KIND,
    payload: { queueItemId }, attempts, max_attempts: maxAttempts,
});

const cleanup = async () => {
    for (const f of created.files) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    if (created.queueItems.length) {
        const ids = created.queueItems;
        const { rows: files } = await query(
            `SELECT organization_id, stored_name FROM resume_artifacts
              WHERE queue_item_id = ANY($1::char(36)[])`, [ids]);
        for (const f of files) {
            try { fs.unlinkSync(`${process.cwd()}/uploads/${f.organization_id}/${f.stored_name}`); }
            catch { /* gone */ }
        }
        await query('DELETE FROM resume_fabrication_flags WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM resume_tailoring_runs WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('UPDATE queue_items SET tailored_resume_artifact_id = NULL WHERE id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM resume_artifacts WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM queue_item_transitions WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM queue_items WHERE id = ANY($1::char(36)[])', [ids]);
        created.queueItems = [];
    }
    if (created.postings.length) {
        await query('DELETE FROM job_postings WHERE id = ANY($1::char(36)[])', [created.postings]);
        created.postings = [];
    }
    if (created.consultants.length) {
        await query('DELETE FROM resume_tailoring_runs WHERE consultant_id = ANY($1::char(36)[])',
            [created.consultants]);
        // users cascades to profiles, skills, education, experience,
        // projects and certifications.
        await query('DELETE FROM users WHERE id = ANY($1::char(36)[])', [created.consultants]);
        created.consultants = [];
    }
    if (created.orgId && created.originalSource) {
        await query('UPDATE organizations SET resume_source = $2, resume_template = $3 WHERE id = $1',
            [created.orgId, created.originalSource, created.originalTemplate]);
    }
};

/* ── the suite ────────────────────────────────────────────────────────── */

const main = async () => {
    section('the completeness rule');

    check('an empty profile is missing everything',
        profileGaps({ name: null, skills: [], experience: [], projects: [], education: [] }).length,
        3);
    check('a name and a skill are still not enough to build from',
        profileGaps({ name: 'A', skills: [{}], experience: [], projects: [], education: [] }),
        ['at least one of: work experience, a project, or education']);
    // A fresher with no employment history is not an incomplete profile. That
    // is exactly the case the entry-level template exists for.
    check('education alone is enough — a fresher is not incomplete',
        profileGaps({ name: 'A', skills: [{}], experience: [], projects: [], education: [{}] }),
        []);
    check('a project alone is enough',
        profileGaps({ name: 'A', skills: [{}], experience: [], projects: [{}], education: [] }),
        []);

    const { rows: orgs } = await query(
        'SELECT id, resume_source, resume_template FROM organizations WHERE is_active ORDER BY created_at LIMIT 1');
    if (orgs.length === 0) {
        console.log('\n  No active organisation — run the seeds first.');
        await pool.end();
        process.exit(1);
    }
    const orgId = orgs[0].id;
    created.orgId = orgId;
    created.originalSource = orgs[0].resume_source;
    created.originalTemplate = orgs[0].resume_template;

    await query("UPDATE organizations SET resume_source='PROFILE', resume_template='CLASSIC' WHERE id=$1",
        [orgId]);

    /* ── assembling ───────────────────────────────────────────────── */

    section('assembling the resume from profile rows');

    const consultantId = await makeConsultant(orgId, { withProfile: true });
    const built = await buildProfileResume({ orgId, consultantId, templateName: 'CLASSIC' });

    check('a filled profile builds', built.ok, true);
    const s = built.document.sections;

    check('contact comes from users + profile',
        [s.contact.name, s.contact.location], ['Priya Nair', 'Dallas, TX']);
    check('every profile link is carried', s.contact.links.length, 2);
    check('skills are grouped by category',
        s.skills.every((g) => g.category && g.items.length > 0), true);
    check('experience carries its bullets', s.experience[0].bullets.length, 2);
    check('an ongoing role reads as Present', s.experience[0].endDate, 'Present');
    // The facts a resume has no room to list separately, folded into the one
    // line it does have.
    check('project metadata is folded into the description',
        s.projects[0].description.includes('Lead developer')
        && s.projects[0].description.includes('Team of 4'), true);
    // A project used to print as a name and one packed line. Its description,
    // the points written for it and its technologies are all points now.
    check('a project’s description is a point, not part of the meta line',
        s.projects[0].bullets.includes('Nightly reconciliation tool'), true);
    check('  and is not repeated in the meta line',
        s.projects[0].description.includes('Nightly reconciliation tool'), false);
    check('  the consultant’s own point is kept',
        s.projects[0].bullets.includes('Cut manual reconciliation effort for the finance team.'), true);
    check('  the technologies are printed as a point',
        s.projects[0].bullets.includes('Technologies used: Java'), true);
    // Printed right-aligned on the project's own line, like an employment
    // date — not folded into the meta line beneath it.
    check('the project duration is its own "when", not part of the description',
        [s.projects[0].when, s.projects[0].description.includes('3 months')],
        ['3 months', false]);
    check('an Indian-format score survives as written',
        s.education[0].details.includes('8.7 CGPA'), true);
    check('the section order comes from the TEMPLATE, not the model',
        s.sectionOrder, getTemplate('CLASSIC').sections);
    // A hackathon placing is real and belongs on the page, but printing it
    // under CERTIFICATIONS would overstate it.
    check('a certification stays a certification', s.certifications.length, 1);
    check('an award moves to its own section',
        s.additional[0].items[0].includes('Runner-up'), true);

    check('the fabrication baseline contains the real bullets',
        built.document.rawText.includes('billing service using Java'), true);

    /* ── the pipeline ─────────────────────────────────────────────── */

    section('the pipeline, in PROFILE mode');

    process.env.LLM_MOCK_RESPONSE_TAILOR = JSON.stringify(s);
    process.env.LLM_MOCK_RESPONSE_CHECK = JSON.stringify({ flags: [] });
    delete process.env.LLM_MOCK_FAIL;

    const postingId = await makePosting(orgId);
    const itemId = await makeItem(orgId, consultantId, postingId);
    const result = await tailorHandler(fakeJob(orgId, itemId));

    let state = await itemState(itemId);
    check('it reaches READY', state.status, 'READY');
    check('marked TAILORED', state.tailoring_state, 'TAILORED');
    check('with the tailored file attached',
        state.tailored_resume_artifact_id === result.artifactId, true);

    const { rows: art } = await query(
        `SELECT kind, template, resume_source, source_artifact_id,
                ats_score_before, ats_score_after, stored_name
           FROM resume_artifacts WHERE id = $1`, [result.artifactId]);
    check('the artifact records which template drew it', art[0].template, 'CLASSIC');
    check('and which source produced it', art[0].resume_source, 'PROFILE');
    // In PROFILE mode there is no source FILE this descends from.
    check('it descends from no base file', art[0].source_artifact_id, null);
    check('both ATS scores were recorded',
        typeof art[0].ats_score_before === 'number'
        && typeof art[0].ats_score_after === 'number', true);
    created.files.push(`${process.cwd()}/uploads/${orgId}/${art[0].stored_name}`);

    // No base resume was uploaded for this consultant at all — the whole point
    // is that PROFILE mode does not need one.
    const { rows: base } = await query(
        "SELECT count(*)::int n FROM resume_artifacts WHERE consultant_id = $1 AND kind = 'base'",
        [consultantId]);
    check('no base resume was needed anywhere', base[0].n, 0);

    /* ── the empty profile ────────────────────────────────────────── */

    section('a consultant who has filled nothing in');

    const emptyId = await makeConsultant(orgId, { withProfile: false });
    const emptyPosting = await makePosting(orgId);
    const emptyItem = await makeItem(orgId, emptyId, emptyPosting);
    const emptyResult = await tailorHandler(fakeJob(orgId, emptyItem));

    state = await itemState(emptyItem);
    // The rule that governs every other shortfall in this pipeline: the
    // application still goes out, and it says why it is not tailored.
    check('the application still goes out', state.status, 'READY');
    check('marked NOT_TAILORED', state.tailoring_state, 'NOT_TAILORED');
    check('with PROFILE_INCOMPLETE as the reason',
        state.tailoring_skip_reason, 'PROFILE_INCOMPLETE');
    check('nothing was invented to fill the gaps',
        state.tailored_resume_artifact_id, null);
    check('and the handler reports it rather than throwing',
        emptyResult.tailored, false);

    const { rows: spent } = await query(
        "SELECT count(*)::int n FROM resume_tailoring_runs WHERE queue_item_id = $1",
        [emptyItem]);
    // The gap is found before any model is called, so an unfinished profile
    // costs nothing at all.
    check('no paid call was made for an empty profile', spent[0].n, 0);

    /* ── the template decides the order ───────────────────────────── */

    section('the template decides the running order');

    const entry = await buildProfileResume({
        orgId, consultantId, templateName: 'ENTRY_LEVEL',
    });
    check('entry-level puts education before skills',
        entry.document.sections.sectionOrder.indexOf('education')
        < entry.document.sections.sectionOrder.indexOf('skills'), true);

    const technical = await buildProfileResume({
        orgId, consultantId, templateName: 'TECHNICAL',
    });
    check('technical puts projects before experience',
        technical.document.sections.sectionOrder.indexOf('projects')
        < technical.document.sections.sectionOrder.indexOf('experience'), true);
    check('an unknown template falls back rather than failing',
        (await buildProfileResume({ orgId, consultantId, templateName: 'NOPE' }))
            .document.sections.sectionOrder,
        getTemplate('CLASSIC').sections);

    await cleanup();

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));

    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
};

main().catch(async (err) => {
    console.error('\nSuite aborted:', err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
});
