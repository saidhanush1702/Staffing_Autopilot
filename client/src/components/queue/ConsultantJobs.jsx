import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Briefcase, MapPin, Clock, ExternalLink, ChevronDown, ChevronRight,
    Sparkles, ShieldCheck, ShieldAlert, Send, Ban, Inbox, AlertCircle,
    Gauge, UserSearch, Search, Settings2, MessageSquareQuote, Layers, FileText, Loader2, CheckCircle2,
} from 'lucide-react';
import api, { errorMessage, API_ROOT } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import TailoringBadge, { SKIP_REASONS } from './TailoringBadge.jsx';
import QueueItemDrawer from './QueueItemDrawer.jsx';
import ContactPanel from '../contacts/ContactPanel.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, btn, btnSm, chip, eyebrow, searchInput, searchIcon, checkbox,
    sectionTitle, alertShell, alertShellSm, TONE, TONE_ALERT, dividerList,
} from '../../design/tokens.js';
import { formatDate, formatDateTime } from '../../utils/datetime.js';

/**
 * ── ONE CONSULTANT, EVERY JOB, THE WHOLE STORY ────────────────────────
 *
 * How many jobs are mapped to this person, what stage each one is at, and
 * everything the system did with it: whether the resume was tailored, what the
 * ATS score did, whether it was actually submitted and by what, and who we
 * found to follow up with.
 *
 * ── WHY ONE LIST AND NOT TWO ──────────────────────────────────────────
 *
 * A job used to be split in half at the moment it was submitted — a queue item
 * before, an application record after — and the two lived on separate screens
 * with no columns in common. Answering "what happened to that Northwind job?"
 * meant opening both and matching rows by company name. The split is real in
 * the database and should be; it is not real to the person asking.
 *
 * ── WHY THE STAGE AND THE QUEUE STATUS ARE BOTH SHOWN ─────────────────
 *
 * They can disagree, and when they do that is the interesting part. A job can
 * be submitted and then have its queue item cancelled — the stage stays
 * SUBMITTED, because an application really was sent to a real employer and no
 * later edit un-sends it, while the queue status still reads "Cancelled". Real
 * data has three such jobs. Showing only one of the two would either hide a
 * sent application or claim a cancelled job is still in flight.
 *
 * ── WHY THE SAME COMPONENT SERVES ALL THREE ROLES ─────────────────────
 *
 * It is the same question whoever asks it. `scope` chooses the endpoint; the
 * server decides whose jobs come back. The only thing that varies on screen is
 * the management-only action drawer, because a consultant may look at their own
 * pipeline but not re-queue themselves.
 */

/** The stages, in the order a job travels through them. */
const STAGES = [
    { key: 'ALL', label: 'All jobs', tone: 'neutral', icon: Briefcase },
    { key: 'MATCHED', label: 'Matched', tone: 'neutral', icon: Layers },
    { key: 'PREPARING', label: 'Preparing', tone: 'info', icon: Sparkles },
    { key: 'REVIEW', label: 'Needs review', tone: 'warning', icon: ShieldAlert },
    { key: 'IN_PROGRESS', label: 'In progress', tone: 'brand', icon: Clock },
    { key: 'SUBMITTED', label: 'Submitted', tone: 'success', icon: Send },
    { key: 'CLOSED', label: 'Closed', tone: 'neutral', icon: Ban },
];

const STAGE_TONE = Object.fromEntries(STAGES.map((s) => [s.key, s.tone]));
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));

const payText = (job) => {
    if (job.pay_min == null && job.pay_max == null) return null;
    const unit = job.pay_unit === 'HOURLY' ? '/hr' : '/yr';
    const n = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (job.pay_min != null && job.pay_max != null) return `$${n(job.pay_min)}–${n(job.pay_max)}${unit}`;
    return `$${n(job.pay_min ?? job.pay_max)}${unit}`;
};

const when = (iso) => (iso ? formatDate(iso) : null);
const whenExact = (iso) => (iso ? formatDateTime(iso) : null);

/* ── the expanded detail ───────────────────────────────────────────── */

