import { TONE_ALERT, alertShellSm } from '../../design/tokens.js';

/**
 * ── WHAT A RUN WILL ACTUALLY ASK FOR ──────────────────────────────────
 *
 * Every discovery run spends money, and the cost was already on screen — "up to
 * 12 credits" — without anything saying what those credits would buy. An admin
 * could see the price and not the order.
 *
 * This shows the request itself: the search terms, where they came from, the
 * location, and the filters. It is read from the same functions the run uses,
 * so it cannot describe one thing while the run does another.
 *
 * It is the detail behind the "Search plan" button on the SerpApi tab — the same
 * place JobsPipe puts its Advanced panel — and takes the plan as given so the
 * card it sits in can show the headline terms from the same fetch.
 *
 * ── WHY THE DROPPED TITLES MATTER MOST ────────────────────────────────
 *
 * Only the top few titles are searched, because each one costs credits. The
 * titles that did not make the cut are the answer to "why is this consultant
 * getting nothing?", and that question is unanswerable from anywhere else in
 * the product.
 */
const SearchPlanDetails = ({ plan }) => {
    const { parameters: p, queries, droppedTitles } = plan;

    return (
        <div className="space-y-5">
            {/* ── the terms ─────────────────────────────────── */}
            <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Search terms
                </p>
                {queries.length === 0 ? (
                    <p className="mt-2 text-sm text-slate-500">
                        No consultant has active criteria with a job title, so a run
                        would search for nothing.
                    </p>
                ) : (
                    <div className="mt-2 space-y-1.5">
                        {queries.map((q) => (
                            <div
                                key={q.q}
                                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-soft pb-1.5"
                            >
                                <span className="font-mono text-sm text-slate-800">
                                    {q.q}
                                    {q.location ? ` — ${q.location}` : ''}
                                </span>
                                <span className="text-xs text-slate-500">
                                    wanted by {q.wantedBy.join(', ')}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ── what is sent alongside them ───────────────── */}
            <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Sent with every search
                </p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                    {[
                        ['Engine', p.engine],
                        ['Location', p.location],
                        ['Country (gl)', p.gl],
                        ['Language (hl)', p.hl],
                        ['Job age', p.dateWindow],
                        ['Pages per term', p.pagesPerTerm],
                        ['Term limit', p.maxTerms],
                        ['Call ceiling per run', p.maxCallsPerRun],
                        ['API key', p.apiKey],
                    ].map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3">
                            <dt className="text-slate-500">{k}</dt>
                            <dd className="text-right font-mono text-slate-800">{String(v)}</dd>
                        </div>
                    ))}
                </dl>
                <p className="mt-2 text-xs text-slate-500">
                    Nothing else is sent. Pay, work type, remote and the rest of a
                    consultant&rsquo;s criteria are applied here, to the results — Google
                    Jobs has no parameter for them.
                </p>
            </div>

            {/* ── what was left out ─────────────────────────── */}
            {droppedTitles.length > 0 && (
                <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                        Not searched — over the {p.maxTerms}-term limit
                    </p>
                    <div className="mt-2 space-y-1.5">
                        {droppedTitles.map((t) => (
                            <div
                                key={t.title}
                                className="flex flex-wrap items-baseline justify-between gap-2"
                            >
                                <span className="font-mono text-sm text-slate-600">{t.title}</span>
                                <span className="text-xs text-slate-500">
                                    wanted by {t.wantedBy.join(', ')}
                                </span>
                            </div>
                        ))}
                    </div>
                    <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.warning}`}>
                        These consultants will see fewer jobs than their criteria ask
                        for. Each extra term costs {p.pagesPerTerm} credits per run.
                    </p>
                </div>
            )}

            {/* One location for the whole bench is a real limitation. */}
            {plan.consultants.length > 1 && (
                <p className="text-xs text-slate-500">
                    A run sends one location for the whole organization
                    (<span className="font-mono">{p.location}</span>), taken from the
                    first consultant location found. Consultants elsewhere are matched
                    against results for that location.
                </p>
            )}
        </div>
    );
};

export default SearchPlanDetails;
