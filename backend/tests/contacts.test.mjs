/**
 * Phase 7 — contact discovery, end to end.
 *
 *   node tests/contacts.test.mjs
 *
 * The waterfall against the real database, with Apollo replaced by recorded
 * fixtures. Everything below the HTTP boundary is genuine: poster extraction,
 * the store's reuse window, the upsert and its unique index, the link table,
 * the do-not-contact rule, the budget ceiling and the ledger.
 *
 * ── WHY THE PROVIDER IS STUBBED AT `fetch` AND NOT AT THE CONNECTOR ───
 *
 * Stubbing `apollo.matchPerson` would test the waterfall against a mock of the
 * thing most likely to be wrong. The connector's whole job is turning Apollo's
 * response shape into ours, and a test that skips it proves nothing about the
 * parsing — which, per the plan, has not yet been checked against a live key.
 *
 * So the fixtures are Apollo-shaped BODIES and the stub is `globalThis.fetch`.
 * Every retry, every status check and every field mapping in between runs for
 * real. When D6 reconciles the shapes against live responses, the fixtures in
 * this file are the thing to correct, and the correction is then covered.
 *
 * Everything created here is removed at the end.
 */
process.env.APOLLO_API_KEY = 'test-key-not-real';
process.env.CONTACT_REUSE_DAYS = '90';

import { randomUUID, createHash } from 'node:crypto';
import { query, pool } from '../db.js';
import { extractPosterName, looksLikePersonName } from '../config/posterName.js';
import { normalisePerson, matchPerson, isConfigured } from '../connectors/apollo.js';
import { discoverContacts, providerState, __test } from '../services/contactDiscovery.js';
import { handle as contactHandler, KIND } from '../jobs/handlers/discoverContact.js';
import { lookupPhone, NullPhoneProvider } from '../services/phoneProvider.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── the Apollo stub ──────────────────────────────────────────────────── */

const realFetch = globalThis.fetch;

/** Every request the connector made this run, so call COUNTS are assertable. */
let calls = [];

/**
 * Queue of canned responses, consumed in order.
 * Each entry is `{status, body}` — the raw shape Apollo returns.
 */
let responses = [];

const stubFetch = () => {
    calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        const next = responses.shift();
        if (!next) throw new Error(`Unexpected Apollo call to ${url} — no fixture queued.`);
        return new Response(JSON.stringify(next.body), {
            status: next.status ?? 200,
            headers: { 'content-type': 'application/json' },
        });
    };
};

const apolloPerson = (over = {}) => ({
    id: `apollo-${randomUUID().slice(0, 8)}`,
    first_name: 'Sarah',
    last_name: 'Chen',
    name: 'Sarah Chen',
    title: 'Technical Recruiter',
    seniority: 'manager',
    organization: { name: 'Testco Payments', primary_domain: 'testco.example' },
    city: 'Dallas',
    state: 'TX',
    country: 'USA',
    linkedin_url: 'https://linkedin.com/in/sarahchen',
    email: 'sarah.chen@testco.example',
    email_status: 'verified',
    phone_numbers: [{ sanitized_number: '+15550100' }],
    ...over,
});

/* ── fixtures we create ───────────────────────────────────────────────── */

const created = { postings: [], contacts: [], orgId: null, providerRestore: null };

const makePosting = async (orgId, { description, company = 'Testco Payments' }) => {
    const id = randomUUID();
    await query(
        `INSERT INTO job_postings
            (id, organization_id, company, title, location_text, is_remote,
             description, source_url, fingerprint)
         VALUES ($1,$2,$3,'Senior Backend Engineer','Dallas, TX',FALSE,$4,$5,$6)`,
        [id, orgId, company, description, `https://example.invalid/contacts-test/${id}`,
            createHash('sha256').update(`contacts-test-${id}`).digest('hex')],
    );
    created.postings.push(id);
    return id;
};

const linksFor = async (postingId) => {
    const { rows } = await query(
        `SELECT c.full_name, c.email, c.phone, c.do_not_contact, l.link_reason, l.rank
           FROM contact_links l JOIN contacts c ON c.id = l.contact_id
          WHERE l.posting_id = $1 ORDER BY l.rank`,
        [postingId],
    );
    return rows;
};

