/**
 * ── WHAT THE AI STAGE COST, AND WHETHER IT IS WORKING ─────────────────
 *
 * One endpoint behind one screen, answering the question an owner actually
 * asks at the end of a month: what did this cost, and what did we get.
 *
 * ── THE FOUR NUMBERS, AND WHY EACH ONE IS HERE ────────────────────────
 *
 * **Spend against the ceiling.** There is no daily cap on applications, so
 * spend scales with how well the matcher works. The per-org budget turns that
 * from an unknown into a number somebody chose, and this is where they see how
 * much of it is left.
 *
 * **Cache read tokens.** The tailoring prompt is laid out so the base resume
 * and the locked rules sit in a cached prefix, re-read for every job that
 * consultant is matched to. When that works it takes roughly 90% off the input
 * cost. When something volatile leaks into the prefix — a timestamp, a per-job
 * id — caching silently stops and the bill triples with no other symptom. A
 * cache-read share that falls to zero is that failure, made visible.
 *
 * **Flag rate.** The share of tailored resumes the checker stopped. It is a
 * measure of the PROMPT, not of the reviewers: above roughly 10% the fix is
 * config/tailoringRules.js, not a bigger review queue.
 *
 * **Not-tailored, by reason.** Every skip is an application that went out with
 * the base resume. Four causes, four different actions — top up the budget,
 * chase a re-upload, ask for a PDF instead of a .doc, or look at the logs — and
 * a single "not tailored" total would hide which one is happening.
 *
 * Read-only. Nothing here changes a budget; that is an organisation setting.
 */
import { query } from '../db.js';
import { spendThisPeriod } from '../connectors/llm/index.js';

/**
 * GET /api/management/ai-usage
 *
 * Management only. Organisation-wide by construction — a recruiter seeing the
 * agency's total AI spend is the same kind of fact as seeing its search-provider
 * budget, which they already do.
 */
