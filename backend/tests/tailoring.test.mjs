/**
 * Phase 7 — the resume tailoring pipeline, end to end.
 *
 *   node tests/tailoring.test.mjs
 *
 * Runs the whole preparation stage against the real database and a real base
 * resume file, with the mock provider standing in for the model. Every stage
 * downstream of the model call is genuine: PDF extraction, the ATS scorer, the
 * mechanical fabrication pass, pdfkit, the artifact row, the state transition.
 *
 * ── WHY THE MOCK IS A PROVIDER AND NOT A STUB ─────────────────────────
 *
 * The provider for this system is deliberately not yet chosen. A test that
 * monkey-patched one vendor's client would have to be rewritten alongside that
 * decision — and would prove nothing about the abstraction that decision is
 * supposed to slot into. Setting LLM_PROVIDER=mock exercises the same facade,
 * the same schema validation, and the same failure handling every real provider
 * will go through.
 *
 * Everything created here is removed at the end.
 */
process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';

/*
 * Clear any PER-STAGE overrides the developer's .env sets.
 *
 * `stageConfig` reads LLM_TAILOR_MODEL before falling back to LLM_MODEL, so a
 * real .env pointing the tailor stage at a live model silently beat the two
 * lines above and this suite recorded a real provider's model id against a mock
 * call. It failed loudly on one assertion and would have passed quietly on the
 * rest — a test that reads the machine it runs on is not a test.
 */
for (const stage of ['PARSE', 'TAILOR', 'CHECK']) {
    delete process.env[`LLM_${stage}_PROVIDER`];
    delete process.env[`LLM_${stage}_MODEL`];
}


import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { handle as tailorHandler, KIND } from '../jobs/handlers/tailorResume.js';
import { mechanicalFlags } from '../services/fabricationCheck.js';
import { scoreResume, extractKeywords } from '../config/atsScore.js';
import { buildFilename, renderResumePdf, tailoredDir } from '../services/resumePdf.js';
import { spendThisPeriod } from '../connectors/llm/index.js';
import { extractResumeText } from '../utils/resumeText.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── fixtures ─────────────────────────────────────────────────────────── */

const BASE_RESUME = {
    contact: {
        name: 'Priya Nair',
        email: 'priya@example.com',
        phone: '555-0100',
        location: 'Dallas, TX',
        links: [],
    },
    sectionOrder: ['summary', 'skills', 'experience', 'education'],
    summary: 'Backend engineer with experience building payment services.',
    skills: [{ category: 'Languages', items: ['Java', 'Python', 'SQL'] }],
    experience: [{
        company: 'Acme Payments',
        title: 'Senior Backend Engineer',
        location: 'Dallas, TX',
        startDate: 'Mar 2020',
        endDate: 'Present',
        bullets: [
            'Built and maintained the billing service using Java and Spring Boot.',
            'Wrote automated tests for the payment reconciliation pipeline.',
            'Improved database query performance on the transactions table.',
        ],
    }],
    projects: [],
    education: [{ institution: 'State University', degree: 'BSc', field: 'Computer Science' }],
    certifications: [],
    additional: [],
};

/** Honest tailoring: reworded and reordered, nothing added. */
const TAILORED_CLEAN = {
    ...BASE_RESUME,
    summary: 'Backend engineer building payment services in Java.',
    experience: [{
        ...BASE_RESUME.experience[0],
        bullets: [
            'Test automation for the payment reconciliation pipeline.',
            'Built and maintained the billing service using Java and Spring Boot.',
            'Improved database query performance on the transactions table.',
        ],
    }],
};

/** Dishonest tailoring: an invented figure and an invented technology. */
const TAILORED_DIRTY = {
    ...BASE_RESUME,
    experience: [{
        ...BASE_RESUME.experience[0],
        bullets: [
            'Built the billing service using Java, Spring Boot and Kubernetes.',
            'Improved database query performance by 40% on the transactions table.',
        ],
    }],
};

