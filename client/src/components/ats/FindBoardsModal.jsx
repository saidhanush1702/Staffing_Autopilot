import { useCallback, useEffect, useRef, useState } from 'react';
import { ScanSearch, Loader2, CheckCircle2, CircleHelp, Square, Play, Briefcase } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import Alert from '../ui/Alert.jsx';
import Badge from '../ui/Badge.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    btn, checkbox, eyebrow, proseMuted, dividerList, meterTrack, meterFill,
    segmentGroup, segmentItem, segmentActive, segmentIdle,
} from '../../design/tokens.js';

/**
 * Find boards for employers you already deal with.
 *
 * Two ways, both PROPOSALS — nothing is saved until the operator ticks rows and
 * presses Add:
 *
 *   From your postings   some posting links already point at a career system.
 *                        Free, and every hit is a board we know exists.
 *   By company name      guesses each company's board address and checks it.
 *                        A hit on Greenhouse can be confirmed by name; on Lever
 *                        or Ashby it only proves SOME company owns that
 *                        address, so those are shown with their job titles and
 *                        left for a person to judge.
 */
const FindBoardsModal = ({ onClose, onAdded }) => {
    const { labelFrom } = useLookups();

    const [tab, setTab] = useState('POSTINGS');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // from postings
    const [fromPostings, setFromPostings] = useState(null);
    // by company
    const [found, setFound] = useState([]);
    const [scanning, setScanning] = useState(false);
    const [progress, setProgress] = useState({ scanned: 0, total: 0 });
    const [scanned, setScanned] = useState(false);
    const stop = useRef(false);

    const [picked, setPicked] = useState(new Set());

    useEffect(() => () => { stop.current = true; }, []);

    const loadPostings = useCallback(async () => {
        setError('');
        try {
            const { data } = await api.get('/management/ats/discover/postings');
            setFromPostings(data.candidates.map((c) => ({
                id: `${c.family}:${c.key}`, family: c.family, input: c.input, companyName: c.companyName,
                title: c.companyName ?? c.key, detail: `${c.postings} posting${c.postings === 1 ? '' : 's'} in your pool`,
                key: c.key, verified: true,
            })));
            setPicked(new Set(data.candidates.map((c) => `${c.family}:${c.key}`)));
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { loadPostings(); }, [loadPostings]);

    const startScan = async () => {
        stop.current = false;
        setScanning(true); setError(''); setFound([]); setScanned(true);
        setPicked(new Set());
        let offset = 0;
        try {
            // Short batches, so each request stays well inside any timeout and
            // the bar moves; the server skips companies a board already covers.
            for (;;) {
                if (stop.current) break;
                const { data } = await api.post('/management/ats/discover/companies', { offset, limit: 8 });
                setProgress({ scanned: data.nextOffset, total: data.totalCompanies });

                const rows = data.results.map((r) => ({
                    id: `${r.family}:${r.key}`, family: r.family, input: r.input, companyName: r.company,
                    title: r.company, key: r.key, verified: r.verified,
                    detail: `${r.total.toLocaleString()} open · ${r.sample.slice(0, 2).join(' · ')}`,
                    boardName: r.boardName,
                }));
                setFound((prev) => {
                    const have = new Set(prev.map((p) => p.id));
                    return [...prev, ...rows.filter((r) => !have.has(r.id))];
                });
                // Verified hits are ticked for you; a guess is left for a person.
                setPicked((prev) => new Set([...prev, ...rows.filter((r) => r.verified).map((r) => r.id)]));

                if (data.done || data.scanned === 0) break;
                offset = data.nextOffset;
            }
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setScanning(false);
        }
    };

    const list = tab === 'POSTINGS' ? (fromPostings ?? []) : found;
    const chosen = list.filter((r) => picked.has(r.id));

    const toggle = (id) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    const switchTab = (t) => {
        if (scanning) return;
        setTab(t);
        setPicked(new Set((t === 'POSTINGS' ? (fromPostings ?? []) : found).filter((r) => r.verified).map((r) => r.id)));
    };

    const add = async () => {
        setBusy(true); setError('');
        try {
            const { data } = await api.post('/management/ats/boards/bulk', {
                items: chosen.map((c) => ({ input: c.input, companyName: c.companyName })),
            });
            await onAdded(`${data.added} board${data.added === 1 ? '' : 's'} added — they will be read over the next few minutes.`);
            onClose();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const pct = progress.total ? Math.min(100, Math.round((progress.scanned / progress.total) * 100)) : 0;

    return (
        <Modal
            size="xl" icon={ScanSearch} tone="brand"
            title="Find boards"
            subtitle="Employers already in your pool whose careers system the mirror can read."
            onClose={() => { stop.current = true; onClose(); }}
            scrollBody
            footer={(
                <ModalActions
                    onCancel={() => { stop.current = true; onClose(); }}
                    confirmLabel={`Add ${chosen.length} board${chosen.length === 1 ? '' : 's'}`}
                    busy={busy} disabled={chosen.length === 0 || scanning} onConfirm={add}
                    extra={tab === 'COMPANIES' && found.some((f) => !f.verified)
                        ? 'Unconfirmed matches are not ticked — check the job titles first.' : null}
                />
            )}
        >
            <div className={segmentGroup} role="group" aria-label="Where to look">
                {[['POSTINGS', 'From your postings', Briefcase], ['COMPANIES', 'By company name', ScanSearch]].map(([k, label, Icon]) => (
                    <button
                        key={k} type="button" aria-pressed={tab === k} onClick={() => switchTab(k)}
                        className={`${segmentItem} ${tab === k ? segmentActive : segmentIdle} inline-flex items-center gap-1.5`}
                    >
                        <Icon className="h-3.5 w-3.5" /> {label}
                    </button>
                ))}
            </div>

            {error && <Alert className="mt-4" tone="danger">{error}</Alert>}

            {tab === 'COMPANIES' && (
                <div className="mt-5">
                    <p className={proseMuted}>
                        For each company in your pool, checks the board addresses it is likely to have on Greenhouse,
                        Lever and Ashby. This makes a few requests per company, so it takes a minute or two.
                    </p>
                    <div className="mt-3 flex items-center gap-3">
                        {!scanning ? (
                            <button type="button" className={btn.secondary} onClick={startScan}>
                                <Play className="h-4 w-4" /> {scanned ? 'Scan again' : 'Start scan'}
                            </button>
                        ) : (
                            <button type="button" className={btn.secondary} onClick={() => { stop.current = true; }}>
                                <Square className="h-4 w-4" /> Stop
                            </button>
                        )}
                        {scanned && (
                            <div className="min-w-0 flex-1">
                                <div className={meterTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                                    <div className={meterFill} style={{ width: `${pct}%` }} />
                                </div>
                                <p className="mt-1 text-xs text-slate-500">
                                    {progress.scanned.toLocaleString()} of {progress.total.toLocaleString()} companies checked
                                    · {found.length} board{found.length === 1 ? '' : 's'} found
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div className="mt-5">
                {tab === 'POSTINGS' && fromPostings === null && !error && (
                    <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>
                )}

                {list.length === 0 && (tab === 'COMPANIES' ? scanned && !scanning : fromPostings !== null) && (
                    <EmptyState
                        icon={ScanSearch}
                        title={tab === 'POSTINGS' ? 'Nothing new in your postings' : 'No boards found'}
                        body={tab === 'POSTINGS'
                            ? 'None of your posting links point at a career system that is not already in the registry. Try the company-name scan.'
                            : 'None of the companies checked have a board at the addresses tried. Add boards by pasting their careers links instead.'}
                    />
                )}

                {list.length > 0 && (
                    <>
                        <div className="mb-2 flex items-center justify-between">
                            <p className={eyebrow}>{list.length} found · {chosen.length} selected</p>
                            <button type="button" className="text-xs text-brand-700 hover:underline"
                                onClick={() => setPicked(chosen.length === list.length ? new Set() : new Set(list.map((r) => r.id)))}>
                                {chosen.length === list.length ? 'Clear all' : 'Select all'}
                            </button>
                        </div>
                        <ul className={`rounded-lg border border-line ${dividerList}`}>
                            {list.map((r) => (
                                <li key={r.id}>
                                    <label className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-surface-raised">
                                        <input type="checkbox" className={`${checkbox} mt-1`}
                                            checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-2">
                                                <span className="truncate text-sm font-medium text-slate-900">{r.title}</span>
                                                <Badge tone="neutral">{labelFrom('atsFamilies', r.family)}</Badge>
                                                {tab === 'COMPANIES' && (r.verified
                                                    ? <Badge tone="success" icon={CheckCircle2}>Name confirmed</Badge>
                                                    : <Badge tone="warning" icon={CircleHelp}
                                                        title="This system does not state the company's name, so only the job titles can tell you if it is the right employer.">
                                                        Check the jobs
                                                    </Badge>)}
                                            </span>
                                            <span className="mt-0.5 block truncate text-xs text-slate-500">{r.detail}</span>
                                            {tab === 'COMPANIES' && r.boardName && !r.verified && (
                                                <span className="block text-xs text-warning-700">Board calls itself &ldquo;{r.boardName}&rdquo;.</span>
                                            )}
                                        </span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </Modal>
    );
};

export default FindBoardsModal;
