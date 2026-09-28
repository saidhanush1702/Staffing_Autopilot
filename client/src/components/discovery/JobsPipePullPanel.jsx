import {
    Fragment, useCallback, useEffect, useState,
} from 'react';
import {
    Zap, Play, Loader2, Power, Coins, AlertCircle, CheckCircle2, Clock,
    TriangleAlert, KeyRound, SlidersHorizontal, Inbox, XCircle, Gauge,
    ChevronDown, ChevronRight,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT, TONE_TEXT,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, alertShell,
    alertShellSm, input, fieldLabel, checkbox, codeChip,
} from '../../design/tokens.js';
import { formatDateTime } from '../../utils/datetime.js';

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
        values: ['linkedin', 'indeed', 'ycombinator'],
    },
];

/* ── Advanced filter vocabularies ─────────────────────────────────────── */
//
// The allowed values from JobsPipe's Filter reference
// (docs.jobspipe.dev/api-reference/filters), mirrored by the controller's
// apiFiltersSchema. An unknown value is not an error to the API — it matches
// nothing and still costs the credits — so only these can be picked.
const EMPLOYMENT_TYPES = [
    ['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'],
    ['temporary', 'Temporary'], ['internship', 'Internship'],
];
const SENIORITY = [
    ['entry_level', 'Entry'], ['mid_level', 'Mid'], ['senior', 'Senior'],
    ['director', 'Director / lead'], ['executive', 'Executive'],
];
const WORK_ARRANGEMENTS = [['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']];
const EMPLOYER_TYPES = [['employer', 'Direct employer'], ['agency', 'Agency'], ['broker', 'Broker']];
const VISA = [
    ['offers', 'Offers sponsorship'], ['no', 'No sponsorship'],
    ['citizenship_required', 'Citizenship required'],
];
const humanise = (v) => [v, v.replace(/_/g, ' ')];
const UNKNOWN_FIELDS = [
    'employment_type', 'seniority', 'work_arrangement', 'location', 'occupation',
    'industry', 'visa_sponsorship', 'benefits', 'company_size', 'salary',
].map(humanise);
const BENEFITS = [
    'health_insurance', 'dental_insurance', 'vision_insurance', 'life_insurance',
    'disability_insurance', 'paid_time_off', 'paid_holidays', '401k', '401k_matching',
    'retirement_plan', 'tuition_reimbursement', 'parental_leave',
    'flexible_spending_account', 'health_savings_account', 'employee_discount',
    'commuter_assistance', 'employee_assistance_program', 'flexible_schedule', 'bonus',
    'signing_bonus', 'profit_sharing', 'equity', 'paid_training',
    'professional_development', 'free_parking', 'relocation_assistance',
    'wellness_program', 'referral_program', 'childcare', 'loan_repayment',
    'phone_reimbursement', 'work_from_home',
].map(humanise);
const ALL_SOURCES = SOURCE_GROUPS.flatMap((g) => g.values).map((v) => [v, v]);

// How each Advanced field is turned into the request (see buildBody).
const LIST_KEYS = [
    'job_title_not', 'description_or', 'description_not', 'skills_or', 'esco_skill_id_or',
    'occupation_code_or', 'isic_division_or', 'job_country_code_not', 'job_location_or',
    'region_or', 'metro_code_or', 'company_name_or', 'company_name_partial_match_or',
];
const UPPERCASE_LIST_KEYS = ['job_country_code_not', 'region_or'];
const NUMBER_KEYS = [
    'min_employee_count', 'max_employee_count', 'min_salary_usd', 'max_applicant_count',
    'max_ghost_score', 'last_verified_max_age_days',
];
const CHIP_KEYS = [
    'job_seniority_or', 'work_arrangement_or', 'employer_type_or', 'employer_type_not',
    'visa_sponsorship_or', 'benefits_or', 'include_unknown',
];
const BOOL_KEYS = ['include_unlabeled_seniority', 'include_unlabeled_employment_type', 'has_recruiter_email'];