const JOB_DESCRIPTION = `We are hiring a Senior Backend Engineer.

Requirements:
- Strong Java and Spring Boot experience
- Test automation and CI/CD
- SQL and database performance tuning
- Experience with payment or billing systems

Benefits: health insurance, paid holidays, equal opportunity employer.`;

/* ── pure stages ──────────────────────────────────────────────────────── */

const pureTests = () => {
    section('ATS scoring');

    const keywords = extractKeywords(JOB_DESCRIPTION, ['java', 'spring boot']);
    check('posting boilerplate is not scored as a skill',
        ['benefits', 'insurance', 'requirements', 'opportunity']
            .some((w) => keywords.has(w)),
        false);
    check('real requirements are picked up',
        ['java', 'spring', 'boot', 'sql'].every((w) => keywords.has(w)), true);

    const baseText = 'Java Spring Boot billing service. Automated tests. SQL performance.';
    const scored = scoreResume(baseText, JOB_DESCRIPTION, ['java']);
    check('a relevant resume scores above zero', scored.score > 0, true);
    check('missing terms are reported, most important first',
        scored.missing.length > 0
            && scored.missing[0].weight >= scored.missing[scored.missing.length - 1].weight,
        true);

    const irrelevant = scoreResume('Pastry chef. Menu design. Inventory.', JOB_DESCRIPTION);
    check('an unrelated resume scores lower than a relevant one',
        irrelevant.score < scored.score, true);

    // A posting with no text is not the resume's fault; null says "not
    // measurable", where zero would say "this resume is terrible".
    check('an empty posting scores null rather than zero',
        scoreResume(baseText, '').score, null);

    check('"java" does not match inside "javascript"',
        scoreResume('JavaScript developer', 'We need Java').score, 0);

    section('the mechanical fabrication pass');

    const baseFlat = JSON.stringify(BASE_RESUME);
    const cleanFlags = mechanicalFlags(baseFlat, JSON.stringify(TAILORED_CLEAN));
    check('honest rewording raises nothing', cleanFlags, []);

    const dirtyFlags = mechanicalFlags(baseFlat, JSON.stringify(TAILORED_DIRTY));
    check('an invented percentage is caught',
        dirtyFlags.some((f) => f.claim.includes('40%')), true);
    check('an invented technology is caught',
        dirtyFlags.some((f) => f.claim === 'Kubernetes'), true);
    check('and both are HIGH severity',
        dirtyFlags.every((f) => f.severity === 'HIGH'), true);
    check('both are attributed to the rule pass, not a model',
        dirtyFlags.every((f) => f.detectedBy === 'RULE'), true);

    // Without this, every tailored resume flags on ordinary capitalised words
    // and the review queue becomes noise a reviewer learns to click through.
    check('ordinary capitalised words are not treated as technologies',
        mechanicalFlags('worked on things', 'THE AND FOR WITH USA Inc'), []);
    check('a technology already in the base is not flagged',
        mechanicalFlags('I used PostgreSQL daily', 'Expert in PostgreSQL'), []);
    check('a figure already in the base is not flagged',
        mechanicalFlags('reduced latency by 40%', 'cut latency 40%'), []);

    section('the output filename');

    check('company, title and date',
        buildFilename('Acme Payments', 'Senior Engineer', new Date('2026-08-30T00:00:00Z')),
        'Acme_Payments_Senior_Engineer_2026-08-30.pdf');
    // A crafted company name must not be able to write outside the folder.
    check('path traversal cannot escape through the name',
        buildFilename('../../etc', 'passwd', new Date('2026-01-01T00:00:00Z')),
        'etc_passwd_2026-01-01.pdf');
    check('an empty company still produces a usable name',
        buildFilename('', 'Engineer', new Date('2026-01-01T00:00:00Z')),
        'Job_Engineer_2026-01-01.pdf');
};

/* ── the rendered PDF ─────────────────────────────────────────────────── */

