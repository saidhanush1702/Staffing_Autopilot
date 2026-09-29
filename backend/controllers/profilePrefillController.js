/**
 * ── "FILL WITH RESUME" ────────────────────────────────────────────────
 *
 *   POST /api/portal/profile/prefill-from-resume     multipart, field "resume"
 *
 * A consultant setting up their profile can pick a resume from their own
 * computer and have the form filled in for them. This reads the file, asks the
 * parse model to structure it, and returns VALUES. It saves nothing:
 *
 *   - the file is held in memory, read, and dropped — it is not stored, and it
 *     does NOT become the base resume (that is a separate, deliberate upload);
 *   - the profile is not touched — the values go back to the browser, which puts
 *     them into the form as ordinary editable fields;
 *   - the normal Submit for approval, and the reviewer, still stand between
 *     these values and anything live.
 *
 * ── THE COST, AND WHY IT IS BOUNDED ───────────────────────────────────
 *
 * It is one model call per click, priced like any other parse and written to the
 * same ledger (against the consultant, so an admin can see who used it). Because
 * a button that spends money can be pressed repeatedly, it is limited to a few
 * reads per consultant per hour, and it honours the organisation's monthly
 * budget and its "Resume reading" settings exactly as tailoring does.
 */
import { query } from '../db.js';
import { extractResumeText } from '../utils/resumeText.js';
import { parseResumeText } from '../services/resumeParse.js';
import { mapParsedResume } from '../services/resumePrefill.js';
import { stageStatus, spendThisPeriod } from '../connectors/llm/index.js';

export const PREFILLS_PER_HOUR = 5;

export const prefillFromResume = async (req, res, next) => {
    try {
        const { orgId, id: consultantId } = req.user;

        if (!req.file?.buffer?.length) {
            return res.status(422).json({ error: 'Choose a resume file first (PDF or DOCX).' });
        }

        const status = await stageStatus(orgId, 'parse');
        if (!status.available) {
            return res.status(503).json({
                error: 'Reading resumes is not switched on for your organisation yet. '
                    + 'Please fill the form in by hand, or ask your admin to set it up.',
            });
        }
        if ((await spendThisPeriod(orgId)).exhausted) {
            return res.status(409).json({
                error: 'Your organisation\'s monthly AI budget is used up, so resumes cannot be read '
                    + 'right now. Please fill the form in by hand.',
            });
        }

        const { rows: [recent] } = await query(
            `SELECT count(*)::int AS n FROM resume_tailoring_runs
              WHERE organization_id = $1 AND consultant_id = $2 AND stage = 'parse'
                AND queue_item_id IS NULL AND created_at > now() - interval '1 hour'`,
            [orgId, consultantId],
        );
        if (recent.n >= PREFILLS_PER_HOUR) {
            return res.status(429).json({
                error: `You have read ${PREFILLS_PER_HOUR} resumes in the last hour. `
                    + 'Please wait a little, or fill in the rest by hand.',
            });
        }

        const extracted = await extractResumeText(req.file.buffer);
        if (!extracted.ok) return res.status(422).json({ error: extracted.error });

        const parsed = await parseResumeText({ orgId, consultantId, text: extracted.text });
        if (!parsed.ok) {
            return res.status(parsed.reason === 'LLM_NOT_CONFIGURED' ? 503 : 502).json({
                error: 'We could not read that resume just now. Please try again, or fill the form '
                    + 'in by hand.',
            });
        }

        return res.json({ ok: true, ...mapParsedResume(parsed.sections) });
    } catch (err) {
        return next(err);
    }
};
