import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Briefcase, Building2, CircleCheck, ShieldCheck, UserCheck, Users } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import Alert from '../../components/ui/Alert.jsx';
import { btn, card, sectionTitle, stack, statGrid } from '../../design/tokens.js';

/**
 * The platform view. Tenants and their headcount — deliberately nothing else.
 *
 * The note about business data is not boilerplate: a super admin CAN reach
 * every organisation's row in the database, and the product's answer to that
 * is that this screen never shows it. Saying so on the screen itself is what
 * makes the boundary visible to the person it constrains.
 */
const PlatformDashboard = () => {
    const [stats, setStats] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/super-admin/stats')
            .then(({ data }) => setStats(data.stats))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <Alert tone="danger">{error}</Alert>;
    if (!stats) return <PageLoader />;

    const dormant = Math.max(0, (stats.total_orgs ?? 0) - (stats.active_orgs ?? 0));

    return (
        <div className={stack}>
            <PageHeader
                icon={ShieldCheck}
                title="Platform overview"
                subtitle="Tenant management only. Organization business data is not visible from here."
                actions={(
                    <Link to="/super-admin/organizations" className={btn.primary}>
                        <Building2 className="h-4 w-4" />
                        Organizations
                    </Link>
                )}
            />

            <div className={statGrid}>
                <StatCard
                    icon={Building2}
                    label="Organizations"
                    value={stats.total_orgs}
                    tone="brand"
                    hint={dormant > 0 ? `${dormant} not active` : 'all active'}
                />
                <StatCard icon={CircleCheck} label="Active" value={stats.active_orgs} tone="success" />
                <StatCard icon={UserCheck} label="Org admins" value={stats.org_admins} tone="info" />
                <StatCard icon={Users} label="Recruiters" value={stats.recruiters} tone="info" />
                <StatCard icon={Briefcase} label="Consultants" value={stats.consultants} tone="neutral" />
            </div>

            <Link to="/super-admin/organizations" className={`${card} group flex items-center gap-4 p-5`}>
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl
                                 bg-brand-50 text-brand-600">
                    <Building2 className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className={`${sectionTitle} block`}>Manage organizations</span>
                    <span className="mt-1 block text-xs text-slate-500">
                        Create a tenant, appoint its first admin, or suspend one.
                    </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-transform duration-150
                                       group-hover:translate-x-0.5 group-hover:text-brand-600" />
            </Link>
        </div>
    );
};

export default PlatformDashboard;