const lookupsFor = async (postingId) => {
    const { rows } = await query(
        `SELECT provider, endpoint, result_count, credits_used, cache_hit, error
           FROM contact_lookups WHERE posting_id = $1 ORDER BY created_at`,
        [postingId],
    );
    return rows;
};

const cleanup = async () => {
    if (created.postings.length) {
        await query('DELETE FROM contact_lookups WHERE posting_id = ANY($1::char(36)[])',
            [created.postings]);
        await query('DELETE FROM contact_links WHERE posting_id = ANY($1::char(36)[])',
            [created.postings]);
        await query('DELETE FROM job_postings WHERE id = ANY($1::char(36)[])',
            [created.postings]);
        created.postings = [];
    }
    if (created.orgId) {
        // Every contact this suite could have made carries the fixture company.
        await query(
            `DELETE FROM contacts
              WHERE organization_id = $1 AND company IN ('Testco Payments','Quietco')`,
            [created.orgId],
        );
    }
    if (created.providerRestore) {
        const r = created.providerRestore;
        await query(
            `UPDATE organization_providers op
                SET is_enabled = $2, monthly_budget = $3, rate_limit_ms = $4
               FROM lkp_job_sources s
              WHERE s.id = op.source_id AND s.name = 'APOLLO'
                AND op.organization_id = $1`,
            [created.orgId, r.is_enabled, r.monthly_budget, r.rate_limit_ms],
        );
        created.providerRestore = null;
    }
    globalThis.fetch = realFetch;
};

/* ── the run ──────────────────────────────────────────────────────────── */

