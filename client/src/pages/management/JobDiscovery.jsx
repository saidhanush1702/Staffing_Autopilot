import { useCallback, useEffect, useState } from 'react';
import {
    Radar, Play, Loader2, AlertCircle, CheckCircle2, XCircle, Power,
    Clock, TriangleAlert, KeyRound, Coins, Star,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import SchedulePanel from '../../components/discovery/SchedulePanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT, TONE_TEXT,
    pageTitle, pageSubtitle, tableHead, tableHeadCell, tableBody, tableRow,
    tableCell,
} from '../../design/tokens.js';

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
    ['held_by_cap', 'Held by cap'],
];

/** Google's own recency vocabulary. Its finest grain is a day, not an hour. */
const RECENCY = {
    today: 'Posted today',
    '3days': 'Posted in the last 3 days',
    week: 'Posted in the last week',
    month: 'Posted in the last month',
};

/**
 * Job discovery — the operator screen.
 *
 * Three jobs: show whether the search provider is actually able to run, let
 * boards be accepted or rejected, and show what the last runs did.
 *
 * The per-stage counts matter more than they look. A run that queued nothing
 * because there was nothing new, a run that queued nothing because every board
 * is switched off, and a run that queued nothing because the API key expired
 * are indistinguishable from a success flag alone — these numbers are the only
 * way to tell them apart.
 */
