import { useCallback, useEffect, useState } from 'react';
import { Building2, Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal from '../ui/Modal.jsx';
import Badge from '../ui/Badge.jsx';
import Alert from '../ui/Alert.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    btnSm, eyebrow, codeChip, input, fieldLabel, fieldHint,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, TONE_TEXT,
} from '../../design/tokens.js';
import { formatDateTime } from '../../utils/datetime.js';
import { timeAgo, timeUntil, formatDuration, formatBytes } from '../../utils/relativeTime.js';
import { BOARD_STATUS, JOB_STATE, RUN_OUTCOME } from './atsLabels.js';

const Fact = ({ label, children }) => (
    <div>
        <p className={eyebrow}>{label}</p>
        <div className="mt-1 text-sm text-slate-800">{children}</div>
    </div>
);

/**
 * One board, in full: how it is being read, what it has produced, and how its
 * recent reads went. Opened from the registry; read-only apart from the company
 * name (the one field an operator genuinely has to be able to fix) and a manual
 * read.
 */
const BoardDetails = ({ boardId, isAdmin, onClose, onChanged }) => {
    const { labelFrom } = useLookups();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState('');
    const [note, setNote] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get(`/management/ats/boards/${boardId}`);
            setData(d);
            setName(d.board.companyName ?? '');
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [boardId]);

    useEffect(() => { load(); }, [load]);

    const saveName = async () => {
        setBusy('name'); setNote(null);
        try {
            await api.patch(`/management/ats/boards/${boardId}`, { companyName: name.trim() });
            setNote({ tone: 'success', text: 'Company name saved.' });
            await Promise.all([load(), onChanged()]);
        } catch (err) {
            setNote({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy('');
        }
    };

    const pollNow = async () => {
        setBusy('poll'); setNote(null);
        try {
            const { data: d } = await api.post(`/management/ats/boards/${boardId}/poll`);
            const r = d.run;
            setNote(r.outcome === 'ERROR' || r.outcome === 'NOT_FOUND'
                ? { tone: 'danger', text: r.error }
                : { tone: 'success', text: `${r.jobs_listed} listed, ${r.new_found} new, ${r.closed} closed.` });
            await Promise.all([load(), onChanged()]);
        } catch (err) {
            setNote({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy('');
        }
    };

    const b = data?.board;
    const status = b ? (BOARD_STATUS[b.status] ?? BOARD_STATUS.PENDING) : null;

    return (
        <Modal
            size="xl" icon={Building2} tone="brand" scrollBody
            title={b ? (b.companyName ?? b.boardKey) : 'Board'}
            subtitle={b ? `${labelFrom('atsFamilies', b.family)} · ${b.boardKey}` : undefined}
            onClose={onClose}
        >
            {!data && !error && (
                <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
            )}
            {error && <Alert tone="danger">{error}</Alert>}
            {note && <Alert className="mb-4" tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Alert>}

            {b && (
                <div className="space-y-6">
                    {b.lastError && <Alert tone="warning" title="Last read failed">{b.lastError}</Alert>}

                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                        <Fact label="Status">
                            <Badge tone={b.isEnabled ? status.tone : 'neutral'} icon={status.icon}>
                                {b.isEnabled ? status.label : 'Paused'}
                            </Badge>
                        </Fact>
                        <Fact label="Reads">{b.cadence}</Fact>
                        <Fact label="Last read">{b.lastPolledAt ? timeAgo(b.lastPolledAt) : 'not yet'}</Fact>
                        <Fact label="Next read">{b.isEnabled ? timeUntil(b.nextPollAt) : 'paused'}</Fact>
                        <Fact label="Open jobs">{b.jobsOpen.toLocaleString()}</Fact>
                        <Fact label="Noticed">{b.jobsDetected.toLocaleString()}</Fact>
                        <Fact label="Added to pool">{b.jobsIngested.toLocaleString()}</Fact>
                        <Fact label="Queued">{b.jobsQueued.toLocaleString()}</Fact>
                    </div>

                    {b.careersUrl && (
                        <a href={b.careersUrl} target="_blank" rel="noreferrer noopener"
                            className="inline-flex items-center gap-1.5 text-sm text-brand-700 hover:underline">
                            <ExternalLink className="h-3.5 w-3.5" /> Open careers page
                        </a>
                    )}

                    {isAdmin && (
                        <div className="flex flex-wrap items-end gap-3">
                            <label className="block min-w-[16rem] flex-1">
                                <span className={fieldLabel}>Company name</span>
                                <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
                                <span className={fieldHint}>
                                    {b.needsCompanyName
                                        ? 'Required before this board can queue anything.'
                                        : 'As it appears on your other postings.'}
                                </span>
                            </label>
                            <button type="button" className={btnSm.secondary}
                                disabled={busy !== '' || !name.trim() || name.trim() === (b.companyName ?? '')}
                                onClick={saveName}>
                                {busy === 'name' && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save name
                            </button>
                            <button type="button" className={btnSm.secondary} disabled={busy !== ''} onClick={pollNow}>
                                {busy === 'poll' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                Read now
                            </button>
                        </div>
                    )}

                    {/* ── what it noticed ─────────────────────────────── */}
                    <section>
                        <h3 className={eyebrow}>Recently noticed</h3>
                        {data.jobs.length === 0 ? (
                            <p className="mt-2 text-sm text-slate-500">
                                Nothing new yet. Jobs already open when the board was first read are remembered, not listed here.
                            </p>
                        ) : (
                            <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                                <table className="w-full text-sm" style={{ minWidth: 640 }}>
                                    <thead className={tableHead}>
                                        <tr>
                                            <th className={tableHeadCell}>Job</th>
                                            <th className={tableHeadCell}>State</th>
                                            <th className={tableHeadCell}>Noticed</th>
                                            <th className={`${tableHeadCell} text-right`}>Delay</th>
                                        </tr>
                                    </thead>
                                    <tbody className={tableBody}>
                                        {data.jobs.map((j) => {
                                            const st = JOB_STATE[j.state] ?? JOB_STATE.DETECTED;
                                            return (
                                                <tr key={j.ext_id} className={tableRow}>
                                                    <td className={tableCell}>
                                                        <span className="block max-w-xs truncate font-medium text-slate-900">{j.title}</span>
                                                        <span className="text-xs text-slate-500">{j.location_text ?? '—'}</span>
                                                    </td>
                                                    <td className={tableCell}>
                                                        <Badge tone={st.tone} icon={st.icon}>{st.label}</Badge>
                                                        {j.closed_at && <Badge tone="neutral" className="ml-1">Taken down</Badge>}
                                                    </td>
                                                    <td className={tableCell} title={formatDateTime(j.first_seen_at)}>{timeAgo(j.first_seen_at)}</td>
                                                    <td className={`${tableCell} text-right tabular-nums`}>{formatDuration(j.latency_s)}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    {/* ── recent reads ────────────────────────────────── */}
                    <section>
                        <h3 className={eyebrow}>Recent reads</h3>
                        {data.runs.length === 0 ? (
                            <p className="mt-2 text-sm text-slate-500">This board has not been read yet.</p>
                        ) : (
                            <div className="mt-2 overflow-x-auto rounded-lg border border-line">
                                <table className="w-full text-sm" style={{ minWidth: 640 }}>
                                    <thead className={tableHead}>
                                        <tr>
                                            <th className={tableHeadCell}>When</th>
                                            <th className={tableHeadCell}>Result</th>
                                            <th className={`${tableHeadCell} text-right`}>Listed</th>
                                            <th className={`${tableHeadCell} text-right`}>New</th>
                                            <th className={`${tableHeadCell} text-right`}>Size</th>
                                            <th className={`${tableHeadCell} text-right`}>Took</th>
                                        </tr>
                                    </thead>
                                    <tbody className={tableBody}>
                                        {data.runs.map((r, i) => {
                                            const o = RUN_OUTCOME[r.outcome] ?? RUN_OUTCOME.OK;
                                            return (
                                                <tr key={i} className={tableRow}>
                                                    <td className={tableCell} title={formatDateTime(r.started_at)}>
                                                        {timeAgo(r.started_at)}
                                                        <span className="ml-1.5 text-xs text-slate-400">{r.trigger.toLowerCase()}</span>
                                                    </td>
                                                    <td className={tableCell}>
                                                        <Badge tone={o.tone} icon={o.icon}>{o.label}</Badge>
                                                        {r.error && <span className={`ml-2 text-xs ${TONE_TEXT.danger}`}>{r.error}</span>}
                                                    </td>
                                                    <td className={`${tableCell} text-right tabular-nums`}>{r.jobs_listed}</td>
                                                    <td className={`${tableCell} text-right tabular-nums`}>{r.new_found}</td>
                                                    <td className={`${tableCell} text-right tabular-nums`}>{formatBytes(r.bytes)}</td>
                                                    <td className={`${tableCell} text-right tabular-nums`}>{r.duration_ms} ms</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>

                    <p className="text-xs text-slate-400">
                        Board id <code className={codeChip}>{b.id}</code>
                    </p>
                </div>
            )}
        </Modal>
    );
};

export default BoardDetails;