const run = async () => {
    /* ── pure: who posted this job ─────────────────────────────────── */

    section('poster extraction — a name where one exists');

    check('LinkedIn-style "Posted by"',
        extractPosterName('Posted by Sarah Chen, Technical Recruiter')?.name, 'Sarah Chen');
    check('an explicit recruiter line',
        extractPosterName('Recruiter: Priya Nair\nApply today')?.name, 'Priya Nair');
    check('a request to make contact',
        extractPosterName('Please contact Mark Reilly at mark@acme.com')?.name, 'Mark Reilly');
    check('a resume destination',
        extractPosterName('Send your resume to Alan Turing today')?.name, 'Alan Turing');
    check('an email sign-off',
        extractPosterName('Thanks,\n\nJohn Smith\nAcme')?.name, 'John Smith');
    check('which pattern fired is recorded',
        typeof extractPosterName('Posted by Sarah Chen')?.matchedBy, 'string');

    section('poster extraction — null for every generic sender');

    for (const generic of [
        'Posted by HR Team',
        'Contact: Talent Acquisition',
        'Contact Person: Careers Team',
        'Recruiter: Recruiting Department',
        'Please contact Human Resources for details',
        'Posted by no-reply Careers',
    ]) {
        check(`"${generic.slice(0, 42)}"`, extractPosterName(generic), null);
    }

    check('a Greenhouse-style advert names nobody',
        extractPosterName('We are hiring a Senior Backend Engineer. '
            + 'Responsibilities include building services. '
            + 'We are an Equal Opportunity Employer.'), null);
    check('an empty description', extractPosterName(''), null);
    check('a missing description', extractPosterName(null), null);
    check('a company is not a person', looksLikePersonName('Acme Solutions Inc'), false);
    check('a shouted heading is not a person', looksLikePersonName('SKILLS REQUIRED'), false);
    check('one word is not a person', looksLikePersonName('Sarah'), false);
    check('two capitalised words are', looksLikePersonName('Sarah Chen'), true);

    /* ── pure: the connector's parsing ─────────────────────────────── */

    section("Apollo's shape, mapped to ours");

    const parsed = normalisePerson(apolloPerson());
    check('the full name', parsed.fullName, 'Sarah Chen');
    check('the title', parsed.title, 'Technical Recruiter');
    check('the company', parsed.company, 'Testco Payments');
    check('the domain', parsed.companyDomain, 'testco.example');
    check('the location, joined', parsed.location, 'Dallas, TX, USA');
    check('the email', parsed.email, 'sarah.chen@testco.example');
    check('how much to trust it', parsed.emailStatus, 'verified');
    check('the phone, from the array shape', parsed.phone, '+15550100');

    check('a person with no name at all is not a person',
        normalisePerson({ title: 'Recruiter' }), null);
    check('a name assembled from the parts',
        normalisePerson({ first_name: 'Ada', last_name: 'Lovelace' }).fullName, 'Ada Lovelace');
    check('a missing organisation costs the company, not the contact',
        normalisePerson({ name: 'Ada Lovelace' }).company, null);
    check('rubbish in is null out', normalisePerson(null), null);

    section('masked and unusable addresses');

    check("Apollo's locked placeholder is not an email",
        __test.isUsableEmail('email_not_unlocked@domain.com'), false);
    check('a real address is', __test.isUsableEmail('sarah@testco.example'), true);
    check('an empty one is not', __test.isUsableEmail(''), false);
    check('a no-reply address is not', __test.isUsableEmail('no-reply@testco.example'), false);
    check('seniority orders the fallback',
        __test.seniorityRank('director') < __test.seniorityRank('entry'), true);
    check('an unknown seniority sorts last',
        __test.seniorityRank('wizard') > __test.seniorityRank('intern'), true);

    /* ── the phone seam ────────────────────────────────────────────── */

    section('the phone provider seam');

    check('the default implementation is the null one',
        NullPhoneProvider.providerName, 'NONE');
    const noPhone = await lookupPhone({ name: 'Sarah Chen', company: 'Testco' });
    check('it answers rather than failing', noPhone.ok, true);
    check('with no number', noPhone.phone, null);
    check('and charges nothing', noPhone.credits, 0);

    /* ── a missing key degrades, never throws ──────────────────────── */

    section('no API key');

    const savedKey = process.env.APOLLO_API_KEY;
    delete process.env.APOLLO_API_KEY;
    check('the connector reports itself unconfigured', isConfigured(), false);
    const noKey = await matchPerson({ name: 'Sarah Chen', company: 'Testco Payments' });
    check('a call without a key returns a failure', noKey.ok, false);
    check('and does not ask for a retry', noKey.retryable, false);
    check('and says why in plain words', /APOLLO_API_KEY/.test(noKey.error), true);
    process.env.APOLLO_API_KEY = savedKey;

    /* ── everything below needs the database ───────────────────────── */

    const { rows: orgs } = await query(
        'SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1',
    );
    if (orgs.length === 0) {
        console.log('\n  No active organisation — run the seeds first.');
        await pool.end();
        process.exit(1);
    }
    const orgId = orgs[0].id;
    created.orgId = orgId;

    // Remember this org's real Apollo settings before overwriting them, and put
    // them back in cleanup. A test that leaves a paid provider switched ON is a
    // test that eventually costs somebody money.
    const { rows: providerRows } = await query(
        `SELECT op.is_enabled, op.monthly_budget, op.rate_limit_ms
           FROM organization_providers op
           JOIN lkp_job_sources s ON s.id = op.source_id
          WHERE op.organization_id = $1 AND s.name = 'APOLLO'`,
        [orgId],
    );
    if (providerRows.length === 0) {
        console.log('\n  No APOLLO provider row — run migration 041.');
        await pool.end();
        process.exit(1);
    }
    created.providerRestore = providerRows[0];

    const setProvider = async ({ enabled = true, budget = 500 }) => query(
        `UPDATE organization_providers op
            SET is_enabled = $2, monthly_budget = $3, rate_limit_ms = 0
           FROM lkp_job_sources s
          WHERE s.id = op.source_id AND s.name = 'APOLLO'
            AND op.organization_id = $1`,
        [orgId, enabled, budget],
    );

    await setProvider({ enabled: true, budget: 500 });
    await sweepStale(orgId);
    stubFetch();

    /* ── the named-poster path ─────────────────────────────────────── */

    section('the waterfall — the posting names a recruiter');

    const namedPosting = await makePosting(orgId, {
        description: 'Great role. Posted by Sarah Chen, Technical Recruiter. '
            + 'We are an Equal Opportunity Employer.',
    });

    responses = [{ status: 200, body: { person: apolloPerson() } }];
    const named = await discoverContacts({ orgId, postingId: namedPosting });

    check('it succeeds', named.ok, true);
    check('by matching the named person', named.step, 'matchPerson');
    check('one contact comes back', named.contacts.length, 1);
    check('the right one', named.contacts[0]?.full_name, 'Sarah Chen');
    check('with the address', named.contacts[0]?.email, 'sarah.chen@testco.example');
    check('it was not free', named.credits, 1);
    check('and it was not from the store', named.cacheHit, false);
    check('exactly one Apollo call was made', calls.length, 1);
    check('to the match endpoint', /people\/match$/.test(calls[0].url), true);
    check('the key travelled in a header, never the URL',
        calls[0].url.includes('test-key-not-real'), false);

    const namedLinks = await linksFor(namedPosting);
    check('the contact is linked to the job', namedLinks.length, 1);
    check('as the poster', namedLinks[0]?.link_reason, 'POSTER');
    check("the phone came through Apollo's own field", namedLinks[0]?.phone, '+15550100');

    const namedLookups = await lookupsFor(namedPosting);
    check('one ledger row', namedLookups.length, 1);
    check('naming the provider', namedLookups[0].provider, 'APOLLO');
    check('with the credit recorded', namedLookups[0].credits_used, 1);
    check('and not marked a cache hit', namedLookups[0].cache_hit, false);

    /* ── the store, which is the entire point ──────────────────────── */

    section('the waterfall — the same company, a second time');

    const secondPosting = await makePosting(orgId, {
        description: 'Another role. Posted by Sarah Chen, Technical Recruiter.',
    });

    responses = [];   // any Apollo call now throws, which is the assertion
    calls = [];
    const reused = await discoverContacts({ orgId, postingId: secondPosting });

    check('it succeeds', reused.ok, true);
    check('from the store', reused.step, 'store');
    check('ZERO Apollo calls', calls.length, 0);
    check('and so it cost nothing', reused.credits, 0);
    check('the same person is attached', reused.contacts[0]?.full_name, 'Sarah Chen');
    check('marked as a cache hit', reused.cacheHit, true);

    const reusedLookups = await lookupsFor(secondPosting);
    check('the free hit is written down too', reusedLookups.length, 1);
    check('as the store answering', reusedLookups[0].provider, 'STORE');
    check('with no credit spent', reusedLookups[0].credits_used, 0);
    check('and flagged so the hit rate is countable', reusedLookups[0].cache_hit, true);

    const { rows: dupe } = await query(
        `SELECT COUNT(*)::int AS n FROM contacts
          WHERE organization_id = $1 AND lower(full_name) = 'sarah chen'`,
        [orgId],
    );
    check('one person is still one row', dupe[0].n, 1);

    /* ── the company fallback ──────────────────────────────────────── */

    section('the waterfall — the posting names nobody');

    const anonPosting = await makePosting(orgId, {
        company: 'Quietco',
        description: 'We are hiring a Senior Backend Engineer. '
            + 'Apply through our careers page. Equal Opportunity Employer.',
    });

    responses = [
        {
            status: 200,
            body: {
                people: [
                    apolloPerson({
                        name: 'Dana Ellis', first_name: 'Dana', last_name: 'Ellis',
                        seniority: 'director', title: 'Head of Talent',
                        organization: { name: 'Quietco', primary_domain: 'quietco.example' },
                        email: 'email_not_unlocked@domain.com',
                        phone_numbers: [],
                    }),
                    apolloPerson({
                        name: 'Ravi Kumar', first_name: 'Ravi', last_name: 'Kumar',
                        seniority: 'entry', title: 'Technical Recruiter',
                        organization: { name: 'Quietco', primary_domain: 'quietco.example' },
                        email: 'email_not_unlocked@domain.com',
                        phone_numbers: [],
                    }),
                ],
            },
        },
        // Each masked address costs a second, billed call to unlock.
        { status: 200, body: { person: apolloPerson({
            name: 'Dana Ellis', first_name: 'Dana', last_name: 'Ellis',
            seniority: 'director', title: 'Head of Talent',
            organization: { name: 'Quietco', primary_domain: 'quietco.example' },
            email: 'dana.ellis@quietco.example',
        }) } },
        { status: 200, body: { person: apolloPerson({
            name: 'Ravi Kumar', first_name: 'Ravi', last_name: 'Kumar',
            seniority: 'entry', title: 'Technical Recruiter',
            organization: { name: 'Quietco', primary_domain: 'quietco.example' },
            email: 'ravi.kumar@quietco.example',
        }) } },
    ];
    calls = [];
    const fallback = await discoverContacts({ orgId, postingId: anonPosting });

    check('it succeeds', fallback.ok, true);
    check('through the company search', fallback.step, 'searchPeople');
    check('two contacts, the limit', fallback.contacts.length, 2);
    check('the search, then one unlock each', calls.length, 3);

    const anonLinks = await linksFor(anonPosting);
    check('both are linked', anonLinks.length, 2);
    check('the most senior first', anonLinks[0]?.full_name, 'Dana Ellis');
    check('then the other', anonLinks[1]?.full_name, 'Ravi Kumar');
    check('ranked, not tied', [anonLinks[0]?.rank, anonLinks[1]?.rank], [1, 2]);
    check('as a company fallback, not as the poster',
        anonLinks[0]?.link_reason, 'COMPANY_FALLBACK');
    check('the masked address was replaced by the real one',
        anonLinks[0]?.email, 'dana.ellis@quietco.example');

    /* ── do not contact ────────────────────────────────────────────── */

    section('do not contact outranks everything');

    await query(
        `UPDATE contacts SET do_not_contact = TRUE, dnc_at = now(),
                             dnc_reason = 'Asked us to stop.'
          WHERE organization_id = $1 AND full_name = 'Sarah Chen'`,
        [orgId],
    );

    const dncPosting = await makePosting(orgId, {
        description: 'Third role. Posted by Sarah Chen, Technical Recruiter.',
    });
    // Apollo answers "nobody", so the only way a contact could appear on this
    // job is the store handing back the person who asked us to stop.
    responses = [
        { status: 200, body: { person: null } },
        { status: 200, body: { people: [] } },
    ];
    calls = [];
    const blocked = await discoverContacts({ orgId, postingId: dncPosting });

    check('the store will not serve them', blocked.step === 'store', false);
    check('so it had to go and ask the provider instead', calls.length > 0, true);
    check('nothing is attached', (await linksFor(dncPosting)).length, 0);

    // And the provider path must refuse them too, not just the store.
    const dncPosting2 = await makePosting(orgId, {
        description: 'Fourth role. Posted by Sarah Chen, Technical Recruiter.',
    });
    responses = [
        { status: 200, body: { person: apolloPerson() } },
    ];
    calls = [];
    const blockedPaid = await discoverContacts({ orgId, postingId: dncPosting2 });
    check('a fresh lookup finds them but still will not link them',
        blockedPaid.contacts.length, 0);
    check('nothing is attached there either', (await linksFor(dncPosting2)).length, 0);
    check('and the refusal is explained', /asked not to be contacted/i.test(blockedPaid.note), true);

    const { rows: stillDnc } = await query(
        `SELECT do_not_contact, dnc_reason FROM contacts
          WHERE organization_id = $1 AND full_name = 'Sarah Chen'`,
        [orgId],
    );
    check('the flag survived the upsert', stillDnc[0]?.do_not_contact, true);
    check('and so did the reason', stillDnc[0]?.dnc_reason, 'Asked us to stop.');

    /* ── the ceiling ───────────────────────────────────────────────── */

    section('the monthly ceiling');

    await setProvider({ enabled: true, budget: 0 });
    const brokePosting = await makePosting(orgId, {
        company: 'Quietco',
        description: 'Posted by Helen Vance, Technical Recruiter.',
    });
    responses = [];
    calls = [];
    const broke = await discoverContacts({ orgId, postingId: brokePosting });

    check('no paid call is made', calls.length, 0);
    check('and it says so rather than pretending to succeed', broke.ok, false);
    check('naming the budget as the reason', broke.step, 'budget');
    check('in words an owner can act on', /budget/i.test(broke.note), true);
    const brokeLookups = await lookupsFor(brokePosting);
    check('the refusal is on the ledger', brokeLookups[0]?.error !== null, true);

    section('the provider switched off');

    await setProvider({ enabled: false, budget: 500 });
    const offPosting = await makePosting(orgId, {
        company: 'Quietco',
        description: 'Posted by Helen Vance, Technical Recruiter.',
    });
    calls = [];
    const off = await discoverContacts({ orgId, postingId: offPosting });
    check('nothing is called', calls.length, 0);
    check('and the reason is the switch', /not enabled/i.test(off.note), true);

    await setProvider({ enabled: true, budget: 500 });
    const state = await providerState(orgId);
    check('spend is readable', typeof state.used, 'number');
    check('the ceiling is readable', state.budget, 500);
    check('and what is left of it', state.remaining, 500 - state.used);

    /* ── the handler ───────────────────────────────────────────────── */

    section('the background job');

    const jobPosting = await makePosting(orgId, {
        company: 'Quietco',
        description: 'Posted by Helen Vance, Technical Recruiter.',
    });
    responses = [{ status: 200, body: { person: apolloPerson({
        name: 'Helen Vance', first_name: 'Helen', last_name: 'Vance',
        organization: { name: 'Quietco', primary_domain: 'quietco.example' },
        email: 'helen.vance@quietco.example',
    }) } }];
    const jobResult = await contactHandler({
        id: randomUUID(),
        organization_id: orgId,
        kind: KIND,
        payload: { postingId: jobPosting },
        attempts: 1,
        max_attempts: 3,
    });
    check('it reports what it did', jobResult.contacts, 1);
    check('and how much it cost', jobResult.credits, 1);

    let threw = null;
    try {
        await contactHandler({
            id: randomUUID(), organization_id: orgId, kind: KIND,
            payload: {}, attempts: 1, max_attempts: 3,
        });
    } catch (err) { threw = err; }
    check('a payload with no posting fails', threw !== null, true);
    check('and is not worth retrying', threw?.retryable, false);

    const goneResult = await contactHandler({
        id: randomUUID(), organization_id: orgId, kind: KIND,
        payload: { postingId: jobPosting, applicationId: randomUUID() },
        attempts: 1, max_attempts: 3,
    });
    check('an application that no longer exists is skipped, not retried',
        goneResult.skipped, true);

    section('a provider outage is retried');

    // A poster this suite has not seen before. Helen Vance is now IN the store
    // from the job above, and a store hit would answer for free — which would
    // make this test pass for the wrong reason and prove nothing about outages.
    const outagePosting = await makePosting(orgId, {
        company: 'Quietco',
        description: 'Posted by Nadia Fox, Technical Recruiter.',
    });
    // Three 500s: the connector retries twice on its own, then gives up.
    responses = [
        { status: 500, body: { error: 'upstream' } },
        { status: 500, body: { error: 'upstream' } },
        { status: 500, body: { error: 'upstream' } },
    ];
    let outageErr = null;
    try {
        await contactHandler({
            id: randomUUID(), organization_id: orgId, kind: KIND,
            payload: { postingId: outagePosting }, attempts: 1, max_attempts: 3,
        });
    } catch (err) { outageErr = err; }
    check('the handler throws so the worker retries', outageErr !== null, true);
    check('and the failure is on the ledger',
        (await lookupsFor(outagePosting)).some((l) => l.error !== null), true);
};

