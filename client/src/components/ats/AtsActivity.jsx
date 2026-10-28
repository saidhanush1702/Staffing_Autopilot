import { useCallback, useEffect, useState } from 'react';
import { Loader2, Activity } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import TableShell from '../TableShell.jsx';
import Badge from '../ui/Badge.jsx';
import Alert from '../ui/Alert.jsx';
import EmptyState from '../ui/EmptyState.jsx';
import {
    tableHead, tableHeadCell, tableBody, tableRow, tableCell, TONE_TEXT,
} from '../../design/tokens.js';
import { formatDateTime } from '../../utils/datetime.js';
import { timeAgo, formatBytes } from '../../utils/relativeTime.js';
import { RUN_OUTCOME } from './atsLabels.js';

/**
 * The poll ledger: every read, newest first.
 *
 * Mostly a trust surface. "No change" rows dominate a healthy system and cost
 * almost nothing — that is the point of conditional requests — so they are shown
 * neutral and small. The rows worth a second look are the red ones, and their
 * error text is printed rather than hidden behind a hover.
 */
const AtsActivity = () => {
    const [runs, setRuns] = useState(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        try {
            const { data } = await api.get('/management/ats/runs', { params: { limit: 100 } });
            setRuns(data.runs);
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, 20_000);
        return () => clearInterval(id);
    }, [load]);

    if (error) return <Alert tone="danger">{error}</Alert>;
    if (!runs) return <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;

    if (runs.length === 0) {
        return (
            <EmptyState
                icon={Activity} title="No reads yet"
                body="Every read of every board is listed here, with what it cost and what it found."
            />
        );
    }

    return (
        <TableShell minWidth={900}>
            <thead className={tableHead}>
                <tr>
                    <th className={tableHeadCell}>When</th>
                    <th className={tableHeadCell}>Employer</th>
                    <th className={tableHeadCell}>Result</th>
                    <th className={`${tableHeadCell} text-right`}>Listed</th>
                    <th className={`${tableHeadCell} text-right`}>New</th>
                    <th className={`${tableHeadCell} text-right`}>Closed</th>
                    <th className={`${tableHeadCell} text-right`}>Size</th>
                    <th className={`${tableHeadCell} text-right`}>Took</th>
                </tr>
            </thead>
            <tbody className={tableBody}>
                {runs.map((r, i) => {
                    const o = RUN_OUTCOME[r.outcome] ?? RUN_OUTCOME.OK;
                    return (
                        <tr key={`${r.board_id}:${r.started_at}:${i}`} className={tableRow}>
                            <td className={tableCell} title={formatDateTime(r.started_at)}>
                                {timeAgo(r.started_at)}
                                <span className="ml-1.5 text-xs text-slate-400">{r.trigger.toLowerCase()}</span>
                            </td>
                            <td className={tableCell}>
                                {r.company}
                                <span className="block text-xs text-slate-400">{r.family_label}</span>
                            </td>
                            <td className={tableCell}>
                                <Badge tone={o.tone} icon={o.icon}>{o.label}</Badge>
                                {r.error && <span className={`block max-w-xs truncate text-xs ${TONE_TEXT.danger}`} title={r.error}>{r.error}</span>}
                            </td>
                            <td className={`${tableCell} text-right tabular-nums`}>{r.jobs_listed}</td>
                            <td className={`${tableCell} text-right tabular-nums`}>{r.new_found || '—'}</td>
                            <td className={`${tableCell} text-right tabular-nums`}>{r.closed || '—'}</td>
                            <td className={`${tableCell} text-right tabular-nums`}>{formatBytes(r.bytes)}</td>
                            <td className={`${tableCell} text-right tabular-nums`}>{r.duration_ms} ms</td>
                        </tr>
                    );
                })}
            </tbody>
        </TableShell>
    );
};

export default AtsActivity;