const Fact = ({ label, children }) => (
    <div className="min-w-0">
        <p className={eyebrow}>{label}</p>
        <p className="mt-0.5 text-sm text-slate-700">{children ?? '—'}</p>
    </div>
);

/**
 * The journey, as timestamps.
 *
 * Only the steps that actually happened are rendered. A placeholder for every
 * stage would make a job that was skipped at once look like one stuck halfway.
 */
const Timeline = ({ job }) => {
    const steps = [
        ['Matched', job.queued_at],
        ['Prepared', job.prepared_at],
        ['Ready to apply', job.became_ready_at],
        ['Submitted', job.submitted_at],
    ].filter(([, at]) => at);

    if (steps.length === 0) return null;

    return (
        <ol className="mt-1 space-y-1.5">
            {steps.map(([label, at]) => (
                <li key={label} className="flex items-center gap-2 text-xs">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    <span className="text-slate-700">{label}</span>
                    <span className="text-slate-400">{whenExact(at)}</span>
                </li>
            ))}
        </ol>
    );
};

const JobDetail = ({ job, scope, onManage }) => {
    const gain = (job.ats_score_before != null && job.ats_score_after != null)
        ? job.ats_score_after - job.ats_score_before
        : null;

    // Contacts hang off the POSTING, but the route that reaches them differs by
    // role: management asks through the queue item, a consultant through their
    // own application. A consultant looking at a job they have not applied to
    // yet therefore has no contacts route — and no contact to see either, since
    // discovery runs after submission.
    const contactEndpoint = scope === 'portal'
        ? (job.application_id ? `/portal/applications/${job.application_id}/contacts` : null)
        : (job.queue_item_id ? `/management/queue/${job.queue_item_id}/contacts` : null);

    return (
        <div className="border-t border-line-soft bg-surface-sunken px-5 py-4">
            <div className="grid gap-5 lg:grid-cols-3">
                {/* ── the journey ─────────────────────────────── */}
                <div>
                    <h5 className={sectionTitle}>Journey</h5>
                    <Timeline job={job} />

                    {job.match_reason && (
                        <p className="mt-3 rounded-lg bg-surface p-2 text-xs text-slate-600">
                            <strong>Matched because:</strong> {job.match_reason}
                        </p>
                    )}
                    {job.park_reason && (
                        <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.warning}`}>
                            Parked: {job.park_reason}
                        </p>
                    )}
                    {job.skip_reason && (
                        <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.neutral}`}>
                            Skipped: {job.skip_reason}
                        </p>
                    )}
                    {job.cancel_reason && (
                        <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.neutral}`}>
                            Cancelled: {job.cancel_reason}
                        </p>
                    )}
                    {job.preparation_error && (
                        <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.danger}`}>
                            Preparation error: {job.preparation_error}
                        </p>
                    )}
                </div>

                {/* ── the resume ──────────────────────────────── */}
                <div>
                    <h5 className={`${sectionTitle} flex items-center gap-2`}>
                        <Sparkles className="h-4 w-4 text-slate-400" /> Resume
                    </h5>

                    <div className="mt-2 space-y-3">
                        <TailoringBadge
                            state={job.tailoring_state}
                            reason={job.tailoring_skip_reason}
                            status={job.status_name}
                        />

                        {job.tailoring_state === 'NOT_TAILORED' && (
                            <p className="text-xs text-slate-500">
                                This job went out with the consultant&rsquo;s base resume
                                {SKIP_REASONS[job.tailoring_skip_reason]
                                    ? ` because ${SKIP_REASONS[job.tailoring_skip_reason]}`
                                    : ''}.
                            </p>
                        )}

                        {job.ats_score_before != null || job.ats_score_after != null ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`${badge} ${TONE.neutral}`}>
                                    <Gauge className="h-3 w-3" /> ATS {job.ats_score_before ?? '—'}
                                    {' → '}{job.ats_score_after ?? '—'}
                                </span>
                                {gain != null && (
                                    <span className={`${badge} ${gain >= 0 ? TONE.success : TONE.warning}`}>
                                        {gain >= 0 ? '+' : ''}{gain} keyword coverage
                                    </span>
                                )}
                            </div>
                        ) : (
                            <p className="text-xs text-slate-400">
                                No ATS score — the resume was not tailored for this job.
                            </p>
                        )}

                        {job.tailored_model && (
                            <Fact label="Written by">
                                {job.tailored_model}
                                {job.tailored_at ? ` · ${when(job.tailored_at)}` : ''}
                            </Fact>
                        )}

                        {job.flag_count > 0 && (
                            <p className={`${alertShellSm} ${TONE_ALERT.warning}`}>
                                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                                <span>
                                    {job.flag_count} claim{job.flag_count === 1 ? '' : 's'} flagged
                                    by the fabrication check.
                                </span>
                            </p>
                        )}
                    </div>
                </div>

                {/* ── the submission ──────────────────────────── */}
                <div>
                    <h5 className={`${sectionTitle} flex items-center gap-2`}>
                        <Send className="h-4 w-4 text-slate-400" /> Submission
                    </h5>

                    {job.application_id ? (
                        <div className="mt-2 space-y-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className={`${badge} ${TONE.success}`}>
                                    {job.application_status_label ?? 'Submitted'}
                                </span>
                                {/*
                                    A witnessed record was observed by software
                                    from filling to submission. A self-reported
                                    one is somebody's account of something this
                                    system never saw. Rendering them the same
                                    would claim more than the data supports.
                                */}
                                <span
                                    className={`${badge} ${job.is_witnessed ? TONE.info : TONE.neutral}`}
                                    title={job.is_witnessed
                                        ? 'Software observed this submission'
                                        : 'Reported by a person — not observed by the system'}
                                >
                                    {job.is_witnessed && <ShieldCheck className="h-3 w-3" />}
                                    {job.submitted_via_label}
                                </span>
                            </div>

                            <Fact label="Sent">{whenExact(job.submitted_at)}</Fact>
                            {job.machine_label && <Fact label="From">{job.machine_label}</Fact>}
                            {job.recorded_by_name && (
                                <Fact label="Recorded by">{job.recorded_by_name}</Fact>
                            )}
                            <p className="flex items-center gap-1.5 text-xs text-slate-500">
                                <MessageSquareQuote className="h-3.5 w-3.5" />
                                {job.answer_count} form answer{job.answer_count === 1 ? '' : 's'} kept
                            </p>
                        </div>
                    ) : (
                        <p className="mt-2 text-xs text-slate-500">
                            Not submitted yet.
                            {job.status_label ? ` Currently: ${job.status_label.toLowerCase()}.` : ''}
                        </p>
                    )}
                </div>
            </div>

            {/* ── who to follow up with ───────────────────────── */}
            {contactEndpoint && (
                <div className="mt-5 border-t border-line-soft pt-4">
                    <ContactPanel endpoint={contactEndpoint} title="Hiring contacts" />
                </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2 border-t border-line-soft pt-3">
                {job.source_url && (
                    <a href={job.source_url} target="_blank" rel="noreferrer" className={btnSm.subtle}>
                        <ExternalLink className="h-3.5 w-3.5" /> The job advert
                    </a>
                )}
                {/*
                    The actual file. `/api/resumes/:id/download` already scopes
                    itself — a consultant reaches their own artifacts and nobody
                    else's — so the same link works for all three roles, and
                    every open of it is audited.
                */}
                {job.tailored_artifact_id && (
                    <a
                        href={`${API_ROOT}/api/resumes/${job.tailored_artifact_id}/download?disposition=inline`}
                        target="_blank"
                        rel="noreferrer"
                        className={btnSm.subtle}
                    >
                        <FileText className="h-3.5 w-3.5" /> The tailored resume
                    </a>
                )}
                {scope !== 'portal' && job.queue_item_id && (
                    <button type="button" className={btnSm.subtle} onClick={() => onManage(job.queue_item_id)}>
                        <Settings2 className="h-3.5 w-3.5" /> Manage this job
                    </button>
                )}
            </div>
        </div>
    );
};

