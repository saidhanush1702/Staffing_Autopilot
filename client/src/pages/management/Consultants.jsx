import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Search, Users as UsersIcon, CheckCircle2, AlertCircle, Clock,
    FileText, ChevronRight, Eye, EyeOff,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import TableShell from '../../components/TableShell.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

/**
 * Consultant profiles.
 *
 * ORG_ADMIN  → every consultant in the organisation
 * RECRUITER  → only those currently assigned to them
 *
 * The narrowing happens server-side in listConsultants(); this component makes
 * the same request for both roles.
 */
const FILTERS = [
    { key: '', label: 'All' },
    { key: 'incomplete', label: 'Incomplete' },
    { key: 'complete', label: 'Complete' },
    { key: 'pending', label: 'Changes pending' },
];

const Consultants = () => {
    const { user } = useAuth();
    const navigate = useNavigate();

    const [rows, setRows] = useState(null);
    const [page, setPage] = useState(null);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const [showAll, setShowAll] = useState(false);

    const load = useCallback(async (p = currentPage, s = search, f = filter, all = showAll) => {
        try {
            const { data } = await api.get('/management/consultants', {
                params: {
                    page: p, limit: 25,
                    search: s || undefined,
                    status: f || undefined,
                    includeInactive: all || undefined,
                },
            });
            setRows(data.consultants);
            setPage(data.page);
        } catch (err) {
            setError(errorMessage(err));
        }
    }, [currentPage, search, filter, showAll]);

    useEffect(() => { load(1); /* eslint-disable-next-line */ }, [filter, showAll]);

    // Debounce search so typing doesn't fire a request per keystroke.
    useEffect(() => {
        const t = setTimeout(() => { setCurrentPage(1); load(1, search, filter); }, 300);
        return () => clearTimeout(t);
        /* eslint-disable-next-line */
    }, [search]);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!rows) return <PageLoader />;

    const isRecruiter = user?.role === 'RECRUITER';

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">
                {isRecruiter ? 'My consultants' : 'Consultants'}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
                {isRecruiter
                    ? 'Consultants currently assigned to you. Open one to view their profile and resume.'
                    : 'Every consultant in this organization. Open one to view their profile and resume.'}
            </p>

            {/* ── search + filters ─────────────────────────────── */}
            <div className="mt-5 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name or email…"
                        className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                    />
                </div>
                <div className="flex gap-1">
                    {FILTERS.map((f) => (
                        <button
                            key={f.key}
                            type="button"
                            onClick={() => { setFilter(f.key); setCurrentPage(1); }}
                            className={[
                                'rounded-lg px-3 py-1.5 text-xs transition-colors',
                                filter === f.key
                                    ? 'bg-brand-600 font-medium text-white'
                                    : 'border border-slate-300 text-slate-600 hover:bg-slate-50',
                            ].join(' ')}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                    {showAll ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showAll ? 'Show active only' : 'Show all consultants'}
                </button>
            </div>

            {/* ── table ─────────────────────────────────────────── */}
            <TableShell
                className="mt-4"
                minWidth={960}
                footer={(
                    <Pagination
                        page={page}
                        onChange={(p) => { setCurrentPage(p); load(p); }}
                    />
                )}
            >
                    <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                            <th className="px-4 py-3">Consultant</th>
                            <th className="px-4 py-3">Location</th>
                            <th className="px-4 py-3">Work authorization</th>
                            <th className="px-4 py-3">Resume</th>
                            {!isRecruiter && <th className="px-4 py-3">Recruiter</th>}
                            <th className="px-4 py-3">Profile</th>
                            <th className="w-10 px-3 py-3" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-4 py-12 text-center">
                                    <UsersIcon className="mx-auto h-8 w-8 text-slate-300" />
                                    <p className="mt-2 text-sm text-slate-500">
                                        {search || filter ? 'No consultants match that.' : 'No consultants yet.'}
                                    </p>
                                    {isRecruiter && !search && !filter && (
                                        <p className="mt-1 text-xs text-slate-400">
                                            Ask your organization admin to assign some.
                                        </p>
                                    )}
                                </td>
                            </tr>
                        )}

                        {rows.map((c) => (
                            <tr
                                key={c.user_id}
                                onClick={() => navigate(`/management/consultants/${c.user_id}`)}
                                className="cursor-pointer hover:bg-slate-50"
                            >
                                <td className="whitespace-nowrap px-4 py-3">
                                    <p className="font-medium text-slate-900">{c.name}</p>
                                    <p className="text-xs text-slate-500">{c.email}</p>
                                </td>
                                <td className="px-4 py-3 text-slate-600">
                                    {c.city || c.state
                                        ? `${c.city ?? ''}${c.city && c.state ? ', ' : ''}${c.state ?? ''}`
                                        : <span className="text-slate-400">—</span>}
                                </td>
                                <td className="px-4 py-3 text-slate-600">
                                    {c.work_auth_name ?? <span className="text-slate-400">—</span>}
                                </td>
                                <td className="px-4 py-3">
                                    {c.base_resume_artifact_id ? (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
                                            <FileText className="h-3.5 w-3.5" /> Uploaded
                                        </span>
                                    ) : (
                                        <span className="text-xs text-slate-400">Missing</span>
                                    )}
                                </td>
                                {!isRecruiter && (
                                    <td className="px-4 py-3 text-slate-600">
                                        {c.recruiter_name ?? <span className="text-slate-400">Unassigned</span>}
                                    </td>
                                )}
                                <td className="px-4 py-3">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        {c.is_complete ? (
                                            <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                                <CheckCircle2 className="h-3 w-3" /> Complete
                                            </span>
                                        ) : (
                                            <span
                                                title={`Missing: ${c.missing_fields.join(', ')}`}
                                                className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                                            >
                                                <AlertCircle className="h-3 w-3" /> {c.missing_fields.length} missing
                                            </span>
                                        )}
                                        {c.has_pending_changes && (
                                            <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                                                <Clock className="h-3 w-3" /> Pending
                                            </span>
                                        )}
                                        {c.employment_status !== 'ACTIVE' && (
                                            <EmploymentStatus status={c.employment_status} />
                                        )}
                                    </div>
                                </td>
                                <td className="px-3 py-3 text-slate-400">
                                    <ChevronRight className="h-4 w-4" />
                                </td>
                            </tr>
                        ))}
                    </tbody>
            </TableShell>
        </div>
    );
};

export default Consultants;