const pdfTest = async (orgId) => {
    section('rendering the PDF');

    const artifactId = randomUUID();
    const file = await renderResumePdf({
        orgId, resume: BASE_RESUME, company: 'Acme Payments', title: 'Senior Engineer', artifactId,
    });

    const bytes = fs.readFileSync(file.absolutePath);
    check('a real PDF is written', bytes.slice(0, 4).toString(), '%PDF');
    check('it has content', bytes.length > 1000, true);
    check('the sha256 is recorded', file.sha256.length, 64);
    // D2: tailored files live apart from base resumes, so the base-resume
    // pruner can never reach them.
    check('it is stored under tailored/, away from base resumes',
        file.storedName.replace(/\\/g, '/').startsWith('tailored/'), true);

    // Read back through our own extractor rather than grepping the raw bytes.
    // Grepping proves the glyphs are in the file; this proves the document is
    // PARSEABLE, which is the only property that matters to the applicant
    // tracking system on the other end.
    const readBack = await extractResumeText(bytes);
    check('the rendered PDF can be read back as text', readBack.ok, true);

    const out = readBack.ok ? readBack.text : '';
    check('the name survives the round trip', out.includes('Priya Nair'), true);
    check('the section headings survive', out.includes('PROFESSIONAL EXPERIENCE'), true);
    check('the bullets survive',
        out.includes('billing service using Java and Spring Boot'), true);
    check('contact details survive as text, not as icons',
        out.includes('priya@example.com'), true);
    // Section order is the base resume's, and the renderer follows it without
    // ever consulting the model about where anything goes.
    check('sections come out in the base resume\'s own order',
        out.indexOf('TECHNICAL SKILLS') < out.indexOf('PROFESSIONAL EXPERIENCE')
        && out.indexOf('PROFESSIONAL EXPERIENCE') < out.indexOf('EDUCATION'),
        true);

    fs.unlinkSync(file.absolutePath);
    return true;
};

/* ── the whole pipeline ───────────────────────────────────────────────── */

const created = {
    queueItems: [], postings: [], files: [],
    consultantId: null, baseArtifactId: null,
};

