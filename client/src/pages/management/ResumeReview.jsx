import { useCallback, useEffect, useState } from 'react';
import {
    ShieldAlert, CheckCircle2, XCircle, RotateCcw, Loader2, AlertCircle,
    ArrowLeft, FileText, Ruler,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import TailoredDiff from '../../components/resume/TailoredDiff.jsx';
import {
    card, cardPad, cardInteractive, badge, btn, btnSm, input, fieldLabel,
    pageTitle, pageSubtitle, sectionTitle, alertShell, TONE, TONE_ALERT,
} from '../../design/tokens.js';

/**
 * ── THE REVIEW GATE ───────────────────────────────────────────────────
 *
 * Every resume the fabrication checker flagged, waiting for a human decision.
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ─────────────────────────────────────
 *
 * The pipeline rewrites a consultant's resume to mirror a job description, and
 * the one thing it must never do is invent — a tool they have not used, a
 * percentage they did not achieve, an employer they did not work for. The
 * checker is a second, independent model plus a mechanical string comparison,
 * and when either raises a claim the application STOPS here rather than going
 * out in a real person's name.
 *
 * That is the whole reason the state exists. It follows that this queue must be
 * cheap to work through, or it becomes a place applications go to be forgotten
 * — which is why C6 expires anything left sitting here, and why this screen
 * shows the wait time in the list rather than hiding it in a detail view.
 *
 * ── THE THREE DECISIONS ───────────────────────────────────────────────
 *
 * Approve  the flags were false alarms; send the tailored resume.
 * Reject   send the base resume instead. Nothing is lost, the application still
 *          goes out, and the item is marked as untailored.
 * Retry    the tailoring was simply bad; run it again from the start.
 *
 * None of them can lose the application, which is the property that makes it
 * safe to be strict about flagging.
 */

/** How long this item has been waiting, so nothing rots unnoticed. */
const waitingFor = (iso) => {
    const ms = Date.now() - new Date(iso).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) return { text: `${days}d waiting`, tone: days >= 3 ? 'danger' : 'warning' };
    const hours = Math.floor(ms / 3_600_000);
    return { text: hours >= 1 ? `${hours}h waiting` : 'just now', tone: 'neutral' };
};

/**
 * `scope` picks the API prefix and nothing else.
 *
 * The consultant's version of this screen is the same screen: the same flags,
 * the same side-by-side, the same wait times. What differs is what they may DO,
 * and that is decided by the SERVER — `canApprove` and `canRetry` come back on
 * the payload, so the buttons a consultant must not have are absent because the
 * server said so, not because a second copy of the rule was written here.
 */
