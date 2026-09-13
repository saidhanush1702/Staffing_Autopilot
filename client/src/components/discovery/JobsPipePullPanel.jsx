import { useCallback, useEffect, useState } from 'react';
import {
    Zap, Play, Loader2, Power, Coins, AlertCircle, CheckCircle2, Clock,
    TriangleAlert, KeyRound, SlidersHorizontal, Inbox, XCircle, Gauge,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT, TONE_TEXT,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, alertShell,
    alertShellSm, input, fieldLabel, checkbox, codeChip,
} from '../../design/tokens.js';

/**
 * ── THE JOBSPIPE PULL PATH, ON THE DISCOVERY SCREEN ───────────────────
 *
 * Deliberately laid out like the SerpApi panel above it — a health badge, a
 * on/off switch, a row of figures, its own Run button, and a run history — so
 * the two ingestion doors read as two of the same kind of thing rather than
 * two unrelated features.
 *
 * ── WHY IT IS A SEPARATE PANEL AND A SEPARATE BUTTON ──────────────────
 *
 * They are billed on completely different units, and one screen cannot show
 * one cost:
 *
 *   SerpApi    1 credit = 1 PAGE of results. A run makes many calls, so the
 *              cost of pressing Run is a range.
 *   JobsPipe   1 credit = 1 REQUEST, capped at 25 jobs. Pressing Run costs
 *              exactly one credit, always, whether it returns 25 jobs or none.
 *
 * A single "Run discovery" button spanning both would spend two metered
 * allowances on one press, and an operator watching one budget would drain the
 * other. Hence two buttons, each naming what it spends.
 *
 * ── WHY "ADVANCED" EXISTS ─────────────────────────────────────────────
 *
 * Measured against the live feed, two filters decide whether a credit is worth
 * spending at all:
 *
 *   country  unfiltered, 1 job in 25 was US — the rest Sweden, India, France.
 *   source   an Indeed relay arrives ~7.7h after publication with a
 *            daily-granularity timestamp; a direct ATS (greenhouse, lever)
 *            arrived in 6 MINUTES with a real one.
 *
 * The whole freshness case for this feed lives in that second filter, so it
 * has to be reachable without editing .env and restarting the server.
 */

/** How each poll outcome should read. Neutral where neutral is correct. */
const OUTCOME = {
    OK: { tone: 'success', label: 'Ran', icon: CheckCircle2 },
    SKIPPED: { tone: 'neutral', label: 'Skipped', icon: Inbox },
    BUDGET_HIT: { tone: 'warning', label: 'Out of credits', icon: Coins },
    ERROR: { tone: 'danger', label: 'Failed', icon: XCircle },
};

/**
 * The nine sources JobsPipe ACTIVELY COLLECTS, and why they are grouped so.
 *
 * ── WHY THE GROUPING IS THE POINT ─────────────────────────────────────
 *
 * Direct ATS boards publish to their own public API the moment a job goes
 * live, so JobsPipe sees them in minutes. Job boards re-publish on their own
 * schedule, which is where the multi-hour lag comes from. Measured on this
 * account: greenhouse **6 minutes**, indeed **7.7 hours** — and Indeed's
 * timestamp is daily-granular, so its rows cannot even be aged accurately.
 *
 * ── WHY ziprecruiter AND jobtech ARE GONE ─────────────────────────────
 *
 * `ziprecruiter` is on JobsPipe's DOCUMENTED list but not its COLLECTED one,
 * so ticking it filtered the feed down to nothing and spent the credit anyway.
 * A filter that silently guarantees an empty page is worse than no filter.
 * `jobtech` is real — it supplied 14 Swedish public-sector jobs in the first
 * trial call — but it is not a US source and is not in the documented set, so
 * it does not belong in a list presented as "pick your coverage".
 *
 * Anything not listed here (glassdoor, icims, bamboohr, taleo, bullhorn …)
 * is documented by JobsPipe but NOT indexed by it. Those need a different
 * vendor, not a tick box.
 */
const SOURCE_GROUPS = [
    {
        label: 'Direct ATS — fastest (minutes)',
        values: ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday', 'paylocity'],
    },
    {
        label: 'Job boards — widest reach (hours)',
        values: ['linkedin', 'indeed'],
    },
];