/* ── the screen ────────────────────────────────────────────────────── */

const ConsultantJobs = ({ consultantId = null, scope = 'management' }) => {
    const { user } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [stage, setStage] = useState('ALL');
    const [q, setQ] = useState('');
    const [openRow, setOpenRow] = useState(null);
    const [manageId, setManageId] = useState(null);
    const [selected, setSelected] = useState(() => new Set());
    const [tailoring, setTailoring] = useState(false);
    const [notice, setNotice] = useState(null);     // { tone, text }

    const endpoint = scope === 'portal'
        ? '/portal/jobs'
        : `/management/consultants/${consultantId}/jobs`;

    const load = useCallback(async () => {
        try {
            setError('');
            const { data: body } = await api.get(endpoint);
            setData(body);
        } catch (err) {
            setError(errorMessage(err, 'Could not load jobs.'));
            setData({ jobs: [], summary: { total: 0, byStage: {} } });
        }
    }, [endpoint]);

    useEffect(() => { load(); }, [load]);

    // A job being tailored comes back to Ready by itself a minute or so later;
    // checking while any is in flight means the person watching sees it happen
    // instead of having to reload.
    const anyPreparing = Boolean(data?.jobs?.some((j) => j.status_name === 'PREPARING'));
    useEffect(() => {
        if (!anyPreparing) return undefined;
        const id = setInterval(load, 8000);
        return () => clearInterval(id);
    }, [anyPreparing, load]);

    // Only a job that is Ready, has a queue item behind it and has not been
    // tailored can be selected. Anything the desktop app has taken, or that is
    // already tailored or being tailored, is not offered.
    const canTailor = (j) => Boolean(j.queue_item_id)
        && j.status_name === 'READY'
        && j.tailoring_state !== 'TAILORED';

    const toggle = (id) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const tailorEndpoint = scope === 'portal' ? '/portal/jobs/tailor' : '/management/jobs/tailor';

    const requestTailoring = async () => {
        setTailoring(true);
        setNotice(null);
        try {
            const { data: res } = await api.post(tailorEndpoint, { queueItemIds: [...selected] });
            const skipped = res.skipped ?? [];
            setNotice({
                tone: res.requested > 0 ? 'success' : 'warning',
                text: (res.requested > 0
                    ? `Tailoring ${res.requested} resume${res.requested === 1 ? '' : 's'}. `
                        + 'Each job returns to Ready with its tailored resume when it is done. '
                    : 'Nothing was tailored. ')
                    + skipped.map((s) => `${s.label ?? 'A job'}: ${s.reason}`).join(' '),
            });
            setSelected(new Set());
            await load();
        } catch (err) {
            setNotice({ tone: 'danger', text: errorMessage(err, 'Could not start tailoring.') });
        } finally {
            setTailoring(false);
        }
    };

    const visible = useMemo(() => {
        if (!data) return [];
        const needle = q.trim().toLowerCase();
        return data.jobs.filter((j) => {
            if (stage !== 'ALL' && j.stage !== stage) return false;
            if (!needle) return true;
            return `${j.company} ${j.title}`.toLowerCase().includes(needle);
        });
    }, [data, stage, q]);

    if (!data) return <PageLoader />;

    const { summary } = data;

    const eligible = visible.filter(canTailor);
    const allTicked = eligible.length > 0 && eligible.every((j) => selected.has(j.queue_item_id));
    const isAdmin = user?.role === 'ORG_ADMIN';

    return (
        <div>
            {error && (
                <div className={`mb-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {/* ── the shape of the pipeline ───────────────────── */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className={`${card} ${cardPad}`}>
                    <p className={eyebrow}>Jobs mapped</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900">
                        {summary.total}
                    </p>
                </div>
                <div className={`${card} ${cardPad}`}>
                    <p className={eyebrow}>Submitted</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900">
                        {summary.submitted ?? 0}
                    </p>
                </div>
                <div className={`${card} ${cardPad}`}>
                    <p className={eyebrow}>Tailored</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900">
                        {summary.tailored ?? 0}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                        {summary.avgAtsGain != null
                            ? `${summary.avgAtsGain >= 0 ? '+' : ''}${summary.avgAtsGain} ATS on average`
                            : `${summary.notTailored ?? 0} went out untailored`}
                    </p>
                </div>
                <div className={`${card} ${cardPad}`}>
                    <p className={eyebrow}>With a contact</p>
                    <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900">
                        {summary.withContacts ?? 0}
                    </p>
                </div>
            </div>

            {/* ── stage filter ────────────────────────────────── */}
            <div className="mt-5 flex flex-wrap gap-2">
                {STAGES.map((s) => {
                    const n = s.key === 'ALL' ? summary.total : (summary.byStage[s.key] ?? 0);
                    if (s.key !== 'ALL' && n === 0) return null;
                    const active = stage === s.key;
                    return (
                        <button
                            key={s.key}
                            type="button"
                            onClick={() => setStage(s.key)}
                            className={`${chip} ${active
                                ? 'border-brand-500 bg-brand-50 text-brand-700'
                                : 'text-slate-600 hover:border-line-strong'}`}
                        >
                            <s.icon className="h-3.5 w-3.5" />
                            {s.label}
                            <span className="tabular-nums text-slate-400">{n}</span>
                        </button>
                    );
                })}
            </div>

            <div className="relative mt-4">
                <Search className={searchIcon} />
                <input
                    className={searchInput}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Filter by company or job title…"
                />
            </div>

            {/* ── choosing which resumes to tailor ────────────── */}
            {notice && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT[notice.tone]}`}>
                    {notice.tone === 'success'
                        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                    <span>{notice.text}</span>
                </div>
            )}
            {data.jobs.some(canTailor) && (
                <div className={`mt-4 ${card} ${cardPad} flex flex-wrap items-center justify-between gap-3`}>
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800">Tailor a resume for the jobs you choose</p>
                        <p className="text-xs text-slate-500">
                            Jobs are ready with the base resume. Tick the ones worth a tailored resume; only
                            those are tailored, and each returns to Ready when done.
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-xs text-slate-600">
                            <input
                                type="checkbox"
                                className={checkbox}
                                checked={allTicked}
                                disabled={eligible.length === 0}
                                onChange={() => setSelected(allTicked
                                    ? new Set()
                                    : new Set(eligible.map((j) => j.queue_item_id)))}
                            />
                            Select all shown ({eligible.length})
                        </label>
                        <button
                            type="button"
                            className={btn.primary}
                            disabled={tailoring || selected.size === 0}
                            onClick={requestTailoring}
                        >
                            {tailoring
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Sparkles className="h-4 w-4" />}
                            Tailor {selected.size > 0 ? selected.size : ''} selected
                        </button>
                    </div>
                </div>
            )}

            {/* ── the jobs ────────────────────────────────────── */}
            {visible.length === 0 ? (
                <div className={`mt-5 ${card} ${cardPad} text-center`}>
                    <Inbox className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-600">
                        {summary.total === 0
                            ? 'No jobs are mapped to this consultant yet.'
                            : 'No jobs match that filter.'}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                        {summary.total === 0
                            ? 'Discovery adds jobs here when they match the search criteria.'
                            : 'Try a different stage, or clear the search.'}
                    </p>
                </div>
            ) : (
                <div className={`mt-5 ${card} ${dividerList} overflow-hidden`}>
                    {visible.map((job) => {
                        const key = job.queue_item_id ?? `app-${job.application_id}`;
                        const isOpen = openRow === key;
                        return (
                            <div key={key}>
                              <div className="flex items-start">
                                {data.jobs.some(canTailor) && (
                                    <div className="flex w-12 shrink-0 justify-center pt-4">
                                        {canTailor(job) && (
                                            <input
                                                type="checkbox"
                                                className={checkbox}
                                                checked={selected.has(job.queue_item_id)}
                                                onChange={() => toggle(job.queue_item_id)}
                                                aria-label={`Tailor a resume for ${job.title} at ${job.company}`}
                                            />
                                        )}
                                    </div>
                                )}
                                <button
                                    type="button"
                                    onClick={() => setOpenRow(isOpen ? null : key)}
                                    aria-expanded={isOpen}
                                    className={`flex w-full min-w-0 flex-1 items-start gap-3 py-4 pr-5 text-left
                                               transition-colors hover:bg-surface-sunken
                                               ${data.jobs.some(canTailor) ? 'pl-1' : 'pl-5'}`}
                                >
                                    {isOpen
                                        ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                                        : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}

                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-slate-900">{job.title}</p>
                                                <p className="text-xs text-slate-500">{job.company}</p>
                                            </div>

                                            <span className="flex flex-wrap items-center gap-1.5">
                                                <span className={`${badge} ${TONE[STAGE_TONE[job.stage]]}`}>
                                                    {STAGE_LABEL[job.stage]}
                                                </span>
                                                {/*
                                                    Shown only when it says something the
                                                    stage does not — a job submitted and
                                                    later cancelled, most importantly.
                                                */}
                                                {job.status_label
                                                    && job.status_name !== 'SUBMITTED'
                                                    && job.stage === 'SUBMITTED' && (
                                                    <span
                                                        className={`${badge} ${TONE.neutral}`}
                                                        title="The queue item moved on after the application was sent"
                                                    >
                                                        queue: {job.status_label}
                                                    </span>
                                                )}
                                                <TailoringBadge
                                                    state={job.tailoring_state}
                                                    reason={job.tailoring_skip_reason}
                                                    status={job.status_name}
                                                />
                                                {/* What tailoring this resume cost. Org admin
                                                    only: the server does not send the field to
                                                    anybody else, and this checks the role too. */}
                                                {isAdmin && job.tailoring_cost_usd != null && (
                                                    <span
                                                        className="text-2xs tabular-nums text-slate-400"
                                                        title="What the AI calls for this resume cost. Only you can see this."
                                                    >
                                                        {job.tailoring_cost_unknown
                                                            ? `≥ $${job.tailoring_cost_usd.toFixed(4)} (part unpriced)`
                                                            : `$${job.tailoring_cost_usd.toFixed(4)}`}
                                                    </span>
                                                )}
                                                {job.score != null && (
                                                    <span className={`${badge} ${
                                                        job.score >= 70 ? TONE.success : TONE.warning}`}>
                                                        score {job.score}
                                                    </span>
                                                )}
                                                {job.contact_count > 0 && (
                                                    <span className={`${badge} ${TONE.info}`}>
                                                        <UserSearch className="h-3 w-3" /> {job.contact_count}
                                                    </span>
                                                )}
                                            </span>
                                        </div>

                                        <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                                            <span className="flex items-center gap-1">
                                                <MapPin className="h-3.5 w-3.5" />
                                                {job.is_remote ? 'Remote' : (job.location_text ?? '—')}
                                            </span>
                                            {payText(job) && <span>{payText(job)}</span>}
                                            {job.source_label && <span>via {job.source_label}</span>}
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3.5 w-3.5" />
                                                {job.submitted_at
                                                    ? `sent ${when(job.submitted_at)}`
                                                    : `matched ${when(job.queued_at)}`}
                                            </span>
                                        </p>
                                    </div>
                                </button>
                              </div>

                                {isOpen && (
                                    <JobDetail job={job} scope={scope} onManage={setManageId} />
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {manageId && (
                <QueueItemDrawer
                    itemId={manageId}
                    // The drawer decides which buttons to offer from these, and
                    // the server refuses the move regardless — a recruiter
                    // cannot cancel a queue, so the button is not shown either.
                    canEdit={['ORG_ADMIN', 'RECRUITER'].includes(user?.role)}
                    isAdmin={user?.role === 'ORG_ADMIN'}
                    onClose={() => setManageId(null)}
                    onChanged={async () => { setManageId(null); await load(); }}
                />
            )}
        </div>
    );
};

export default ConsultantJobs;
