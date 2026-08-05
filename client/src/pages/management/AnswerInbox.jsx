import { useEffect, useMemo, useState } from 'react';
import {
    Inbox, Lock, CheckCircle2, XCircle, Pencil, AlertCircle, Clock, Users,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import AuditLogPanel from '../../components/layout/AuditLogPanel.jsx';
import {
    card, cardPad, inputBase, fieldLabel, btnSm, badge, sectionTitle,
    TONE, TONE_ALERT, pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

const FILTERS = [
    { key: 'PENDING', label: 'Awaiting review' },
    { key: 'APPROVED', label: 'Approved' },
    { key: 'REJECTED', label: 'Rejected' },
    { key: 'ALL', label: 'All' },
];

/** How long an item has been waiting, so nothing rots unnoticed. */
const waitingFor = (iso) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (days >= 1) return { text: `${days}d waiting`, tone: days >= 3 ? 'danger' : 'warning' };
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    return { text: hours >= 1 ? `${hours}h waiting` : 'just now', tone: 'neutral' };
};

/**
 * The approval inbox.
 *
 * Sensitive items (salary, work authorisation) are VISIBLE to a recruiter but
 * locked — R-07. Hiding them entirely would leave the recruiter wondering why
 * their consultant is stuck; showing them greyed out with "Owner approval
 * required" answers that without letting the recruiter act.
 *
 * Items sharing a normalised question are grouped so a reviewer can work
 * through the same question across consultants quickly — but each is approved
 * and audited individually, which the specification requires.
 */
const AnswerInbox = () => {
    const [items, setItems] = useState(null);
    const [page, setPage] = useState(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [filter, setFilter] = useState('PENDING');
    const [grouped, setGrouped] = useState(true);
    const [error, setError] = useState('');

    const [target, setTarget] = useState(null);      // the item being decided
    const [mode, setMode] = useState('APPROVE');     // APPROVE | CORRECT | REJECT
    const [text, setText] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState('');

    const load = async (p = 1, status = filter) => {
        try {
            const { data } = await api.get('/management/answers', {
                params: { page: p, limit: 25, status },
            });
            setItems(data.data);
            setPage(data.page);
            setCurrentPage(p);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(1, filter); /* eslint-disable-next-line */ }, [filter]);

    /** Same normalised question → one block. Order preserved (oldest first). */
    const groups = useMemo(() => {
        if (!items) return [];
        if (!grouped) return items.map((i) => ({ key: i.id, question: i.questionText, rows: [i] }));
        const map = new Map();
        for (const i of items) {
            if (!map.has(i.groupKey)) {
                map.set(i.groupKey, { key: i.groupKey, question: i.questionText, rows: [] });
            }
            map.get(i.groupKey).rows.push(i);
        }
        return [...map.values()];
    }, [items, grouped]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!items) return <PageLoader />;

    const open = (item, nextMode) => {
        setTarget(item);
        setMode(nextMode);
        setText(item.proposedText);
        setNote('');
        setDialogError('');
    };

    const submit = async () => {
        setBusy(true);
        setDialogError('');
        try {
            await api.post(`/management/answers/${target.id}/review`, {
                decision: mode === 'REJECT' ? 'REJECT' : 'APPROVE',
                correctedText: mode === 'CORRECT' ? text : null,
                note: note.trim() || null,
            });
            setTarget(null);
            await load(currentPage);
        } catch (err) {
            setDialogError(errorMessage(err, 'Could not record that decision.'));
        } finally {
            setBusy(false);
        }
    };

    const Row = ({ i }) => {
        const wait = waitingFor(i.answeredAt);
        return (
            <div className={`${card} ${cardPad} ${i.canReview ? '' : 'opacity-90'}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900">{i.consultantName}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                            <span className={`${badge} ${i.requiresOwnerApproval ? TONE.warning : TONE.neutral}`}>
                                {i.categoryLabel}
                            </span>
                            {i.status === 'PENDING' && (
                                <span className={`${badge} ${TONE[wait.tone]}`}>
                                    <Clock className="h-3 w-3" /> {wait.text}
                                </span>
                            )}
                            {i.consultantEmploymentStatus !== 'ACTIVE' && (
                                <EmploymentStatus status={i.consultantEmploymentStatus} />
                            )}
                            {i.revisionNo > 1 && (
                                <span className={`${badge} ${TONE.neutral}`}>revision {i.revisionNo}</span>
                            )}
                        </p>
                    </div>
                    {i.status !== 'PENDING' && (
                        <span className={`${badge} ${i.status === 'APPROVED' ? TONE.success : TONE.danger}`}>
                            {i.statusLabel}
                        </span>
                    )}
                </div>

                <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
                    {i.approvedText ?? i.proposedText}
                </p>

                {i.wasCorrected && (
                    <p className="mt-2 text-xs text-slate-500">
                        Corrected on approval. Original: <span className="line-through">{i.proposedText}</span>
                    </p>
                )}
                {i.reviewNote && (
                    <p className="mt-2 text-xs text-slate-500"><strong>Note:</strong> {i.reviewNote}</p>
                )}
                {i.reviewedByName && (
                    <p className="mt-2 text-xs text-slate-400">
                        {i.statusLabel} by {i.reviewedByName} ({i.reviewedByRole})
                    </p>
                )}

                {i.status === 'PENDING' && (
                    i.canReview ? (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            <button type="button" onClick={() => open(i, 'APPROVE')} className={btnSm.success}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                            </button>
                            <button type="button" onClick={() => open(i, 'CORRECT')} className={btnSm.secondary}>
                                <Pencil className="h-3.5 w-3.5" /> Correct &amp; approve
                            </button>
                            <button type="button" onClick={() => open(i, 'REJECT')} className={btnSm.danger}>
                                <XCircle className="h-3.5 w-3.5" /> Reject
                            </button>
                        </div>
                    ) : (
                        <p className={`mt-3 flex items-center gap-1.5 rounded-lg p-2 text-xs ${TONE_ALERT.warning}`}>
                            <Lock className="h-3.5 w-3.5 shrink-0" /> {i.lockedReason}
                        </p>
                    )
                )}
            </div>
        );
    };

    return (
        <div>
            <h1 className={pageTitle}>Answer approvals</h1>
            <p className={pageSubtitle}>
                Answers become usable on job applications only once approved. Salary and
                work-authorization answers are decided by an organization admin.
            </p>

            <div className={`mt-5 ${tabBar}`}>
                <nav className={tabNav}>
                    {FILTERS.map((f) => (
                        <button
                            key={f.key} type="button" onClick={() => setFilter(f.key)}
                            className={`${tabItem} ${filter === f.key ? tabActive : tabIdle}`}
                        >
                            {f.label}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="mt-3 flex items-center justify-end">
                <button
                    type="button"
                    onClick={() => setGrouped((v) => !v)}
                    className={btnSm.secondary}
                    title="Group items that ask the same question"
                >
                    <Users className="h-3.5 w-3.5" />
                    {grouped ? 'Ungroup' : 'Group by question'}
                </button>
            </div>

            {items.length === 0 && (
                <div className={`mt-4 ${card} ${cardPad} text-center`}>
                    <Inbox className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-500">Nothing here.</p>
                </div>
            )}

            <div className="mt-4 space-y-6">
                {groups.map((g) => (
                    <div key={g.key}>
                        <h2 className={sectionTitle}>
                            {g.question}
                            {grouped && g.rows.length > 1 && (
                                <span className={`ml-2 ${badge} ${TONE.brand}`}>
                                    {g.rows.length} consultants
                                </span>
                            )}
                        </h2>
                        {grouped && g.rows.length > 1 && (
                            <p className="mt-0.5 text-xs text-slate-400">
                                Grouped for speed — each is still approved and audited separately.
                            </p>
                        )}
                        <div className="mt-2 space-y-3">
                            {g.rows.map((i) => <Row key={i.id} i={i} />)}
                        </div>
                    </div>
                ))}
            </div>

            <Pagination page={page} onChange={(p) => load(p)} />

            {target && (
                <Modal
                    size="md"
                    tone={mode === 'REJECT' ? 'danger' : 'success'}
                    icon={mode === 'REJECT' ? XCircle : CheckCircle2}
                    title={{
                        APPROVE: 'Approve this answer?',
                        CORRECT: 'Correct and approve',
                        REJECT: 'Reject this answer',
                    }[mode]}
                    subtitle={target.questionText}
                    onClose={() => setTarget(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setTarget(null)}
                            onConfirm={submit}
                            confirmLabel={{
                                APPROVE: 'Approve',
                                CORRECT: 'Save and approve',
                                REJECT: 'Reject',
                            }[mode]}
                            variant={mode === 'REJECT' ? 'danger' : 'primary'}
                            busy={busy}
                            disabled={
                                (mode === 'REJECT' && !note.trim())
                                || (mode === 'CORRECT' && !text.trim())
                            }
                            confirmTitle={mode === 'REJECT' && !note.trim()
                                ? 'A rejection needs a note' : undefined}
                        />
                    )}
                >
                    {dialogError && (
                        <div className={`mb-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{dialogError}</span>
                        </div>
                    )}

                    <p className="text-xs uppercase tracking-wide text-slate-400">
                        {target.consultantName} wrote
                    </p>
                    <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
                        {target.proposedText}
                    </p>

                    {mode === 'CORRECT' && (
                        <label className="mt-4 block">
                            <span className={fieldLabel}>Approved wording</span>
                            <textarea
                                value={text} onChange={(e) => setText(e.target.value)}
                                rows={4} maxLength={4000} autoFocus
                                className={`mt-1 ${inputBase}`}
                            />
                            <span className="mt-1 block text-xs text-slate-400">
                                Recorded as your edit. The consultant's original wording is kept.
                            </span>
                        </label>
                    )}

                    <label className="mt-4 block">
                        <span className={fieldLabel}>
                            {mode === 'REJECT' ? 'What should they change? (required)' : 'Note (optional)'}
                        </span>
                        <input
                            value={note} onChange={(e) => setNote(e.target.value)}
                            maxLength={500}
                            autoFocus={mode === 'REJECT'}
                            placeholder={mode === 'REJECT'
                                ? 'Be specific — this is what they see.'
                                : ''}
                            className={`mt-1 ${inputBase}`}
                        />
                    </label>
                </Modal>
            )}

            <AuditLogPanel module="answers" />
        </div>
    );
};

export default AnswerInbox;