const ageText = (h) => {
    if (h === null || h === undefined) return '—';
    const n = Number(h);
    if (n < 1) return `${Math.round(n * 60)}m`;
    if (n < 48) return `${n.toFixed(1)}h`;
    return `${(n / 24).toFixed(1)}d`;
};

const JobsPipePullPanel = ({ canEdit }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [banner, setBanner] = useState(null);
    const [busy, setBusy] = useState('');
    const [confirm, setConfirm] = useState(false);
    const [advanced, setAdvanced] = useState(false);

    /* ── the Advanced form ───────────────────────────────────────────── */
    //
    // Defaults chosen from the measured trial rather than from the API's own
    // defaults: US only, last day, direct-ATS sources. Those are the settings
    // that made a credit worth spending.
    const [form, setForm] = useState({
        country: 'US',
        maxAgeDays: 1,
        limit: 25,
        contractOnly: false,
        remoteOnly: false,
        sources: [],
        titles: '',
    });

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get('/management/jobspipe/pull');
            setData(d);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) {
        return (
            <div className={`mt-3 ${alertShell} ${TONE_ALERT.danger}`}>
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
            </div>
        );
    }
    if (!data) {
        return <div className={`mt-3 ${card} ${cardPad} text-sm text-slate-500`}>Loading JobsPipe…</div>;
    }

    const { configured, enabled, budget, plan, runs, postings, scheduleEnabled, scheduleCron } = data;
    const outOfCredits = budget.remaining <= 0;
    const canRun = configured && enabled && !outOfCredits && plan.titles.length > 0;

    const health = () => {
        if (!configured) return { tone: 'neutral', text: 'No API key', icon: KeyRound };
        if (!enabled) return { tone: 'neutral', text: 'Switched off', icon: Power };
        if (outOfCredits) return { tone: 'warning', text: "Month's credits used", icon: Coins };
        if (runs[0]?.outcome === 'ERROR') return { tone: 'warning', text: 'Last poll failed', icon: TriangleAlert };
        if (runs.length === 0) return { tone: 'info', text: 'Never polled', icon: Clock };
        return { tone: 'success', text: 'Ready', icon: CheckCircle2 };
    };
    const status = health();

    const act = async (name, fn) => {
        setBusy(name);
        setBanner(null);
        try {
            await fn();
            await load();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy('');
        }
    };

    const toggle = () => act('toggle', () => api.patch('/management/jobspipe/pull', { isEnabled: !enabled }));

    /** Build the request body. Empty object = the one-click, bench-driven case. */
    const buildBody = () => {
        if (!advanced) return {};
        const body = {};
        const titles = form.titles.split(',').map((t) => t.trim()).filter(Boolean);
        if (titles.length) body.titles = titles;
        if (form.country) body.countries = [form.country.toUpperCase()];
        if (form.contractOnly) body.employmentTypes = ['contract'];
        if (form.remoteOnly) body.remote = true;
        if (form.sources.length) body.sources = form.sources;
        if (form.maxAgeDays) body.maxAgeDays = Number(form.maxAgeDays);
        if (form.limit) body.limit = Number(form.limit);
        return body;
    };

    const runNow = async () => {
        setConfirm(false);
        await act('run', async () => {
            const { data: res } = await api.post('/management/jobspipe/poll', buildBody());
            const r = res.run;
            const tone = r.outcome === 'OK' ? (r.queued > 0 ? 'success' : 'info') : 'warning';
            setBanner({
                tone,
                text: r.outcome !== 'OK'
                    ? `${OUTCOME[r.outcome]?.label ?? r.outcome} — ${r.error ?? 'no detail'}`
                    : `${r.returned} job(s) for 1 credit · ${r.newPostings} new, `
                      + `${r.duplicates} already held, ${r.matches} matched, `
                      + `${r.queued} queued, ${r.prepared} sent to AI preparation. `
                      + `Median age ${ageText(r.age?.median)}. `
                      + `${res.budget.remaining}/${res.budget.monthly ?? budget.monthly} credits left.`,
            });
        });
    };

    const setSource = (value) => setForm((f) => ({
        ...f,
        sources: f.sources.includes(value)
            ? f.sources.filter((s) => s !== value)
            : [...f.sources, value],
    }));

    return (
        <>
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>JobsPipe — real-time pull</h2>
                {canEdit && (
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setAdvanced((v) => !v)}
                            className={advanced ? btnSm.primary : btnSm.secondary}
                        >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                            Advanced
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirm(true)}
                            disabled={busy === 'run' || !canRun}
                            className={btn.primary}
                        >
                            {busy === 'run'
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Play className="h-4 w-4" />}
                            Run JobsPipe now
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
                                <Zap className="h-4 w-4 text-amber-500" />
                                JobsPipe search API
                            </p>
                            <span className={`${badge} ${TONE[status.tone]}`}>
                                <status.icon className="h-3.5 w-3.5" /> {status.text}
                            </span>
                        </div>
                        <p className="mt-1 max-w-xl text-xs text-slate-500">
                            A second door into the same pool. Pulls jobs published in the last
                            day or two and runs them through the same de-duplication, matcher
                            and AI preparation as a Google Jobs run — nothing here changes
                            the provider above.
                        </p>
                    </div>

                    {canEdit && (
                        <button
                            type="button"
                            onClick={toggle}
                            disabled={busy === 'toggle' || (!configured && !enabled)}
                            className={enabled ? btnSm.caution : btnSm.success}
                        >
                            <Power className="h-3.5 w-3.5" />
                            {enabled ? 'Turn off' : 'Turn on'}
                        </button>
                    )}
                </div>

                {/* ── the figures ───────────────────────────────────── */}
                <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Cost per run</p>
                        <p className={`flex items-center gap-1 text-sm tabular-nums ${TONE_TEXT.warning}`}>
                            <Coins className="h-3.5 w-3.5" />
                            exactly 1 credit
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">This month</p>
                        <p className="flex items-center gap-1 text-sm tabular-nums text-slate-700">
                            <Gauge className="h-3.5 w-3.5" />
                            {budget.spent}/{budget.monthly}
                            <span className={`ml-1 text-xs ${outOfCredits ? TONE_TEXT.danger : 'text-slate-400'}`}>
                                ({budget.remaining} left)
                            </span>
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Jobs per credit</p>
                        <p className="text-sm tabular-nums text-slate-700">up to 25</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Search terms</p>
                        <p className="text-sm tabular-nums text-slate-700">
                            {plan.titles.length} from {plan.benchSize} consultant(s)
                        </p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Postings so far</p>
                        <p className="text-sm tabular-nums text-slate-700">{postings}</p>
                    </div>
                    <div>
                        <p className="text-xs uppercase tracking-wide text-slate-400">Automatic polling</p>
                        <p className="text-sm text-slate-700">
                            {scheduleEnabled
                                ? <span className={TONE_TEXT.success}>on · {scheduleCron}</span>
                                : <span className="text-slate-500">off — manual only</span>}
                        </p>
                    </div>
                </div>

                <p className="mt-3 text-xs text-slate-500">
                    A credit buys one <strong>request</strong>, not one job — a page is capped at
                    25 whatever you ask for, so asking for less never costs less. That is the
                    opposite of the provider above, where a credit buys one page and a run
                    buys several.
                </p>

                {/* what a one-click run would search for */}
                {plan.titles.length > 0 ? (
                    <div className="mt-3">
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                            {advanced ? 'Bench titles (used unless overridden below)' : 'A run will search for'}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {plan.titles.map((t) => (
                                <span key={t.title} className={codeChip}>
                                    {t.title}
                                    {t.consultants > 1 && (
                                        <span className="ml-1 text-slate-400">×{t.consultants}</span>
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
                            nothing to search for. A run would spend a credit to return jobs
                            nobody asked for, so the button stays disabled.
                        </span>
                    </div>
                )}

                {!configured && (
                    <div className={`mt-3 ${alertShell} ${TONE_ALERT.info}`}>
                        <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                            No API key is set. Add <code className="font-mono text-xs">JOBSPIPE_API_KEY</code>
                            {' '}to the server&apos;s <code className="font-mono text-xs">.env</code> and
                            restart it.
                        </span>
                    </div>
                )}

                {outOfCredits && configured && (
                    <div className={`mt-3 ${alertShellSm} ${TONE_ALERT.warning}`}>
                        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            This month&apos;s allowance is used up ({budget.spent}/{budget.monthly}).
                            It resets on the 1st.
                        </span>
                    </div>
                )}

                {/* ── Advanced ──────────────────────────────────────── */}
                {advanced && canEdit && (
                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs text-slate-600">
                            Every field here <strong>narrows</strong> the search. It still costs
                            exactly one credit — these settings decide whether that credit buys
                            jobs you can use.
                        </p>

                        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label className={fieldLabel} htmlFor="jp-country">Country</label>
                                <input
                                    id="jp-country"
                                    className={input}
                                    value={form.country}
                                    maxLength={2}
                                    placeholder="US"
                                    onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))}
                                />
                                <p className="mt-1 text-xs text-slate-500">
                                    Unfiltered, 1 job in 25 was US.
                                </p>
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="jp-age">Posted within (days)</label>
                                <input
                                    id="jp-age"
                                    type="number"
                                    min={1}
                                    max={30}
                                    className={input}
                                    value={form.maxAgeDays}
                                    onChange={(e) => setForm((f) => ({ ...f, maxAgeDays: e.target.value }))}
                                />
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="jp-limit">Page size</label>
                                <input
                                    id="jp-limit"
                                    type="number"
                                    min={1}
                                    max={100}
                                    className={input}
                                    value={form.limit}
                                    onChange={(e) => setForm((f) => ({ ...f, limit: e.target.value }))}
                                />
                                <p className="mt-1 text-xs text-slate-500">
                                    Capped at 25 by the plan.
                                </p>
                            </div>
                            <div>
                                <p className={fieldLabel}>Only</p>
                                <label className="mt-1 flex items-center gap-2 text-sm text-slate-700">
                                    <input
                                        type="checkbox"
                                        className={checkbox}
                                        checked={form.contractOnly}
                                        onChange={(e) => setForm((f) => ({ ...f, contractOnly: e.target.checked }))}
                                    />
                                    Contract roles
                                </label>
                                <label className="mt-1 flex items-center gap-2 text-sm text-slate-700">
                                    <input
                                        type="checkbox"
                                        className={checkbox}
                                        checked={form.remoteOnly}
                                        onChange={(e) => setForm((f) => ({ ...f, remoteOnly: e.target.checked }))}
                                    />
                                    Remote
                                </label>
                            </div>
                        </div>

                        <div className="mt-4">
                            <p className={fieldLabel}>Sources</p>
                            <p className="mb-2 text-xs text-slate-500">
                                Leave all unticked for every source. Direct-ATS postings reached
                                us in <strong>6 minutes</strong>; the same measurement put Indeed
                                at <strong>7.7 hours</strong> with a date accurate only to the day.
                            </p>
                            {/*
                              These nine are not a shortlist — they are the WHOLE of what
                              JobsPipe indexes. Their site lists 42 sources, but 33 of those
                              are written up as guides and explicitly not collected, so
                              filtering to one returns an empty page and still costs the
                              credits. Saying so here is cheaper than finding out by running it.
                            */}
                            <p className="mb-2 text-xs text-slate-400">
                                These nine are everything JobsPipe indexes. Glassdoor, iCIMS,
                                Taleo, BambooHR, Bullhorn, ZipRecruiter, Naukri and ~26 others
                                appear on their site but are <strong>not collected</strong> —
                                they need a different provider, not a tick box.
                            </p>
                            {SOURCE_GROUPS.map((group) => (
                                <div key={group.label} className="mt-2">
                                    <p className="text-xs uppercase tracking-wide text-slate-400">
                                        {group.label}
                                    </p>
                                    <div className="mt-1 flex flex-wrap gap-2">
                                        {group.values.map((v) => (
                                            <label
                                                key={v}
                                                className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                                                    form.sources.includes(v)
                                                        ? 'border-brand-400 bg-brand-50 text-brand-800'
                                                        : 'border-slate-200 bg-white text-slate-600'
                                                }`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="sr-only"
                                                    checked={form.sources.includes(v)}
                                                    onChange={() => setSource(v)}
                                                />
                                                {v}
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="mt-4">
                            <label className={fieldLabel} htmlFor="jp-titles">
                                Override titles (comma separated)
                            </label>
                            <input
                                id="jp-titles"
                                className={input}
                                placeholder="leave blank to use the bench titles above"
                                value={form.titles}
                                onChange={(e) => setForm((f) => ({ ...f, titles: e.target.value }))}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* ── run history ──────────────────────────────────────── */}
            <h3 className={`mt-6 ${sectionTitle}`}>Recent JobsPipe polls</h3>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Every poll, including the ones that spent nothing. <strong>Median age</strong> is
                what the trial turns on — how old a posting was when we first saw it.
            </p>

            <div className={`mt-3 overflow-x-auto ${card}`}>
                <table className="w-full min-w-[52rem] text-sm">
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>When</th>
                            <th className={tableHeadCell}>Outcome</th>
                            <th className={tableHeadCell}>Credits</th>
                            <th className={tableHeadCell}>Returned</th>
                            <th className={tableHeadCell}>New</th>
                            <th className={tableHeadCell}>Queued</th>
                            <th className={tableHeadCell}>Prepared</th>
                            <th className={tableHeadCell}>Median age</th>
                            <th className={tableHeadCell}>&lt;24h</th>
                            <th className={tableHeadCell}>Took</th>
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {runs.length === 0 && (
                            <tr>
                                <td colSpan={10} className="p-6 text-center text-sm text-slate-500">
                                    No polls yet. “Run JobsPipe now” spends one credit and shows
                                    exactly what it bought.
                                </td>
                            </tr>
                        )}
                        {runs.map((r) => {
                            const o = OUTCOME[r.outcome] ?? OUTCOME.ERROR;
                            return (
                                <tr key={r.id} className={tableRow}>
                                    <td className={tableCell}>
                                        {new Date(r.started_at).toLocaleString()}
                                        <span className="ml-1 text-xs text-slate-400">
                                            {r.trigger === 'MANUAL' ? 'manual' : 'scheduled'}
                                        </span>
                                    </td>
                                    <td className={tableCell}>
                                        <span className={`${badge} ${TONE[o.tone]}`}>
                                            <o.icon className="h-3.5 w-3.5" /> {o.label}
                                        </span>
                                        {r.error && (
                                            <p className="mt-1 max-w-xs text-xs text-slate-500">{r.error}</p>
                                        )}
                                    </td>
                                    <td className={`${tableCell} tabular-nums`}>{r.credits_spent}</td>
                                    <td className={`${tableCell} tabular-nums`}>{r.jobs_returned}</td>
                                    <td className={`${tableCell} tabular-nums`}>{r.new_postings}</td>
                                    <td className={`${tableCell} tabular-nums`}>{r.queued_count}</td>
                                    <td className={`${tableCell} tabular-nums`}>{r.preparation_enqueued}</td>
                                    <td className={`${tableCell} tabular-nums`}>{ageText(r.age_hours_median)}</td>
                                    <td className={`${tableCell} tabular-nums`}>{r.posted_last_24h}</td>
                                    <td className={`${tableCell} tabular-nums text-slate-500`}>
                                        {r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {confirm && (
                <Modal
                    size="sm"
                    tone="brand"
                    icon={Zap}
                    title="Run a JobsPipe poll?"
                    onClose={() => setConfirm(false)}
                    footer={(
                        <ModalActions
                            onCancel={() => setConfirm(false)}
                            onConfirm={runNow}
                            confirmLabel="Run now"
                            busy={busy === 'run'}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        This is a <strong>real</strong> request. Anything it finds is stored,
                        matched against every active consultant, and queued — which also hands
                        work to the AI preparation stage.
                    </p>
                    <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.warning}`}>
                        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                            Costs <strong>1 credit</strong> of {budget.remaining} left this month,
                            and returns at most 25 jobs.
                        </span>
                    </p>
                    <div className="mt-3 rounded-md bg-slate-50 p-3">
                        <p className="text-xs uppercase tracking-wide text-slate-400">Will send</p>
                        <pre className="mt-1 overflow-x-auto text-xs text-slate-600">
                            {JSON.stringify(
                                advanced
                                    ? buildBody()
                                    : {
                                        job_title_or: plan.titles.map((t) => t.title),
                                        posted_at_max_age_days: plan.maxAgeDays,
                                        limit: plan.limit,
                                    },
                                null,
                                1,
                            )}
                        </pre>
                        {!advanced && (
                            <p className="mt-1 text-xs text-slate-500">
                                No country or source filter — press Advanced to narrow it.
                            </p>
                        )}
                    </div>
                </Modal>
            )}
        </>
    );
};

export default JobsPipePullPanel;
