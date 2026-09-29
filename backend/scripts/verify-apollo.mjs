/**
 * ── DOES THE APOLLO CONNECTOR ACTUALLY WORK AGAINST LIVE APOLLO? ───────
 *
 *   npm run verify:apollo
 *
 * Run this after changing APOLLO_API_KEY, APOLLO_BASE_URL, or anything in
 * connectors/apollo.js — the same role verify-llm.mjs plays for the model
 * providers. It makes exactly two real calls, one per operation the
 * connector has, and prints Apollo's raw response next to what
 * normalisePerson() extracted from it so a field-mapping mistake is visible
 * by eye rather than discovered later as a badly-shaped contact.
 *
 * ── WHY EXACTLY TWO, AND WHY THESE TWO PEOPLE ──────────────────────────
 *
 * Apollo bills per lookup, so this script is deliberately not part of the
 * committed test suite (that runs on no key and no bill, same as the LLM
 * suite). It asks about a real, well-known executive at a real company —
 * someone certain to be in Apollo's index — specifically so the "found"
 * branch of normalisePerson runs at least once. A miss tells you nothing
 * about whether the field mapping is right; a hit does.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────
 *
 * Two calls, matchPerson and searchPeople. Apollo's documented behaviour is
 * that a miss is free and a hit is billed — see the comment in
 * services/contactDiscovery.js — so the worst case is two credits, not more.
 * Nothing here touches the database or any organisation's monthly budget;
 * this talks to the connector directly, not through discoverContacts().
 */
import 'dotenv/config';
import { matchPerson, searchPeople, isConfigured } from '../connectors/apollo.js';

const rule = () => console.log('─'.repeat(72));

if (!isConfigured()) {
    console.error('APOLLO_API_KEY is not set. Nothing to verify.');
    process.exit(1);
}

console.log('CALL 1/2 — matchPerson (the named-poster path)');
rule();
const m = await matchPerson({ name: 'Satya Nadella', company: 'Microsoft', domain: 'microsoft.com' });
console.log('ok:', m.ok, m.ok ? '' : `error: ${m.error} (status ${m.status}, retryable ${m.retryable})`);
if (m.ok) {
    console.log('\nRAW person object from Apollo:');
    console.log(JSON.stringify(m.raw?.person ?? null, null, 2));
    console.log('\nnormalisePerson() output:');
    console.log(JSON.stringify(m.person, null, 2));
}

console.log();
rule();
console.log('\nCALL 2/2 — searchPeople (the company-fallback path)');
rule();
const s = await searchPeople({ company: 'Salesforce', domain: 'salesforce.com', limit: 2 });
console.log('ok:', s.ok, s.ok ? '' : `error: ${s.error} (status ${s.status}, retryable ${s.retryable})`);
if (s.ok) {
    console.log('\nRAW people array from Apollo (first 2):');
    console.log(JSON.stringify((s.raw?.people ?? []).slice(0, 2), null, 2));
    console.log('\nsearchPeople() normalised output:');
    console.log(JSON.stringify(s.people, null, 2));
    console.log('\ntotal_entries Apollo reports for this search:', s.raw?.pagination?.total_entries ?? s.raw?.total_entries);
}
rule();
console.log('DONE — exactly two HTTP requests were made, one per operation.');
