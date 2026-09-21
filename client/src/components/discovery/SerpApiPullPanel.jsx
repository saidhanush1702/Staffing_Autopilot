import { Fragment, useCallback, useEffect, useState } from 'react';
import {
    Radar, Play, Loader2, AlertCircle, CheckCircle2, XCircle, Power, Clock, TriangleAlert,
    KeyRound, Coins, Star, Search, ChevronDown, ChevronRight,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import SearchPlanDetails from './SearchPlanPanel.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT, TONE_TEXT, codeChip,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, alertShellSm, alertShell,
} from '../../design/tokens.js';

/**
 * ── THE SERPAPI (GOOGLE JOBS) TAB ─────────────────────────────────────
 *
 * Deliberately the same shape as the JobsPipe tab beside it, because they are the
 * same kind of thing — a door jobs come in through — and two screens for two
 * doors should not make an operator relearn where everything is:
 *
 *   header      the title, with the detail button and the Run button on the right
 *   card        the provider, its health, an on/off switch, the figures that
 *               matter, and what a run will search for
 *   boards      a table of where postings were listed, with the accept switch
 *   history     a table of recent runs, each expandable to its full breakdown
 *
 * It loads its own data, as the JobsPipe panel does, so the page around it only
 * has to choose which one to show. `refreshKey` lets that page reload this one
 * when the scheduled cycle fires while it is open.
 */

/** The stage counters, in pipeline order, so a run reads left to right. */
const STAGES = [
    ['provider_calls', 'Credits spent'],
    ['credits_saved', 'Credits saved'],
    ['raw_items', 'Results'],
    ['filtered_by_portal', 'Board-filtered'],
    ['quarantined', 'Quarantined'],
    ['postings_new', 'New'],
    ['postings_duplicate', 'Repeat'],
    ['prefilter_out', 'Pre-filtered out'],
    ['matches_found', 'Matched'],
    ['queued', 'Queued'],
];

/** Google's own recency vocabulary. Its finest grain is a day, not an hour. */
const RECENCY = {
    day: 'Last 24 hours',
    '3days': 'Last 3 days',
    week: 'Last week',
    month: 'Last month',
};

const outcomeOf = (run) => {
    if (!run.finished_at) return { tone: 'warning', label: 'Running', icon: Loader2, spin: true };
    if (run.error) return { tone: 'danger', label: 'Failed', icon: XCircle };
    if (run.queries_failed > 0) return { tone: 'warning', label: 'Partial', icon: TriangleAlert };
    return { tone: 'success', label: 'Completed', icon: CheckCircle2 };
};

const tookText = (run) => {
    if (!run.finished_at) return '—';
    const s = (new Date(run.finished_at) - new Date(run.started_at)) / 1000;
    return Number.isFinite(s) && s >= 0 ? `${s.toFixed(1)}s` : '—';
};

