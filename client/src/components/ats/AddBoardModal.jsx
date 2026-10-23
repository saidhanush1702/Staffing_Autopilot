import { useState } from 'react';
import { Plus, CheckCircle2, Loader2, Link2, ListPlus, Star } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import Alert from '../ui/Alert.jsx';
import Badge from '../ui/Badge.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    input, fieldLabel, fieldHint, fieldError, requiredMark, checkbox, cardQuiet,
    segmentGroup, segmentItem, segmentActive, segmentIdle, eyebrow,
} from '../../design/tokens.js';

const EXAMPLES = [
    'https://boards.greenhouse.io/stripe',
    'https://jobs.lever.co/palantir',
    'https://jobs.ashbyhq.com/ramp',
    'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
    'https://careers.smartrecruiters.com/BoschGroup',
];

/** "url, Company Name" per line → [{ input, companyName }]. */
export const parseLines = (text) => text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
        // The first comma / tab / pipe after the link separates the company
        // name. Careers URLs essentially never contain one.
        const m = /^(\S+)\s*[,\t|]\s*(.+)$/.exec(line);
        return m ? { input: m[1], companyName: m[2].trim() } : { input: line.split(/\s+/)[0] };
    });

/**
 * Add one employer board — or many.
 *
 * ONE board is verified before it is saved: the address is read, and the
 * operator sees the job count and a few real titles. "It answered" proves the
 * address exists; the titles prove it is the right company. Nothing is written
 * until they press Add.
 *
 * MANY boards are not verified one by one (200 round trips would outlast any
 * request); they go in as "waiting for first read" and the scheduler checks
 * them over the next few minutes. One that does not exist is parked.
 */
