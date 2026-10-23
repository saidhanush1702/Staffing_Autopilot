import { useCallback, useEffect, useState } from 'react';
import {
    Plus, ScanSearch, Search, Star, Trash2, RefreshCw, Loader2, TriangleAlert, Building2, ChevronRight,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import TableShell from '../TableShell.jsx';
import Pagination from '../Pagination.jsx';
import Badge from '../ui/Badge.jsx';
import Alert from '../ui/Alert.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    btn, iconBtn, inputBase, searchInput, searchIcon, codeChip,
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, tableCellStrong,
    toggleTrack, toggleTrackOn, toggleTrackOff, toggleKnob, toggleKnobOn, toggleKnobOff,
    TONE_TEXT,
} from '../../design/tokens.js';
import { timeAgo, timeUntil } from '../../utils/relativeTime.js';
import { BOARD_STATUS, TIER_TONE } from './atsLabels.js';
import AddBoardModal from './AddBoardModal.jsx';
import FindBoardsModal from './FindBoardsModal.jsx';
import BoardDetails from './BoardDetails.jsx';

const SORTS = [
    ['activity', 'Most recent activity'],
    ['name', 'Name'],
    ['jobs', 'Most open jobs'],
    ['polled', 'Last read'],
];

const AtsBoards = ({ isAdmin, families, onChanged }) => {
    const { labelFrom } = useLookups();

    const [filters, setFilters] = useState({ search: '', family: '', status: '', needsName: false, sort: 'activity' });
    const [searchDraft, setSearchDraft] = useState('');
    const [page, setPage] = useState(1);
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [banner, setBanner] = useState(null);
    const [busyId, setBusyId] = useState('');

    const [adding, setAdding] = useState(false);
    const [finding, setFinding] = useState(false);
    const [details, setDetails] = useState(null);
    const [removing, setRemoving] = useState(null);
    const [removeBusy, setRemoveBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get('/management/ats/boards', {
                params: {
                    page, limit: 25, sort: filters.sort,
                    search: filters.search || undefined,
                    family: filters.family || undefined,
                    status: filters.status || undefined,
                    needsName: filters.needsName || undefined,
                },
            });
            setResult(data);
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [page, filters]);

    useEffect(() => { load(); }, [load]);

    // Debounce the search box so typing does not fire a request per keystroke.
    useEffect(() => {
        const t = setTimeout(() => { setFilters((f) => (f.search === searchDraft ? f : { ...f, search: searchDraft })); setPage(1); }, 300);
        return () => clearTimeout(t);
    }, [searchDraft]);

    const refresh = async () => { await Promise.all([load(), onChanged()]); };

    const act = async (id, fn, okText) => {
        setBusyId(id);
        setBanner(null);
        try {
            await fn();
            if (okText) setBanner({ tone: 'success', text: okText });
            await refresh();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusyId('');
        }
    };

    const pollNow = (b) => act(b.id, async () => {
        const { data } = await api.post(`/management/ats/boards/${b.id}/poll`);
        const r = data.run;
        setBanner({
            tone: r.outcome === 'ERROR' || r.outcome === 'NOT_FOUND' ? 'danger' : 'success',
            text: r.outcome === 'ERROR' || r.outcome === 'NOT_FOUND'
                ? `${b.companyName ?? b.boardKey}: ${r.error}`
                : `${b.companyName ?? b.boardKey}: ${r.jobs_listed} listed, ${r.new_found} new, `
                    + `${r.closed} closed${r.outcome === 'NOT_MODIFIED' ? ' (no change since last read)' : ''}.`,
        });
    });

    const rows = result?.data ?? [];
    const filtered = filters.search || filters.family || filters.status || filters.needsName;

    return (
        <div>
            {/* ── toolbar ───────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative min-w-[14rem] flex-1">
                    <Search className={searchIcon} />
                    <input
                        className={searchInput} placeholder="Search employer or board…"
                        value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)}
                        aria-label="Search boards"
                    />
                </div>

                <select
                    className={`${inputBase} w-auto`} aria-label="Career system"
                    value={filters.family}
                    onChange={(e) => { setFilters({ ...filters, family: e.target.value }); setPage(1); }}
                >
                    <option value="">All systems</option>
                    {families.map((f) => <option key={f.id} value={f.name}>{labelFrom('atsFamilies', f.name)}</option>)}
                </select>

                <select
                    className={`${inputBase} w-auto`} aria-label="Status"
                    value={filters.status}
                    onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}
                >
                    <option value="">Any status</option>
                    {Object.entries(BOARD_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>

                <select
                    className={`${inputBase} w-auto`} aria-label="Sort"
                    value={filters.sort}
                    onChange={(e) => { setFilters({ ...filters, sort: e.target.value }); setPage(1); }}
                >
                    {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>

                {isAdmin && (
                    <>
                        <button type="button" className={btn.secondary} onClick={() => setFinding(true)}>
                            <ScanSearch className="h-4 w-4" /> Find boards
                        </button>
                        <button type="button" className={btn.primary} onClick={() => setAdding(true)}>
                            <Plus className="h-4 w-4" /> Add board
                        </button>
                    </>
                )}
            </div>

            {banner && (
                <Alert className="mt-4" tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Alert>
            )}
            {error && <Alert className="mt-4" tone="danger">{error}</Alert>}

            {/* ── the registry ──────────────────────────────────────── */}
            <div className="mt-4">
                {!result && !error && (
                    <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
                )}

                {result && rows.length === 0 && (
                    <EmptyState
                        icon={Building2}
                        title={filtered ? 'No boards match' : 'No boards yet'}
                        body={filtered
                            ? 'Try a different search or clear the filters.'
                            : 'Paste a careers link — Greenhouse, Lever, Ashby, Workday or SmartRecruiters — or let the mirror find boards for the companies already in your pool.'}
                        action={isAdmin && !filtered && (
                            <button type="button" className={btn.primary} onClick={() => setAdding(true)}>
                                <Plus className="h-4 w-4" /> Add the first board
                            </button>
                        )}
                    />
                )}

                {result && rows.length > 0 && (
                    <TableShell minWidth={980} footer={<Pagination page={result.page} onChange={setPage} />}>
                        <thead className={tableHead}>
                            <tr>
                                <th className={tableHeadCell}>Employer</th>
                                <th className={tableHeadCell}>Status</th>
                                <th className={`${tableHeadCell} text-right`}>Open jobs</th>
                                <th className={tableHeadCell}>Read</th>
                                <th className={tableHeadCell}>Last new job</th>
                                <th className={`${tableHeadCell} text-right`}>Actions</th>
                            </tr>
                        </thead>
                        <tbody className={tableBody}>
                            {rows.map((b) => {
                                const status = BOARD_STATUS[b.status] ?? BOARD_STATUS.PENDING;
                                const busy = busyId === b.id;
                                return (
                                    <tr key={b.id} className={tableRow}>
                                        <td className={tableCellStrong}>
                                            <button
                                                type="button" onClick={() => setDetails(b)}
                                                className="group flex items-center gap-1.5 text-left hover:text-brand-700"
                                            >
                                                <span className="min-w-0">
                                                    <span className="block truncate">{b.companyName ?? b.boardKey}</span>
                                                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                                        <Badge tone="neutral">{labelFrom('atsFamilies', b.family)}</Badge>
                                                        <code className={codeChip}>{b.boardKey}</code>
                                                        {b.needsCompanyName && (
                                                            <Badge tone="warning" icon={TriangleAlert}
                                                                title="Without the company's real name, jobs from this board are noticed but never queued — a guessed name would not match the same job found elsewhere.">
                                                                Needs company name
                                                            </Badge>
                                                        )}
                                                    </span>
                                                </span>
                                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300 group-hover:text-brand-600" />
                                            </button>
                                        </td>
                                        <td className={tableCell}>
                                            <Badge tone={b.isEnabled ? status.tone : 'neutral'} icon={status.icon}
                                                title={b.lastError ?? undefined}>
                                                {b.isEnabled ? status.label : 'Paused'}
                                            </Badge>
                                        </td>
                                        <td className={`${tableCell} text-right tabular-nums`}>{b.jobsOpen.toLocaleString()}</td>
                                        <td className={tableCell}>
                                            <span className="flex items-center gap-2">
                                                <Badge tone={TIER_TONE[b.tier]} variant="outline">{b.tier}</Badge>
                                                <span className="text-xs text-slate-500">
                                                    {b.cadence}
                                                    <span className="block text-slate-400">
                                                        {b.lastPolledAt ? `last ${timeAgo(b.lastPolledAt)}` : 'not read yet'}
                                                        {b.isEnabled && b.nextPollAt ? ` · next ${timeUntil(b.nextPollAt)}` : ''}
                                                    </span>
                                                </span>
                                            </span>
                                        </td>
                                        <td className={tableCell}>
                                            <span className="text-xs text-slate-600">{b.lastChangedAt ? timeAgo(b.lastChangedAt) : '—'}</span>
                                            <span className="block text-xs text-slate-400">
                                                {b.jobsDetected.toLocaleString()} noticed · {b.jobsQueued.toLocaleString()} queued
                                            </span>
                                        </td>
                                        <td className={`${tableCell} text-right`}>
                                            <span className="inline-flex items-center justify-end gap-1">
                                                {isAdmin && (
                                                    <>
                                                        <button
                                                            type="button" className={`${iconBtn} ${b.isPriority ? TONE_TEXT.warning : ''}`}
                                                            title={b.isPriority ? 'Priority: always read at the fastest rate. Click to remove.' : 'Make priority: always read at the fastest rate'}
                                                            aria-pressed={b.isPriority} disabled={busy}
                                                            onClick={() => act(b.id, () => api.patch(`/management/ats/boards/${b.id}`, { isPriority: !b.isPriority }))}
                                                        >
                                                            <Star className="h-4 w-4" fill={b.isPriority ? 'currentColor' : 'none'} />
                                                        </button>
                                                        <button
                                                            type="button" className={iconBtn} title="Read this board now" disabled={busy}
                                                            onClick={() => pollNow(b)}
                                                        >
                                                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                                        </button>
                                                        <button
                                                            type="button" role="switch" aria-checked={b.isEnabled}
                                                            aria-label={b.isEnabled ? 'Pause this board' : 'Resume this board'}
                                                            title={b.isEnabled ? 'Pause this board' : 'Resume this board'}
                                                            disabled={busy}
                                                            onClick={() => act(b.id, () => api.patch(`/management/ats/boards/${b.id}`, { isEnabled: !b.isEnabled }))}
                                                            className={`${toggleTrack} ${b.isEnabled ? toggleTrackOn : toggleTrackOff} mx-1`}
                                                        >
                                                            <span className={`${toggleKnob} ${b.isEnabled ? toggleKnobOn : toggleKnobOff}`} />
                                                        </button>
                                                        <button
                                                            type="button" className={iconBtn} title="Remove this board" disabled={busy}
                                                            onClick={() => setRemoving(b)}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </>
                                                )}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </TableShell>
                )}
            </div>

            {adding && (
                <AddBoardModal
                    onClose={() => setAdding(false)}
                    onAdded={async (text) => { setBanner({ tone: 'success', text }); await refresh(); }}
                />
            )}

            {finding && (
                <FindBoardsModal
                    onClose={() => setFinding(false)}
                    onAdded={async (text) => { setBanner({ tone: 'success', text }); await refresh(); }}
                />
            )}

            {details && (
                <BoardDetails
                    boardId={details.id} isAdmin={isAdmin}
                    onClose={() => setDetails(null)}
                    onChanged={refresh}
                />
            )}

            {removing && (
                <Modal
                    size="sm" tone="danger" icon={Trash2}
                    title={`Remove ${removing.companyName ?? removing.boardKey}?`}
                    onClose={() => setRemoving(null)}
                    footer={(
                        <ModalActions
                            onCancel={() => setRemoving(null)} confirmLabel="Remove board" variant="danger"
                            busy={removeBusy}
                            onConfirm={async () => {
                                setRemoveBusy(true);
                                await act(removing.id, () => api.delete(`/management/ats/boards/${removing.id}`),
                                    `${removing.companyName ?? removing.boardKey} was removed.`);
                                setRemoveBusy(false);
                                setRemoving(null);
                            }}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        This stops watching the board and forgets what it listed. Postings it already produced
                        <strong> stay</strong> in the pool — they are real jobs and may already be in consultants&apos; queues.
                    </p>
                    <p className="mt-3 text-sm text-slate-600">
                        If you add the board again later it will be treated as new, and its existing jobs
                        will be remembered without being queued.
                    </p>
                </Modal>
            )}
        </div>
    );
};

export default AtsBoards;
