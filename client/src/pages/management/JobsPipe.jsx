import { useCallback, useEffect, useState } from 'react';
import {
    Webhook, Play, Loader2, AlertCircle, CheckCircle2, XCircle, Power,
    Clock, TriangleAlert, KeyRound, Copy, Check, RefreshCw, Eye, EyeOff,
    ChevronRight, Zap, Inbox,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TableShell from '../../components/TableShell.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, TONE, TONE_ALERT, TONE_TEXT,
    pageTitle, pageSubtitle, tableHead, tableHeadCell, tableBody, tableRow,
    tableCell, alertShell, codeChip,
} from '../../design/tokens.js';

/**
 * How each outcome should read at a glance.
 *
 * The important line here is that DUPLICATE and FILTERED are NEUTRAL, not
 * warnings. Most postings suit nobody on a given bench, and most feeds
 * redeliver. If those rows were painted amber, a healthy trial would look like
 * a failing one and somebody would "fix" a feed that was working — which is
 * exactly the wrong conclusion to make easy to reach.
 */
const OUTCOME = {
    QUEUED: { tone: 'success', label: 'Reached a queue', icon: CheckCircle2 },
    FILTERED: { tone: 'neutral', label: 'Suited nobody', icon: Inbox },
    DUPLICATE: { tone: 'neutral', label: 'Already had it', icon: Inbox },
    INVALID: { tone: 'warning', label: 'Unusable payload', icon: TriangleAlert },
    DISABLED: { tone: 'warning', label: 'Endpoint off', icon: Power },
    UNAUTHORISED: { tone: 'danger', label: 'Bad secret', icon: KeyRound },
    ERROR: { tone: 'danger', label: 'Failed', icon: XCircle },
};

/** A small copy-to-clipboard control, since three things on this page need one. */
const CopyButton = ({ value, label = 'Copy' }) => {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // Clipboard access is refused outside a secure context. The value is
            // on screen and selectable either way, so this is not worth an alert.
        }
    };

    return (
        <button type="button" onClick={copy} className={btnSm.secondary}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : label}
        </button>
    );
};

/**
 * JobsPipe — the real-time push feed, on trial.
 *
 * ── WHAT THIS SCREEN IS FOR ───────────────────────────────────────────
 *
 * The Job Discovery screen answers "is the scheduled cycle working". This one
 * answers a different question: "is the JobsPipe Free Tier worth paying for".
 *
 * That is a measurement, not a status light, so the screen leads with the
 * funnel — arrived, new, matched, queued — and with the delivery log
 * underneath it. A feed that delivers two hundred jobs a day of which none
 * suit the bench is WORKING and NOT WORTH BUYING, and no single health badge
 * can express that. Four numbers can.
 *
 * The raw payload of every delivery is one click away for the same reason: the
 * deliveries that teach you something during a trial are the ones that failed.
 */
