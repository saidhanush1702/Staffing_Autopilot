import { useCallback, useEffect, useState } from 'react';
import {
    ListChecks, ExternalLink, MapPin, Layers, Clock, Inbox,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import QueueItemDrawer from './QueueItemDrawer.jsx';
import TailoringBadge from './TailoringBadge.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { card, cardPad, badge, sectionTitle, inputBase, TONE, TONE_ALERT, cardInteractive, alertShellSm } from '../../design/tokens.js';
import { formatDate } from '../../utils/datetime.js';

/**
 * What the queue can be filtered to.
 *
 * ACTIONABLE is what the server returns when asked for nothing, and it is the
 * right default — it is the work someone can actually do something about. The
 * rest exist because the states it hides are exactly the ones a person goes
 * looking for when something has gone wrong.
 */
const STATUS_FILTERS = [
    { value: 'ACTIONABLE', label: 'Needs action' },
    { value: 'ALL', label: 'Everything' },
    { value: 'QUEUED', label: 'Waiting for a cap slot' },
    { value: 'READY', label: 'Ready' },
    { value: 'FILLING', label: 'Being filled' },
    { value: 'PARKED_UNKNOWN', label: 'Parked on a question' },
    { value: 'AWAITING_REVIEW', label: 'Awaiting review' },
    { value: 'SUBMITTED', label: 'Submitted' },
    { value: 'SKIPPED', label: 'Skipped' },
    { value: 'CANCELLED', label: 'Cancelled' },
];

const payText = (p) => {
    if (p.pay_min == null && p.pay_max == null) return null;
    const range = p.pay_min && p.pay_max && p.pay_min !== p.pay_max
        ? `${Number(p.pay_min).toLocaleString()}–${Number(p.pay_max).toLocaleString()}`
        : Number(p.pay_max ?? p.pay_min).toLocaleString();
    return `${range} / ${p.pay_unit === 'HOURLY' ? 'hr' : 'yr'}`;
};

/**
 * One consultant's job queue.
 *
 * Answers the question this phase exists for: *which jobs are useful for this
 * person, and why?* Every item shows its match score, the reason in words, and
 * the criteria version it was judged against — so "why was this sent to them?"
 * is answerable months later, which is what Phase 3's immutable versions were
 * for.
 *
 * The **Held** section matters as much as the queue itself. Without it, a cap
 * that stopped assignment at 5 looks identical to discovery finding only 5
 * jobs, and a recruiter has no idea there is work waiting.
 */
const ConsultantQueue = ({ consultantId }) => {
    const { user } = useAuth();
    const [openItem, setOpenItem] = useState(null);
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('ACTIONABLE');

    // Named rather than inline, so the drawer can refresh this list after a
    // move without the two disagreeing about what the queue currently is.
    const load = useCallback(async () => {
        try {
            // ACTIONABLE is the server's own default, so it sends no parameter.
            // Everything else is an explicit ask.
            // The server reads one parameter, `status`, and treats 'ALL' as a
            // value of it rather than as a separate flag.
            const params = filter === 'ACTIONABLE' ? {} : { status: filter };
            const { data: d } = await api.get(
                `/management/consultants/${consultantId}/queue`, { params },
            );
            setData(d);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [consultantId, filter]);

    useEffect(() => { load(); }, [load]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!data) return <PageLoader />;

    const { queue, awaitingCap: held } = data;

    return (
        <div className="space-y-6">
            {/* ── the queue ──────────────────────────────────────── */}
            <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <ListChecks className="h-4 w-4 text-slate-400" /> Queue ({queue.length})
                    </h2>

                    {/*
                      Without this the view showed only the four actionable
                      states, and a skipped job was simply gone — no way to see
                      why it failed, and no way to put it back. "It vanished" is
                      the worst thing a queue can tell somebody.
                    */}
                    <label className="flex items-center gap-2 text-xs text-slate-500">
                        Showing
                        <select
                            value={filter}
                            onChange={(e) => { setData(null); setFilter(e.target.value); }}
                            className={`${inputBase} w-auto py-1 text-xs`}
                        >
                            {STATUS_FILTERS.map((f) => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                            ))}
                        </select>
                    </label>
                </div>

                {queue.length === 0 && (
                    <div className={`mt-2 ${card} ${cardPad} text-center`}>
                        <Inbox className="mx-auto h-8 w-8 text-slate-300" />
                        <p className="mt-2 text-sm text-slate-500">
                            {filter === 'ACTIONABLE'
                                ? 'Nothing queued yet.'
                                : 'Nothing in this state.'}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                            {filter === 'ACTIONABLE'
                                ? "Discovery adds jobs here when they match this consultant's search criteria."
                                : 'Try a different state, or "Everything".'}
                        </p>
                    </div>
                )}

                <div className="mt-2 space-y-3">
                    {queue.map((item) => (
                        <div
                            key={item.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => setOpenItem(item.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setOpenItem(item.id); }}
                            className={`${cardInteractive} ${cardPad}`}
                        >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                                    <p className="text-xs text-slate-500">{item.company}</p>
                                </div>
                                <span className="flex flex-wrap items-center gap-1.5">
                                    <span className={`${badge} ${TONE.brand}`}>{item.status_label}</span>
                                    <TailoringBadge
                                        state={item.tailoring_state}
                                        reason={item.tailoring_skip_reason}
                                        status={item.status_name}
                                    />
                                    {item.score != null && (
                                        <span className={`${badge} ${item.score >= 70 ? TONE.success : TONE.warning}`}>
                                            score {item.score}
                                        </span>
                                    )}
                                    {/* R-01/R-03: expected and allowed, shown not blocked. */}
                                    {item.is_overlap && (
                                        <span
                                            className={`${badge} ${TONE.info}`}
                                            title="Also queued for another consultant — each applies under their own name"
                                        >
                                            <Layers className="h-3 w-3" /> Overlap
                                        </span>
                                    )}
                                </span>
                            </div>

                            <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                                <span className="flex items-center gap-1">
                                    <MapPin className="h-3.5 w-3.5" />
                                    {item.is_remote ? 'Remote' : (item.location_text ?? '—')}
                                </span>
                                {payText(item) && <span>{payText(item)}</span>}
                                {item.source_label && <span>via {item.source_label}</span>}
                                <span className="flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" />
                                    {formatDate(item.queued_at)}
                                </span>
                            </p>

                            {item.reason && (
                                <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                                    <strong>Why:</strong> {item.reason}
                                    {item.criteria_version_no && (
                                        <span className="ml-1 text-slate-400">
                                            (criteria v{item.criteria_version_no})
                                        </span>
                                    )}
                                </p>
                            )}

                            {item.park_reason && (
                                <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.warning}`}>
                                    Parked: {item.park_reason}
                                </p>
                            )}
                            {item.skip_reason && (
                                <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.danger}`}>
                                    Skipped: {item.skip_reason}
                                </p>
                            )}

                            <a
                                href={item.source_url}
                                target="_blank" rel="noreferrer"
                                className="mt-2 inline-flex items-center gap-1.5 text-xs text-brand-700 hover:underline"
                            >
                                <ExternalLink className="h-3.5 w-3.5" /> View the posting
                            </a>
                        </div>
                    ))}
                </div>
            </div>

            {/*
              Nothing waits on a cap any more, so this list is normally empty.
              It is kept because an item is briefly QUEUED between matching and
              the next promotion pass, and "matched but not ready yet" is still
              worth being able to see.
            */}
            {held.length > 0 && (
                <div>
                    <h2 className={sectionTitle}>Matched, not yet ready ({held.length})</h2>
                    <p className="mt-1 text-xs text-slate-500">
                        These become ready on the next discovery pass.
                    </p>
                    <div className={`mt-2 ${card} divide-y divide-line-soft`}>
                        {held.map((h) => (
                            <div key={h.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                                <div className="min-w-0">
                                    <p className="truncate text-sm text-slate-800">{h.title}</p>
                                    <p className="text-xs text-slate-500">
                                        {h.company}
                                        {h.location_text ? ` · ${h.location_text}` : ''}
                                    </p>
                                </div>
                                <span className={`${badge} ${TONE.neutral}`}>score {h.score}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {openItem && (
                <QueueItemDrawer
                    itemId={openItem}
                    canEdit={['ORG_ADMIN', 'RECRUITER'].includes(user?.role)}
                    isAdmin={user?.role === 'ORG_ADMIN'}
                    onClose={() => setOpenItem(null)}
                    onChanged={load}
                />
            )}
        </div>
    );
};

export default ConsultantQueue;