export const aiUsage = async (req, res, next) => {
    try {
        const orgId = req.user.orgId;

        const [budget, stages, outcomes, states, agentRuns, agentOutcomes, agentHosts, agentStage] = await Promise.all([
            spendThisPeriod(orgId),

            // Per stage, so "what did the checking half cost" is answerable
            // separately from the tailoring half.
            query(
                `SELECT stage,
                        COUNT(*)::int                              AS runs,
                        COALESCE(SUM(cost_usd), 0)::float8         AS cost,
                        COALESCE(SUM(input_tokens), 0)::bigint     AS input_tokens,
                        COALESCE(SUM(output_tokens), 0)::bigint    AS output_tokens,
                        COALESCE(SUM(cache_read_tokens), 0)::bigint  AS cache_read_tokens,
                        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
                        COALESCE(AVG(duration_ms), 0)::int         AS avg_ms
                   FROM resume_tailoring_runs
                  WHERE organization_id = $1
                    AND created_at >= date_trunc('month', now())
               GROUP BY stage
               ORDER BY stage`,
                [orgId],
            ),

            query(
                `SELECT verdict, COUNT(*)::int AS n
                   FROM resume_tailoring_runs
                  WHERE organization_id = $1
                    AND stage = 'tailor'
                    AND created_at >= date_trunc('month', now())
               GROUP BY verdict`,
                [orgId],
            ),

            // The marker, across the whole queue rather than this month — it is
            // a picture of what has been sent, and an application from three
            // weeks ago went out just as untailored as one from this morning.
            query(
                `SELECT tailoring_state, tailoring_skip_reason, COUNT(*)::int AS n
                   FROM queue_items
                  WHERE organization_id = $1
               GROUP BY tailoring_state, tailoring_skip_reason`,
                [orgId],
            ),

            // ── the AI agent ──────────────────────────────────────────
            //
            // What it was asked to do, what it finished, and what it cost per
            // job — the number that says whether it is cheaper than a person.
            query(
                `SELECT COUNT(*)::int                                            AS runs,
                        COUNT(*) FILTER (WHERE outcome = 'READY_TO_SUBMIT')::int AS filled,
                        COUNT(*) FILTER (WHERE shadow)::int                      AS shadow,
                        COALESCE(SUM(cost_usd), 0)::float8                       AS cost,
                        COALESCE(AVG(cost_usd) FILTER (WHERE ended_at IS NOT NULL), 0)::float8 AS avg_cost,
                        COALESCE(SUM(model_calls), 0)::int                       AS model_calls
                   FROM agent_runs
                  WHERE organization_id = $1
                    AND started_at >= date_trunc('month', now())`,
                [orgId],
            ),
            query(
                `SELECT COALESCE(outcome, 'RUNNING') AS outcome, COUNT(*)::int AS n
                   FROM agent_runs
                  WHERE organization_id = $1
                    AND started_at >= date_trunc('month', now())
               GROUP BY 1`,
                [orgId],
            ),
            // The sites the agent works most. The top of this list is the next
            // recipe worth writing: coded, it moves back to free and instant.
            query(
                `SELECT host,
                        COUNT(*)::int                                            AS runs,
                        COUNT(*) FILTER (WHERE outcome = 'READY_TO_SUBMIT')::int AS filled,
                        COALESCE(SUM(cost_usd), 0)::float8                       AS cost
                   FROM agent_runs
                  WHERE organization_id = $1
                    AND host IS NOT NULL
                    AND started_at >= now() - interval '30 days'
               GROUP BY host
               ORDER BY runs DESC
                  LIMIT 10`,
                [orgId],
            ),
            query(
                `SELECT 'agent' AS stage,
                        COUNT(*)::int                                AS runs,
                        COALESCE(SUM(cost_usd), 0)::float8           AS cost,
                        COALESCE(SUM(input_tokens), 0)::bigint       AS input_tokens,
                        COALESCE(SUM(output_tokens), 0)::bigint      AS output_tokens,
                        COALESCE(SUM(cache_read_tokens), 0)::bigint  AS cache_read_tokens,
                        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
                        COALESCE(AVG(duration_ms), 0)::int           AS avg_ms
                   FROM agent_steps
                  WHERE organization_id = $1
                    AND created_at >= date_trunc('month', now())`,
                [orgId],
            ),
        ]);

        // Agent turns sit in the same table as every other stage, so "what did
        // AI cost this month" is one total rather than two screens.
        const byStage = [
            ...stages.rows,
            ...agentStage.rows.filter((r) => r.runs > 0),
        ];
        const totals = byStage.reduce((acc, s) => ({
            cost: acc.cost + Number(s.cost),
            input: acc.input + Number(s.input_tokens),
            cacheRead: acc.cacheRead + Number(s.cache_read_tokens),
        }), { cost: 0, input: 0, cacheRead: 0 });

        const verdicts = Object.fromEntries(outcomes.rows.map((r) => [r.verdict, r.n]));
        const decided = (verdicts.CLEAN ?? 0) + (verdicts.FLAGGED ?? 0);

        const skips = {};
        let tailored = 0;
        let notTailored = 0;
        let pending = 0;
        let flagged = 0;

        for (const row of states.rows) {
            if (row.tailoring_state === 'TAILORED') tailored += row.n;
            if (row.tailoring_state === 'PENDING') pending += row.n;
            if (row.tailoring_state === 'FLAGGED') flagged += row.n;
            if (row.tailoring_state === 'NOT_TAILORED') {
                notTailored += row.n;
                const key = row.tailoring_skip_reason ?? 'UNKNOWN';
                skips[key] = (skips[key] ?? 0) + row.n;
            }
        }

        return res.json({
            budget,
            month: {
                cost: Number(totals.cost.toFixed(4)),
                byStage,
                // The share of input tokens served from cache. `null` rather
                // than 0 when nothing has run — "no data" and "caching is
                // broken" must not look the same on a chart.
                cacheHitRate: totals.input > 0
                    ? Math.round((totals.cacheRead / (totals.input + totals.cacheRead)) * 100)
                    : null,
                flagRate: decided > 0
                    ? Math.round(((verdicts.FLAGGED ?? 0) / decided) * 100)
                    : null,
                verdicts,
            },
            queue: {
                tailored, notTailored, pending, flagged, skips,
            },
            agent: {
                runs: agentRuns.rows[0]?.runs ?? 0,
                filled: agentRuns.rows[0]?.filled ?? 0,
                shadow: agentRuns.rows[0]?.shadow ?? 0,
                cost: Number((agentRuns.rows[0]?.cost ?? 0).toFixed(4)),
                avgCost: Number((agentRuns.rows[0]?.avg_cost ?? 0).toFixed(4)),
                modelCalls: agentRuns.rows[0]?.model_calls ?? 0,
                outcomes: Object.fromEntries(agentOutcomes.rows.map((r) => [r.outcome, r.n])),
                hosts: agentHosts.rows,
            },
        });
    } catch (err) {
        return next(err);
    }
};
