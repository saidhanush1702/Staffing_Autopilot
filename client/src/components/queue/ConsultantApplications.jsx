import { useCallback, useEffect, useState } from 'react';
import {
    FileCheck2, Inbox, ExternalLink, ShieldCheck, MessageSquareQuote, X, Loader2,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import {
    card, cardPad, badge, btnSm, sectionTitle, TONE, TONE_ALERT,
} from '../../design/tokens.js';

/**
 * One consultant's permanent application record.
 *
 * ── WHY "HOW IT WAS SUBMITTED" IS ON EVERY ROW ────────────────────────
 *
 * These records carry different amounts of trust. A `DESKTOP_BOT` row was
 * watched by software from filling to submission; a `PORTAL_SELF_REPORTED` row
 * is the consultant's own account of something that happened somewhere this
 * system never saw. Both are worth keeping — but a screen that renders them
 * identically claims more than the data supports, so witnessed records carry a
 * mark and self-reported ones do not.
 *
 * Nothing here can edit or delete a record. There is no route for it, and the
 * database refuses it regardless of who asks.
 */
const ConsultantApplications = ({ consultantId }) => {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState('');
    const [open, setOpen] = useState(null);
    const [detail, setDetail] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get(`/management/consultants/${consultantId}/applications`);
            setRows(data.applications);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [consultantId]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!open) { setDetail(null); return; }
        api.get(`/management/applications/${open}`)
            .then(({ data }) => setDetail(data))
            .catch((err) => setError(errorMessage(err)));
    }, [open]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!rows) return <PageLoader />;

    return (
        <div>
            <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                <FileCheck2 className="h-4 w-4 text-slate-400" /> Applications ({rows.length})
            </h2>
            <p className="mt-1 text-xs text-slate-500">
                Permanent and append-only. Nobody can edit or delete these — not a
                recruiter, not an admin, not through the database.
            </p>

            {rows.length === 0 && (
                <div className={`mt-3 ${card} ${cardPad} text-center`}>
                    <Inbox className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-500">No applications recorded yet.</p>
                </div>
            )}

            <div className="mt-3 space-y-3">
                {rows.map((a) => (
                    <div
                        key={a.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setOpen(a.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter') setOpen(a.id); }}
                        className={`${card} ${cardPad} cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-500`}
                    >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-900">{a.job_title}</p>
                                <p className="text-xs text-slate-500">{a.company}</p>
                            </div>
                            <span className="flex flex-wrap items-center gap-1.5">
                                <span className={`${badge} ${TONE.success}`}>{a.status_label}</span>
                                <span
                                    className={`${badge} ${a.is_witnessed ? TONE.info : TONE.neutral}`}
                                    title={a.is_witnessed
                                        ? 'Software observed this submission'
                                        : 'Reported by a person — not observed by the system'}
                                >
                                    {a.is_witnessed && <ShieldCheck className="h-3 w-3" />}
                                    {a.submitted_via_label}
                                </span>
                            </span>
                        </div>

                        <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                            <span>{new Date(a.submitted_at).toLocaleString()}</span>
                            {a.portal_label && <span>via {a.portal_label}</span>}
                            {a.machine_label && <span>from {a.machine_label}</span>}
                            {a.recorded_by_name && <span>recorded by {a.recorded_by_name}</span>}
                            <span className="flex items-center gap-1">
                                <MessageSquareQuote className="h-3.5 w-3.5" />
                                {a.answer_count} answer{a.answer_count === 1 ? '' : 's'}
                            </span>
                        </p>
                    </div>
                ))}
            </div>

            {/* ── the exact form, as it was filled ────────────────── */}
            {open && (
                <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={() => setOpen(null)}>
                    <aside
                        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-100 bg-white p-5">
                            <div>
                                <h3 className={sectionTitle}>
                                    {detail?.application.job_title ?? 'Application'}
                                </h3>
                                <p className="text-sm text-slate-500">
                                    {detail?.application.company}
                                </p>
                            </div>
                            <button type="button" onClick={() => setOpen(null)} className={btnSm.secondary}>
                                <X className="h-3.5 w-3.5" /> Close
                            </button>
                        </div>

                        <div className="p-5">
                            {!detail ? (
                                <p className="flex items-center gap-2 text-sm text-slate-500">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                                </p>
                            ) : (
                                <>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={`${badge} ${TONE.success}`}>
                                            {detail.application.status_label}
                                        </span>
                                        <span className={`${badge} ${detail.application.is_witnessed ? TONE.info : TONE.neutral}`}>
                                            {detail.application.submitted_via_label}
                                        </span>
                                    </div>

                                    {!detail.application.is_witnessed && (
                                        <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.neutral}`}>
                                            This was reported by a person rather than observed by the
                                            system, so the questions and answers below are as they
                                            were given to us.
                                        </p>
                                    )}

                                    {detail.application.job_url && (
                                        <a
                                            href={detail.application.job_url}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                            className={`mt-3 ${btnSm.secondary}`}
                                        >
                                            <ExternalLink className="h-3.5 w-3.5" /> Open the job
                                        </a>
                                    )}

                                    <h4 className={`mt-6 ${sectionTitle}`}>
                                        What the form asked ({detail.qa.length})
                                    </h4>
                                    {/* The question text is what the EMPLOYER wrote, stored
                                        verbatim — not a link to the question bank, which is
                                        editable and would rewrite history when reworded. */}
                                    {detail.qa.length === 0 ? (
                                        <p className="mt-2 text-sm text-slate-500">
                                            No questions were recorded for this application.
                                        </p>
                                    ) : (
                                        <ol className="mt-3 space-y-3">
                                            {detail.qa.map((q) => (
                                                <li key={q.position} className={`${card} ${cardPad}`}>
                                                    <p className="text-sm font-medium text-slate-800">
                                                        {q.question_text}
                                                    </p>
                                                    <p className="mt-1 text-sm text-slate-600">
                                                        {q.answer_text || <span className="text-slate-400">(left blank)</span>}
                                                    </p>
                                                    {q.field_type && (
                                                        <p className="mt-1 text-xs text-slate-400">{q.field_type}</p>
                                                    )}
                                                </li>
                                            ))}
                                        </ol>
                                    )}
                                </>
                            )}
                        </div>
                    </aside>
                </div>
            )}
        </div>
    );
};

export default ConsultantApplications;
