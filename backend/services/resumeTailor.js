/**
 * ── THE TAILORING CALL ────────────────────────────────────────────────
 *
 * One model call: the locked rules, the consultant's structured base resume,
 * and this job's description in, an adapted resume in the same structure out.
 *
 * ── THE ORDER OF THE PROMPT IS LOAD-BEARING ───────────────────────────
 *
 *   system     the locked rules      — identical on every call, ever
 *   cacheable  the base resume       — identical for every job this consultant
 *   input      the job description   — different every time
 *
 * Prompt caching is a PREFIX match on every provider that has it. Put the job
 * description before the base resume and the cache can never hit, because the
 * prefix differs on every call. The pipeline still works perfectly — and costs
 * roughly three times more, silently, with nothing in the output to say so.
 *
 * That is why resume_tailoring_runs records cache_read_tokens per call, and why
 * a run of zeroes on a consultant's second job is a bug rather than a curiosity.
 */
import { callModel } from '../connectors/llm/index.js';
import { validateResume, RESUME_JSON_SCHEMA, compareStructure } from '../config/resumeSchema.js';
import { TAILOR_SYSTEM, tailorInstruction } from '../config/tailoringRules.js';
import { describeTemplate } from '../config/resumeTemplates.js';

/**
 * The base resume as the model should see it.
 *
 * Sent as JSON rather than as the original text because the answer must come
 * back as JSON: showing the model the exact structure it has to return removes
 * a whole class of "close enough" responses that then fail validation.
 */
const baseBlock = (sections) => `BASE RESUME (JSON)
==================
${JSON.stringify(sections, null, 2)}`;

/**
 * Adapt one resume for one job.
 *
 * Never throws.
 *
 * @returns {{ok: true, resume, structural, provider, model, usage, costUsd, durationMs}}
 *        | {{ok: false, error, retryable, provider, model, usage, costUsd}}
 */
export const tailorResume = async ({
    baseSections, posting, template = null, orgId = null,
}) => {
    const res = await callModel({
        orgId,
        stage: 'tailor',
        system: TAILOR_SYSTEM,
        // The template description rides with the base resume in the CACHEABLE
        // block, not with the job. It is identical for every job this agency
        // runs, so putting it here keeps it inside the cached prefix; putting
        // it beside the volatile job description would push it outside and
        // quietly stop the cache from hitting at all.
        cacheable: template
            ? `${describeTemplate(template)}

${baseBlock(baseSections)}`
            : baseBlock(baseSections),
        input: tailorInstruction({
            company: posting.company,
            title: posting.title,
            // A posting with no description still tailors — the title and
            // company alone carry real signal — so this degrades rather than
            // refusing the job.
            description: posting.description || '(No description was provided with this posting.)',
        }),
        schema: RESUME_JSON_SCHEMA,
        maxTokens: 16000,
    });

    if (!res.ok) return res;

    const validated = validateResume(res.json);
    if (!validated.ok) {
        return {
            ok: false,
            provider: res.provider,
            model: res.model,
            usage: res.usage,
            costUsd: res.costUsd,
            durationMs: res.durationMs,
            // Worth one more attempt: this is usually a shape wobble rather
            // than a request the provider will reject identically every time.
            retryable: true,
            error: `The tailored resume did not match the expected shape: ${validated.error}`,
        };
    }

    // The structural comparison runs HERE, before anything is rendered or any
    // second model is asked for an opinion. An invented employer or a promoted
    // job title is a fact that can be established by comparing two lists, and
    // establishing it in code costs nothing and cannot be argued with.
    const structural = compareStructure(baseSections, validated.value);

    return {
        ok: true,
        resume: validated.value,
        structural,
        provider: res.provider,
        model: res.model,
        usage: res.usage,
        costUsd: res.costUsd,
        durationMs: res.durationMs,
    };
};