const JobsPipe = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [data, setData] = useState(null);
    const [events, setEvents] = useState([]);
    const [error, setError] = useState('');
    const [banner, setBanner] = useState(null);
    const [busy, setBusy] = useState('');
    const [token, setToken] = useState(null);
    const [expanded, setExpanded] = useState(null);

    const load = useCallback(async () => {
        try {
            const [s, e] = await Promise.all([
                api.get('/management/jobspipe'),
                api.get('/management/jobspipe/events'),
            ]);
            setData(s.data);
            setEvents(e.data.events);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!data) return <PageLoader />;

    const { endpoint, webhookUrl, funnel } = data;

    /* ── the funnel, over the last 30 days ────────────────────────── */
    const total = funnel.reduce((n, r) => n + r.count, 0);
    const countOf = (...outcomes) => funnel
        .filter((r) => outcomes.includes(r.outcome))
        .reduce((n, r) => n + r.count, 0);
    const queuedJobs = funnel.reduce((n, r) => n + r.queued, 0);
    // Weighted by row count so a batch of 25 does not count the same as one
    // delivery when working out how long we typically take to answer.
    const avgMs = total === 0 ? 0 : Math.round(
        funnel.reduce((n, r) => n + (r.avg_ms * r.count), 0) / total,
    );

    const health = () => {
        if (!endpoint) return { tone: 'neutral', text: 'Not set up', icon: KeyRound };
        if (!endpoint.is_enabled) return { tone: 'neutral', text: 'Switched off', icon: Power };
        if (!endpoint.last_event_at) return { tone: 'info', text: 'Waiting for the first delivery', icon: Clock };
        if (endpoint.last_error) return { tone: 'warning', text: 'Last delivery had a problem', icon: TriangleAlert };
        return { tone: 'success', text: 'Receiving', icon: CheckCircle2 };
    };
    const status = health();

    /* ── actions ──────────────────────────────────────────────────── */

    const act = async (name, fn, done) => {
        setBusy(name);
        setBanner(null);
        try {
            const result = await fn();
            if (done) done(result);
            await load();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy('');
        }
    };

    const generate = () => act(
        'token',
        () => api.post('/management/jobspipe/token'),
        ({ data: d }) => {
            setToken(d.token);
            setBanner({
                tone: 'warning',
                text: 'A new secret is active. Every delivery using the old one is refused '
                    + 'from now on — paste this into JobsPipe before the next push.',
            });
        },
    );

    const reveal = () => act(
        'reveal',
        () => api.get('/management/jobspipe/token'),
        ({ data: d }) => setToken(d.token),
    );

    const toggle = () => act(
        'toggle',
        () => api.patch('/management/jobspipe', { isEnabled: !endpoint.is_enabled }),
    );

    const sendTest = () => act(
        'test',
        () => api.post('/management/jobspipe/test'),
        ({ data: d }) => {
            const r = d.result;
            const shape = OUTCOME[r.outcome];

            // Why a quiet result was quiet. Without this the three ways a test
            // can queue nothing — nobody on the bench, nobody who wants this
            // title, or a job we already hold — all print the same sentence,
            // and only one of them is a reason to change anything.
            let why = '';
            if (r.outcome === 'FILTERED' && r.benchSize === 0) {
                why = ' Nothing could match: no consultant on this bench is active, '
                    + 'unpaused and running active criteria.';
            } else if (r.outcome === 'FILTERED') {
                why = ` The posting was stored but suited none of the ${r.benchSize} `
                    + 'consultant(s) on the bench — the pre-filter working, not a failure.';
            } else if (r.outcome === 'DUPLICATE') {
                why = ' A posting with this company, title and location already existed, '
                    + 'so it was merged rather than duplicated (R-15).';
            }

            setBanner({
                tone: r.outcome === 'QUEUED' ? 'success' : 'info',
                text: `Test delivery${r.title ? ` — "${r.title}"` : ''}: `
                    + `${shape?.label ?? r.outcome} — `
                    + `${r.considered} consultant(s) considered, `
                    + `${r.prefilteredOut} dropped by the pre-filter, `
                    + `${r.matches} matched, ${r.queued} queued, `
                    + `${r.prepared} sent to AI preparation. ${r.durationMs}ms.${why}`,
            });
        },
    );

    return (
        <div>
            <h1 className={pageTitle}>JobsPipe — real-time feed</h1>
            <p className={pageSubtitle}>
                Jobs pushed to us the moment they are published, alongside the scheduled
                discovery cycle. Costs no search credits, and lands in the same pool
                through the same de-duplication and matching.
            </p>

            {banner && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT[banner.tone]}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{banner.text}</span>
                </div>
            )}

            {/* ── the funnel: what the trial is actually measuring ─── */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className={sectionTitle}>Last 30 days</h2>
                {isAdmin && (
                    <button
                        type="button"
                        onClick={sendTest}
                        disabled={busy !== ''}
                        className={btn.primary}
                    >
                        {busy === 'test'
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Play className="h-4 w-4" />}
                        Send test delivery
                    </button>
                )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {[
                    ['Deliveries', total, 'Every POST we answered, including refusals.'],
                    ['New postings', countOf('QUEUED', 'FILTERED'), 'Jobs the cycle had not already found.'],
                    ['Already known', countOf('DUPLICATE'), 'Collapsed onto an existing posting by R-15.'],
                    ['Reached a queue', queuedJobs, 'Queue items created for a consultant.'],
                    ['Typical response', `${avgMs}ms`, 'How long we take to answer a push.'],
                ].map(([label, value, hint]) => (
                    <div key={label} className={`${card} ${cardPad}`}>
                        <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
                        <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-slate-900">
                            {value}
                        </p>
                        <p className="mt-1 text-xs leading-snug text-slate-500">{hint}</p>
                    </div>
                ))}
            </div>

            <p className="mt-3 text-xs text-slate-500">
                {total === 0 && <>Nothing has arrived yet. </>}
                <strong>Send test delivery</strong> pushes a sample job through the whole
                path — adapter, de-duplication, pre-filter, matcher and AI preparation —
                without waiting on JobsPipe. The title is taken from what this bench
                actually asks for, so a real match is possible.
                {' '}
                It is a <em>real</em> delivery, not a mock: each press stores one synthetic
                posting and, when it matches, queues it and spends a model call on
                preparation. Synthetic postings are the ones whose company begins
                &ldquo;JobsPipe Test Employer&rdquo;.
            </p>

            {/* ── the endpoint ──────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>The endpoint</h2>

            <div className={`mt-3 ${card} ${cardPad}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-slate-900">JobsPipe push webhook</p>
                            <span className={`${badge} ${TONE[status.tone]}`}>
                                <status.icon className="h-3.5 w-3.5" /> {status.text}
                            </span>
                        </div>
                        <p className="mt-1 max-w-2xl text-xs text-slate-500">
                            JobsPipe posts each job here as it is published. Nothing is fetched,
                            so this path spends no search credits — the scheduled cycle is
                            untouched and still runs on its own interval.
                        </p>
                    </div>

                    {isAdmin && endpoint && (
                        <button
                            type="button"
                            onClick={toggle}
                            disabled={busy !== ''}
                            className={endpoint.is_enabled ? btnSm.caution : btnSm.success}
                        >
                            <Power className="h-3.5 w-3.5" />
                            {endpoint.is_enabled ? 'Turn off' : 'Turn on'}
                        </button>
                    )}
                </div>

                {/* the URL */}
                <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Webhook URL</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <code className={`${codeChip} break-all`}>POST {webhookUrl}</code>
                        <CopyButton value={webhookUrl} label="Copy URL" />
                    </div>
                    <p className="mt-1.5 text-xs text-slate-500">
                        Must be reachable from the internet for JobsPipe to deliver to it. On a
                        laptop, put a tunnel in front of it and give JobsPipe the tunnel&apos;s
                        address.
                    </p>
                </div>

                {/* the secret */}
                <div className="mt-4">
                    <p className="text-xs uppercase tracking-wide text-slate-400">Shared secret</p>

                    {!endpoint && (
                        <p className="mt-1.5 text-sm text-slate-600">
                            No secret has been issued yet.
                            {isAdmin
                                ? ' Generate one, paste it into JobsPipe, then turn the endpoint on.'
                                : ' An organisation admin needs to generate one.'}
                        </p>
                    )}

                    {token ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <code className={`${codeChip} break-all`}>{token}</code>
                            <CopyButton value={token} label="Copy secret" />
                            <button
                                type="button"
                                onClick={() => setToken(null)}
                                className={btnSm.subtle}
                            >
                                <EyeOff className="h-3.5 w-3.5" /> Hide
                            </button>
                        </div>
                    ) : (
                        endpoint && (
                            <p className="mt-1.5 text-sm text-slate-600">
                                Held encrypted. Reveal it when you need to paste it into JobsPipe —
                                every reveal is written to the audit log.
                            </p>
                        )
                    )}

                    {isAdmin && (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                            {endpoint?.can_reveal && !token && (
                                <button
                                    type="button"
                                    onClick={reveal}
                                    disabled={busy !== ''}
                                    className={btnSm.secondary}
                                >
                                    {busy === 'reveal'
                                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        : <Eye className="h-3.5 w-3.5" />}
                                    Reveal secret
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={generate}
                                disabled={busy !== ''}
                                className={endpoint ? btnSm.caution : btnSm.primary}
                            >
                                {busy === 'token'
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <RefreshCw className="h-3.5 w-3.5" />}
                                {endpoint ? 'Rotate secret' : 'Generate secret'}
                            </button>
                        </div>
                    )}

                    <p className="mt-2 text-xs text-slate-500">
                        Send it as
                        {' '}
                        <code className={codeChip}>X-JobsPipe-Token</code>
                        {' '}
                        or
                        {' '}
                        <code className={codeChip}>Authorization: Bearer …</code>.
                        It is the only thing that identifies which agency a pushed job belongs
                        to, so it is what stops another tenant&apos;s feed writing into this pool.
                    </p>
                </div>

                {/* health detail */}
                {endpoint && (
                    <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-line-soft pt-4">
                        <div>
                            <p className="text-xs uppercase tracking-wide text-slate-400">Last delivery</p>
                            <p className="text-sm text-slate-700">
                                {endpoint.last_event_at
                                    ? new Date(endpoint.last_event_at).toLocaleString()
                                    : '—'}
                            </p>
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-slate-400">Received</p>
                            <p className="text-sm tabular-nums text-slate-700">{endpoint.events_received}</p>
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-slate-400">Refused</p>
                            <p className={`text-sm tabular-nums ${endpoint.events_rejected > 0 ? TONE_TEXT.warning : 'text-slate-700'}`}>
                                {endpoint.events_rejected}
                            </p>
                        </div>
                        {endpoint.last_error && (
                            <div className="min-w-0 flex-1">
                                <p className="text-xs uppercase tracking-wide text-slate-400">Last error</p>
                                <p className="text-sm break-words text-danger-700">{endpoint.last_error}</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ── the delivery log ──────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>Deliveries</h2>
            <p className="mt-1 text-xs text-slate-500">
                Newest first. Click a row to read the payload exactly as it arrived —
                during a trial, the deliveries worth reading are the ones that failed.
            </p>

            <div className="mt-3">
                <TableShell minWidth={980}>
                    <thead className={tableHead}>
                        <tr>
                            <th className={tableHeadCell}>Received</th>
                            <th className={tableHeadCell}>Outcome</th>
                            <th className={tableHeadCell}>Job</th>
                            <th className={`${tableHeadCell} text-right`}>Considered</th>
                            <th className={`${tableHeadCell} text-right`}>Pre-filtered</th>
                            <th className={`${tableHeadCell} text-right`}>Matched</th>
                            <th className={`${tableHeadCell} text-right`}>Queued</th>
                            <th className={`${tableHeadCell} text-right`}>Prepared</th>
                            <th className={`${tableHeadCell} text-right`}>Time</th>
                            <th className={tableHeadCell} />
                        </tr>
                    </thead>
                    <tbody className={tableBody}>
                        {events.length === 0 && (
                            <tr>
                                <td colSpan={10} className="px-4 py-10 text-center text-sm text-slate-500">
                                    <Webhook className="mx-auto mb-2 h-6 w-6 text-slate-300" />
                                    No deliveries yet.
                                </td>
                            </tr>
                        )}

                        {events.map((e) => {
                            const shape = OUTCOME[e.outcome] ?? OUTCOME.ERROR;
                            const open = expanded === e.id;
                            return [
                                <tr
                                    key={e.id}
                                    className={`${tableRow} cursor-pointer`}
                                    onClick={() => setExpanded(open ? null : e.id)}
                                >
                                    <td className={`${tableCell} whitespace-nowrap`}>
                                        {new Date(e.received_at).toLocaleString()}
                                    </td>
                                    <td className={tableCell}>
                                        <span className={`${badge} ${TONE[shape.tone]}`}>
                                            <shape.icon className="h-3.5 w-3.5" /> {shape.label}
                                        </span>
                                    </td>
                                    <td className={tableCell}>
                                        {e.title
                                            ? (
                                                <>
                                                    <span className="font-medium text-slate-900">{e.title}</span>
                                                    <span className="block text-xs text-slate-500">
                                                        {e.company}
                                                        {e.location_text ? ` · ${e.location_text}` : ''}
                                                        {e.is_new_posting ? ' · new' : ''}
                                                    </span>
                                                </>
                                            )
                                            : <span className="text-slate-400">—</span>}
                                    </td>
                                    <td className={`${tableCell} text-right tabular-nums`}>{e.consultants_considered}</td>
                                    <td className={`${tableCell} text-right tabular-nums`}>{e.prefiltered_out}</td>
                                    <td className={`${tableCell} text-right tabular-nums`}>{e.matches_created}</td>
                                    <td className={`${tableCell} text-right tabular-nums`}>
                                        {e.queued_count > 0
                                            ? <span className="font-medium text-success-700">{e.queued_count}</span>
                                            : e.queued_count}
                                    </td>
                                    <td className={`${tableCell} text-right tabular-nums`}>
                                        {e.preparation_enqueued > 0
                                            ? (
                                                <span className={`inline-flex items-center gap-1 ${TONE_TEXT.brand}`}>
                                                    <Zap className="h-3.5 w-3.5" />
                                                    {e.preparation_enqueued}
                                                </span>
                                            )
                                            : e.preparation_enqueued}
                                    </td>
                                    <td className={`${tableCell} text-right tabular-nums`}>
                                        {e.duration_ms == null ? '—' : `${e.duration_ms}ms`}
                                    </td>
                                    <td className={tableCell}>
                                        <ChevronRight
                                            className={`h-4 w-4 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
                                        />
                                    </td>
                                </tr>,

                                open && (
                                    <tr key={`${e.id}-detail`}>
                                        <td colSpan={10} className="bg-surface-sunken px-4 py-4">
                                            {e.detail && (
                                                <p className="mb-3 text-xs text-slate-600">{e.detail}</p>
                                            )}
                                            <p className="text-xs uppercase tracking-wide text-slate-400">
                                                Raw payload
                                                {e.payload_bytes ? ` · ${e.payload_bytes} bytes` : ''}
                                                {e.delivery_id ? ` · ${e.delivery_id}` : ''}
                                            </p>
                                            <pre className="mt-1.5 max-h-80 overflow-auto rounded-lg border border-line bg-surface p-3 text-xs leading-relaxed text-slate-700">
                                                {e.raw_payload
                                                    ? (() => {
                                                        try {
                                                            return JSON.stringify(JSON.parse(e.raw_payload), null, 2);
                                                        } catch {
                                                            // Kept verbatim when it will not re-parse — a
                                                            // truncated or malformed body is exactly the
                                                            // one worth reading as it arrived.
                                                            return e.raw_payload;
                                                        }
                                                    })()
                                                    : 'Not kept for this row — only the first job of a batch keeps the body.'}
                                            </pre>
                                        </td>
                                    </tr>
                                ),
                            ];
                        })}
                    </tbody>
                </TableShell>
            </div>
        </div>
    );
};

export default JobsPipe;