const ResumeReview = ({ scope = 'management' }) => {
    const root = scope === 'portal' ? '/portal' : '/management';
    const [items, setItems] = useState(null);
    const [openId, setOpenId] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const { data } = await api.get(`${root}/resume-reviews`);
            setItems(data.items);
        } catch (err) {
            setError(errorMessage(err));
            setItems([]);
        }
    }, [root]);

    useEffect(() => { load(); }, [load]);

    if (items === null) return <PageLoader />;

    if (openId) {
        return (
            <ReviewDetail
                root={root}
                itemId={openId}
                onBack={() => setOpenId(null)}
                onDecided={async () => { setOpenId(null); await load(); }}
            />
        );
    }

    return (
        <div className="mx-auto max-w-5xl">
            <h1 className={pageTitle}>
                {scope === 'portal' ? 'My resumes awaiting review' : 'Resume review'}
            </h1>
            <p className={pageSubtitle}>
                {scope === 'portal'
                    ? 'A resume rewritten for one of your jobs contained claims the checker '
                      + 'could not find in your base resume. Your recruiter decides — you can '
                      + 'ask for your base resume to be sent instead.'
                    : 'Tailored resumes holding for a decision. Each one names claims the '
                      + 'checker could not trace back to the consultant’s base resume.'}
            </p>

            {error && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {items.length === 0 ? (
                <div className={`mt-6 ${card} ${cardPad} text-center`}>
                    <ShieldAlert className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-600">Nothing is waiting for review.</p>
                    <p className="mt-1 text-xs text-slate-400">
                        Resumes appear here only when the fabrication checker flags a claim.
                    </p>
                </div>
            ) : (
                <div className="mt-6 space-y-3">
                    {items.map((item) => {
                        const wait = waitingFor(item.updated_at);
                        return (
                            <div
                                key={item.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setOpenId(item.id)}
                                onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(item.id); }}
                                className={`${cardInteractive} ${cardPad}`}
                            >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="text-sm font-medium text-slate-900">{item.title}</p>
                                        <p className="text-xs text-slate-500">
                                            {item.company}
                                            {scope === 'portal' ? '' : ` · ${item.consultant_name}`}
                                        </p>
                                    </div>
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        {/*
                                            Proven flags come from an exact string
                                            comparison, so they are shown apart from
                                            the model's opinions. A reviewer with
                                            twenty items open should be able to pick
                                            the provable ones first.
                                        */}
                                        {item.proven_count > 0 && (
                                            <span className={`${badge} ${TONE.danger}`} title="Found by exact comparison">
                                                <Ruler className="h-3 w-3" /> {item.proven_count} proven
                                            </span>
                                        )}
                                        {item.high_count > 0 && (
                                            <span className={`${badge} ${TONE.danger}`}>
                                                {item.high_count} high
                                            </span>
                                        )}
                                        <span className={`${badge} ${TONE.warning}`}>
                                            {item.flag_count} flag{item.flag_count === 1 ? '' : 's'}
                                        </span>
                                        <span className={`${badge} ${TONE[wait.tone]}`}>{wait.text}</span>
                                    </span>
                                </div>

                                {(item.ats_score_before != null || item.ats_score_after != null) && (
                                    <p className="mt-2 text-xs text-slate-500">
                                        ATS {item.ats_score_before ?? '—'} → {item.ats_score_after ?? '—'}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

/* ── one item ──────────────────────────────────────────────────────── */

const ReviewDetail = ({ root, itemId, onBack, onDecided }) => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const { data: body } = await api.get(`${root}/resume-reviews/${itemId}`);
                setData(body);
            } catch (err) {
                setError(errorMessage(err));
            }
        })();
    }, [root, itemId]);

    const decide = async (action) => {
        setBusy(true);
        setError('');
        try {
            await api.post(`${root}/resume-reviews/${itemId}/${action}`, { reason });
            await onDecided();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (error && !data) {
        return (
            <div className="mx-auto max-w-5xl">
                <button type="button" onClick={onBack} className={btnSm.subtle}>
                    <ArrowLeft className="h-3.5 w-3.5" /> Back
                </button>
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            </div>
        );
    }

    if (!data) return <PageLoader />;

    const { item, artifact, flags, baseText, tailoredText, canApprove, canRetry } = data;

    return (
        <div className="mx-auto max-w-6xl">
            <button type="button" onClick={onBack} className={btnSm.subtle}>
                <ArrowLeft className="h-3.5 w-3.5" /> All reviews
            </button>

            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className={pageTitle}>{item.title}</h1>
                    <p className={pageSubtitle}>
                        {item.company} · {item.consultantName}
                        {artifact?.model ? ` · tailored by ${artifact.model}` : ''}
                    </p>
                </div>
                {item.sourceUrl && (
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className={btnSm.subtle}>
                        <FileText className="h-3.5 w-3.5" /> The job advert
                    </a>
                )}
            </div>

            {error && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {!tailoredText && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.warning}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                        This resume was tailored before the text was kept alongside the PDF,
                        so only the flagged claims are shown. Retrying will produce a full
                        comparison.
                    </span>
                </div>
            )}

            <div className="mt-5">
                <TailoredDiff
                    baseText={baseText ?? 'The base resume text is not available.'}
                    tailoredText={tailoredText ?? 'The tailored resume text is not available.'}
                    flags={flags}
                    scoreBefore={artifact?.ats_score_before}
                    scoreAfter={artifact?.ats_score_after}
                />
            </div>

            {/* ── the decision ─────────────────────────────────────── */}
            <div className={`mt-6 ${card} ${cardPad}`}>
                <h3 className={sectionTitle}>Your decision</h3>
                <p className="mt-1 text-xs text-slate-500">
                    Whichever you choose, the application still goes out — rejecting sends
                    the consultant&rsquo;s base resume instead of the tailored one.
                </p>

                <label className={`mt-3 block ${fieldLabel}`} htmlFor="review-reason">
                    Why (recorded against every flag and in the history)
                </label>
                <input
                    id="review-reason"
                    className={input}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Checked against the original — the figure is in the summary."
                />

                <div className="mt-4 flex flex-wrap gap-2">
                    {canApprove && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => decide('approve')}
                            className={btn.primary}
                        >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <CheckCircle2 className="h-4 w-4" />}
                            Approve — send the tailored resume
                        </button>
                    )}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => decide('reject')}
                        className={btn.ghost}
                    >
                        <XCircle className="h-4 w-4" />
                        Reject — send the base resume
                    </button>
                    {canRetry && (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => decide('retry')}
                            className={btn.ghost}
                        >
                            <RotateCcw className="h-4 w-4" />
                            Tailor it again
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ResumeReview;
