import { useCallback, useEffect, useState } from 'react';
import {
    X, Loader2, AlertCircle, ExternalLink, History, Bot, User,
    SkipForward, RotateCcw, Ban,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import {
    card, cardPad, badge, btn, btnSm, sectionTitle, input, fieldLabel,
    TONE, TONE_ALERT,
} from '../../design/tokens.js';

/**
 * One queue item, everything known about it, and what may be done to it.
 *
 * ── THE ACTIONS COME FROM THE SERVER ──────────────────────────────────
 *
 * `allowedTransitions` is returned by the endpoint, so the buttons on screen
 * are the moves the state machine will actually accept. Deciding that here
 * would put a second copy of the rules in the client, and the two would drift —
 * the first symptom being a button that always fails with a 409.
 *
 * ── WHY THE HISTORY IS THE POINT ──────────────────────────────────────
 *
 * Every move is a row: who, when, from, to, why. This is the answer to "what
 * happened to this application?", and it is why transitions are recorded rather
 * than a status being overwritten in place.
 */
const QueueItemDrawer = ({ itemId, canEdit, isAdmin, onClose, onChanged }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [reason, setReason] = useState('');
    const [pending, setPending] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data: payload } = await api.get(`/management/queue/${itemId}`);
            setData(payload);
        } catch (err) {
            setError(errorMessage(err, 'Could not load that queue item.'));
        }
    }, [itemId]);

    useEffect(() => { load(); }, [load]);

    const act = async (path, body) => {
        setBusy(true);
        setError('');
        try {
            await api.post(`/management/queue/${itemId}/${path}`, body);
            setPending(null);
            setReason('');
            await load();
            onChanged?.();
        } catch (err) {
            // A 409 here is the state machine or a live device lease refusing
            // the move. Showing the server's own words is more use than a
            // generic failure, because both cases are recoverable and the
            // difference matters.
            setError(errorMessage(err, 'That move was refused.'));
        } finally {
            setBusy(false);
        }
    };

    const item = data?.item;
    const allowed = data?.allowedTransitions ?? [];

    return (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
            <aside
                className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-100 bg-white p-5">
                    <div>
                        <h2 className={sectionTitle}>
                            {item ? item.title : 'Queue item'}
                        </h2>
                        {item && <p className="text-sm text-slate-500">{item.company}</p>}
                    </div>
                    <button type="button" onClick={onClose} className={btnSm.secondary}>
                        <X className="h-3.5 w-3.5" /> Close
                    </button>
                </div>

                <div className="p-5">
                    {error && (
                        <div className={`mb-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {!data ? (
                        <p className="flex items-center gap-2 text-sm text-slate-500">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                        </p>
                    ) : (
                        <>
                            <div className="flex flex-wrap items-center gap-2">
                                <span className={`${badge} ${TONE.brand}`}>{item.status_label}</span>
                                {/* The lane decides who is expected to act. Without it
                                    the same job looks identical in two places. */}
                                <span className={`${badge} ${item.channel === 'BOT' ? TONE.info : TONE.neutral}`}>
                                    {item.channel === 'BOT'
                                        ? <><Bot className="h-3.5 w-3.5" /> Desktop app</>
                                        : <><User className="h-3.5 w-3.5" /> Applies manually</>}
                                </span>
                                {item.is_overlap && (
                                    <span className={`${badge} ${TONE.warning}`}>
                                        Also in another queue
                                    </span>
                                )}
                            </div>

                            <div className={`mt-4 ${card} ${cardPad}`}>
                                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                                    <div>
                                        <dt className="text-xs uppercase tracking-wide text-slate-400">Consultant</dt>
                                        <dd className="text-slate-700">{item.consultant_name}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs uppercase tracking-wide text-slate-400">Location</dt>
                                        <dd className="text-slate-700">
                                            {item.location_text ?? '—'}{item.is_remote ? ' · Remote' : ''}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs uppercase tracking-wide text-slate-400">Apply through</dt>
                                        <dd className="text-slate-700">{item.portal_label ?? '—'}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-xs uppercase tracking-wide text-slate-400">Listed on</dt>
                                        <dd className="text-slate-700">{item.source_label ?? '—'}</dd>
                                    </div>
                                    {item.score != null && (
                                        <div>
                                            <dt className="text-xs uppercase tracking-wide text-slate-400">Match score</dt>
                                            <dd className="tabular-nums text-slate-700">{item.score}</dd>
                                        </div>
                                    )}
                                    {item.criteria_version_no && (
                                        <div>
                                            <dt className="text-xs uppercase tracking-wide text-slate-400">Matched by</dt>
                                            {/* Phase 3 froze every version for exactly this: the
                                                answer to "why this person" survives later edits. */}
                                            <dd className="text-slate-700">criteria v{item.criteria_version_no}</dd>
                                        </div>
                                    )}
                                </dl>

                                {item.match_reason && (
                                    <p className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                                        {item.match_reason}
                                    </p>
                                )}

                                {item.source_url && (
                                    <a
                                        href={item.source_url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className={`mt-3 ${btnSm.secondary}`}
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" /> Open the job
                                    </a>
                                )}
                            </div>

                            {item.parked_question && (
                                <div className={`mt-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.warning}`}>
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                    <span>
                                        Parked on an unanswered question:
                                        {' '}<strong>{item.parked_question}</strong>. It resumes
                                        automatically once that answer is approved.
                                    </span>
                                </div>
                            )}

                            {/* ── actions ──────────────────────────────── */}
                            {canEdit && allowed.length > 0 && (
                                <div className="mt-5">
                                    <h3 className="text-xs uppercase tracking-wide text-slate-400">Actions</h3>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {allowed.includes('SKIPPED') && (
                                            <button type="button" onClick={() => setPending('skip')} className={btnSm.caution}>
                                                <SkipForward className="h-3.5 w-3.5" /> Skip
                                            </button>
                                        )}
                                        {allowed.includes('QUEUED') && (
                                            <button type="button" onClick={() => act('requeue', {})} className={btnSm.secondary}>
                                                <RotateCcw className="h-3.5 w-3.5" /> Re-queue
                                            </button>
                                        )}
                                        {isAdmin && allowed.includes('CANCELLED') && (
                                            <button type="button" onClick={() => setPending('cancel')} className={btnSm.danger}>
                                                <Ban className="h-3.5 w-3.5" /> Cancel
                                            </button>
                                        )}
                                    </div>

                                    {/* Skipping and cancelling are refused without a
                                        reason by the server, so the field is not optional. */}
                                    {pending && (
                                        <div className={`mt-3 ${card} ${cardPad}`}>
                                            <label className={fieldLabel} htmlFor="reason">
                                                Why {pending === 'skip' ? 'skip' : 'cancel'} this?
                                            </label>
                                            <input
                                                id="reason"
                                                value={reason}
                                                onChange={(e) => setReason(e.target.value)}
                                                placeholder="Required — it becomes part of the record"
                                                className={input}
                                            />
                                            <div className="mt-3 flex gap-2">
                                                <button
                                                    type="button"
                                                    disabled={busy || !reason.trim()}
                                                    onClick={() => act(pending === 'skip' ? 'skip' : 'cancel', { reason })}
                                                    className={pending === 'skip' ? btn.primary : btn.danger}
                                                >
                                                    {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                                    Confirm
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => { setPending(null); setReason(''); }}
                                                    className={btn.secondary}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── history ──────────────────────────────── */}
                            <h3 className={`mt-6 flex items-center gap-1.5 ${sectionTitle}`}>
                                <History className="h-4 w-4 text-slate-400" /> History
                            </h3>
                            <ol className="mt-3 space-y-3">
                                {data.history.map((h, i) => (
                                    <li key={i} className="border-l-2 border-slate-200 pl-3">
                                        <p className="text-sm text-slate-700">
                                            {h.from_label ? `${h.from_label} → ` : ''}
                                            <strong>{h.to_label}</strong>
                                        </p>
                                        {h.reason && (
                                            <p className="text-xs text-slate-500">{h.reason}</p>
                                        )}
                                        <p className="text-xs text-slate-400">
                                            {new Date(h.created_at).toLocaleString()}
                                            {h.performed_by_name
                                                ? ` · ${h.performed_by_name}`
                                                : ' · automatic'}
                                        </p>
                                    </li>
                                ))}
                            </ol>
                        </>
                    )}
                </div>
            </aside>
        </div>
    );
};

export default QueueItemDrawer;