const makeItem = async ({ orgId, consultantId, postingId }) => {
    const id = randomUUID();
    await query(
        `INSERT INTO queue_items
            (id, organization_id, consultant_id, posting_id, status_id, channel)
         VALUES ($1,$2,$3,$4,
                 (SELECT id FROM lkp_queue_statuses WHERE name='PREPARING'), 'HUMAN')`,
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
          WHERE q.id = $1`,
        [id],
    );
    return rows[0];
};

const fakeJob = (orgId, queueItemId, attempts = 1, maxAttempts = 3) => ({
    id: randomUUID(),
    organization_id: orgId,
    kind: KIND,
    payload: { queueItemId },
    attempts,
    max_attempts: maxAttempts,
});

const cleanup = async () => {
    for (const f of created.files) { try { fs.unlinkSync(f); } catch { /* gone */ } }
    if (created.queueItems.length) {
        const ids = created.queueItems;
        await query('DELETE FROM resume_fabrication_flags WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM resume_tailoring_runs WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('UPDATE queue_items SET tailored_resume_artifact_id = NULL WHERE id = ANY($1::char(36)[])', [ids]);

        // The PDFs the pipeline wrote. Read the paths back from the rows before
        // deleting them — a test that leaves files behind on every run is a
        // test that slowly fills the uploads folder with rubbish.
        const { rows: files } = await query(
            `SELECT organization_id, stored_name FROM resume_artifacts
              WHERE queue_item_id = ANY($1::char(36)[])`,
            [ids],
        );
        for (const f of files) {
            try {
                fs.unlinkSync(`${process.cwd()}/uploads/${f.organization_id}/${f.stored_name}`);
            } catch { /* already gone */ }
        }

        await query('DELETE FROM resume_artifacts WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM queue_item_transitions WHERE queue_item_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM queue_items WHERE id = ANY($1::char(36)[])', [ids]);
    }
    if (created.postings.length) {
        await query('DELETE FROM job_postings WHERE id = ANY($1::char(36)[])',
            [created.postings]);
        created.postings = [];
    }
    if (created.consultantId) {
        // The profile's FK to the base artifact has to be released before the
        // artifact row can go, and the user before the artifact's consultant_id.
        await query('UPDATE consultant_profiles SET base_resume_artifact_id = NULL WHERE user_id = $1',
            [created.consultantId]);
        await query('DELETE FROM resume_tailoring_runs WHERE consultant_id = $1',
            [created.consultantId]);
        await query('DELETE FROM resume_documents WHERE artifact_id = $1',
            [created.baseArtifactId]);
        await query('DELETE FROM users WHERE id = $1', [created.consultantId]);
        await query('DELETE FROM resume_artifacts WHERE id = $1', [created.baseArtifactId]);
        created.consultantId = null;
        created.baseArtifactId = null;
    }
    await query("DELETE FROM background_jobs WHERE kind = 'tailorResume' AND payload->>'queueItemId' = ANY($1::text[])",
        [created.queueItems.length ? created.queueItems : ['-']]);
    created.queueItems = [];
};

const main = async () => {
    pureTests();

    // ── the fixture consultant ────────────────────────────────────────
    //
    // Built here rather than borrowed from the seeded data, and the reason is
    // the subtlest thing in this suite.
    //
    // The fabrication check compares the tailored resume against the BASE
    // RESUME'S EXTRACTED TEXT — the real bytes on disk — not against whatever
    // the parse stage returned. Borrowing a real consultant meant the mock
    // handed back this file's fictional sections while `baseText` came from
    // that consultant's genuine resume, so every sentence in the "clean"
    // fixture was, correctly, unsupported. The suite was not wrong; the fixture
    // was incoherent.
    //
    // So the base resume on disk is RENDERED FROM the same fixture the mock
    // returns. Base text and parsed sections then describe one person, which is
    // the only arrangement in which "clean" and "flagged" mean anything.
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1',
    );
    if (orgs.length === 0) {
        console.log('\n  No active organisation — run the seeds first.');
        await pool.end();
        process.exit(1);
    }
    const orgId = orgs[0].id;

    await pdfTest(orgId);

    const baseFile = await renderResumePdf({
        orgId,
        resume: BASE_RESUME,
        company: 'Base',
        title: 'Resume',
        artifactId: randomUUID(),
    });
    created.files.push(baseFile.absolutePath);

    // Order matters and is enforced by the schema: resume_artifacts.consultant_id
    // is NOT NULL, so the user exists first; consultant_profiles then points at
    // the artifact.
    const consultantId = randomUUID();
    await query(
        `INSERT INTO users
            (id, organization_id, name, email, role, password_enc, password_iv,
             password_tag, employment_status)
         VALUES ($1,$2,'Phase 7 Fixture',$3,'CONSULTANT','x','x','x','ACTIVE')`,
        [consultantId, orgId, `phase7-fixture-${consultantId}@example.invalid`],
    );
    created.consultantId = consultantId;

    const baseArtifactId = randomUUID();
    await query(
        `INSERT INTO resume_artifacts
            (id, organization_id, consultant_id, kind, original_name, stored_name,
             mime_type, size_bytes, sha256)
         VALUES ($1,$2,$3,'base',$4,$5,'application/pdf',$6,$7)`,
        [baseArtifactId, orgId, consultantId, 'phase7-fixture.pdf', baseFile.storedName,
            baseFile.sizeBytes, baseFile.sha256],
    );
    created.baseArtifactId = baseArtifactId;

    await query(
        `INSERT INTO consultant_profiles (user_id, organization_id, base_resume_artifact_id)
         VALUES ($1,$2,$3)`,
        [consultantId, orgId, baseArtifactId],
    );

    const consultant = { id: consultantId, org_id: orgId, name: 'Phase 7 Fixture' };
    console.log(`\nRunning the pipeline for "${consultant.name}"`);

    // The suite makes its own postings rather than borrowing real ones.
    // Borrowing meant the run depended on whether this consultant's
    // organisation happened to have postings they were not already queued
    // against — which is why the pipeline half of this suite silently skipped
    // the first time it was run, reporting a green 28/28 while testing none of
    // the thing it exists to test.
    const postings = [];
    for (let i = 0; i < 6; i += 1) {
        const id = randomUUID();
        await query(
            `INSERT INTO job_postings
                (id, organization_id, company, title, location_text, is_remote,
                 description, source_url, fingerprint)
             VALUES ($1,$2,$3,$4,'Dallas, TX',FALSE,$5,$6,$7)`,
            [id, orgId, 'Testco Payments', 'Senior Backend Engineer',
                JOB_DESCRIPTION, `https://example.invalid/phase7-test/${id}`,
                createHash('sha256').update(`phase7-test-${id}`).digest('hex')],
        );
        created.postings.push(id);
        postings.push({ id });
    }

    /* ── the clean path ────────────────────────────────────────────── */

    section('the pipeline — a clean tailoring');

    process.env.LLM_MOCK_RESPONSE_PARSE = JSON.stringify(BASE_RESUME);
    process.env.LLM_MOCK_RESPONSE_TAILOR = JSON.stringify(TAILORED_CLEAN);
    process.env.LLM_MOCK_RESPONSE_CHECK = JSON.stringify({ flags: [] });
    delete process.env.LLM_MOCK_FAIL;

    const cleanItem = await makeItem({
        orgId, consultantId: consultant.id, postingId: postings[0].id,
    });
    const cleanResult = await tailorHandler(fakeJob(orgId, cleanItem));

    let state = await itemState(cleanItem);
    check('a clean resume reaches READY', state.status, 'READY');
    check('and is marked TAILORED', state.tailoring_state, 'TAILORED');
    check('with no skip reason', state.tailoring_skip_reason, null);
    check('the tailored artifact is attached to the item',
        state.tailored_resume_artifact_id === cleanResult.artifactId, true);
    check('an ATS score was recorded for both versions',
        typeof cleanResult.atsBefore === 'number' && typeof cleanResult.atsAfter === 'number',
        true);

    const { rows: art } = await query(
        `SELECT kind, mime_type, stored_name, source_artifact_id, ats_score_before,
                ats_score_after, provider, model
           FROM resume_artifacts WHERE id = $1`,
        [cleanResult.artifactId],
    );
    check('the artifact is a tailored PDF', [art[0].kind, art[0].mime_type],
        ['tailored', 'application/pdf']);
    check('it points back at the base resume it came from',
        art[0].source_artifact_id !== null, true);
    check('the provider and model that made it are recorded',
        [art[0].provider, art[0].model], ['mock', 'mock-model']);
    created.files.push(`${process.cwd()}/uploads/${orgId}/${art[0].stored_name}`);

    const { rows: ledger } = await query(
        `SELECT stage, verdict FROM resume_tailoring_runs
          WHERE queue_item_id = $1 ORDER BY created_at`,
        [cleanItem],
    );
    check('both paid stages are in the cost ledger',
        ledger.map((r) => r.stage).sort(), ['check', 'tailor']);
    check('and both are recorded clean',
        ledger.every((r) => r.verdict === 'CLEAN'), true);

    /* ── the flagged path ──────────────────────────────────────────── */

    section('the pipeline — a fabricated claim');

    process.env.LLM_MOCK_RESPONSE_TAILOR = JSON.stringify(TAILORED_DIRTY);

    const dirtyItem = await makeItem({
        orgId, consultantId: consultant.id, postingId: postings[1].id,
    });
    const dirtyResult = await tailorHandler(fakeJob(orgId, dirtyItem));

    state = await itemState(dirtyItem);
    check('a flagged resume holds at RESUME_REVIEW', state.status, 'RESUME_REVIEW');
    check('and is marked FLAGGED', state.tailoring_state, 'FLAGGED');
    // The whole point of the gate: an unreviewed resume must not be reachable
    // by the desktop app, which resolves COALESCE(tailored, base).
    check('the flagged file is NOT attached to the queue item',
        state.tailored_resume_artifact_id, null);
    check('flags were raised', dirtyResult.flags > 0, true);

    const { rows: flags } = await query(
        `SELECT claim_text, severity, detected_by, reviewer_verdict
           FROM resume_fabrication_flags WHERE queue_item_id = $1`,
        [dirtyItem],
    );
    check('the invented figure is on the record',
        flags.some((f) => f.claim_text.includes('40%')), true);
    check('the invented technology is on the record',
        flags.some((f) => f.claim_text === 'Kubernetes'), true);
    check('every flag starts awaiting a decision',
        flags.every((f) => f.reviewer_verdict === 'PENDING'), true);
    const { rows: dirtyLedger } = await query(
        "SELECT verdict FROM resume_tailoring_runs WHERE queue_item_id = $1 AND stage = 'check'",
        [dirtyItem],
    );
    check('the check stage is recorded as FLAGGED', dirtyLedger[0].verdict, 'FLAGGED');

    /* ── failure paths ─────────────────────────────────────────────── */

    section('the pipeline — the provider is down');

    process.env.LLM_MOCK_FAIL = 'retryable';
    process.env.LLM_MOCK_FAIL_STAGE = 'tailor';

    const failItem = await makeItem({
        orgId, consultantId: consultant.id, postingId: postings[2].id,
    });

    // Attempts remain, so the handler must RAISE and let the worker retry
    // rather than giving up on the first hiccup.
    let threw = false;
    try {
        await tailorHandler(fakeJob(orgId, failItem, 1, 3));
    } catch { threw = true; }
    check('with retries left it throws, so the worker retries', threw, true);
    check('and the item stays at PREPARING',
        (await itemState(failItem)).status, 'PREPARING');

    // On the LAST attempt the right move is to finish, not to raise. An
    // application must never fail to go out because the AI stage had a bad day.
    const lastResult = await tailorHandler(fakeJob(orgId, failItem, 3, 3));
    state = await itemState(failItem);
    check('on the final attempt it finishes rather than failing', state.status, 'READY');
    check('marked NOT_TAILORED', state.tailoring_state, 'NOT_TAILORED');
    check('with AI_FAILED as the reason', state.tailoring_skip_reason, 'AI_FAILED');
    check('and no tailored file attached, so the base resume is used',
        state.tailored_resume_artifact_id, null);
    check('the handler reports the outcome rather than throwing',
        lastResult.tailored, false);

    delete process.env.LLM_MOCK_FAIL;
    delete process.env.LLM_MOCK_FAIL_STAGE;

    section('the pipeline — no provider configured');

    const savedProvider = process.env.LLM_PROVIDER;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_TAILOR_PROVIDER;

    const offItem = await makeItem({
        orgId, consultantId: consultant.id, postingId: postings[3].id,
    });
    await tailorHandler(fakeJob(orgId, offItem));
    state = await itemState(offItem);
    check('with no provider chosen the application still goes out',
        state.status, 'READY');
    check('marked so anyone can see why it was not tailored',
        [state.tailoring_state, state.tailoring_skip_reason],
        ['NOT_TAILORED', 'LLM_NOT_CONFIGURED']);

    process.env.LLM_PROVIDER = savedProvider;

    section('the pipeline — the item moved underneath us');

    const goneItem = await makeItem({
        orgId, consultantId: consultant.id, postingId: postings[4].id,
    });
    await query(
        `UPDATE queue_items SET status_id =
            (SELECT id FROM lkp_queue_statuses WHERE name='CANCELLED') WHERE id = $1`,
        [goneItem],
    );
    const skipped = await tailorHandler(fakeJob(orgId, goneItem));
    check('a cancelled item is left alone rather than re-prepared',
        Boolean(skipped.skipped), true);

    /* ── budget ────────────────────────────────────────────────────── */

    section('the spend ledger');

    const spend = await spendThisPeriod(orgId);
    check('spend is readable', typeof spend.spent, 'number');
    check('the budget is readable', typeof spend.budget, 'number');
    // The mock is priced at zero, so nothing here should have exhausted a
    // real budget.
    check('a zero-cost provider does not exhaust the budget', spend.exhausted, false);

    /* ── done ──────────────────────────────────────────────────────── */

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
