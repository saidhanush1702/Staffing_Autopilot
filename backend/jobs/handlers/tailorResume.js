/**
 * ── THE PREPARATION PIPELINE ──────────────────────────────────────────
 *
 * One queue item, from QUEUED to either READY or RESUME_REVIEW.
 *
 *    1  load the item, the posting, the agency's resume settings
 *    2  which source does this agency use — BASE_RESUME or PROFILE?
 *    3  BASE_RESUME with no file?  → NOT_TAILORED, READY, stop
 *    4  budget exhausted?          → NOT_TAILORED, READY, stop
 *    5  read the career:
 *         BASE_RESUME → parse the file  (cached per resume, not per job)
 *         PROFILE     → assemble the structured rows  (no model call)
 *    6  nothing to build from?     → NOT_TAILORED, READY, stop
 *    7  ATS score, before
 *    8  tailor          (told which template it is writing for)
 *    9  fabrication check
 *   10  ATS score, after
 *   11  render the PDF  (into the agency's template)
 *   12  write the artifact and the ledger
 *   13  flagged → RESUME_REVIEW ·  clean → READY
 *
 * ── TWO SOURCES, ONE SHAPE ────────────────────────────────────────────
 *
 * Step 5 is the only place the two sources differ. Both hand back
 * `{ sections, rawText }`, so steps 7 to 13 are identical either way — which
 * is why adding PROFILE mode was a branch rather than a second pipeline, and
 * why the fabrication check, the scorer and the review gate needed no changes
 * at all.
 *
 * ── THE RULE THAT SHAPES EVERY FAILURE PATH ───────────────────────────
 *
 * An application never fails to go out because the AI stage had a bad day.
 *
 * Steps 3, 4 and 6 are not errors — they are ordinary outcomes with ordinary
 * causes, and each one ends with the item at READY carrying the consultant's
 * base resume and a marker saying what did not happen. The old behaviour, where
 * a missing resume or an exhausted budget silently held a job forever, is worse
 * for the consultant than an untailored application in every case.
 *
 * The same applies to a provider outage. It is retried while retries remain,
 * and on the last attempt it stops being a failure and becomes a marked,
 * delivered application. That is why this handler reads `job.attempts` — it has
 * to know whether it is allowed to try again, because on the final attempt the
 * right move is to finish rather than to raise.
 */
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../../db.js';
import { checkTransition } from '../../config/queueStates.js';
import { scoreResume, postingText } from '../../config/atsScore.js';
import { flattenResumeText } from '../../config/resumeSchema.js';
import { spendThisPeriod, stageStatus } from '../../connectors/llm/index.js';
import { getBaseDocument, recordRun } from '../../services/resumeParse.js';
import { tailorResume } from '../../services/resumeTailor.js';
import { checkFabrication } from '../../services/fabricationCheck.js';
import { renderResumePdf } from '../../services/resumePdf.js';
import { buildProfileResume } from '../../services/profileResume.js';
import { getTemplate } from '../../config/resumeTemplates.js';

export const KIND = 'tailorResume';

/* ── moving the item ───────────────────────────────────────────────── */

const statusIds = async () => {
    const { rows } = await query('SELECT id, name FROM lkp_queue_statuses');
    return Object.fromEntries(rows.map((r) => [r.name, r.id]));
};

/**
 * Move a queue item, write the transition row, and set the marker.
 *
 * The transition row is not optional bookkeeping. It is the evidence trail
 * behind a real application sent in a real person's name, and a move with no
 * row in it is a gap exactly where somebody later asks "why did this go out
 * like that?".
 */
