/**
 * Phase 8 — the career-record API.
 *
 *   node tests/profileApi.test.mjs
 *
 * Calls the controller handlers directly with stand-in req/res objects rather
 * than over HTTP.
 *
 * ── WHY NOT THROUGH HTTP ──────────────────────────────────────────────
 *
 * The risk in this controller is the SQL, not the routing. It builds column
 * lists and placeholder strings from a registry, so a mistake shows up as a
 * malformed query — and that is visible whether the call arrives through
 * Express or not. Going through HTTP would mean booting a server and minting
 * tokens to test the same statements, and would test Express rather than this.
 *
 * The scope checks ARE exercised, because those are the other thing worth
 * proving: a consultant must not be able to touch another consultant's rows.
 */
import { randomUUID } from 'node:crypto';
import { query, pool } from '../db.js';
import {
    listSection, getFullProfile, createRow, updateRow, deleteRow, reorderSection,
    addSkill, removeSkill, updateBasics, searchSkillsEndpoint, validateSection,
} from '../controllers/profileSectionsController.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/** A res that records what the handler did instead of writing to a socket. */
const mockRes = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};

/** Run a handler and surface any thrown error rather than swallowing it. */
const call = async (handler, req) => {
    const res = mockRes();
    let thrown = null;
    await handler(req, res, (e) => { thrown = e; });
    if (thrown) throw thrown;
    return res;
};

/**
 * Run a section handler through validateSection first, as the routes do.
 *
 * Skipping it would test a path no real request takes — the validator is what
 * applies the schema defaults, so a handler called without it sees a body real
 * traffic never produces.
 */
const callValidated = async (handler, req) => {
    const res = mockRes();
    let passed = false;
    await validateSection(req, res, () => { passed = true; });
    if (!passed) return res;
    return call(handler, req);
};

const created = { consultants: [], orgId: null };

const cleanup = async () => {
    if (created.consultants.length) {
        await query('DELETE FROM users WHERE id = ANY($1::char(36)[])', [created.consultants]);
        created.consultants = [];
    }
};

const makeConsultant = async (orgId, name) => {
    const id = randomUUID();
    await query(
        `INSERT INTO users (id, organization_id, name, email, role,
                            password_enc, password_iv, password_tag, employment_status)
         VALUES ($1,$2,$3,$4,'CONSULTANT','x','x','x','ACTIVE')`,
        [id, orgId, name, `phase8api-${id}@example.invalid`],
    );
    await query(
        'INSERT INTO consultant_profiles (user_id, organization_id) VALUES ($1,$2)',
        [id, orgId],
    );
    created.consultants.push(id);
    return id;
};