const JobDiscovery = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [sources, setSources] = useState(null);
    const [provider, setProvider] = useState(null);
    const [runs, setRuns] = useState([]);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [confirmRun, setConfirmRun] = useState(false);
    const [banner, setBanner] = useState(null);

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
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!sources || !provider) return <PageLoader />;

    const providerRow = sources.find((s) => s.fetch_mode === 'PROVIDER');
    const portals = sources.filter((s) => s.fetch_mode === 'PORTAL');
    const acceptedCount = portals.filter((s) => s.is_enabled).length;
    const estimatedCredits = Math.min(
        provider.maxQueries * provider.maxPages,
        provider.maxCallsPerRun,
    );
    // The number that actually shows up on an invoice. A per-run figure reads
    // as trivial; the same figure times the cycle is what needs a decision.
    const monthlyCredits = estimatedCredits * provider.runsPerDay * 30;

    const toggle = async (source) => {
        setError('');
        try {
            await api.patch(`/management/discovery/sources/${source.id}`, {
                isEnabled: !source.is_enabled,
            });
            await load();
        } catch (err) {
            setError(errorMessage(err, 'Could not change that setting.'));
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
                    + `postings, ${r.matches_found} matches, ${r.queued} queued, `
                    + `${r.held_by_cap} held by cap`
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
    const providerHealth = () => {
        if (!provider.configured) {
            return { tone: 'danger', text: 'No API key', icon: KeyRound };
        }
        if (!provider.enabled) return { tone: 'neutral', text: 'Switched off', icon: Power };
        if (provider.consecutiveFailures >= 3) {
            return { tone: 'danger', text: `Failing (${provider.consecutiveFailures})`, icon: XCircle };
        }
        if (provider.consecutiveFailures > 0) {
            return {
                tone: 'warning',
                text: `${provider.consecutiveFailures} recent failure(s)`,
                icon: TriangleAlert,
            };
        }
        if (provider.lastSuccessAt) return { tone: 'success', text: 'Healthy', icon: CheckCircle2 };
        return { tone: 'info', text: 'Not run yet', icon: Clock };
    };

    const health = providerHealth();
    const canRun = provider.configured && provider.enabled;

    return (
        <div>
            <h1 className={pageTitle}>Job discovery</h1>
            <p className={pageSubtitle}>
                Finds postings through Google Jobs and works out which consultant
                each one suits.
            </p>

            <SchedulePanel canEdit={isAdmin} onCycleFired={load} />

            {banner && (
                <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT[banner.tone]}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{banner.text}</span>
                </div>
            )}

            {/* ── the provider ───────────────────────────────────── */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>Search provider</h2>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={() => setConfirmRun(true)}
                        disabled={running || !canRun}
                        className={btn.primary}
                    >
                        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        Run discovery now
                    </button>
                )}
            </div>

            <div className={`mt-3 ${card} ${cardPad}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-slate-900">{provider.label}</p>
                            <span className={`${badge} ${TONE[health.tone]}`}>
                                <health.icon className="h-3.5 w-3.5" /> {health.text}
                            </span>
                        </div>
                        <p className="mt-1 max-w-xl text-xs text-slate-500">
                            The only source that is fetched. Every board below is attribution —
                            which site Google says a posting came from.
                        </p>
                    </div>

                    {isAdmin && providerRow && (
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

                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Last success</p>
                        <p className="text-sm text-slate-700">
                            {provider.lastSuccessAt
                                ? new Date(provider.lastSuccessAt).toLocaleString()
                                : '—'}
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
                            <span className="ml-1 text-xs text-slate-400">
                                ({provider.runsPerDay}×/day)
                            </span>
                        </p>
                    </div>
                </div>

                <p className="mt-3 text-xs text-slate-500">
                    A credit buys one page of results, not one job — so the ceiling above is
                    what a run costs if every search finds something new. Searches stop
                    paging as soon as a page returns nothing we do not already have.
                </p>

                {provider.lastError && (
                    <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>
                        {provider.lastError}
                    </p>
                )}

                {!provider.configured && (
                    <div className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.info}`}>
                        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            No API key is set. Add <code className="font-mono text-xs">SERPAPI_KEY</code>
                            {' '}to the server&apos;s <code className="font-mono text-xs">.env</code> and
                            restart it. Runs still work meanwhile — they fetch nothing and match
                            what is already in the pool.
                        </span>
                    </div>
                )}
            </div>

            {/* ── boards ─────────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>Job boards</h2>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Everything Google returns is kept. The five starred boards are the priority
                set — the ones we make sure to cover — not a filter. Switching a board off
                makes discovery discard its postings at ingest.
            </p>

            {acceptedCount === 0 && (
                <div className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.warning}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        Every board is switched off, so a run will discard everything it
                        finds. Turn at least one on.
                    </span>
                </div>
            )}

            <TableShell className="mt-3" minWidth={760}>
                <thead className={tableHead}>
                    <tr>
                        <th className={tableHeadCell}>Board</th>
                        <th className={tableHeadCell}>Accepting</th>
                        <th className={tableHeadCell}>Postings</th>
                        {isAdmin && <th className={tableHeadCell} />}
                    </tr>
                </thead>
                <tbody className={tableBody}>
                    {portals.map((s) => (
                        <tr key={s.id} className={tableRow}>
                            <td className={tableCell}>
                                <p className="flex items-center gap-1.5 font-medium text-slate-900">
                                    {s.is_priority && (
                                        <Star
                                            className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT.brand}`}
                                            aria-label="Priority board"
                                        />
                                    )}
                                    {s.label}
                                </p>
                                {s.notes && (
                                    <p className="mt-0.5 max-w-lg text-xs text-slate-400">{s.notes}</p>
                                )}
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
                            {isAdmin && (
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
            </TableShell>

            {/* ── runs ───────────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>Recent runs</h2>
            <p className="mt-1 text-xs text-slate-500">
                A run that queued nothing because there was nothing new looks very
                different here from one that queued nothing because the key expired.
            </p>

            <div className="mt-3 space-y-3">
                {runs.length === 0 && (
                    <div className={`${card} ${cardPad} text-center`}>
                        <Radar className="mx-auto h-8 w-8 text-slate-300" />
                        <p className="mt-2 text-sm text-slate-500">No runs yet.</p>
                    </div>
                )}

                {runs.map((r) => (
                    <div key={r.id} className={`${card} ${cardPad}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`${badge} ${r.trigger === 'SCHEDULED' ? TONE.info : TONE.brand}`}>
                                    {r.trigger === 'SCHEDULED' ? 'Scheduled' : 'Manual'}
                                </span>
                                <span className="text-sm text-slate-700">
                                    {new Date(r.started_at).toLocaleString()}
                                </span>
                                {r.triggered_by_name && (
                                    <span className="text-xs text-slate-400">by {r.triggered_by_name}</span>
                                )}
                                {!r.finished_at && (
                                    <span className={`${badge} ${TONE.warning}`}>
                                        <Loader2 className="h-3 w-3 animate-spin" /> running
                                    </span>
                                )}
                            </div>
                            {r.queries_failed > 0 && (
                                <span className={`${badge} ${TONE.danger}`}>
                                    {r.queries_failed} search(es) failed
                                </span>
                            )}
                        </div>

                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
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
                            <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>{r.error}</p>
                        )}
                        {r.notes && (
                            <details className="mt-3">
                                <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                                    Run notes
                                </summary>
                                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                                    {r.notes}
                                </pre>
                            </details>
                        )}
                    </div>
                ))}
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
                        This sends up to {provider.maxQueries} searches to Google Jobs, then
                        matches everything found against each active consultant&apos;s search
                        criteria.
                    </p>
                    <p className={`mt-2 flex items-start gap-2 rounded-lg p-2 text-xs ${TONE_ALERT.warning}`}>
                        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            Costs up to <strong>{estimatedCredits} API credits</strong>. Two runs
                            cannot overlap.
                        </span>
                    </p>
                </Modal>
            )}

            <AuditLogPanel module="discovery" />
        </div>
    );
};

export default JobDiscovery;
