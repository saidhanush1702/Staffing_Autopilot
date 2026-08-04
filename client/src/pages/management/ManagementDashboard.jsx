import { useEffect, useState } from 'react';
import { Users, UserCheck, UserX, Link2, PauseCircle } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { card, cardPad } from '../../design/tokens.js';

const StatCard = ({ icon: Icon, label, value }) => (
    <div className={`${card} ${cardPad}`}>
        <div className="flex items-center gap-3">
            <span className="rounded-lg bg-brand-50 p-2">
                <Icon className="h-5 w-5 text-brand-600" />
            </span>
            <div>
                <p className="text-2xl font-semibold text-slate-900">{value ?? '—'}</p>
                <p className="text-xs text-slate-500">{label}</p>
            </div>
        </div>
    </div>
);

const ManagementDashboard = () => {
    const { user } = useAuth();
    const [stats, setStats] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/management/stats')
            .then(({ data }) => setStats(data.stats))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!stats) return <PageLoader />;

    const isRecruiter = user?.role === 'RECRUITER';

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">
                {user?.organizationName}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
                {isRecruiter
                    ? 'You see only the consultants currently assigned to you.'
                    : 'Full control within this organization.'}
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {isRecruiter ? (
                    <StatCard icon={Users} label="My consultants" value={stats.myConsultants} />
                ) : (
                    <>
                        <StatCard icon={UserCheck} label="Recruiters" value={stats.recruiters} />
                        <StatCard icon={Users} label="Consultants" value={stats.consultants} />
                        <StatCard icon={Link2} label="Unassigned" value={stats.unassigned} />
                        <StatCard icon={PauseCircle} label="Suspended" value={stats.suspended_users} />
                        <StatCard icon={UserX} label="Terminated" value={stats.terminated_users} />
                    </>
                )}
            </div>
        </div>
    );
};

export default ManagementDashboard;