const main = async () => {
    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1');
    if (orgs.length === 0) { console.log('No active organisation.'); process.exit(1); }
    const orgId = orgs[0].id;
    created.orgId = orgId;

    const me = await makeConsultant(orgId, 'API Fixture');
    const other = await makeConsultant(orgId, 'Somebody Else');

    const asMe = (extra = {}) => ({
        user: { id: me, orgId, role: 'CONSULTANT' },
        params: {}, body: {}, query: {}, ip: '127.0.0.1', ...extra,
    });

    /* ── every section round-trips ─────────────────────────────────── */

    section('each section accepts, lists, edits and deletes');

    const samples = {
        education: { level: 'BACHELORS', institution: 'State University', degree: 'B.Tech', score: '8.7', score_type: 'CGPA' },
        experience: { company: 'Acme', title: 'Engineer', bullets: ['Did the thing.'], tech_used: ['Java'] },
        projects: { name: 'Ledger', team_size: 4, bullets: ['Built it.'], repo_url: 'https://github.com/x/y' },
        certifications: { kind: 'CERTIFICATION', name: 'AWS SAA', issuer: 'Amazon' },
    };

    const ids = {};
    for (const [name, body] of Object.entries(samples)) {
        const res = await callValidated(createRow, asMe({ params: { section: name }, body }));
        check(`${name}: created`, res.statusCode, 201);
        ids[name] = res.body?.id;

        const list = await call(listSection, asMe({ params: { section: name } }));
        check(`${name}: listed`, list.body.items.length, 1);
    }

    // JSONB columns are the ones most likely to be written as a string.
    const { rows: expRow } = await query(
        'SELECT bullets, tech_used FROM consultant_experience WHERE id = $1', [ids.experience]);
    check('experience: bullets stored as real JSON', Array.isArray(expRow[0].bullets), true);
    check('experience: bullet content survives', expRow[0].bullets[0], 'Did the thing.');

    const upd = await callValidated(updateRow, asMe({
        params: { section: 'projects', id: ids.projects },
        body: { ...samples.projects, name: 'Ledger Reconciler', team_size: 6 },
    }));
    check('projects: edited', [upd.body.name, upd.body.team_size], ['Ledger Reconciler', 6]);

    /* ── the scope rule ────────────────────────────────────────────── */

    section('a consultant cannot reach somebody else\'s rows');

    // The other consultant's row, with a valid id, from the same agency. Only
    // the consultant_id in the WHERE clause stops this.
    const theirs = await callValidated(createRow, {
        user: { id: other, orgId, role: 'CONSULTANT' },
        params: { section: 'education' },
        body: samples.education, query: {}, ip: '1.1.1.1',
    });

    const steal = await callValidated(updateRow, asMe({
        params: { section: 'education', id: theirs.body.id },
        body: { ...samples.education, institution: 'Hacked University' },
    }));
    check('editing another consultant\'s row is a 404', steal.statusCode, 404);

    const stealDelete = await call(deleteRow, asMe({
        params: { section: 'education', id: theirs.body.id },
    }));
    check('deleting another consultant\'s row is a 404', stealDelete.statusCode, 404);

    const { rows: intact } = await query(
        'SELECT institution FROM consultant_education WHERE id = $1', [theirs.body.id]);
    check('and their row is untouched', intact[0].institution, 'State University');

    /* ── unknown sections fail closed ──────────────────────────────── */

    section('an unknown section never reaches a table lookup');

    const bad = mockRes();
    let nextCalled = false;
    await validateSection(
        { params: { section: 'consultant_profiles' }, body: {} },
        bad, () => { nextCalled = true; },
    );
    check('validateSection refuses it', bad.statusCode, 404);
    check('and does not call through to the handler', nextCalled, false);

    /* ── ordering ──────────────────────────────────────────────────── */

    section('order is the consultant\'s to set');

    await callValidated(createRow, asMe({
        params: { section: 'education' },
        body: { ...samples.education, institution: 'Second College' },
    }));
    const before = await call(listSection, asMe({ params: { section: 'education' } }));
    const order = before.body.items.map((r) => r.id);
    check('two entries', order.length, 2);

    await call(reorderSection, asMe({
        params: { section: 'education' }, body: { ids: [order[1], order[0]] },
    }));
    const after = await call(listSection, asMe({ params: { section: 'education' } }));
    check('the order is reversed', after.body.items.map((r) => r.id), [order[1], order[0]]);

    /* ── skills ────────────────────────────────────────────────────── */

    section('skills');

    const byName = await call(addSkill, asMe({ body: { name: 'Kubernetes' } }));
    check('added by name', byName.statusCode, 201);

    // The alias table is what makes this join the existing Kubernetes rather
    // than founding a rival entry — the whole reason the vocabulary exists.
    const alias = await call(addSkill, asMe({ body: { name: 'k8s' } }));
    check('an alias resolves to the same skill',
        alias.body.skill_id, byName.body.skill_id);

    const full = await call(getFullProfile, asMe());
    check('the profile carries exactly one Kubernetes',
        full.body.skills.filter((s) => s.name === 'Kubernetes').length, 1);

    const invented = await call(addSkill, asMe({ body: { name: 'Zorblang' } }));
    check('a genuinely new skill is accepted rather than refused',
        invented.statusCode, 201);
    const { rows: origin } = await query(
        'SELECT origin FROM lkp_skills WHERE id = $1', [invented.body.skill_id]);
    check('and is marked CUSTOM, not passed off as curated', origin[0].origin, 'CUSTOM');

    const gone = await call(removeSkill, asMe({
        params: { skillId: String(byName.body.skill_id) },
    }));
    check('a skill can be removed', gone.body.ok, true);

    /* ── basics ────────────────────────────────────────────────────── */

    section('the self-service scalar fields');

    await call(updateBasics, asMe({
        body: { headline: 'Backend Engineer', github_url: 'https://github.com/x' },
    }));
    let basics = (await call(getFullProfile, asMe())).body.basics;
    check('saved', [basics.headline, basics.github_url],
        ['Backend Engineer', 'https://github.com/x']);

    // A field the form did not render must not be wiped by a partial save.
    await call(updateBasics, asMe({ body: { summary: 'Writes services.' } }));
    basics = (await call(getFullProfile, asMe())).body.basics;
    check('a partial save leaves untouched fields alone',
        basics.headline, 'Backend Engineer');
    check('and applies the new one', basics.summary, 'Writes services.');

    await call(updateBasics, asMe({ body: { headline: '' } }));
    basics = (await call(getFullProfile, asMe())).body.basics;
    check('clearing a field stores null, not an empty string', basics.headline, null);

    /* ── the full payload ──────────────────────────────────────────── */

    section('the editor loads in one request');

    const everything = (await call(getFullProfile, asMe())).body;
    check('every section is present',
        ['education', 'experience', 'projects', 'certifications', 'skills', 'basics']
            .every((k) => k in everything), true);
    check('name and email come from the user record',
        everything.basics.name, 'API Fixture');

    /* ── autocomplete ──────────────────────────────────────────────── */

    section('autocomplete');

    const search = await call(searchSkillsEndpoint, asMe({ query: { q: 'postg' } }));
    check('finds PostgreSQL', search.body.items.some((i) => i.name === 'PostgreSQL'), true);
    const empty = await call(searchSkillsEndpoint, asMe({ query: { q: '' } }));
    check('an empty box still suggests something useful',
        empty.body.items.length > 0, true);

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
