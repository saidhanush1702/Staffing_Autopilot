import { useEffect, useState } from 'react';
import {
    MessageSquare, Plus, CheckCircle2, Clock, XCircle, AlertCircle, Lock,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import {
    card, cardPad, inputBase, fieldLabel, btn, badge, sectionTitle,
    TONE, TONE_ALERT,
} from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

const STATUS_TONE = {
    PENDING: 'info', APPROVED: 'success', REJECTED: 'danger', SUPERSEDED: 'neutral',
};
const STATUS_ICON = { PENDING: Clock, APPROVED: CheckCircle2, REJECTED: XCircle };

/**
 * One consultant's answer bank, on their detail page.
 *
 * Read-only here — decisions are made in the approval inbox, where the R-07
 * locking and the grouping live. This tab answers "what has this person
 * already said?", which is what a recruiter needs before an interview.
 *
 * The one write is raising a new question at them.
 */
const ConsultantAnswers = ({ consultantId }) => {
    const { options } = useLookups();
    const [answers, setAnswers] = useState(null);
    const [error, setError] = useState('');
    const [asking, setAsking] = useState(false);
    const [text, setText] = useState('');
    const [category, setCategory] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [askError, setAskError] = useState('');

    const load = async () => {
        try {
            const { data } = await api.get(`/management/consultants/${consultantId}/answers`);
            setAnswers(data.answers);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); /* eslint-disable-next-line */ }, [consultantId]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!answers) return <PageLoader />;

    const ask = async () => {
        setBusy(true);
        setAskError('');
        try {
            await api.post(`/management/consultants/${consultantId}/questions`, {
                questionText: text,
                category: category || null,
                note: note.trim() || null,
            });
            setAsking(false);
            setText(''); setCategory(''); setNote('');
            await load();
        } catch (err) {
            setAskError(errorMessage(err, 'Could not raise that question.'));
        } finally {
            setBusy(false);
        }
    };

    const group = (s) => answers.filter((a) => a.status_name === s);

    return (
        <div className="space-y-6">
            <div className={`${card} ${cardPad} flex flex-wrap items-center justify-between gap-3`}>
                <div>
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <MessageSquare className="h-4 w-4 text-slate-400" /> Answer bank
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                        {group('APPROVED').length} approved · {group('PENDING').length} awaiting
                        review · {group('REJECTED').length} rejected. Only approved answers are
                        used to fill applications.
                    </p>
                </div>
                <button type="button" onClick={() => setAsking(true)} className={btn.primary}>
                    <Plus className="h-4 w-4" /> Ask a question
                </button>
            </div>

            {answers.length === 0 && (
                <p className="text-sm text-slate-400">
                    This consultant has not answered anything yet.
                </p>
            )}

            {['PENDING', 'REJECTED', 'APPROVED'].map((s) => {
                const rows = group(s);
                if (rows.length === 0) return null;
                const Icon = STATUS_ICON[s];
                return (
                    <div key={s}>
                        <h3 className={sectionTitle}>{rows[0].status_label} ({rows.length})</h3>
                        <div className="mt-2 space-y-3">
                            {rows.map((a) => (
                                <div key={a.id} className={`${card} ${cardPad}`}>
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                                            {a.question_text}
                                        </p>
                                        <span className={`${badge} ${TONE[STATUS_TONE[s]]}`}>
                                            {Icon && <Icon className="h-3.5 w-3.5" />} {a.status_label}
                                        </span>
                                    </div>
                                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                                        <span className={`${badge} ${a.requires_owner_approval ? TONE.warning : TONE.neutral}`}>
                                            {a.requires_owner_approval && <Lock className="h-3 w-3" />}
                                            {a.category_label}
                                        </span>
                                        {a.revision_no > 1 && <span>revision {a.revision_no}</span>}
                                    </p>
                                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">
                                        {a.approved_text ?? a.proposed_text}
                                    </p>
                                    {a.was_corrected && (
                                        <p className="mt-2 text-xs text-slate-500">
                                            Corrected on approval. They wrote:{' '}
                                            <span className="line-through">{a.proposed_text}</span>
                                        </p>
                                    )}
                                    {a.review_note && (
                                        <p className="mt-2 text-xs text-slate-500">
                                            <strong>Note:</strong> {a.review_note}
                                        </p>
                                    )}
                                    {a.reviewed_by_name && (
                                        <p className="mt-2 text-xs text-slate-400">
                                            {a.status_label} by {a.reviewed_by_name} ({a.reviewed_by_role})
                                            {' on '}{new Date(a.reviewed_at).toLocaleDateString()}
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}

            {asking && (
                <Modal
                    size="md"
                    icon={MessageSquare}
                    tone="brand"
                    title="Ask this consultant a question"
                    subtitle="It joins the shared bank, so an identical question is never asked twice."
                    onClose={() => setAsking(false)}
                    footer={(
                        <ModalActions
                            onCancel={() => setAsking(false)}
                            onConfirm={ask}
                            confirmLabel="Raise question"
                            busy={busy}
                            disabled={text.trim().length < 5}
                        />
                    )}
                >
                    {askError && (
                        <div className={`mb-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{askError}</span>
                        </div>
                    )}

                    <label className="block">
                        <span className={fieldLabel}>Question</span>
                        <textarea
                            value={text} onChange={(e) => setText(e.target.value)}
                            rows={3} maxLength={500} autoFocus
                            placeholder="Word it exactly as an application form would."
                            className={`mt-1 ${inputBase}`}
                        />
                    </label>

                    <label className="mt-4 block">
                        <span className={fieldLabel}>Category</span>
                        <select
                            value={category} onChange={(e) => setCategory(e.target.value)}
                            className={`mt-1 ${inputBase}`}
                        >
                            <option value="">Decide automatically</option>
                            {options('questionCategories').map((c) => (
                                <option key={c.id} value={c.name}>{c.label}</option>
                            ))}
                        </select>
                        <span className="mt-1 block text-xs text-slate-400">
                            Left automatic, anything about pay or right-to-work routes to an
                            organization admin. Unclear questions do too.
                        </span>
                    </label>

                    <label className="mt-4 block">
                        <span className={fieldLabel}>Why are you asking? (optional)</span>
                        <input
                            value={note} onChange={(e) => setNote(e.target.value)}
                            maxLength={255}
                            placeholder="Client asked about Kubernetes experience"
                            className={`mt-1 ${inputBase}`}
                        />
                    </label>
                </Modal>
            )}
        </div>
    );
};

export default ConsultantAnswers;
