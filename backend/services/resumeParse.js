/**
 * ── TURNING A BASE RESUME INTO STRUCTURE ──────────────────────────────
 *
 * Reads the consultant's uploaded file, extracts its text, and asks a model to
 * split it into the shape config/resumeSchema.js declares — without changing a
 * word of it.
 *
 * ── WHY THE RESULT IS CACHED ON THE FILE'S HASH ───────────────────────
 *
 * This is the only stage whose cost does not have to scale with the number of
 * jobs. A consultant matched to forty postings has one resume, and parsing it
 * forty times would be forty identical model calls against an unchanged
 * document — the single most obviously wasteful thing this pipeline could do.
 *
 * The key is the file's sha256 rather than its artifact id, because the hash is
 * what actually identifies the CONTENT. Re-uploading the same file, or a
 * profile change that mints a new artifact row for identical bytes, both
 * resolve to work already done.
 *
 * ── WHY PARSING IS A MODEL CALL AT ALL ────────────────────────────────
 *
 * Resumes have no schema. Headings are "Work History", "Professional
 * Experience", "Where I've Been"; dates are "2019–present", "Mar '19 - Now",
 * "3/2019"; skills are comma lists, bullet grids or prose. Every regex-based
 * attempt at this handles the resumes it was written against and silently
 * mangles the next one — and a mangled parse is invisible, because what comes
 * out still looks like a resume.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { query } from '../db.js';
import { resolveStoredPath } from '../utils/upload.js';
import { extractResumeText } from '../utils/resumeText.js';
import { callModel } from '../connectors/llm/index.js';
import { validateResume, RESUME_JSON_SCHEMA, SCHEMA_VERSION } from '../config/resumeSchema.js';
import { PARSE_SYSTEM, PROMPT_VERSION } from '../config/tailoringRules.js';

/** Write one row to the cost ledger. Never throws — a ledger failure must not lose the work. */
export const recordRun = async ({
    orgId, queueItemId = null, consultantId = null, stage, attempt = 1,
    provider = null, model = null, usage = {}, costUsd = null,
    verdict, durationMs = null, error = null,
}) => {
    const id = randomUUID();
    try {
        await query(
            `INSERT INTO resume_tailoring_runs
                (id, organization_id, queue_item_id, consultant_id, stage, attempt,
                 provider, model, prompt_version,
                 input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                 cost_usd, verdict, duration_ms, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [id, orgId, queueItemId, consultantId, stage, attempt,
                provider, model, PROMPT_VERSION,
                usage.inputTokens ?? null, usage.outputTokens ?? null,
                usage.cacheReadTokens ?? null, usage.cacheWriteTokens ?? null,
                costUsd, verdict, durationMs, error ? String(error).slice(0, 2000) : null],
        );
    } catch (err) {
        console.error('[resumeParse] could not write the cost ledger:', err.message);
    }
    return id;
};

/**
 * Turn resume TEXT into the structured shape — one model call, validated, and
 * written to the cost ledger. No file, no cache.
 *
 * Split out of getBaseDocument so a caller that only has text (the profile's
 * "Fill with resume", which reads a file and keeps nothing) uses exactly the same
 * prompt, schema, validation and ledger entry as the tailoring path. A second
 * copy of the parse would be a second place for the two to drift apart.
 *
 * Never throws. Failures carry the same `reason` vocabulary as getBaseDocument.
 *
 * @returns {{ok: true, sections, provider, model}} | {{ok: false, reason, error, retryable}}
 */
export const parseResumeText = async ({ orgId, consultantId = null, text }) => {
    const res = await callModel({
        orgId,
        stage: 'parse',
        system: PARSE_SYSTEM,
        input: `RESUME TEXT\n===========\n${text}`,
        schema: RESUME_JSON_SCHEMA,
        maxTokens: 16000,
    });

    await recordRun({
        orgId,
        consultantId,
        stage: 'parse',
        provider: res.provider,
        model: res.model,
        usage: res.usage ?? {},
        costUsd: res.costUsd ?? null,
        verdict: res.ok ? 'CLEAN' : 'FAILED',
        durationMs: res.durationMs,
        error: res.ok ? null : res.error,
    });

    if (!res.ok) {
        return {
            ok: false,
            reason: res.retryable ? 'AI_FAILED' : 'LLM_NOT_CONFIGURED',
            error: res.error,
            retryable: res.retryable,
        };
    }

    const validated = validateResume(res.json);
    if (!validated.ok) {
        return {
            ok: false,
            reason: 'AI_FAILED',
            error: `The parsed resume did not match the expected shape: ${validated.error}`,
            retryable: true,
        };
    }
    return { ok: true, sections: validated.value, provider: res.provider, model: res.model };
};

/**
 * The structured form of a consultant's base resume, parsing it if needed.
 *
 * Never throws. Every failure carries a `reason` that maps directly onto
 * queue_items.tailoring_skip_reason, because every one of them ends the same
 * way: the application still goes out, marked.
 *
 * @returns {{ok: true, document, cached}} | {{ok: false, reason, error}}
 */
export const getBaseDocument = async ({ orgId, artifact, consultantId }) => {
    if (!artifact) {
        return {
            ok: false,
            reason: 'NO_BASE_RESUME',
            error: 'This consultant has no base resume on file.',
        };
    }

    // ── the cache ──
    const { rows: cached } = await query(
        `SELECT id, sections, raw_text
           FROM resume_documents
          WHERE organization_id = $1 AND sha256 = $2 AND parser_version = $3`,
        [orgId, artifact.sha256, SCHEMA_VERSION],
    );
    if (cached.length > 0) {
        return {
            ok: true,
            cached: true,
            document: {
                id: cached[0].id,
                sections: cached[0].sections,
                rawText: cached[0].raw_text,
            },
        };
    }

    // ── the file ──
    let buffer;
    try {
        buffer = fs.readFileSync(resolveStoredPath(orgId, artifact.stored_name));
    } catch (err) {
        return {
            ok: false,
            reason: 'UNPARSEABLE_RESUME',
            error: `The stored resume file could not be read: ${err.message}`,
        };
    }

    const extracted = await extractResumeText(buffer);
    if (!extracted.ok) {
        // UNSUPPORTED_FORMAT, EMPTY_DOCUMENT and EXTRACTION_FAILED all mean the
        // same thing to the queue: there is nothing here a model could work
        // from, and no number of retries will change that.
        return { ok: false, reason: 'UNPARSEABLE_RESUME', error: extracted.error };
    }

    // ── the model ──
    const parsed = await parseResumeText({ orgId, consultantId, text: extracted.text });
    if (!parsed.ok) return parsed;
    const validated = { ok: true, value: parsed.sections };

    // ── store ──
    const id = randomUUID();
    await query(
        `INSERT INTO resume_documents
            (id, organization_id, artifact_id, sha256, sections, raw_text,
             parser_version, provider, model)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
         -- Two jobs for the same consultant can reach this line at the same
         -- moment. Both parses are valid and identical; the loser simply keeps
         -- the winner's row rather than failing a consultant's application over
         -- a race in a cache.
         ON CONFLICT (organization_id, sha256, parser_version) DO NOTHING`,
        [id, orgId, artifact.id, artifact.sha256,
            JSON.stringify(validated.value), extracted.text, SCHEMA_VERSION,
            parsed.provider, parsed.model],
    );

    return {
        ok: true,
        cached: false,
        document: { id, sections: validated.value, rawText: extracted.text },
    };
};
