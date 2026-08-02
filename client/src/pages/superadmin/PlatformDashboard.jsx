import { useEffect, useState } from 'react';
import { Building2, Users, UserCheck, Briefcase } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';

const StatCard = ({ icon: Icon, label, value }) => (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
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

const PlatformDashboard = () => {
    const [stats, setStats] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/super-admin/stats')
            .then(({ data }) => setStats(data.stats))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!stats) return <PageLoader />;

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">Platform overview</h1>
            <p className="mt-1 text-sm text-slate-500">
                Tenant management only. Organisation business data is not visible from here.
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Building2} label="Organizations" value={stats.total_orgs} />
                <StatCard icon={Building2} label="Active" value={stats.active_orgs} />
                <StatCard icon={UserCheck} label="Org admins" value={stats.org_admins} />
                <StatCard icon={Users} label="Recruiters" value={stats.recruiters} />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Briefcase} label="Consultants" value={stats.consultants} />
            </div>
        </div>
    );
};

export default PlatformDashboard;
