import { useEffect, useState } from 'react';
import {
    MessageSquare, Loader2, AlertCircle, CheckCircle2, Clock, XCircle, Lock, Pencil,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import {
    card, cardPad, inputBase, fieldLabel, btn, btnSm, badge, sectionTitle,
    TONE, TONE_ALERT, pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

const STATUS_TONE = {
    PENDING: 'info',
    APPROVED: 'success',
    REJECTED: 'danger',
    SUPERSEDED: 'neutral',
};

const STATUS_ICON = {
    PENDING: Clock,
    APPROVED: CheckCircle2,
    REJECTED: XCircle,
};

const TABS = [
    { key: 'OUTSTANDING', label: 'To answer' },
    { key: 'ANSWERED', label: 'My answers' },
];

/**
 * The consultant's side of the answer bank.
 *
 * They write the answers; somebody else approves them. Nothing here is usable
 * to fill a form until it is APPROVED — the page says so plainly rather than
 * letting a pending answer look finished.
 */
const MyAnswers = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('OUTSTANDING');
    const [editing, setEditing] = useState(null);   // { question, current }
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState('');

    const load = async () => {
        try {
            const { data: d } = await api.get('/portal/questions');
            setData(d);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!data) return <PageLoader />;

    const { outstanding, answers } = data;
    const byStatus = (s) => answers.filter((a) => a.status_name === s);

    const open = (question, current) => {
        setEditing({ question, current });
        setText(current?.proposed_text ?? '');
        setSaveError('');
    };

    const submit = async () => {
        setBusy(true);
        setSaveError('');
        try {
            await api.post('/portal/answers', {
                questionId: editing.question.id ?? editing.question.question_id,
                answerText: text,
            });
            setEditing(null);
            await load();
        } catch (err) {
            setSaveError(errorMessage(err, 'Could not submit that answer.'));
        } finally {
            setBusy(false);
        }
    };

    const AnswerCard = ({ a }) => {
        const Icon = STATUS_ICON[a.status_name];
        return (
            <div className={`${card} ${cardPad}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                        {a.question_text}
                    </p>
                    <span className={`${badge} ${TONE[STATUS_TONE[a.status_name]]}`}>
                        {Icon && <Icon className="h-3.5 w-3.5" />}
                        {a.status_label}
                    </span>
                </div>

                <p className="mt-1 text-xs text-slate-400">
                    {a.category_label}
                    {a.requires_owner_approval && ' · approved by your organization admin'}
                </p>

                {/* When a reviewer edited before approving, both texts are shown.
                    Hiding the original would misrepresent what the consultant
                    actually said. */}
                {a.was_corrected ? (
                    <div className="mt-3 space-y-2 text-sm">
                        <p className="text-slate-500">
                            <span className="text-xs uppercase tracking-wide text-slate-400">You wrote</span>
                            <br />
                            <span className="line-through">{a.proposed_text}</span>
                        </p>
                        <p className="text-slate-800">
                            <span className="text-xs uppercase tracking-wide text-slate-400">
                                Approved as
                            </span>
                            <br />
                            {a.approved_text}
                        </p>
                    </div>
                ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">
                        {a.approved_text ?? a.proposed_text}
                    </p>
                )}

                {a.review_note && (
                    <div className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>
                        <strong>Reviewer note:</strong> {a.review_note}
                    </div>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-400">
                        {a.reviewed_at
                            ? `Reviewed by ${a.reviewed_by_name ?? 'a reviewer'}`
                              + (a.reviewed_by_role ? ` (${a.reviewed_by_role})` : '')
                              + ` on ${new Date(a.reviewed_at).toLocaleDateString()}`
                            : `Submitted ${new Date(a.answered_at).toLocaleDateString()} — awaiting review`}
                    </p>
                    {a.status_name !== 'PENDING' && (
                        <button
                            type="button"
                            onClick={() => open({ id: a.question_id, question_text: a.question_text }, a)}
                            className={btnSm.secondary}
                        >
                            <Pencil className="h-3.5 w-3.5" />
                            {a.status_name === 'REJECTED' ? 'Rewrite' : 'Revise'}
                        </button>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div>
            <h1 className={pageTitle}>My answers</h1>
            <p className={pageSubtitle}>
                Standard application questions. Your answers are used to fill job
                applications on your behalf — but only after they are approved.
            </p>

            <div className={`mt-5 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.info}`}>
                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                    Nothing you write here is used until a reviewer approves it. Pay and
                    work-authorization answers go to your organization admin rather than
                    your recruiter.
                </span>
            </div>

            <div className={`mt-5 ${tabBar}`}>
                <nav className={tabNav}>
                    {TABS.map((t) => (
                        <button
                            key={t.key} type="button" onClick={() => setTab(t.key)}
                            className={`${tabItem} ${tab === t.key ? tabActive : tabIdle}`}
                        >
                            {t.label}
                            <span className={`${badge} ${tab === t.key ? TONE.brand : TONE.neutral}`}>
                                {t.key === 'OUTSTANDING' ? outstanding.length : answers.length}
                            </span>
                        </button>
                    ))}
                </nav>
            </div>

            {tab === 'OUTSTANDING' ? (
                <div className="mt-4 space-y-3">
                    {outstanding.length === 0 && (
                        <div className={`${card} ${cardPad} text-center`}>
                            <CheckCircle2 className="mx-auto h-8 w-8 text-success-600" />
                            <p className="mt-2 text-sm text-slate-600">
                                Nothing left to answer. Your recruiter will let you know if
                                a new question comes up.
                            </p>
                        </div>
                    )}
                    {outstanding.map((q) => (
                        <div key={q.id} className={`${card} ${cardPad} flex flex-wrap items-center justify-between gap-3`}>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-slate-900">{q.question_text}</p>
                                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                                    <span className={`${badge} ${q.requires_owner_approval ? TONE.warning : TONE.neutral}`}>
                                        {q.category_label}
                                    </span>
                                    {q.source_note && <span>Asked because: {q.source_note}</span>}
                                </p>
                            </div>
                            <button type="button" onClick={() => open(q, null)} className={btn.primary}>
                                <MessageSquare className="h-4 w-4" /> Answer
                            </button>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="mt-4 space-y-4">
                    {answers.length === 0 && (
                        <p className="text-sm text-slate-400">You have not answered anything yet.</p>
                    )}
                    {['PENDING', 'REJECTED', 'APPROVED'].map((s) => {
                        const group = byStatus(s);
                        if (group.length === 0) return null;
                        return (
                            <div key={s}>
                                <h2 className={sectionTitle}>
                                    {group[0].status_label} ({group.length})
                                </h2>
                                <div className="mt-2 space-y-3">
                                    {group.map((a) => <AnswerCard key={a.id} a={a} />)}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {editing && (
                <Modal
                    size="md"
                    icon={MessageSquare}
                    tone="brand"
                    title={editing.current ? 'Revise your answer' : 'Answer this question'}
                    subtitle={editing.question.question_text}
                    onClose={() => setEditing(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setEditing(null)}
                            onConfirm={submit}
                            confirmLabel="Submit for approval"
                            busy={busy}
                            disabled={!text.trim() || text.trim() === editing.current?.proposed_text}
                        />
                    )}
                >
                    {saveError && (
                        <div className={`mb-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{saveError}</span>
                        </div>
                    )}

                    {editing.current?.review_note && (
                        <div className={`mb-3 rounded-lg p-3 text-sm ${TONE_ALERT.warning}`}>
                            <strong>What to change:</strong> {editing.current.review_note}
                        </div>
                    )}

                    <label className="block">
                        <span className={fieldLabel}>Your answer</span>
                        <textarea
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            rows={5}
                            maxLength={4000}
                            autoFocus
                            placeholder="Answer exactly as you would on the application form."
                            className={`mt-1 ${inputBase}`}
                        />
                    </label>
                    <p className="mt-2 text-xs text-slate-400">
                        This replaces your previous answer, which stays on record. It goes back
                        for approval before it can be used.
                    </p>
                </Modal>
            )}
        </div>
    );
};

export default MyAnswers;
