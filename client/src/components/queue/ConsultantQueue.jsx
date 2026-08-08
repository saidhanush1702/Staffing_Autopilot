import { useEffect, useState } from 'react';
import {
    ListChecks, ExternalLink, MapPin, Layers, Gauge, Clock, Inbox,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import {
    card, cardPad, badge, sectionTitle, TONE, TONE_ALERT,
} from '../../design/tokens.js';

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
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get(`/management/consultants/${consultantId}/queue`)
            .then(({ data: d }) => setData(d))
            .catch((err) => setError(errorMessage(err)));
    }, [consultantId]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!data) return <PageLoader />;

    const { queue, held, cap } = data;
    const usedToday = cap.used_today ?? 0;
    const dailyCap = cap.daily_cap ?? 0;
    const atCap = dailyCap > 0 && usedToday >= dailyCap;

    return (
        <div className="space-y-6">
            {/* ── cap ────────────────────────────────────────────── */}
            <div className={`${card} ${cardPad} flex flex-wrap items-center justify-between gap-3`}>
                <div>
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <Gauge className="h-4 w-4 text-slate-400" /> Daily cap
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                        Discovery stops adding to this queue once the cap is reached.
                        Anything over is held, not thrown away.
                    </p>
                </div>
                <span className={`${badge} ${atCap ? TONE.warning : TONE.success}`}>
                    {usedToday} of {dailyCap} used today
                </span>
            </div>

            {/* ── the queue ──────────────────────────────────────── */}
            <div>
                <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                    <ListChecks className="h-4 w-4 text-slate-400" /> Queue ({queue.length})
                </h2>

                {queue.length === 0 && (
                    <div className={`mt-2 ${card} ${cardPad} text-center`}>
                        <Inbox className="mx-auto h-8 w-8 text-slate-300" />
                        <p className="mt-2 text-sm text-slate-500">Nothing queued yet.</p>
                        <p className="mt-1 text-xs text-slate-400">
                            Discovery adds jobs here when they match this consultant's search criteria.
                        </p>
                    </div>
                )}

                <div className="mt-2 space-y-3">
                    {queue.map((item) => (
                        <div key={item.id} className={`${card} ${cardPad}`}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <p className="text-sm font-medium text-slate-900">{item.title}</p>
                                    <p className="text-xs text-slate-500">{item.company}</p>
                                </div>
                                <span className="flex flex-wrap items-center gap-1.5">
                                    <span className={`${badge} ${TONE.brand}`}>{item.status_label}</span>
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
                                    {new Date(item.queued_at).toLocaleDateString()}
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
                                <p className={`mt-2 rounded-lg p-2 text-xs ${TONE_ALERT.warning}`}>
                                    Parked: {item.park_reason}
                                </p>
                            )}
                            {item.skip_reason && (
                                <p className={`mt-2 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>
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

            {/* ── held by the cap ────────────────────────────────── */}
            {held.length > 0 && (
                <div>
                    <h2 className={sectionTitle}>Waiting for a slot ({held.length})</h2>
                    <p className="mt-1 text-xs text-slate-500">
                        Matched, but the daily cap was reached. These are reconsidered on the
                        next run — nothing is discarded.
                    </p>
                    <div className={`mt-2 ${card} divide-y divide-slate-100`}>
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
        </div>
    );
};

export default ConsultantQueue;