const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** A row of toggle chips for a multi-value filter. */
const Chips = ({ options, value = [], onToggle }) => (
    <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map(([v, label]) => {
            const on = value.includes(v);
            return (
                <button
                    key={v}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onToggle(v)}
                    className={`rounded-md border px-2 py-1 text-xs ${on
                        ? 'border-brand-400 bg-brand-50 text-brand-800'
                        : 'border-slate-200 bg-white text-slate-600'}`}
                >
                    {label}
                </button>
            );
        })}
    </div>
);

/** A collapsible group, so ~40 filters stay scannable. */
const FilterSection = ({ title, hint, children }) => (
    <details className="mt-3 rounded-md border border-slate-200 bg-white p-3">
        <summary className="cursor-pointer text-sm font-medium text-slate-800">
            {title}
            {hint && <span className="ml-2 text-xs font-normal text-slate-400">{hint}</span>}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </details>
);

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
    // Which poll row is expanded to show its per-board breakdown.
    const [openRun, setOpenRun] = useState(null);

    /* ── the Advanced form ───────────────────────────────────────────── */
    //
    // Defaults chosen from the measured trial rather than from the API's own
    // defaults: US only, last day, direct-ATS sources. Those are the settings
    // that made a credit worth spending.
    const [form, setForm] = useState({
        country: 'US',
        maxAgeDays: 1,
        limit: 25,
        remoteOnly: false,
        sources: [],
        excludeSources: [],
        employmentTypes: [],
        titles: '',
        // Every other filter, keyed by JobsPipe's own API name.
        f: {},
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

    const {
        configured, enabled, budget, plan, runs, postings, scheduleEnabled, scheduleCron,
        boards = [],
    } = data;

    // Every collectable board, including ones that have yielded nothing — a
    // board at 0 is information, the same way the SerpApi list shows it.
    const boardCount = Object.fromEntries(boards.filter((b) => b.board).map((b) => [b.board, b.postings]));
    const unrecorded = boards.find((b) => !b.board)?.postings ?? 0;
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
        if (form.employmentTypes.length) body.employmentTypes = form.employmentTypes;
        if (form.remoteOnly) body.remote = true;
        if (form.sources.length) body.sources = form.sources;
        if (form.maxAgeDays) body.maxAgeDays = Number(form.maxAgeDays);
        if (form.limit) body.limit = Number(form.limit);

        // Everything else, under JobsPipe's own names. Blank fields are left
        // out entirely — only a filter somebody chose may narrow the page.
        const filters = {};
        for (const k of LIST_KEYS) {
            const values = (form.f[k] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
            if (values.length) {
                filters[k] = UPPERCASE_LIST_KEYS.includes(k) ? values.map((v) => v.toUpperCase()) : values;
            }
        }
        for (const k of NUMBER_KEYS) {
            if (form.f[k] !== undefined && form.f[k] !== '') filters[k] = Number(form.f[k]);
        }
        for (const k of CHIP_KEYS) {
            if (form.f[k]?.length) filters[k] = form.f[k];
        }
        for (const k of BOOL_KEYS) {
            if (form.f[k]) filters[k] = true;
        }
        if (form.f.posted_at_gte) filters.posted_at_gte = form.f.posted_at_gte;
        if (form.f.posted_at_lte) filters.posted_at_lte = form.f.posted_at_lte;
        // The API wants "YYYY-MM-DD HH:MM:SS"; a datetime input gives "YYYY-MM-DDTHH:MM".
        if (form.f.discovered_at_gte) {
            filters.discovered_at_gte = `${form.f.discovered_at_gte.replace('T', ' ')}:00`;
        }
        if (form.f.status) filters.status = form.f.status;
        if (form.excludeSources.length) filters.source_not = form.excludeSources;
        if (Object.keys(filters).length) body.filters = filters;

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

    /* ── Advanced field renderers ────────────────────────────────────── */
    // Plain functions rather than components, so typing never remounts an
    // input and loses focus.
    const setF = (key, value) => setForm((s) => ({ ...s, f: { ...s.f, [key]: value } }));

    const textField = (key, label, placeholder, hint) => (
        <div key={key}>
            <label className={fieldLabel} htmlFor={`jp-${key}`}>{label}</label>
            <input
                id={`jp-${key}`}
                className={input}
                placeholder={placeholder}
                value={form.f[key] ?? ''}
                onChange={(e) => setF(key, e.target.value)}
            />
            {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
        </div>
    );

    const numberField = (key, label, { min = 0, max, hint } = {}) => (
        <div key={key}>
            <label className={fieldLabel} htmlFor={`jp-${key}`}>{label}</label>
            <input
                id={`jp-${key}`}
                type="number"
                min={min}
                max={max}
                className={input}
                value={form.f[key] ?? ''}
                onChange={(e) => setF(key, e.target.value)}
            />
            {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
        </div>
    );

    const chipField = (key, label, options, wide = false) => (
        <div key={key} className={wide ? 'sm:col-span-2 lg:col-span-3' : ''}>
            <p className={fieldLabel}>{label}</p>
            <Chips
                options={options}
                value={form.f[key] ?? []}
                onToggle={(v) => setF(key, toggleIn(form.f[key] ?? [], v))}
            />
        </div>
    );

    const checkField = (key, label) => (
        <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
            <input
                type="checkbox"
                className={checkbox}
                checked={Boolean(form.f[key])}
                onChange={(e) => setF(key, e.target.checked)}
            />
            {label}
        </label>
    );

    return (
        <>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
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
                            day or two and runs them through the same de-duplication and
                            matcher as a Google Jobs run — nothing here changes the provider
                            above.
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
                                These ten are everything JobsPipe indexes. Glassdoor, iCIMS,
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

                        <div className="mt-4">
                            <p className={fieldLabel}>Exclude boards</p>
                            <p className="text-xs text-slate-500">
                                Never pull from these, whatever is ticked above.
                            </p>
                            <Chips
                                options={ALL_SOURCES}
                                value={form.excludeSources}
                                onToggle={(v) => setForm((s) => ({ ...s, excludeSources: toggleIn(s.excludeSources, v) }))}
                            />
                        </div>

                        {/* ── every other JobsPipe filter, grouped ───────── */}
                        <FilterSection title="Role" hint="type, seniority, keywords, skills">
                            <div className="sm:col-span-2 lg:col-span-3">
                                <p className={fieldLabel}>Employment type</p>
                                <Chips
                                    options={EMPLOYMENT_TYPES}
                                    value={form.employmentTypes}
                                    onToggle={(v) => setForm((s) => ({ ...s, employmentTypes: toggleIn(s.employmentTypes, v) }))}
                                />
                            </div>
                            {chipField('job_seniority_or', 'Seniority', SENIORITY, true)}
                            {textField('job_title_not', 'Exclude title words', 'intern, unpaid')}
                            {textField('description_or', 'Description includes any', 'react, typescript')}
                            {textField('description_not', 'Description excludes', 'clearance, relocation')}
                            {textField('skills_or', 'Skills', 'python, kubernetes', 'JobsPipe skill slugs')}
                            {checkField('include_unlabeled_employment_type', 'Keep jobs with no employment type')}
                            {checkField('include_unlabeled_seniority', 'Keep jobs with no seniority')}
                        </FilterSection>

                        <FilterSection title="Location" hint="cities, states, metros, work arrangement">
                            {chipField('work_arrangement_or', 'Work arrangement', WORK_ARRANGEMENTS, true)}
                            {textField('job_location_or', 'Cities / regions', 'Austin, Dallas')}
                            {textField('region_or', 'US states / CA provinces', 'US-TX, US-NY', 'ISO 3166-2 codes')}
                            {textField('metro_code_or', 'US metro codes', '19100, 12420', 'CBSA codes')}
                            {textField('job_country_code_not', 'Exclude countries', 'IN, GB')}
                        </FilterSection>

                        <FilterSection title="Company" hint="names, size, employer type">
                            {textField('company_name_or', 'Company is exactly', 'Stripe, Datadog')}
                            {textField('company_name_partial_match_or', 'Company name contains', 'bank, health')}
                            {numberField('min_employee_count', 'Min employees')}
                            {numberField('max_employee_count', 'Max employees')}
                            {chipField('employer_type_or', 'Only employer types', EMPLOYER_TYPES)}
                            {chipField('employer_type_not', 'Exclude employer types', EMPLOYER_TYPES)}
                        </FilterSection>

                        <FilterSection title="Pay, visa & benefits">
                            {numberField('min_salary_usd', 'Min annual salary (USD)', { hint: 'Annual, in USD' })}
                            {chipField('visa_sponsorship_or', 'Visa sponsorship', VISA, true)}
                            {chipField('benefits_or', 'Benefits', BENEFITS, true)}
                        </FilterSection>

                        <FilterSection title="Dates & quality" hint="posted range, status, applicants, ghost jobs">
                            <div>
                                <label className={fieldLabel} htmlFor="jp-posted-gte">Posted on or after</label>
                                <input
                                    id="jp-posted-gte"
                                    type="date"
                                    className={input}
                                    value={form.f.posted_at_gte ?? ''}
                                    onChange={(e) => setF('posted_at_gte', e.target.value)}
                                />
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="jp-posted-lte">Posted on or before</label>
                                <input
                                    id="jp-posted-lte"
                                    type="date"
                                    className={input}
                                    value={form.f.posted_at_lte ?? ''}
                                    onChange={(e) => setF('posted_at_lte', e.target.value)}
                                />
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="jp-discovered">Discovered since</label>
                                <input
                                    id="jp-discovered"
                                    type="datetime-local"
                                    className={input}
                                    value={form.f.discovered_at_gte ?? ''}
                                    onChange={(e) => setF('discovered_at_gte', e.target.value)}
                                />
                                <p className="mt-1 text-xs text-slate-500">Only jobs JobsPipe first saw after this.</p>
                            </div>
                            <div>
                                <label className={fieldLabel} htmlFor="jp-status">Status</label>
                                <select
                                    id="jp-status"
                                    className={input}
                                    value={form.f.status ?? ''}
                                    onChange={(e) => setF('status', e.target.value)}
                                >
                                    <option value="">Default (active)</option>
                                    <option value="active">Active</option>
                                    <option value="closed">Closed</option>
                                    <option value="any">Any</option>
                                </select>
                            </div>
                            {numberField('last_verified_max_age_days', 'Verified within (days)', { min: 1, max: 365 })}
                            {numberField('max_applicant_count', 'Max applicants')}
                            {numberField('max_ghost_score', 'Max ghost score', { max: 100, hint: '0–100; lower = less likely a fake listing' })}
                            {checkField('has_recruiter_email', 'Has a recruiter email')}
                        </FilterSection>

                        <FilterSection title="Classification codes" hint="ISCO, ISIC, ESCO">
                            {textField('occupation_code_or', 'Occupation (ISCO-08)', '2512, 2519', '1–4 digit codes')}
                            {textField('isic_division_or', 'Industry (ISIC division)', '62, 64', '2-digit codes')}
                            {textField('esco_skill_id_or', 'ESCO skill IDs', 'ESCO concept IDs')}
                        </FilterSection>

                        <FilterSection title="Missing values" hint="keep jobs where a field is unknown">
                            {chipField('include_unknown', 'Include jobs with unknown', UNKNOWN_FIELDS, true)}
                        </FilterSection>
                    </div>
                )}
            </div>

            {/* ── boards ───────────────────────────────────────────── */}
            <h3 className={`mt-8 ${sectionTitle}`}>Job boards</h3>
            <p className="mt-1 max-w-2xl text-xs text-slate-500">
                Where JobsPipe postings were actually listed. Tick boards under
                <strong> Advanced</strong> to pull from them only.
            </p>

            <div className={`mt-3 overflow-x-auto ${card}`}>
                <table className="w-full min-w-[36rem] text-sm">
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>Board</th>
                            <th className={tableHeadCell}>Type</th>
                            <th className={tableHeadCell}>Postings</th>
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {SOURCE_GROUPS.flatMap((group) => group.values.map((v) => (
                            <tr key={v} className={tableRow}>
                                <td className={`${tableCell} font-medium text-slate-900`}>{v}</td>
                                <td className={`${tableCell} text-xs text-slate-500`}>
                                    {group.label.split(' — ')[0]}
                                </td>
                                <td className={`${tableCell} tabular-nums`}>
                                    {boardCount[v] > 0
                                        ? <span className="text-slate-700">{boardCount[v]}</span>
                                        : <span className="text-slate-300">0</span>}
                                </td>
                            </tr>
                        )))}
                        {unrecorded > 0 && (
                            <tr className={tableRow}>
                                <td className={`${tableCell} text-slate-500`}>Board not recorded</td>
                                <td className={`${tableCell} text-xs text-slate-400`}>
                                    ingested before boards were stored
                                </td>
                                <td className={`${tableCell} tabular-nums text-slate-500`}>{unrecorded}</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* ── run history ──────────────────────────────────────── */}
            <h3 className={`mt-8 ${sectionTitle}`}>Recent JobsPipe polls</h3>
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
                            <th className={tableHeadCell}>Ready</th>
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
                            const isOpen = openRun === r.id;
                            const breakdown = Object.entries(r.board_breakdown ?? {})
                                .sort((a, b) => b[1].returned - a[1].returned);
                            let asked = [];
                            try { asked = JSON.parse(r.filters ?? '{}').source_or ?? []; } catch { asked = []; }
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
                                        {formatDateTime(r.started_at)}
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

                                {/* ── this run, board by board ─────────────── */}
                                {isOpen && (
                                    <tr className="bg-slate-50">
                                        <td colSpan={10} className="px-4 py-3">
                                            <p className="text-xs text-slate-500">
                                                Boards asked for:{' '}
                                                <strong className="text-slate-700">
                                                    {asked.length ? asked.join(', ') : 'all boards'}
                                                </strong>
                                            </p>
                                            {breakdown.length === 0 ? (
                                                <p className="mt-2 text-xs text-slate-400">
                                                    {r.jobs_returned > 0
                                                        ? 'No board breakdown — this poll ran before per-board counts were recorded.'
                                                        : 'This poll returned no jobs.'}
                                                </p>
                                            ) : (
                                                <table className="mt-2 w-full max-w-3xl text-xs">
                                                    <thead>
                                                        <tr className="text-left uppercase tracking-wide text-slate-400">
                                                            <th className="py-1 pr-4 font-medium">Board</th>
                                                            <th className="py-1 pr-4 font-medium">Returned</th>
                                                            <th className="py-1 pr-4 font-medium">New</th>
                                                            <th className="py-1 pr-4 font-medium">Already held</th>
                                                            <th className="py-1 pr-4 font-medium">Unusable</th>
                                                            <th className="py-1 pr-4 font-medium">Matched</th>
                                                            <th className="py-1 font-medium">Queued</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y divide-slate-200">
                                                        {breakdown.map(([board, c]) => (
                                                            <tr key={board} className="tabular-nums text-slate-700">
                                                                <td className="py-1.5 pr-4 font-medium text-slate-900">{board}</td>
                                                                <td className="py-1.5 pr-4">{c.returned}</td>
                                                                <td className="py-1.5 pr-4">{c.new}</td>
                                                                <td className="py-1.5 pr-4">{c.duplicates}</td>
                                                                <td className="py-1.5 pr-4">{c.unusable}</td>
                                                                <td className="py-1.5 pr-4">{c.matched}</td>
                                                                <td className="py-1.5">{c.queued}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
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
                        matched against every active consultant, and queued — each match
                        goes to that consultant's Ready list (resumes are tailored later, per
                        job, when someone chooses).
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