const SerpApiPullPanel = ({ canEdit, refreshKey = 0 }) => {
    const [sources, setSources] = useState(null);
    const [provider, setProvider] = useState(null);
    const [runs, setRuns] = useState([]);
    const [plan, setPlan] = useState(null);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [confirmRun, setConfirmRun] = useState(false);
    const [banner, setBanner] = useState(null);
    const [showPlan, setShowPlan] = useState(false);
    const [openRun, setOpenRun] = useState(null);

    const load = useCallback(async () => {
        try {
            const [s, r] = await Promise.all([
                api.get('/management/discovery/sources'),
                api.get('/management/discovery/runs'),
            ]);
            setSources(s.data.sources);
            setProvider(s.data.provider);
            setRuns(r.data.runs);
        } catch (err) {
            setError(errorMessage(err));
        }
        // The plan shows what an organisation spends credits on, so it is an
        // ORG_ADMIN view. A failure here must not take the rest of the tab down.
        if (canEdit) {
            try {
                const { data } = await api.get('/management/discovery/preview');
                setPlan(data);
            } catch { setPlan(null); }
        }
    }, [canEdit]);

    useEffect(() => { load(); }, [load, refreshKey]);

    if (error) return <p className="mt-6 text-sm text-danger-700">{error}</p>;
    if (!sources || !provider) return <PageLoader />;

    const providerRow = sources.find((s) => s.fetch_mode === 'PROVIDER');
    const portals = sources.filter((s) => s.fetch_mode === 'PORTAL');
    const acceptedCount = portals.filter((s) => s.is_enabled).length;
    const estimatedCredits = Math.min(provider.maxQueries * provider.maxPages, provider.maxCallsPerRun);
    // The number that actually shows up on an invoice. A per-run figure reads
    // as trivial; the same figure times the cycle is what needs a decision.
    const monthlyCredits = estimatedCredits * provider.runsPerDay * 30;

    const toggle = async (source) => {
        setError('');
        try {
            await api.patch(`/management/discovery/sources/${source.id}`, { isEnabled: !source.is_enabled });
            await load();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err, 'Could not change that setting.') });
        }
    };

    const runNow = async () => {
        setRunning(true);
        setBanner(null);
        try {
            const { data } = await api.post('/management/discovery/run');
            const r = data.run;
            setBanner({
                tone: r.queries_failed > 0 ? 'warning' : 'success',
                text: `Run complete — ${r.provider_calls} API call(s), ${r.postings_new} new `
                    + `postings, ${r.matches_found} matches, ${r.queued} queued`
                    + (r.queries_failed ? `. ${r.queries_failed} search(es) failed.` : '.'),
            });
            setConfirmRun(false);
            await load();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err, 'The run failed.') });
        } finally {
            setRunning(false);
        }
    };

    /** Whether the provider can actually do anything right now. */
    const status = (() => {
        if (!provider.configured) return { tone: 'danger', text: 'No API key', icon: KeyRound };
        if (!provider.enabled) return { tone: 'neutral', text: 'Switched off', icon: Power };
        if (provider.consecutiveFailures >= 3) {
            return { tone: 'danger', text: `Failing (${provider.consecutiveFailures})`, icon: XCircle };
        }
        if (provider.consecutiveFailures > 0) {
            return { tone: 'warning', text: `${provider.consecutiveFailures} recent failure(s)`, icon: TriangleAlert };
        }
        if (provider.lastSuccessAt) return { tone: 'success', text: 'Ready', icon: CheckCircle2 };
        return { tone: 'info', text: 'Not run yet', icon: Clock };
    })();

    const canRun = provider.configured && provider.enabled;
    const terms = plan?.queries ?? [];

    return (
        <>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>SerpApi — Google Jobs</h2>
                {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setShowPlan((v) => !v)}
                            disabled={!plan}
                            className={showPlan ? btnSm.primary : btnSm.secondary}
                        >
                            <Search className="h-3.5 w-3.5" />
                            Search plan
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirmRun(true)}
                            disabled={running || !canRun}
                            className={btn.primary}
                        >
                            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                            Run discovery now
                        </button>
                    </div>
                )}
            </div>

            {banner && (
                <div className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT[banner.tone]}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{banner.text}</span>
                </div>
            )}

            <div className={`mt-3 ${card} ${cardPad}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="flex items-center gap-1.5 font-medium text-slate-900">
                                <Radar className="h-4 w-4 text-brand-500" />
                                {provider.label}
                            </p>
                            <span className={`${badge} ${TONE[status.tone]}`}>
                                <status.icon className="h-3.5 w-3.5" /> {status.text}
                            </span>
                        </div>
                        <p className="mt-1 max-w-xl text-xs text-slate-500">
                            The scheduled door. Searches Google Jobs for what each consultant is
                            looking for, then works out which consultant each posting suits. Every
                            board below is attribution — which site Google says a posting came from.
                        </p>
                    </div>

                    {canEdit && providerRow && (
                        <button
                            type="button"
                            onClick={() => toggle(providerRow)}
                            disabled={!provider.configured && !providerRow.is_enabled}
                            className={providerRow.is_enabled ? btnSm.caution : btnSm.success}
                        >
                            <Power className="h-3.5 w-3.5" />
                            {providerRow.is_enabled ? 'Turn off' : 'Turn on'}
                        </button>
                    )}
                </div>

                {/* ── the figures ───────────────────────────────────── */}
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Cost per run</p>
                        <p className={`flex items-center gap-1 text-sm tabular-nums ${TONE_TEXT.warning}`}>
                            <Coins className="h-3.5 w-3.5" />
                            up to {estimatedCredits} credits
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">If left running</p>
                        <p className="text-sm tabular-nums text-slate-700">
                            ≤{monthlyCredits.toLocaleString()}/month
                            <span className="ml-1 text-xs text-slate-400">({provider.runsPerDay}×/day)</span>
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Job age</p>
                        <p className="text-sm text-slate-700">{RECENCY[provider.datePosted] ?? 'Any age'}</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Search terms</p>
                        <p className="text-sm tabular-nums text-slate-700">{provider.maxQueries} per run</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Pages per term</p>
                        <p className="text-sm tabular-nums text-slate-700">{provider.maxPages}</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Last success</p>
                        <p className="text-sm text-slate-700">
                            {provider.lastSuccessAt ? new Date(provider.lastSuccessAt).toLocaleString() : '—'}
                        </p>
                    </div>
                </div>

                <p className="mt-3 text-xs text-slate-500">
                    A credit buys one <strong>page</strong> of results, not one job — so the ceiling
                    above is what a run costs if every search finds something new. Searches stop
                    paging as soon as a page returns nothing we do not already have.
                </p>

                {/* what a one-click run would search for */}
                {canEdit && plan && (
                    terms.length > 0 ? (
                        <div className="mt-3">
                            <p className="text-xs uppercase tracking-wide text-slate-400">A run will search for</p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {terms.map((q) => (
                                    <span key={q.q} className={codeChip}>
                                        {q.q}
                                        {q.wantedBy.length > 1 && (
                                            <span className="ml-1 text-slate-400">×{q.wantedBy.length}</span>
                                        )}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className={`mt-3 ${alertShell} ${TONE_ALERT.warning}`}>
                            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                                No active consultant has a job title in their criteria, so there is
                                nothing to search for. A run would spend credits to return jobs
                                nobody asked for.
                            </span>
                        </div>
                    )
                )}

                {provider.lastError && (
                    <p className={`mt-3 ${alertShellSm} ${TONE_ALERT.danger}`}>{provider.lastError}</p>
                )}

                {!provider.configured && (
                    <div className={`mt-3 ${alertShell} ${TONE_ALERT.info}`}>
                        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            No API key is set. Add <code className="font-mono text-xs">SERPAPI_KEY</code>
                            {' '}to the server&apos;s <code className="font-mono text-xs">.env</code> and
                            restart it. Runs still work meanwhile — they fetch nothing and match
                            what is already in the pool.
                        </span>
                    </div>
                )}

                {/* ── Search plan ───────────────────────────────────── */}
                {showPlan && canEdit && plan && (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <SearchPlanDetails plan={plan} />
                    </div>
                )}
            </div>

            {/* ── boards ───────────────────────────────────────────── */}
            <h3 className={`mt-8 ${sectionTitle}`}>Job boards</h3>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Everything Google returns is kept. The starred boards are the priority set — the
                ones we make sure to cover — not a filter. Switching a board off makes discovery
                discard its postings at ingest.
            </p>

            {acceptedCount === 0 && (
                <div className={`mt-3 ${alertShell} ${TONE_ALERT.warning}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        Every board is switched off, so a run will discard everything it finds.
                        Turn at least one on.
                    </span>
                </div>
            )}

            <div className={`mt-3 overflow-x-auto ${card}`}>
                <table className="w-full min-w-[36rem] text-sm">
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>Board</th>
                            <th className={tableHeadCell}>Accepting</th>
                            <th className={tableHeadCell}>Postings</th>
                            {canEdit && <th className={tableHeadCell} />}
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {portals.map((s) => (
                            <tr key={s.id} className={tableRow}>
                                <td className={tableCell}>
                                    <p className="flex items-center gap-1.5 font-medium text-slate-900">
                                        {s.is_priority && (
                                            <Star className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.brand}`} aria-label="Priority board" />
                                        )}
                                        {s.label}
                                    </p>
                                    {s.notes && <p className="mt-0.5 max-w-lg text-xs text-slate-400">{s.notes}</p>}
                                </td>
                                <td className={tableCell}>
                                    <span className={`${badge} ${s.is_enabled ? TONE.success : TONE.neutral}`}>
                                        {s.is_enabled
                                            ? <><CheckCircle2 className="h-3.5 w-3.5" /> Yes</>
                                            : <><XCircle className="h-3.5 w-3.5" /> No</>}
                                    </span>
                                </td>
                                <td className={`${tableCell} tabular-nums`}>
                                    {s.postings > 0
                                        ? <span className="text-slate-700">{s.postings}</span>
                                        : <span className="text-slate-300">0</span>}
                                </td>
                                {canEdit && (
                                    <td className={`${tableCell} text-right`}>
                                        <button
                                            type="button"
                                            onClick={() => toggle(s)}
                                            className={s.is_enabled ? btnSm.caution : btnSm.success}
                                        >
                                            <Power className="h-3.5 w-3.5" />
                                            {s.is_enabled ? 'Stop accepting' : 'Accept'}
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* ── run history ──────────────────────────────────────── */}
            <h3 className={`mt-8 ${sectionTitle}`}>Recent runs</h3>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Every run, including the ones that found nothing. A run that queued nothing because
                there was nothing new looks very different here from one that queued nothing
                because the key expired — open a row for the full breakdown.
            </p>

            <div className={`mt-3 overflow-x-auto ${card}`}>
                <table className="w-full min-w-[52rem] text-sm">
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>When</th>
                            <th className={tableHeadCell}>Outcome</th>
                            <th className={tableHeadCell}>Credits</th>
                            <th className={tableHeadCell}>Results</th>
                            <th className={tableHeadCell}>New</th>
                            <th className={tableHeadCell}>Matched</th>
                            <th className={tableHeadCell}>Queued</th>
                            <th className={tableHeadCell}>Took</th>
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {runs.length === 0 && (
                            <tr>
                                <td colSpan={8} className="p-6 text-center text-sm text-slate-500">
                                    No runs yet. “Run discovery now” searches Google Jobs and shows
                                    exactly what it bought.
                                </td>
                            </tr>
                        )}
                        {runs.map((r) => {
                            const o = outcomeOf(r);
                            const isOpen = openRun === r.id;
                            return (
                                <Fragment key={r.id}>
                                    <tr
                                        className={`${tableRow} cursor-pointer`}
                                        onClick={() => setOpenRun(isOpen ? null : r.id)}
                                        aria-expanded={isOpen}
                                    >
                                        <td className={tableCell}>
                                            {isOpen
                                                ? <ChevronDown className="mr-1 inline h-3.5 w-3.5 text-slate-400" />
                                                : <ChevronRight className="mr-1 inline h-3.5 w-3.5 text-slate-400" />}
                                            {new Date(r.started_at).toLocaleString()}
                                            <span className="ml-1 text-xs text-slate-400">
                                                {r.trigger === 'SCHEDULED' ? 'scheduled' : 'manual'}
                                                {r.triggered_by_name ? ` · ${r.triggered_by_name}` : ''}
                                            </span>
                                        </td>
                                        <td className={tableCell}>
                                            <span className={`${badge} ${TONE[o.tone]}`}>
                                                <o.icon className={`h-3.5 w-3.5 ${o.spin ? 'animate-spin' : ''}`} /> {o.label}
                                            </span>
                                            {r.queries_failed > 0 && (
                                                <p className="mt-1 text-xs text-slate-500">{r.queries_failed} search(es) failed</p>
                                            )}
                                            {r.error && <p className="mt-1 max-w-xs text-xs text-slate-500">{r.error}</p>}
                                        </td>
                                        <td className={`${tableCell} tabular-nums`}>{r.provider_calls}</td>
                                        <td className={`${tableCell} tabular-nums`}>{r.raw_items}</td>
                                        <td className={`${tableCell} tabular-nums`}>{r.postings_new}</td>
                                        <td className={`${tableCell} tabular-nums`}>{r.matches_found}</td>
                                        <td className={`${tableCell} tabular-nums`}>{r.queued}</td>
                                        <td className={`${tableCell} tabular-nums text-slate-500`}>{tookText(r)}</td>
                                    </tr>

                                    {/* ── this run, stage by stage ─────────────── */}
                                    {isOpen && (
                                        <tr className="bg-slate-50">
                                            <td colSpan={8} className="px-4 py-3">
                                                <div className="flex flex-wrap gap-x-6 gap-y-2">
                                                    {STAGES.map(([key, label]) => (
                                                        <div key={key}>
                                                            <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
                                                            <p className={`text-sm font-medium tabular-nums ${
                                                                r[key] > 0 ? 'text-slate-900' : 'text-slate-300'}`}
                                                            >
                                                                {r[key]}
                                                            </p>
                                                        </div>
                                                    ))}
                                                </div>
                                                {r.error && (
                                                    <p className={`mt-3 ${alertShellSm} ${TONE_ALERT.danger}`}>{r.error}</p>
                                                )}
                                                {r.notes && (
                                                    <details className="mt-3">
                                                        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                                                            Run notes
                                                        </summary>
                                                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-xs text-slate-600">
                                                            {r.notes}
                                                        </pre>
                                                    </details>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {confirmRun && (
                <Modal
                    size="sm"
                    tone="brand"
                    icon={Radar}
                    title="Run discovery now?"
                    onClose={() => setConfirmRun(false)}
                    footer={(
                        <ModalActions
                            onCancel={() => setConfirmRun(false)}
                            onConfirm={runNow}
                            confirmLabel="Run now"
                            busy={running}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        This sends up to {provider.maxQueries} searches to Google Jobs, then matches
                        everything found against each active consultant&apos;s search criteria.
                    </p>
                    <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.warning}`}>
                        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            Costs up to <strong>{estimatedCredits} API credits</strong>. Two runs
                            cannot overlap.
                        </span>
                    </p>
                </Modal>
            )}
        </>
    );
};

export default SerpApiPullPanel;
