/**
 * Phase 7 — the model layer and the resume schema. Unit suite.
 *
 *   node tests/llm.test.mjs
 *
 * Pure. Nothing here touches the network or the database, and nothing costs a
 * credit. That is possible because the provider layer is split in two: the
 * adapters are the only part shaped like a vendor, and everything tested here
 * sits on our side of that seam.
 *
 * What is deliberately covered:
 *
 *   · JSON recovery from the four shapes providers actually emit
 *   · cost arithmetic, including the case where a price is NOT known
 *   · stage → provider/model resolution from the environment
 *   · the resume schema's gate, and the structural comparison that runs
 *     BEFORE any model is asked whether it fabricated anything
 */
import { extractJson } from '../connectors/llm/transport.js';
import { priceCall, stageConfig, isStageConfigured } from '../config/llmModels.js';
import { adapterFor, knownProviders, unavailableReason } from '../connectors/llm/index.js';
import {
    validateResume, compareStructure, flattenResumeText, RESUME_JSON_SCHEMA,
} from '../config/resumeSchema.js';
import { normaliseText, sniffKind } from '../utils/resumeText.js';

let pass = 0; let fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}`
        + (ok ? '' : `\n          got  ${JSON.stringify(actual)}`
                   + `\n          want ${JSON.stringify(expected)}`));
    ok ? pass += 1 : fail += 1;
};
const section = (t) => console.log(`\n— ${t} —`);

/* ── JSON recovery ────────────────────────────────────────────────────── */

section('extractJson — every shape a provider actually returns');

check('clean JSON', extractJson('{"a":1}'), { a: 1 });
check('fenced with a language tag',
    extractJson('```json\n{"a":1}\n```'), { a: 1 });
check('fenced without a tag',
    extractJson('```\n{"a":2}\n```'), { a: 2 });
check('preamble before the object',
    extractJson('Here is the resume you asked for:\n{"a":3}'), { a: 3 });
check('trailing chatter after the object',
    extractJson('{"a":4}\n\nLet me know if you need changes.'), { a: 4 });
check('a brace inside a string does not end the object early',
    extractJson('{"bullet":"Reduced {latency} by 30%","ok":true}'),
    { bullet: 'Reduced {latency} by 30%', ok: true });
check('an escaped quote inside a string survives',
    extractJson('{"t":"said \\"hello\\" once"}'), { t: 'said "hello" once' });
check('prose with no object at all', extractJson('I cannot help with that.'), null);
check('empty string', extractJson(''), null);
check('truncated object', extractJson('{"a":1,'), null);
// A bare array is not the contract — every stage asks for an object — so this
// returning null is correct rather than a gap.
check('a top-level array is not accepted', extractJson('[1,2,3]'), null);

/* ── cost ─────────────────────────────────────────────────────────────── */

section('priceCall — the ledger arithmetic');

check('a known model prices out',
    priceCall('anthropic', 'claude-sonnet-5',
        { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    2);
check('cached input is billed at the cache rate',
    priceCall('anthropic', 'claude-sonnet-5',
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }),
    0.2);
check('output is billed at the output rate',
    priceCall('anthropic', 'claude-sonnet-5',
        { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    10);
check('a cache write costs 1.25x normal input',
    priceCall('anthropic', 'claude-sonnet-5',
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 }),
    2.5);
// The single most important assertion in this file. An unknown model must NOT
// price as free, or the monthly ceiling silently never fires.
check('an UNKNOWN model prices as null, never as zero',
    priceCall('someprovider', 'some-model-we-never-heard-of',
        { inputTokens: 5_000_000, outputTokens: 5_000_000 }),
    null);
check('a realistic tailoring call lands in cents',
    priceCall('anthropic', 'claude-sonnet-5',
        { inputTokens: 2000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 0 })
        < 0.05,
    true);

/* ── provider resolution ──────────────────────────────────────────────── */

section('stage → provider, from the environment');

delete process.env.LLM_PROVIDER;
delete process.env.LLM_MODEL;
delete process.env.LLM_TAILOR_PROVIDER;
delete process.env.LLM_TAILOR_MODEL;

check('nothing configured is not an error, just unconfigured',
    isStageConfigured('tailor'), false);
check('and it says so in words',
    /No model provider is configured/.test(unavailableReason('tailor')), true);

process.env.LLM_PROVIDER = 'mock';
process.env.LLM_MODEL = 'mock-model';
check('a global provider covers every stage',
    stageConfig('tailor'), { stage: 'tailor', provider: 'mock', model: 'mock-model' });
check('...and the check stage too',
    stageConfig('check').provider, 'mock');

process.env.LLM_TAILOR_PROVIDER = 'anthropic';
process.env.LLM_TAILOR_MODEL = 'claude-sonnet-5';
check('a per-stage override wins for that stage only',
    stageConfig('tailor'), { stage: 'tailor', provider: 'anthropic', model: 'claude-sonnet-5' });
check('and leaves the other stages alone',
    stageConfig('check').provider, 'mock');

delete process.env.LLM_TAILOR_PROVIDER;
delete process.env.LLM_TAILOR_MODEL;

section('adapter registry — no vendor is special');

check('claude is an alias for anthropic',
    adapterFor('claude') === adapterFor('anthropic'), true);
// Several vendors speak OpenAI's dialect. One adapter, distinct names, so the
// ledger records who was actually billed.
check('deepseek reuses the openai dialect',
    adapterFor('deepseek') === adapterFor('openai'), true);
check('qwen reuses the openai dialect',
    adapterFor('qwen') === adapterFor('openai'), true);
check('google is an alias for gemini',
    adapterFor('google') === adapterFor('gemini'), true);
check('an unknown provider resolves to nothing rather than a default',
    adapterFor('not-a-provider'), null);
check('every provider the plan names is registered',
    ['anthropic', 'openai', 'gemini', 'deepseek', 'qwen', 'mock']
        .every((p) => knownProviders().includes(p)),
    true);

process.env.LLM_PROVIDER = 'not-a-provider';
check('an unknown provider is reported by name',
    /Unknown model provider/.test(unavailableReason('tailor')), true);

process.env.LLM_PROVIDER = 'anthropic';
process.env.LLM_MODEL = 'claude-sonnet-5';
const savedKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
check('a configured provider with no key is reported as such',
    /no API key/.test(unavailableReason('tailor')), true);
if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;

/* ── the resume schema ────────────────────────────────────────────────── */

section('resume schema — what comes back from a model');

const minimal = {
    contact: { name: 'Asha Rao' },
    sectionOrder: ['summary', 'experience'],
    experience: [{ company: 'Acme', title: 'Engineer', bullets: ['Built things'] }],
};
const validated = validateResume(minimal);
check('a minimal resume validates', validated.ok, true);
check('and absent arrays are filled in rather than left undefined',
    [validated.value.skills, validated.value.education, validated.value.certifications],
    [[], [], []]);

check('a resume with no name is refused',
    validateResume({ contact: {}, experience: [] }).ok, false);
check('an experience entry with no company is refused',
    validateResume({
        contact: { name: 'X' },
        experience: [{ title: 'Engineer', bullets: [] }],
    }).ok, false);
check('an unexpected field is stripped, not fatal',
    Object.hasOwn(
        validateResume({ ...minimal, madeUpField: 'whatever' }).value,
        'madeUpField',
    ), false);
// Every section must be REQUIRED, and this assertion is the guard on a bug
// that cost a real consultant their whole resume.
//
// A structured-output model treats an optional property as one it may simply
// not emit. With only three fields required, Gemini parsed a real graduate CV
// and returned the contact block, the section order and an empty experience
// array — dropping the education, projects, skills and certifications that
// were plainly in the text. It validated (an absent optional array is legal),
// was cached, and every job tailored from it was built from a summary alone.
//
// An empty array is still a valid answer, so nothing is invented to fill a
// section the consultant does not have.
check('every resume section is required, so a model cannot omit one',
    [...RESUME_JSON_SCHEMA.required].sort(),
    ['additional', 'certifications', 'contact', 'education', 'experience',
        'projects', 'sectionOrder', 'skills', 'summary']);
check('an empty section is still an acceptable answer',
    validateResume({
        ...minimal, education: [], projects: [], certifications: [],
    }).ok, true);

/* ── the structural gate ──────────────────────────────────────────────── */

section('compareStructure — fabrication caught before any model is asked');

const base = {
    contact: { name: 'Asha Rao' },
    experience: [
        { company: 'Acme', title: 'Senior Engineer', bullets: ['Ran the billing service'] },
        { company: 'Globex', title: 'Engineer', bullets: ['Wrote reports'] },
    ],
    education: [{ institution: 'State University', degree: 'BSc' }],
    certifications: [{ name: 'AWS Solutions Architect' }],
};

const honest = {
    contact: { name: 'Asha Rao' },
    experience: [
        // Reordered and reworded — exactly what tailoring is for.
        { company: 'Acme', title: 'Senior Engineer', bullets: ['Owned the billing platform'] },
        { company: 'Globex', title: 'Engineer', bullets: ['Authored reporting'] },
    ],
    education: [{ institution: 'State University', degree: 'BSc' }],
    certifications: [{ name: 'AWS Solutions Architect' }],
};
check('rewording and reordering is clean', compareStructure(base, honest), []);

const invented = {
    ...honest,
    experience: [...honest.experience,
        { company: 'Initech', title: 'Principal Engineer', bullets: ['Led platform'] }],
};
check('an invented employer is caught',
    compareStructure(base, invented).length, 2); // the entry, and the role count

check('a promoted job title is caught',
    compareStructure(base, {
        ...honest,
        experience: [{ company: 'Acme', title: 'Director of Engineering', bullets: [] }],
    }).length, 1);

check('an invented degree is caught',
    compareStructure(base, {
        ...honest,
        education: [{ institution: 'Institute of Technology', degree: 'MSc' }],
    }).length, 1);

check('an invented certification is caught',
    compareStructure(base, {
        ...honest,
        certifications: [{ name: 'Certified Kubernetes Administrator' }],
    }).length, 1);

check('a changed name is caught',
    compareStructure(base, { ...honest, contact: { name: 'Asha R. Rao' } }).length, 1);

check('dropping a role is allowed — that is emphasis, not fabrication',
    compareStructure(base, {
        ...honest,
        experience: [honest.experience[0]],
    }), []);

/* ── flattening ───────────────────────────────────────────────────────── */

section('flattenResumeText — what the checker and the scorer both read');

const flat = flattenResumeText(base);
check('bullets are included', flat.includes('Ran the billing service'), true);
check('companies are included', flat.includes('Globex'), true);
check('certifications are included', flat.includes('AWS Solutions Architect'), true);
check('null input does not throw', flattenResumeText(null), '');

/* ── text extraction helpers ──────────────────────────────────────────── */

section('resume text normalisation');

check('CRLF collapses', normaliseText('a\r\nb'), 'a\nb');
check('runs of blank lines collapse to one', normaliseText('a\n\n\n\n\nb'), 'a\n\nb');
check('the fi ligature is unpacked', normaliseText('ofﬁce'), 'office');
check('non-breaking spaces become ordinary ones',
    normaliseText('a b'), 'a b');
check('leading and trailing whitespace goes', normaliseText('  \n hi \n  '), 'hi');

section('file sniffing — bytes, never the extension');

check('PDF magic', sniffKind(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d])), 'pdf');
check('DOCX is a zip', sniffKind(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'docx');
// Detected precisely so it can be REFUSED with a clear message rather than
// scraped into plausible-looking garbage.
check('legacy .doc is identified so it can be refused',
    sniffKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), 'doc');
check('anything else is nothing', sniffKind(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
check('a truncated buffer does not throw', sniffKind(Buffer.from([0x25])), null);

/* ── result ───────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('─'.repeat(52));
process.exit(fail === 0 ? 0 : 1);
