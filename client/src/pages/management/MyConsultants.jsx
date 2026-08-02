import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';

/**
 * RECRUITER view. The narrowing happens server-side: /api/management/users
 * returns only consultants with a current assignment to this recruiter.
 */
const MyConsultants = () => {
    const [users, setUsers] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/management/users')
            .then(({ data }) => setUsers(data.users))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!users) return <PageLoader />;

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">My consultants</h1>
            <p className="mt-1 text-sm text-slate-500">
                Consultants currently assigned to you. Assignments are managed by your
                organization admin.
            </p>

            {users.length === 0 ? (
                <div className="mt-6 flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white py-16">
                    <Users className="h-8 w-8 text-slate-300" />
                    <p className="text-sm text-slate-500">No consultants assigned to you yet.</p>
                    <p className="text-xs text-slate-400">Ask your organization admin to assign some.</p>
                </div>
            ) : (
                <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <table className="w-full text-sm">
                        <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                                <th className="px-4 py-3">Name</th>
                                <th className="px-4 py-3">Email</th>
                                <th className="px-4 py-3">Phone</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Last sign-in</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {users.map((u) => (
                                <tr key={u.id} className="hover:bg-slate-50">
                                    <td className="px-4 py-3 font-medium text-slate-900">{u.name}</td>
                                    <td className="px-4 py-3 text-slate-500">{u.email}</td>
                                    <td className="px-4 py-3 text-slate-500">{u.phone ?? '—'}</td>
                                    <td className="px-4 py-3">
                                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                                            {u.is_active ? 'Active' : 'Disabled'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-slate-400">
                                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default MyConsultants;