const AddBoardModal = ({ onClose, onAdded }) => {
    const { labelFrom } = useLookups();

    const [mode, setMode] = useState('ONE');
    const [link, setLink] = useState('');
    const [probe, setProbe] = useState(null);
    const [name, setName] = useState('');
    const [priority, setPriority] = useState(false);
    const [bulk, setBulk] = useState('');
    const [bulkResult, setBulkResult] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const reset = () => { setProbe(null); setError(''); };

    const verify = async (e) => {
        e?.preventDefault();
        setBusy('verify'); setError(''); setProbe(null);
        try {
            const { data } = await api.post('/management/ats/probe', { input: link });
            setProbe(data);
            setName(data.suggestedCompanyName ?? '');
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy('');
        }
    };

    const addOne = async (e) => {
        e?.preventDefault();
        setBusy('add'); setError('');
        try {
            const { data } = await api.post('/management/ats/boards', {
                input: link, companyName: name, isPriority: priority,
            });
            const run = data.firstPoll;
            await onAdded(
                `${data.board.companyName ?? data.board.boardKey} added`
                + (run ? ` — ${run.jobs_listed} jobs read, ${run.new_found} fresh.` : '.'),
            );
            onClose();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy('');
        }
    };

    const addMany = async (e) => {
        e?.preventDefault();
        const items = parseLines(bulk);
        if (items.length === 0) return;
        setBusy('bulk'); setError('');
        try {
            const { data } = await api.post('/management/ats/boards/bulk', { items });
            setBulkResult(data);
            await onAdded(`${data.added} board${data.added === 1 ? '' : 's'} added — they will be read over the next few minutes.`);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy('');
        }
    };

    const needsName = probe?.needsCompanyName;
    const canAdd = probe && !probe.alreadyRegistered && (!needsName || name.trim().length > 0);
    const lines = parseLines(bulk);

    return (
        <Modal
            size="lg" icon={Plus} tone="brand"
            title="Add employer boards"
            subtitle="Paste the link you see when you open the employer's careers page."
            onClose={onClose}
            footer={bulkResult ? (
                <ModalActions onCancel={onClose} cancelLabel="Done" confirmLabel="Add more"
                    onConfirm={() => { setBulkResult(null); setBulk(''); }} />
            ) : mode === 'ONE' ? (
                <ModalActions
                    onCancel={onClose}
                    confirmLabel={probe ? 'Add board' : 'Verify'}
                    busy={busy === 'add' || busy === 'verify'}
                    disabled={probe ? !canAdd : link.trim().length < 3}
                    onConfirm={probe ? addOne : verify}
                />
            ) : (
                <ModalActions
                    onCancel={onClose} confirmLabel={`Add ${lines.length || ''} board${lines.length === 1 ? '' : 's'}`.replace('  ', ' ')}
                    busy={busy === 'bulk'} disabled={lines.length === 0} onConfirm={addMany}
                />
            )}
        >
            <div className={segmentGroup} role="group" aria-label="How many">
                {[['ONE', 'One board', Link2], ['MANY', 'Paste a list', ListPlus]].map(([k, label, Icon]) => (
                    <button
                        key={k} type="button" aria-pressed={mode === k}
                        onClick={() => { setMode(k); setError(''); }}
                        className={`${segmentItem} ${mode === k ? segmentActive : segmentIdle} inline-flex items-center gap-1.5`}
                    >
                        <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                ))}
            </div>

            {error && <Alert className="mt-4" tone="danger">{error}</Alert>}

            {/* ── one board ───────────────────────────────────────── */}
            {mode === 'ONE' && (
                <form onSubmit={probe ? addOne : verify} className="mt-5 space-y-4">
                    <label className="block">
                        <span className={fieldLabel}>Careers link</span>
                        <input
                            className={input} autoFocus value={link}
                            onChange={(e) => { setLink(e.target.value); if (probe) reset(); }}
                            placeholder="https://boards.greenhouse.io/stripe  or  lever:palantir"
                        />
                        <span className={fieldHint}>
                            Greenhouse, Lever, Ashby, Workday or SmartRecruiters. A link to any single job on the
                            board works too.
                        </span>
                    </label>

                    {!probe && (
                        <div>
                            <p className={eyebrow}>Examples</p>
                            <ul className="mt-1.5 space-y-1">
                                {EXAMPLES.map((ex) => (
                                    <li key={ex}>
                                        <button type="button" className="text-left text-xs text-brand-700 hover:underline"
                                            onClick={() => setLink(ex)}>{ex}</button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {busy === 'verify' && (
                        <p className="flex items-center gap-2 text-sm text-slate-500">
                            <Loader2 className="h-4 w-4 animate-spin" /> Reading the board…
                        </p>
                    )}

                    {probe && (
                        <div className={`${cardQuiet} p-4`}>
                            <div className="flex flex-wrap items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-success-600" />
                                <span className="text-sm font-medium text-slate-900">
                                    Found a {labelFrom('atsFamilies', probe.family)} board with{' '}
                                    {probe.total.toLocaleString()} open job{probe.total === 1 ? '' : 's'}
                                </span>
                                <Badge tone="neutral">{probe.key}</Badge>
                            </div>

                            {probe.sample.length > 0 && (
                                <ul className="mt-3 space-y-0.5 text-sm text-slate-600">
                                    {probe.sample.map((t, i) => <li key={i} className="truncate">• {t}</li>)}
                                </ul>
                            )}

                            {probe.alreadyRegistered && (
                                <Alert className="mt-3" tone="warning">This board is already in your registry.</Alert>
                            )}
                        </div>
                    )}

                    {probe && !probe.alreadyRegistered && (
                        <>
                            <label className="block">
                                <span className={fieldLabel}>
                                    Company name {needsName && <span className={requiredMark}>*</span>}
                                </span>
                                <input className={input} value={name} onChange={(e) => setName(e.target.value)}
                                    placeholder="Exactly as it appears on your postings" />
                                {needsName && !name.trim() && (
                                    <span className={fieldError}>
                                        {labelFrom('atsFamilies', probe.family)} does not say which company this is.
                                    </span>
                                )}
                                <span className={fieldHint}>
                                    This is what stops the same job being queued twice when another source also finds it,
                                    so use the name your other postings use.
                                </span>
                            </label>

                            <label className="flex items-start gap-3">
                                <input type="checkbox" className={`${checkbox} mt-0.5`}
                                    checked={priority} onChange={(e) => setPriority(e.target.checked)} />
                                <span>
                                    <span className={`${fieldLabel} inline-flex items-center gap-1.5`}>
                                        <Star className="h-3.5 w-3.5" /> Priority
                                    </span>
                                    <span className={`block ${fieldHint}`}>
                                        Always read at the fastest rate, even when it has been quiet.
                                    </span>
                                </span>
                            </label>
                        </>
                    )}
                </form>
            )}

            {/* ── many boards ─────────────────────────────────────── */}
            {mode === 'MANY' && !bulkResult && (
                <form onSubmit={addMany} className="mt-5 space-y-3">
                    <label className="block">
                        <span className={fieldLabel}>One board per line</span>
                        <textarea
                            rows={8} className={`${input} font-mono text-xs`} value={bulk}
                            onChange={(e) => setBulk(e.target.value)}
                            placeholder={'https://jobs.lever.co/acme, Acme Corporation\nhttps://boards.greenhouse.io/northwindlabs, Northwind Labs\nlever:modeln, Model N'}
                        />
                        <span className={fieldHint}>
                            Add the company name after a comma. Greenhouse and SmartRecruiters can name themselves; for
                            Lever, Ashby and Workday a board without a name is watched but never queued.
                        </span>
                    </label>
                    <p className="text-xs text-slate-500">
                        {lines.length === 0 ? 'Nothing to add yet.' : `${lines.length} line${lines.length === 1 ? '' : 's'} ready.`}
                    </p>
                </form>
            )}

            {mode === 'MANY' && bulkResult && (
                <div className="mt-5 space-y-3">
                    <Alert tone="success">
                        {bulkResult.added} added,{' '}
                        {bulkResult.results.filter((r) => r.result === 'exists').length} already in the registry,{' '}
                        {bulkResult.results.filter((r) => r.result === 'invalid').length} not recognised.
                    </Alert>
                    {bulkResult.results.some((r) => r.result === 'invalid') && (
                        <div>
                            <p className={eyebrow}>Not recognised</p>
                            <ul className="mt-1.5 space-y-0.5 text-xs text-slate-600">
                                {bulkResult.results.filter((r) => r.result === 'invalid').map((r, i) => (
                                    <li key={i} className="truncate font-mono">{r.input}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
};

export default AddBoardModal;
