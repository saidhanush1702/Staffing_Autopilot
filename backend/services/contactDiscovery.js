/**
 * ── THE CONTACT WATERFALL ─────────────────────────────────────────────
 *
 * Given a job, produce the human being worth emailing about it — and spend as
 * little as possible getting there.
 *
 *   1  read the posting for a poster name            free
 *   2  ask the 90-day store                          free
 *   3  a name we do not already have  → matchPerson  one credit
 *   4  no name at all                 → searchPeople one credit, plus enrichment
 *
 * The order is the design. Each step is cheaper than the one below it, and the
 * first step that produces a usable contact ends the run — so the common case,
 * a company this agency has already applied to, costs nothing at all.
 *
 * ── WHY THE STORE IS CHECKED BEFORE THE PROVIDER, ALWAYS ──────────────
 *
 * A bench settles. After a few weeks an agency is applying to the same forty
 * employers over and over, and the recruiter at each one does not change every
 * Tuesday. Looking them up again per application would be paying, repeatedly,
 * for an answer already written down. `CONTACT_REUSE_DAYS` is the judgement of
 * how long that answer stays true — long enough to matter, short enough that a
 * recruiter who has moved on is eventually re-checked.
 *
 * The measure of whether this is working is the ratio of `cache_hit` rows in
 * `contact_lookups`, which is why hits are written down as carefully as misses.
 *
 * ── TWO RULES ENFORCED HERE AND NOWHERE ELSE ──────────────────────────
 *
 * 1. A contact marked `do_not_contact` is never linked to anything, ever, no
 *    matter which step found them. The check sits in the linking function so
 *    that a future fifth step cannot forget it. Somebody asked not to be
 *    contacted; honouring that only along the path they said it on would be
 *    honouring it in name.
 *
 * 2. One person is one row. The unique index does the enforcing, and this file
 *    upserts against it rather than selecting-then-inserting, because the
 *    select-then-insert version has a race in it that produces two half-filled
 *    copies of the same human being.
 *
 * ── THE RULE ABOUT FAILURE ────────────────────────────────────────────
 *
 * Nothing here throws for a provider problem. Contact discovery is a
 * nice-to-have attached to an application that has ALREADY been submitted, and
 * an Apollo outage must degrade to "no contact yet" — never to a failed job
 * that a worker retries three times and dead-letters.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { extractPosterName } from '../config/posterName.js';
import { lookupPhone } from './phoneProvider.js';
import * as apollo from '../connectors/apollo.js';

/** How long a stored contact is trusted before a fresh lookup is allowed. */
const reuseDays = () => {
    const n = Number(process.env.CONTACT_REUSE_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 90;
};

/**
 * Apollo returns a placeholder rather than an address when the plan has not
 * paid to unlock it. Treating that string as an email would put
 * "email_not_unlocked@domain.com" in front of a recruiter as a real contact.
 */
const isUsableEmail = (email) => {
    const value = String(email ?? '').trim().toLowerCase();
    if (value.length === 0 || !value.includes('@')) return false;
    return !value.startsWith('email_not_unlocked')
        && !value.includes('not_unlocked')
        && !value.startsWith('noreply')
        && !value.startsWith('no-reply');
};

/** Most senior first — the order the two fallback contacts are ranked in. */
const SENIORITY_ORDER = [
    'owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director',
    'manager', 'senior', 'entry', 'intern',
];

const seniorityRank = (seniority) => {
    const index = SENIORITY_ORDER.indexOf(String(seniority ?? '').toLowerCase());
    return index === -1 ? SENIORITY_ORDER.length : index;
};

/* ── the ledger ────────────────────────────────────────────────────── */

/**
 * Write down that a lookup happened — including the free ones.
 *
 * Recording cache hits is not bookkeeping for its own sake. The ratio of hits
 * to misses IS the value of the store, and a ledger holding only the paid calls
 * can show cost going up while hiding the saving that came with it.
 */
const recordLookup = async ({
    orgId, postingId, provider, endpoint, queryPayload,
    httpStatus = null, resultCount = 0, creditsUsed = 0,
    cacheHit = false, error = null,
}) => {
    try {
        await query(
            `INSERT INTO contact_lookups
                (id, organization_id, posting_id, provider, endpoint, query,
                 http_status, result_count, credits_used, cache_hit, error)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
            [randomUUID(), orgId, postingId, provider, endpoint,
                JSON.stringify(queryPayload ?? {}), httpStatus, resultCount,
                creditsUsed, cacheHit, error ? String(error).slice(0, 1000) : null],
        );
    } catch (err) {
        // The ledger must never be the reason a contact is lost.
        console.error('Contact lookup ledger write failed:', err.message);
    }
};

/* ── the provider's settings for this agency ───────────────────────── */

/**
 * Apollo's row in `organization_providers`, plus what is left of this month.
 *
 * Budget is counted in credits from `contact_lookups`, not from a separate
 * counter, for the same reason discovery counts from `discovery_runs`: a second
 * tally can only ever drift from the record of what actually happened.
 */
export const providerState = async (orgId) => {
    const { rows } = await query(
        `SELECT op.is_enabled, op.monthly_budget, op.rate_limit_ms, op.credential_env
           FROM organization_providers op
           JOIN lkp_job_sources s ON s.id = op.source_id
          WHERE op.organization_id = $1 AND s.name = 'APOLLO'`,
        [orgId],
    );
    const row = rows[0] ?? null;

    const { rows: spend } = await query(
        `SELECT COALESCE(SUM(credits_used), 0)::int AS used
           FROM contact_lookups
          WHERE organization_id = $1
            AND provider = $2
            AND created_at >= date_trunc('month', now())`,
        [orgId, apollo.PROVIDER],
    );

    const used = spend[0]?.used ?? 0;
    const budget = row?.monthly_budget ?? 0;

    return {
        enabled: Boolean(row?.is_enabled),
        configured: apollo.isConfigured(),
        rateLimitMs: row?.rate_limit_ms ?? 1000,
        budget,
        used,
        remaining: Math.max(budget - used, 0),
    };
};

/** Why no paid call may be made right now, or null when one may. */
const paidBlocker = (state) => {
    if (!state.enabled) return 'Apollo is not enabled for this organisation.';
    if (!state.configured) return 'APOLLO_API_KEY is not set.';
    if (state.remaining <= 0) {
        return `This month's Apollo budget of ${state.budget} credits is used up.`;
    }
    return null;
};

/* ── reading and writing contacts ──────────────────────────────────── */

/**
 * A domain for this company, if any contact already carries one.
 *
 * Apollo matches far more reliably on a domain than on a company name, and
 * company names arrive from job boards in every possible spelling. This costs
 * one indexed read and materially improves the hit rate of the paid call that
 * follows.
 */
const knownDomain = async (orgId, company) => {
    const { rows } = await query(
        `SELECT company_domain
           FROM contacts
          WHERE organization_id = $1
            AND lower(btrim(company)) = lower(btrim($2))
            AND company_domain IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`,
        [orgId, company],
    );
    return rows[0]?.company_domain ?? null;
};

/**
 * Step 2, the free one: has this person, or this company, been looked up
 * recently enough to trust?
 *
 * `pulledAt` is coalesced across email, phone and creation because a contact
 * with a fresh phone and no email is still a fresh contact — it was checked,
 * and the checking is what expires.
 */
const fromStore = async ({ orgId, company, name }) => {
    const days = reuseDays();

    if (name) {
        const { rows } = await query(
            `SELECT * FROM contacts
              WHERE organization_id = $1
                AND lower(btrim(full_name)) = lower(btrim($2))
                AND lower(btrim(company))   = lower(btrim($3))
                AND NOT do_not_contact
                AND COALESCE(email_pulled_at, phone_pulled_at, created_at)
                    > now() - ($4 || ' days')::interval
              LIMIT 1`,
            [orgId, name, company, String(days)],
        );
        return rows;
    }

    // No name in the posting: reuse whoever we already know does this
    // company's recruiting, most senior first.
    const { rows } = await query(
        `SELECT * FROM contacts
          WHERE organization_id = $1
            AND lower(btrim(company)) = lower(btrim($2))
            AND NOT do_not_contact
            AND COALESCE(email_pulled_at, phone_pulled_at, created_at)
                > now() - ($3 || ' days')::interval
          ORDER BY updated_at DESC
          LIMIT 5`,
        [orgId, company, String(days)],
    );

    return rows
        .sort((a, b) => seniorityRank(a.seniority) - seniorityRank(b.seniority))
        .slice(0, 2);
};

/**
 * One person, one row.
 *
 * `COALESCE(EXCLUDED.x, contacts.x)` on every updatable column, so a second
 * provider answer that knows less than the first cannot erase what we had. The
 * `WHERE NOT contacts.do_not_contact` guard means a person who asked not to be
 * contacted is not quietly refreshed and re-surfaced by the next lookup.
 */
const upsertContact = async ({ orgId, person, provider }) => {
    const now = new Date();
    const hasEmail = isUsableEmail(person.email);

    const { rows } = await query(
        `INSERT INTO contacts
            (id, organization_id, full_name, first_name, last_name, title,
             seniority, company, company_domain, location, linkedin_url,
             email, email_status, email_source, email_pulled_at,
             phone, phone_source, phone_pulled_at, provider, provider_person_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (organization_id, lower(btrim(full_name)), lower(btrim(company)))
         DO UPDATE SET
            first_name      = COALESCE(EXCLUDED.first_name,      contacts.first_name),
            last_name       = COALESCE(EXCLUDED.last_name,       contacts.last_name),
            title           = COALESCE(EXCLUDED.title,           contacts.title),
            seniority       = COALESCE(EXCLUDED.seniority,       contacts.seniority),
            company_domain  = COALESCE(EXCLUDED.company_domain,  contacts.company_domain),
            location        = COALESCE(EXCLUDED.location,        contacts.location),
            linkedin_url    = COALESCE(EXCLUDED.linkedin_url,    contacts.linkedin_url),
            email           = COALESCE(EXCLUDED.email,           contacts.email),
            email_status    = COALESCE(EXCLUDED.email_status,    contacts.email_status),
            email_source    = COALESCE(EXCLUDED.email_source,    contacts.email_source),
            email_pulled_at = COALESCE(EXCLUDED.email_pulled_at, contacts.email_pulled_at),
            phone           = COALESCE(EXCLUDED.phone,           contacts.phone),
            phone_source    = COALESCE(EXCLUDED.phone_source,    contacts.phone_source),
            phone_pulled_at = COALESCE(EXCLUDED.phone_pulled_at, contacts.phone_pulled_at),
            provider           = COALESCE(EXCLUDED.provider,           contacts.provider),
            provider_person_id = COALESCE(EXCLUDED.provider_person_id, contacts.provider_person_id)
         WHERE NOT contacts.do_not_contact
         RETURNING *`,
        [
            randomUUID(), orgId, person.fullName, person.firstName, person.lastName,
            person.title, person.seniority, person.company, person.companyDomain,
            person.location, person.linkedinUrl,
            hasEmail ? person.email : null,
            hasEmail ? person.emailStatus : null,
            hasEmail ? provider : null,
            hasEmail ? now : null,
            person.phone ?? null,
            person.phone ? (person.phoneSource ?? provider) : null,
            person.phone ? now : null,
            provider, person.providerPersonId,
        ],
    );

    // No row back means the conflicting row is marked do_not_contact and the
    // DO UPDATE's WHERE declined it. That is the rule working, not an error.
    return rows[0] ?? null;
};

/**
 * Attach a contact to a job.
 *
 * The `do_not_contact` re-check is not redundant with `upsertContact`'s: a
 * contact coming from the store took a different path here and was never
 * upserted at all.
 */
const linkContact = async ({
    orgId, contact, postingId, applicationId, queueItemId, linkReason, rank,
}) => {
    if (!contact || contact.do_not_contact) return false;

    await query(
        `INSERT INTO contact_links
            (id, organization_id, contact_id, posting_id, application_id,
             queue_item_id, link_reason, rank)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (contact_id, posting_id) DO UPDATE SET
            application_id = COALESCE(contact_links.application_id, EXCLUDED.application_id),
            queue_item_id  = COALESCE(contact_links.queue_item_id,  EXCLUDED.queue_item_id)`,
        [randomUUID(), orgId, contact.id, postingId, applicationId,
            queueItemId, linkReason, rank],
    );
    return true;
};

/** Ask the phone provider, and fold the answer into the person. */
const withPhone = async (person) => {
    if (person.phone) return person;

    const result = await lookupPhone({
        name: person.fullName,
        company: person.company,
        linkedinUrl: person.linkedinUrl,
        email: person.email,
    });

    return result.phone
        ? { ...person, phone: result.phone, phoneSource: result.source }
        : person;
};

/* ── the waterfall ─────────────────────────────────────────────────── */

/**
 * Find and attach the hiring contact for one job.
 *
 * @param   orgId          the tenant
 * @param   postingId      the job
 * @param   applicationId  the submission this was triggered by, when there is one
 * @param   queueItemId    the queue item, for the manual pre-apply lookup
 * @param   manual         true for the on-demand endpoint — recorded on the link
 *                         so a recruiter can tell a contact somebody asked for
 *                         from one the pipeline found on its own
 *
 * @returns {{ok, contacts, cacheHit, credits, step, note}}
 *   `ok: false` is a provider or configuration problem. An empty `contacts`
 *   with `ok: true` is the ordinary "nobody was found", which is not an error
 *   and must not be retried.
 */
export const discoverContacts = async ({
    orgId, postingId, applicationId = null, queueItemId = null, manual = false,
}) => {
    const { rows: postings } = await query(
        `SELECT id, company, title, description, location_text
           FROM job_postings
          WHERE id = $1 AND organization_id = $2`,
        [postingId, orgId],
    );
    const posting = postings[0];
    if (!posting) {
        return {
            ok: false, contacts: [], cacheHit: false, credits: 0,
            step: 'posting', note: 'That job posting does not exist.',
        };
    }

    /* ── 1 · the posting itself, free ──────────────────────────────── */
    const poster = extractPosterName(posting.description);
    const name = poster?.name ?? null;

    /* ── 2 · the store, free ───────────────────────────────────────── */
    const stored = await fromStore({ orgId, company: posting.company, name });

    if (stored.length > 0) {
        const linkReason = manual ? 'MANUAL' : (name ? 'POSTER' : 'COMPANY_FALLBACK');
        let rank = 1;
        const linked = [];
        for (const contact of stored) {
            // eslint-disable-next-line no-await-in-loop
            if (await linkContact({
                orgId, contact, postingId, applicationId, queueItemId, linkReason, rank,
            })) {
                linked.push(contact);
                rank += 1;
            }
        }

        await recordLookup({
            orgId,
            postingId,
            provider: 'STORE',
            endpoint: name ? 'store/person' : 'store/company',
            queryPayload: { name, company: posting.company, reuseDays: reuseDays() },
            resultCount: linked.length,
            creditsUsed: 0,
            cacheHit: true,
        });

        return {
            ok: true, contacts: linked, cacheHit: true, credits: 0,
            step: 'store',
            note: `Reused ${linked.length} contact(s) already on file for ${posting.company}.`,
        };
    }

    /* ── may we spend? ─────────────────────────────────────────────── */
    const state = await providerState(orgId);
    const blocker = paidBlocker(state);
    if (blocker) {
        await recordLookup({
            orgId,
            postingId,
            provider: apollo.PROVIDER,
            endpoint: 'skipped',
            queryPayload: { name, company: posting.company },
            resultCount: 0,
            creditsUsed: 0,
            error: blocker,
        });
        return {
            ok: false, contacts: [], cacheHit: false, credits: 0,
            step: 'budget', note: blocker,
        };
    }

    const domain = await knownDomain(orgId, posting.company);
    let credits = 0;

    /* ── 3 · a named poster we do not already have ─────────────────── */
    if (name) {
        const res = await apollo.matchPerson({ name, company: posting.company, domain });

        // Apollo bills a match that found somebody. A miss is answered for free
        // on every plan this is written against — and if that ever changes, the
        // number here is the one line to correct.
        const found = res.ok && res.person ? 1 : 0;
        credits += found;

        await recordLookup({
            orgId,
            postingId,
            provider: apollo.PROVIDER,
            endpoint: '/api/v1/people/match',
            queryPayload: { name, company: posting.company, domain, matchedBy: poster.matchedBy },
            httpStatus: res.status ?? (res.ok ? 200 : null),
            resultCount: found,
            creditsUsed: found,
            error: res.ok ? null : res.error,
        });

        if (!res.ok) {
            return {
                ok: false, contacts: [], cacheHit: false, credits,
                step: 'matchPerson', note: res.error,
            };
        }

        if (res.person) {
            const person = await withPhone({ ...res.person, company: res.person.company ?? posting.company });
            const contact = await upsertContact({ orgId, person, provider: apollo.PROVIDER });
            const ok = await linkContact({
                orgId,
                contact,
                postingId,
                applicationId,
                queueItemId,
                linkReason: manual ? 'MANUAL' : 'POSTER',
                rank: 1,
            });
            return {
                ok: true, contacts: ok ? [contact] : [], cacheHit: false, credits,
                step: 'matchPerson',
                note: ok ? `Found ${contact.full_name}.` : 'That person has asked not to be contacted.',
            };
        }
        // Named, but Apollo does not know them. Fall through to the company
        // search rather than giving up — the name was a hint, not a requirement.
    }

    /* ── 4 · nobody named, so find who recruits for this company ────── */
    if (state.rateLimitMs > 0 && name) {
        await new Promise((resolve) => { setTimeout(resolve, state.rateLimitMs); });
    }

    const search = await apollo.searchPeople({
        company: posting.company,
        domain,
        location: posting.location_text,
        limit: 2,
    });

    await recordLookup({
        orgId,
        postingId,
        provider: apollo.PROVIDER,
        endpoint: '/api/v1/mixed_people/api_search',
        queryPayload: { company: posting.company, domain, location: posting.location_text },
        httpStatus: search.status ?? (search.ok ? 200 : null),
        resultCount: search.ok ? search.people.length : 0,
        creditsUsed: search.ok && search.people.length > 0 ? 1 : 0,
        cacheHit: false,
        error: search.ok ? null : search.error,
    });

    if (!search.ok) {
        return {
            ok: false, contacts: [], cacheHit: false, credits,
            step: 'searchPeople', note: search.error,
        };
    }
    credits += search.people.length > 0 ? 1 : 0;

    const ranked = [...search.people]
        .sort((a, b) => seniorityRank(a.seniority) - seniorityRank(b.seniority));

    const contacts = [];
    let rank = 1;

    for (const found of ranked) {
        let person = found;

        // A search result usually arrives with the email masked. Unmasking it is
        // a second, billed call — worth making, because a contact without an
        // address is a contact nobody can use.
        if (!isUsableEmail(person.email)) {
            const remaining = state.remaining - credits;
            if (remaining > 0) {
                // eslint-disable-next-line no-await-in-loop
                const enriched = await apollo.matchPerson({
                    name: person.fullName,
                    company: person.company ?? posting.company,
                    domain: person.companyDomain ?? domain,
                });
                const billed = enriched.ok && enriched.person ? 1 : 0;
                credits += billed;

                // eslint-disable-next-line no-await-in-loop
                await recordLookup({
                    orgId,
                    postingId,
                    provider: apollo.PROVIDER,
                    endpoint: '/api/v1/people/match',
                    queryPayload: { name: person.fullName, company: person.company, enrich: true },
                    httpStatus: enriched.status ?? (enriched.ok ? 200 : null),
                    resultCount: billed,
                    creditsUsed: billed,
                    error: enriched.ok ? null : enriched.error,
                });

                if (enriched.ok && enriched.person) person = { ...person, ...enriched.person };
            }
        }

        // eslint-disable-next-line no-await-in-loop
        person = await withPhone({ ...person, company: person.company ?? posting.company });
        // eslint-disable-next-line no-await-in-loop
        const contact = await upsertContact({ orgId, person, provider: apollo.PROVIDER });
        // eslint-disable-next-line no-await-in-loop
        const linked = await linkContact({
            orgId,
            contact,
            postingId,
            applicationId,
            queueItemId,
            linkReason: manual ? 'MANUAL' : 'COMPANY_FALLBACK',
            rank,
        });
        if (linked) {
            contacts.push(contact);
            rank += 1;
        }
    }

    return {
        ok: true,
        contacts,
        cacheHit: false,
        credits,
        step: 'searchPeople',
        note: contacts.length === 0
            ? `Apollo knows nobody recruiting for ${posting.company}.`
            : `Found ${contacts.length} contact(s) at ${posting.company}.`,
    };
};

export const __test = { isUsableEmail, seniorityRank, reuseDays };
