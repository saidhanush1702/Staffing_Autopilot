import { useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Loader2 } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import { card } from '../../design/tokens.js';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Collapsible audit panel, dropped at the bottom of every module page:
 *
 *   <AuditLogPanel module="users" />
 *
 * Renders nothing unless the viewer is ORG_ADMIN. Lazy-fetches on first
 * expand, 10 per page.
 */
const PAGE_SIZE = 10;

/** First word of the action drives the colour. */
const actionColour = (action = '') => {
    const verb = action.split(' ')[0];
    if (['Added', 'Created', 'Generated'].includes(verb)) return 'bg-emerald-50 text-emerald-700';
    if (['Updated', 'Ran', 'Submitted'].includes(verb)) return 'bg-amber-50 text-amber-700';
    if (['Approved', 'Enabled', 'Reactivated'].includes(verb)) return 'bg-emerald-50 text-emerald-800';
    if (['Sent', 'Signed'].includes(verb)) return 'bg-sky-50 text-sky-700';
    if (['Suspended', 'Cancelled'].includes(verb)) return 'bg-amber-50 text-amber-800';
    // 'Disabled' stays listed: pre-lifecycle rows are still in the log and
    // audit_logs is append-only, so history cannot be rewritten to match.
    if (['Rejected', 'Deleted', 'Removed', 'Disabled', 'Terminated'].includes(verb)) return 'bg-red-50 text-red-700';
    return 'bg-slate-100 text-slate-600';
};

const AuditLogPanel = ({ module }) => {
    const [open, setOpen] = useState(false);
    const [logs, setLogs] = useState([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Identity comes from the auth context, not from localStorage. This was
    // the only component reading a role out of storage, which meant it would
    // keep rendering for a stale value after a role change or a sign-out that
    // did not clear that particular key.
    if (user?.role !== 'ORG_ADMIN') return null;

    const fetchLogs = async (nextOffset = 0) => {
        setLoading(true);
        setError('');
        try {
            const { data } = await api.get(`/management/audit-logs/${module}`, {
                params: { limit: PAGE_SIZE, offset: nextOffset },
            });
            setLogs(data.logs);
            setTotal(data.total);
            setOffset(nextOffset);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setLoading(false);
        }
    };

    const toggle = () => {
        const next = !open;
        setOpen(next);
        if (next && logs.length === 0) fetchLogs(0);
    };

    return (
        <div className={`mt-8 overflow-hidden ${card}`}>
            <button
                type="button"
                onClick={toggle}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
            >
                <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    Activity log
                    {total > 0 && <span className="text-xs text-slate-400">({total})</span>}
                </span>
                {open && (
                    <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); fetchLogs(offset); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); fetchLogs(offset); } }}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    </span>
                )}
            </button>

            {open && (
                <div className="border-t border-slate-200">
                    {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}
                    {loading && logs.length === 0 && (
                        <div className="flex justify-center py-6">
                            <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                        </div>
                    )}
                    {!loading && logs.length === 0 && !error && (
                        <p className="px-4 py-6 text-center text-sm text-slate-400">No activity recorded yet.</p>
                    )}

                    <ul className="divide-y divide-slate-100">
                        {logs.map((log) => (
                            <li key={log.id} className="px-4 py-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${actionColour(log.action)}`}>
                                        {log.action}
                                    </span>
                                    <span className="text-sm text-slate-700">{log.entity_name ?? log.entity_type}</span>
                                    <span className="ml-auto text-xs text-slate-400">
                                        {new Date(log.created_at).toLocaleString()}
                                    </span>
                                </div>
                                {log.description && (
                                    <p className="mt-1 text-xs text-slate-500">{log.description}</p>
                                )}
                                <p className="mt-1 text-xs text-slate-400">
                                    by {log.performed_by_name ?? 'Unknown'}
                                    {log.performed_by_role && (
                                        <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                                            {log.performed_by_role.replace('_', ' ')}
                                        </span>
                                    )}
                                </p>
                            </li>
                        ))}
                    </ul>

                    {total > PAGE_SIZE && (
                        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}</span>
                            <div className="flex gap-2">
                                <button
                                    type="button" disabled={offset === 0}
                                    onClick={() => fetchLogs(Math.max(offset - PAGE_SIZE, 0))}
                                    className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                                >Previous</button>
                                <button
                                    type="button" disabled={offset + PAGE_SIZE >= total}
                                    onClick={() => fetchLogs(offset + PAGE_SIZE)}
                                    className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                                >Next</button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AuditLogPanel;