const moveItem = async ({
    itemId, orgId, from, to, ids, reason, tailoringState, skipReason = null,
    artifactId = undefined,
}) => {
    const verdict = checkTransition(from, to, { reason });
    if (!verdict.ok) {
        // A state machine refusal means the world moved under us — an admin
        // cancelled the item while it was being prepared, most likely. That is
        // not an error worth retrying.
        const err = new Error(`Cannot move this item from ${from} to ${to}: ${verdict.error}`);
        err.retryable = false;
        throw err;
    }

    await withTransaction(async (client) => {
        await client.query(
            `UPDATE queue_items
                SET status_id = $2,
                    tailoring_state = $3,
                    tailoring_skip_reason = $4,
                    tailored_resume_artifact_id =
                        CASE WHEN $6::boolean THEN $5 ELSE tailored_resume_artifact_id END,
                    prepared_at = now(),
                    became_ready_at = CASE WHEN $7 = 'READY' THEN now() ELSE became_ready_at END,
                    preparation_error = $8
              WHERE id = $1`,
            [itemId, ids[to], tailoringState, skipReason,
                artifactId ?? null, artifactId !== undefined, to,
                skipReason ? String(reason).slice(0, 500) : null],
        );

        await client.query(
            `INSERT INTO queue_item_transitions
                (id, organization_id, queue_item_id, from_status_id, to_status_id, reason)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [randomUUID(), orgId, itemId, ids[from], ids[to], String(reason).slice(0, 500)],
        );
    });
};

/* ── the handler ───────────────────────────────────────────────────── */

/**
 * @param job  the background_jobs row; `payload.queueItemId` names the work
 */
export const handle = async (job) => {
    const orgId = job.organization_id;
    const itemId = job.payload?.queueItemId;
    const lastAttempt = job.attempts >= job.max_attempts;

    if (!itemId) {
        const err = new Error('The job payload has no queueItemId.');
        err.retryable = false;
        throw err;
    }

    const ids = await statusIds();

    /* ── 1 · everything this job is about ──────────────────────────── */

    const { rows } = await query(
        `SELECT q.id, q.consultant_id, q.status_id,
                st.name              AS status,
                p.company, p.title, p.description,
                r.id AS artifact_id, r.stored_name, r.sha256, r.original_name,
                -- Where this agency reads a consultant's career from, and
                -- which layout it prints. Both are per organisation.
                o.resume_source, o.resume_template
           FROM queue_items q
           JOIN lkp_queue_statuses st ON st.id = q.status_id
           JOIN job_postings p        ON p.id = q.posting_id
           JOIN organizations o       ON o.id = q.organization_id
      LEFT JOIN consultant_profiles cp ON cp.user_id = q.consultant_id
      LEFT JOIN resume_artifacts r     ON r.id = cp.base_resume_artifact_id
          WHERE q.id = $1 AND q.organization_id = $2`,
        [itemId, orgId],
    );

    const item = rows[0];
    if (!item) {
        // Cancelled and deleted while the job waited. Nothing to do, and
        // nothing wrong.
        return { skipped: 'The queue item no longer exists.' };
    }

    if (item.status !== 'PREPARING') {
        // Somebody moved it — cancelled, skipped, or a second job got here
        // first. Re-preparing would overwrite a decision a person made.
        return { skipped: `The item is ${item.status}, not PREPARING.` };
    }

    const finishUntailored = async (skipReason, reason) => {
        await moveItem({
            itemId,
            orgId,
            from: 'PREPARING',
            to: 'READY',
            ids,
            reason,
            tailoringState: 'NOT_TAILORED',
            skipReason,
        });
        return { tailored: false, skipReason, reason };
    };

    /* ── 2 · which source is this agency using ─────────────────────── */
    //
    // Resolved HERE rather than at the source branch below, because the
    // no-base-resume check immediately after it only makes sense for one of
    // the two sources. Computing it later meant PROFILE-mode consultants —
    // who by design never upload a file — were rejected as NO_BASE_RESUME
    // before the profile was ever looked at.
    const template = getTemplate(item.resume_template);
    const fromProfile = item.resume_source === 'PROFILE';

    /* ── 3 · nothing to tailor from ────────────────────────────────── */

    // Only a concern in BASE_RESUME mode. In PROFILE mode the absence of an
    // uploaded file is normal, and the equivalent check — "is there anything
    // in the profile?" — happens inside buildProfileResume below.
    if (!fromProfile && !item.artifact_id) {
        return finishUntailored('NO_BASE_RESUME',
            'No base resume is on file for this consultant, so there was nothing to tailor. '
            + 'The application can still be made.');
    }

    /* ── 4 · is the feature even switched on, and is there budget ──── */

    const tailorStatus = await stageStatus(orgId, 'tailor');
    if (!tailorStatus.available) {
        return finishUntailored('LLM_NOT_CONFIGURED', tailorStatus.reason);
    }

    const budget = await spendThisPeriod(orgId);
    if (budget.exhausted) {
        return finishUntailored('BUDGET_EXHAUSTED',
            `The monthly AI budget of $${budget.budget.toFixed(2)} is spent `
            + `($${budget.spent.toFixed(2)} used). The base resume was attached instead.`);
    }

    /* ── 5 · where this agency reads the career from ───────────────── */
    //
    // Two sources, one shape. PROFILE assembles structured rows; BASE_RESUME
    // parses the uploaded file and caches it. Both hand back
    // `{ sections, rawText }`, so everything after this point — tailoring, the
    // fabrication check, scoring, rendering, the review gate — is identical
    // either way. That is why this is a branch and not a second pipeline.
    const parsed = fromProfile
        ? await buildProfileResume({
            orgId,
            consultantId: item.consultant_id,
            templateName: item.resume_template,
        })
        : await getBaseDocument({
            orgId,
            consultantId: item.consultant_id,
            artifact: {
                id: item.artifact_id,
                stored_name: item.stored_name,
                sha256: item.sha256,
            },
        });

    /* ── 6 · nothing to build from ─────────────────────────────────── */

    if (!parsed.ok) {
        if (parsed.retryable && !lastAttempt) {
            throw new Error(`Could not read the consultant's career: ${parsed.error}`);
        }
        // PROFILE_INCOMPLETE from the profile builder, UNPARSEABLE_RESUME from
        // the file parser. Both end the same way: the application still goes
        // out, carrying the base resume, marked with the reason.
        return finishUntailored(parsed.reason, parsed.error);
    }

    const baseSections = parsed.document.sections;
    const baseText = parsed.document.rawText;

    /* ── 7 · the score before ──────────────────────────────────────── */

    // The consultant's own search terms are weighted up: a skill the agency
    // already placed this person on matters more than an incidental word.
    const { rows: terms } = await query(
        `SELECT t.value
           FROM search_criteria_terms t
           JOIN search_criteria_versions v ON v.id = t.version_id
           JOIN search_criteria c          ON c.current_version_id = v.id
          WHERE c.consultant_id = $1
            AND t.kind IN ('JOB_TITLE','KEYWORD_INCLUDE')`,
        [item.consultant_id],
    );
    const criteriaTerms = terms.map((t) => t.value);

    const jobText = postingText(item);

    // ── SCORE BOTH SIDES IN THE SAME REPRESENTATION ───────────────────
    //
    // `before` is measured on the FLATTENED base sections, not on the raw PDF
    // text, because `after` is measured on the flattened tailored sections and
    // the delta is only meaningful if the two are comparable.
    //
    // Scoring the raw text here made every job look worse than it was. Raw PDF
    // text carries page furniture, headers and every character the document
    // had; the flattened form is a normalised reconstruction and is always
    // shorter. On a real graduate CV the raw text scored 9 and the flattened
    // base scored 7, so a tailoring that actually cost one point was reported
    // as costing three — two of them purely for changing representation. The
    // ATS delta exists to prove the tailoring did something (D12); measured
    // that way it was proving the parser reformats.
    //
    // NOTE the deliberate asymmetry: `baseText` stays RAW everywhere else, and
    // in particular it is what the fabrication checker compares against. That
    // is correct and must not be "tidied" to match this line — a claim the
    // consultant really wrote is legitimate even when the parser dropped it, so
    // the checker has to see everything the document said, not a reconstruction
    // of it.
    const before = scoreResume(flattenResumeText(baseSections), jobText, criteriaTerms);

    /* ── 8 · tailor ────────────────────────────────────────────────── */

    const tailored = await tailorResume({ baseSections, posting: item, template, orgId });

    await recordRun({
        orgId,
        queueItemId: itemId,
        consultantId: item.consultant_id,
        stage: 'tailor',
        attempt: job.attempts,
        provider: tailored.provider,
        model: tailored.model,
        usage: tailored.usage ?? {},
        costUsd: tailored.costUsd ?? null,
        verdict: tailored.ok ? 'CLEAN' : 'FAILED',
        durationMs: tailored.durationMs,
        error: tailored.ok ? null : tailored.error,
    });

    if (!tailored.ok) {
        if (tailored.retryable && !lastAttempt) {
            throw new Error(`Tailoring failed: ${tailored.error}`);
        }
        return finishUntailored('AI_FAILED',
            `Tailoring did not succeed after ${job.attempts} attempt(s): ${tailored.error}. `
            + 'The base resume was attached instead.');
    }

    /* ── 9 · the independent check ─────────────────────────────────── */

    const check = await checkFabrication({
        orgId,
        baseText,
        tailoredResume: tailored.resume,
        structural: tailored.structural,
    });

    await recordRun({
        orgId,
        queueItemId: itemId,
        consultantId: item.consultant_id,
        stage: 'check',
        attempt: job.attempts,
        provider: check.provider,
        model: check.model,
        usage: check.usage ?? {},
        costUsd: check.costUsd ?? null,
        verdict: check.flags.length > 0 ? 'FLAGGED' : 'CLEAN',
        durationMs: check.durationMs,
        error: check.error,
    });

    /* ── 10 · the score after ───────────────────────────────────────── */

    const after = scoreResume(flattenResumeText(tailored.resume), jobText, criteriaTerms);

    /* ── 11 · render ───────────────────────────────────────────────── */

    const artifactId = randomUUID();
    let file;
    try {
        file = await renderResumePdf({
            orgId,
            resume: tailored.resume,
            company: item.company,
            title: item.title,
            artifactId,
            template,
        });
    } catch (err) {
        if (!lastAttempt) throw new Error(`Could not render the PDF: ${err.message}`);
        return finishUntailored('AI_FAILED',
            `The tailored resume could not be rendered: ${err.message}`);
    }

    /* ── 12 · the artifact, and the flags against it ───────────────── */

    await query(
        `INSERT INTO resume_artifacts
            (id, organization_id, consultant_id, kind, original_name, stored_name,
             mime_type, size_bytes, sha256, source_artifact_id, queue_item_id,
             provider, model, ats_score_before, ats_score_after, sections,
             template, resume_source, generated_at)
         VALUES ($1,$2,$3,'tailored',$4,$5,'application/pdf',$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,now())`,
        [artifactId, orgId, item.consultant_id, file.filename, file.storedName,
            file.sizeBytes, file.sha256,
            // In PROFILE mode there is no source FILE this descends from — the
            // source is the profile itself — so the link is left null rather
            // than pointed at a base resume that had nothing to do with it.
            fromProfile ? null : item.artifact_id,
            itemId,
            tailored.provider, tailored.model, before.score, after.score,
            // Kept so the review screen can show the sentence that was flagged
            // in the document it appears in. See migration 042.
            JSON.stringify(tailored.resume),
            // Which layout and which source produced this file. Both settings
            // will change; a file has to stay accountable to the ones that
            // were in force when it was made.
            template.name, item.resume_source],
    );

    for (const flag of check.flags) {
        await query(
            `INSERT INTO resume_fabrication_flags
                (id, organization_id, queue_item_id, tailored_artifact_id,
                 claim_text, section, severity, detected_by, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [randomUUID(), orgId, itemId, artifactId,
                String(flag.claim).slice(0, 2000), flag.section,
                flag.severity, flag.detectedBy, flag.reason],
        );
    }

    /* ── 13 · where it goes next ───────────────────────────────────── */

    const scoreNote = before.score !== null && after.score !== null
        ? ` ATS keyword coverage ${before.score} → ${after.score}.`
        : '';

    if (check.flags.length > 0) {
        const high = check.flags.filter((f) => f.severity === 'HIGH').length;
        await moveItem({
            itemId,
            orgId,
            from: 'PREPARING',
            to: 'RESUME_REVIEW',
            ids,
            reason: `The fabrication check raised ${check.flags.length} flag(s)`
                + `${high ? `, ${high} of them high severity` : ''}. `
                + 'Waiting for a person to look before this is sent.',
            tailoringState: 'FLAGGED',
            // Deliberately NOT attached to the queue item yet. Until somebody
            // approves it, the desktop app must keep resolving to the base
            // resume — a flagged file that is already attached is a flagged
            // file that can be sent by accident.
        });
        return {
            tailored: true,
            flagged: true,
            flags: check.flags.length,
            artifactId,
            atsBefore: before.score,
            atsAfter: after.score,
            modelChecked: check.modelChecked,
        };
    }

    await moveItem({
        itemId,
        orgId,
        from: 'PREPARING',
        to: 'READY',
        ids,
        reason: `Resume tailored and checked — no unsupported claims.${scoreNote}`,
        tailoringState: 'TAILORED',
        artifactId,
    });

    return {
        tailored: true,
        flagged: false,
        artifactId,
        atsBefore: before.score,
        atsAfter: after.score,
        modelChecked: check.modelChecked,
        cachedParse: parsed.cached,
    };
};
