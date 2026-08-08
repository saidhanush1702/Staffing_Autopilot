import { useCallback, useEffect, useState } from 'react';
import {
    Radar, Play, Loader2, AlertCircle, CheckCircle2, XCircle, Power,
    Clock, TriangleAlert,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import SchedulePanel from '../../components/discovery/SchedulePanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT,
    pageTitle, pageSubtitle, tableHead, tableHeadCell, tableBody, tableRow,
    tableCell, tableEmpty,
} from '../../design/tokens.js';

/** The stage counters, in pipeline order, so a run reads left to right. */
const STAGES = [
    ['raw_items', 'Fetched'],
    ['parsed_ok', 'Parsed'],
    ['quarantined', 'Quarantined'],
    ['postings_new', 'New'],
    ['postings_duplicate', 'Repeat'],
    ['prefilter_out', 'Pre-filtered out'],
    ['matches_found', 'Matched'],
    ['queued', 'Queued'],
    ['held_by_cap', 'Held by cap'],
];

/**
 * Job discovery — the operator screen.
 *
 * Two jobs: turn boards on and off, and show what the last runs actually did.
 *
 * The per-stage counts matter more than they look. A run that queued nothing
 * because there were no new postings and a run that queued nothing because a
 * parser broke are indistinguishable from a success flag alone — these numbers
 * are the only way to tell them apart.
 */
const JobDiscovery = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [sources, setSources] = useState(null);
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
            setRuns(r.data.runs);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!sources) return <PageLoader />;

    const fetchable = sources.filter((s) => s.fetch_mode === 'HTTP');
    const enabledCount = fetchable.filter((s) => s.is_enabled).length;

    const toggle = async (source) => {
        setError('');
        try {
            await api.patch(`/management/discovery/sources/${source.id}`, {
                isEnabled: !source.is_enabled,
            });
            await load();
        } catch (err) {
            setError(errorMessage(err, 'Could not change that board.'));
        }
    };

    const runNow = async () => {
        setRunning(true);
        setBanner(null);
        try {
            const { data } = await api.post('/management/discovery/run');
            const r = data.run;
            setBanner({
                tone: r.sources_failed > 0 ? 'warning' : 'success',
                text: `Run complete — ${r.postings_new} new postings, ${r.matches_found} matches, `
                    + `${r.queued} queued, ${r.held_by_cap} held by cap`
                    + (r.sources_failed ? `. ${r.sources_failed} board(s) failed.` : '.'),
            });
            setConfirmRun(false);
            await load();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err, 'The run failed.') });
        } finally {
            setRunning(false);
        }
    };

    /** A board's health, at a glance. */
    const health = (s) => {
        if (!s.is_enabled) return { tone: 'neutral', text: 'Off', icon: Power };
        if (s.consecutive_failures >= 3) {
            return { tone: 'danger', text: `Failing (${s.consecutive_failures})`, icon: XCircle };
        }
        if (s.consecutive_failures > 0) {
            return { tone: 'warning', text: `${s.consecutive_failures} recent failure(s)`, icon: TriangleAlert };
        }
        if (s.last_success_at) return { tone: 'success', text: 'Healthy', icon: CheckCircle2 };
        return { tone: 'info', text: 'Not run yet', icon: Clock };
    };

    return (
        <div>
            <h1 className={pageTitle}>Job discovery</h1>
            <p className={pageSubtitle}>
                Finds postings on the enabled boards and works out which consultant
                each one suits.
            </p>

            <SchedulePanel canEdit={isAdmin} onCycleFired={load} />

            {banner && (
                <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT[banner.tone]}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{banner.text}</span>
                </div>
            )}

            {enabledCount === 0 && (
                <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.info}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        No board is enabled, so a run will find nothing. Boards ship switched
                        off — nothing reaches out to the internet until you turn one on.
                    </span>
                </div>
            )}

            {/* ── boards ─────────────────────────────────────────── */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>Job boards</h2>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={() => setConfirmRun(true)}
                        disabled={running}
                        className={btn.primary}
                    >
                        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        Run discovery now
                    </button>
                )}
            </div>

            <TableShell className="mt-3" minWidth={860}>
                <thead className={tableHead}>
                    <tr>
                        <th className={tableHeadCell}>Board</th>
                        <th className={tableHeadCell}>Health</th>
                        <th className={tableHeadCell}>Last success</th>
                        <th className={tableHeadCell}>Pace</th>
                        <th className={tableHeadCell}>Quarantined</th>
                        {isAdmin && <th className={tableHeadCell} />}
                    </tr>
                </thead>
                <tbody className={tableBody}>
                    {fetchable.map((s) => {
                        const h = health(s);
                        return (
                            <tr key={s.id} className={tableRow}>
                                <td className={tableCell}>
                                    <p className="font-medium text-slate-900">{s.label}</p>
                                    {s.notes && (
                                        <p className="mt-0.5 max-w-md text-xs text-slate-400">{s.notes}</p>
                                    )}
                                </td>
                                <td className={tableCell}>
                                    <span className={`${badge} ${TONE[h.tone]}`}>
                                        <h.icon className="h-3.5 w-3.5" /> {h.text}
                                    </span>
                                    {s.last_error && (
                                        <p className="mt-1 max-w-xs truncate text-xs text-danger-700" title={s.last_error}>
                                            {s.last_error}
                                        </p>
                                    )}
                                </td>
                                <td className={`${tableCell} whitespace-nowrap text-slate-500`}>
                                    {s.last_success_at
                                        ? new Date(s.last_success_at).toLocaleString()
                                        : '—'}
                                </td>
                                <td className={`${tableCell} whitespace-nowrap text-xs text-slate-500`}>
                                    {s.rate_limit_ms / 1000}s gap · {s.max_pages} page(s)
                                </td>
                                <td className={tableCell}>
                                    {s.quarantined > 0 ? (
                                        <span className={`${badge} ${TONE.warning}`}>{s.quarantined}</span>
                                    ) : <span className="text-slate-400">0</span>}
                                </td>
                                {isAdmin && (
                                    <td className={`${tableCell} text-right`}>
                                        <button
                                            type="button"
                                            onClick={() => toggle(s)}
                                            className={s.is_enabled ? btnSm.caution : btnSm.success}
                                        >
                                            <Power className="h-3.5 w-3.5" />
                                            {s.is_enabled ? 'Turn off' : 'Turn on'}
                                        </button>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </TableShell>

            {/* ── runs ───────────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>Recent runs</h2>
            <p className="mt-1 text-xs text-slate-500">
                A run that queued nothing because there was nothing new looks very
                different here from one that queued nothing because a parser broke.
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
                            {r.sources_failed > 0 && (
                                <span className={`${badge} ${TONE.danger}`}>
                                    {r.sources_failed} board(s) failed
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
                                    Per-board notes
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
                        This fetches from {enabledCount} enabled board
                        {enabledCount === 1 ? '' : 's'}, then matches everything found against
                        each active consultant's search criteria.
                    </p>
                    <p className="mt-2 text-xs text-slate-500">
                        It makes real requests to those boards, so it is deliberately slow —
                        a minute or more is normal. Two runs cannot overlap.
                    </p>
                </Modal>
            )}

            <AuditLogPanel module="discovery" />
        </div>
    );
};

export default JobDiscovery;
