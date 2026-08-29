import { useCallback, useEffect, useState } from 'react';
import { Search, ChevronDown, ChevronRight, AlertCircle } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import { card, cardPad, badge, sectionTitle, TONE, TONE_ALERT, alertShell, alertShellSm } from '../../design/tokens.js';

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
 * ── WHY THE DROPPED TITLES MATTER MOST ────────────────────────────────
 *
 * Only the top few titles are searched, because each one costs credits. The
 * titles that did not make the cut are the answer to "why is this consultant
 * getting nothing?", and that question is unanswerable from anywhere else in
 * the product.
 */
const SearchPlanPanel = () => {
    const [plan, setPlan] = useState(null);
    const [error, setError] = useState('');
    const [open, setOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get('/management/discovery/preview');
            setPlan(data);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) {
        return (
            <div className={`${cardPad} rounded-xl ${alertShell} ${TONE_ALERT.danger}`}>
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
            </div>
        );
    }
    if (!plan) return null;

    const { parameters: p, queries, droppedTitles } = plan;

    return (
        <div className={`${card} ${cardPad}`}>
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full items-center justify-between text-left"
            >
                <span className={`flex items-center gap-2 ${sectionTitle}`}>
                    <Search className="h-4 w-4 text-slate-400" />
                    What the next run will search for
                </span>
                <span className="flex items-center gap-2">
                    <span className={`${badge} ${TONE.neutral}`}>
                        {queries.length} term{queries.length === 1 ? '' : 's'}
                        {' · '}
                        {plan.estimatedCredits} credits
                    </span>
                    {open
                        ? <ChevronDown className="h-4 w-4 text-slate-400" />
                        : <ChevronRight className="h-4 w-4 text-slate-400" />}
                </span>
            </button>

            {open && (
                <div className="mt-4 space-y-5">
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
            )}
        </div>
    );
};

export default SearchPlanPanel;
