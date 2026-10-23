import { useCallback, useEffect, useState } from 'react';
import { Loader2, Radio, ExternalLink } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import TableShell from '../TableShell.jsx';
import Badge from '../ui/Badge.jsx';
import Alert from '../ui/Alert.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import { useLookups } from '../../context/LookupContext.jsx';
import {
    inputBase, checkbox, tableHead, tableHeadCell, tableBody, tableRow, tableCell, tableCellStrong,
} from '../../design/tokens.js';
import { formatDateTime } from '../../utils/datetime.js';
import { timeAgo, formatDuration } from '../../utils/relativeTime.js';
import { JOB_STATE } from './atsLabels.js';

const REFRESH_MS = 15_000;

/**
 * The live feed: what the mirror has noticed, newest first, and how long each
 * took to notice.
 *
 * The "Delay" column is the whole product in one number — the time between an
 * employer publishing a job and us seeing it. It is blank (not zero) where it
 * cannot be known: systems that publish only a day (Workday), and jobs that were
 * already open when a board was first read.
 *
 * Refreshes itself while the tab is showing, because a feed that needs a
 * reload to be live is not one.
 */
const AtsFeed = () => {
    const { labelFrom } = useLookups();
    const [jobs, setJobs] = useState(null);
    const [state, setState] = useState('');
    const [auto, setAuto] = useState(true);
    const [error, setError] = useState('');
    const [, tick] = useState(0);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get('/management/ats/jobs', { params: { state: state || undefined, limit: 100 } });
            setJobs(data.jobs);
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [state]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!auto) return undefined;
        const id = setInterval(() => { load(); tick((n) => n + 1); }, REFRESH_MS);
        return () => clearInterval(id);
    }, [auto, load]);

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3">
                <select className={`${inputBase} w-auto`} aria-label="State" value={state} onChange={(e) => setState(e.target.value)}>
                    <option value="">Everything noticed</option>
                    {['OBSERVED', 'INGESTED', 'DUPLICATE', 'DETECTED', 'FAILED'].map((k) => (
                        <option key={k} value={k}>{JOB_STATE[k].label}</option>
                    ))}
                </select>
                <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" className={checkbox} checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                    <Radio className="h-3.5 w-3.5" /> Update automatically
                </label>
            </div>

            {error && <Alert className="mt-4" tone="danger">{error}</Alert>}

            <div className="mt-4">
                {!jobs && !error && <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>}

                {jobs && jobs.length === 0 && (
                    <EmptyState
                        icon={Radio} title="Nothing noticed yet"
                        body="Jobs appear here as watched boards publish them. Jobs that were already open when a board was added are not listed — they are remembered, not news."
                    />
                )}

                {jobs && jobs.length > 0 && (
                    <TableShell minWidth={900}>
                        <thead className={tableHead}>
                            <tr>
                                <th className={tableHeadCell}>Job</th>
                                <th className={tableHeadCell}>Employer</th>
                                <th className={tableHeadCell}>Result</th>
                                <th className={tableHeadCell}>Noticed</th>
                                <th className={`${tableHeadCell} text-right`} title="From the employer publishing it to us seeing it">Delay</th>
                                <th className={`${tableHeadCell} text-right`}>Matched</th>
                            </tr>
                        </thead>
                        <tbody className={tableBody}>
                            {jobs.map((j) => {
                                const st = JOB_STATE[j.state] ?? JOB_STATE.DETECTED;
                                return (
                                    <tr key={`${j.board_id}:${j.ext_id}`} className={tableRow}>
                                        <td className={tableCellStrong}>
                                            <span className="flex items-center gap-1.5">
                                                <span className="block max-w-xs truncate">{j.title}</span>
                                                {j.source_url && (
                                                    <a href={j.source_url} target="_blank" rel="noreferrer noopener"
                                                        className="text-slate-300 hover:text-brand-600" aria-label="Open the posting">
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                    </a>
                                                )}
                                            </span>
                                            <span className="block text-xs font-normal text-slate-500">{j.location_text ?? '—'}</span>
                                        </td>
                                        <td className={tableCell}>
                                            {j.company}
                                            <span className="block text-xs text-slate-400">{labelFrom('atsFamilies', j.family)}</span>
                                        </td>
                                        <td className={tableCell}>
                                            <Badge tone={st.tone} icon={st.icon}>{st.label}</Badge>
                                            {j.closed_at && <Badge tone="neutral" className="ml-1">Taken down</Badge>}
                                        </td>
                                        <td className={tableCell} title={formatDateTime(j.first_seen_at)}>{timeAgo(j.first_seen_at)}</td>
                                        <td className={`${tableCell} text-right tabular-nums`}>{formatDuration(j.latency_s)}</td>
                                        <td className={`${tableCell} text-right tabular-nums`}>
                                            {j.state === 'INGESTED' || j.state === 'DUPLICATE' ? `${j.matches} / ${j.queued}` : '—'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </TableShell>
                )}
            </div>
            <p className="mt-3 text-xs text-slate-500">
                &ldquo;Matched&rdquo; is consultants matched / queued. A dash in Delay means the employer&apos;s system does not say exactly when it was published.
            </p>
        </div>
    );
};

export default AtsFeed;
