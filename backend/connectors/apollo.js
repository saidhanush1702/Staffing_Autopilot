/**
 * ── APOLLO ────────────────────────────────────────────────────────────
 *
 * The only file that asks a paid provider who a hiring contact is.
 *
 * Same contract as connectors/serpapi.js, for the same reasons: configuration
 * read fresh on every call, retries on the failures worth retrying, the key
 * never written anywhere, and IT NEVER THROWS. A provider outage must degrade
 * into "no contact was found for this job", never into an exception that
 * unwinds the submission the lookup was triggered by.
 *
 * ── TWO OPERATIONS, AND WHY THOSE TWO ─────────────────────────────────
 *
 *   matchPerson    we know a name and a company. LinkedIn and Dice postings
 *                  usually name whoever posted them.
 *   searchPeople   we know only the company. Greenhouse and Lever postings
 *                  usually name nobody, so the fallback is to find the people
 *                  who do this company's recruiting.
 *
 * Nothing else is needed, and adding more would be adding surface area to a
 * paid API for no current caller.
 *
 * ── ONE THING TO VERIFY BEFORE THIS IS TRUSTED ────────────────────────
 *
 * The request and response shapes below follow Apollo's documented contract.
 * They have NOT yet been checked against live responses, because no key is in
 * the environment yet. `normalisePerson` is written defensively — every field
 * is optional and every access is guarded — so an unexpected shape yields a
 * thin contact rather than a crash. When APOLLO_API_KEY lands, run one call of
 * each operation and reconcile the parsed result against the raw body. That
 * step is a gate, not a formality: a silently mis-parsed contact is worse than
 * no contact, because somebody will email it.
 */
import { postJson, env, numEnv } from './llm/transport.js';

export const PROVIDER = 'APOLLO';

const baseUrl = () => env('APOLLO_BASE_URL', 'https://api.apollo.io').replace(/\/+$/, '');
const apiKey = () => env('APOLLO_API_KEY');

export const isConfigured = () => apiKey().length > 0;

/**
 * Apollo's person shape → ours.
 *
 * Every field is optional. A provider that renames one field should cost us
 * that field, not the whole contact.
 */
export const normalisePerson = (p) => {
    if (!p || typeof p !== 'object') return null;

    const first = p.first_name ?? null;
    const last = p.last_name ?? null;
    const full = p.name ?? [first, last].filter(Boolean).join(' ').trim();
    if (!full) return null;

    const org = p.organization ?? p.employment_history?.[0] ?? {};

    // Apollo returns several phone shapes depending on the endpoint and the
    // plan. Take the first that is actually present rather than assuming one.
    const phone = p.phone_numbers?.[0]?.sanitized_number
        ?? p.phone_numbers?.[0]?.raw_number
        ?? p.sanitized_phone
        ?? null;

    return {
        fullName: full,
        firstName: first,
        lastName: last,
        title: p.title ?? null,
        seniority: p.seniority ?? null,
        company: org.name ?? p.organization_name ?? null,
        companyDomain: org.primary_domain ?? org.website_url ?? null,
        location: [p.city, p.state, p.country].filter(Boolean).join(', ') || null,
        linkedinUrl: p.linkedin_url ?? null,
        email: p.email ?? null,
        // Apollo says 'verified', 'guessed', 'unavailable' — kept verbatim so a
        // recruiter can see how much to trust an address before using it.
        emailStatus: p.email_status ?? null,
        phone,
        providerPersonId: p.id ?? null,
    };
};

const request = async (path, body) => {
    const key = apiKey();
    if (!key) {
        return {
            ok: false,
            retryable: false,
            error: 'APOLLO_API_KEY is not set, so no contact lookup can be made.',
        };
    }

    return postJson({
        url: `${baseUrl()}${path}`,
        // The key goes in a header. It must never reach the URL, because the URL
        // is what gets written to contact_lookups and shown to operators.
        headers: { 'x-api-key': key, accept: 'application/json' },
        body,
        timeoutMs: numEnv('APOLLO_TIMEOUT_MS', 20_000),
    });
};

/**
 * One named person at one company.
 *
 * @returns {{ok: true, person, raw}} | {{ok: false, error, retryable}}
 *   `person` is null when Apollo answered but knew nobody — a successful call
 *   that found nothing, which is a different thing from a failed call and must
 *   not be retried.
 */
export const matchPerson = async ({ name, company, domain }) => {
    const res = await request('/api/v1/people/match', {
        name,
        organization_name: company,
        domain: domain ?? undefined,
        // Both are billed extra on most plans. They are the entire reason for
        // the lookup, so they are requested explicitly rather than left to a
        // default that may change.
        reveal_personal_emails: true,
        reveal_phone_number: true,
    });
    if (!res.ok) return res;

    return { ok: true, person: normalisePerson(res.body?.person), raw: res.body };
};

/**
 * The people who do a company's recruiting.
 *
 * Used when the posting named nobody. Titles are passed as a filter rather than
 * searched for in prose, so "Talent Acquisition Manager" and "Technical
 * Recruiter" both match without us guessing at the exact wording.
 */
export const TALENT_TITLES = [
    'talent acquisition', 'recruiter', 'technical recruiter',
    'talent partner', 'head of talent', 'recruiting manager',
    'hr manager', 'human resources manager',
];

export const searchPeople = async ({
    company, domain, location, titles = TALENT_TITLES, limit = 2,
}) => {
    const res = await request('/api/v1/mixed_people/search', {
        q_organization_domains: domain ? [domain] : undefined,
        organization_names: domain ? undefined : [company],
        person_titles: titles,
        person_locations: location ? [location] : undefined,
        page: 1,
        per_page: Math.max(1, Math.min(limit, 10)),
    });
    if (!res.ok) return res;

    const people = (res.body?.people ?? [])
        .map(normalisePerson)
        .filter(Boolean)
        .slice(0, limit);

    return { ok: true, people, raw: res.body };
};