/**
 * Sweep what an earlier ABORTED run left behind, before this one starts.
 *
 * A run killed part-way — Ctrl-C, a crash in the suite itself — never reaches
 * its own cleanup. Without this the next run inherits a contact store that is
 * already populated, and the store-reuse tests then pass by finding rows the
 * previous run created rather than the ones this one is supposed to make. That
 * is the worst kind of green: it appears when the code is broken.
 *
 * Postings are swept by their fixture URL prefix, which nothing else uses.
 */
const sweepStale = async (orgId) => {
    const { rows } = await query(
        `SELECT id FROM job_postings
          WHERE organization_id = $1 AND source_url LIKE 'https://example.invalid/contacts-test/%'`,
        [orgId],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
        await query('DELETE FROM contact_lookups WHERE posting_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM contact_links WHERE posting_id = ANY($1::char(36)[])', [ids]);
        await query('DELETE FROM job_postings WHERE id = ANY($1::char(36)[])', [ids]);
    }
    await query(
        `DELETE FROM contacts
          WHERE organization_id = $1 AND company IN ('Testco Payments','Quietco')`,
        [orgId],
    );
};

try {
    await run();
    await cleanup();

    console.log(`\n${'─'.repeat(52)}`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('─'.repeat(52));
    await pool.end();
    process.exit(fail === 0 ? 0 : 1);
} catch (err) {
    console.error('\n  The suite itself failed:', err);
    await cleanup().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
}
