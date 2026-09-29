import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    ArrowRight, Briefcase, ClipboardCheck, Link2, MessageSquare, PauseCircle,
    Radar, UserCheck, UserX, Users,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import Alert from '../../components/ui/Alert.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { card, cardInteractive, sectionTitle, stack, statGrid } from '../../design/tokens.js';

/**
 * ── WHERE A RECRUITER OR ADMIN STARTS THE DAY ─────────────────────────
 *
 * Counts across the top, then the four places work actually gets done.
 *
 * The shortcut cards exist because the counts alone are a dead end: knowing
 * there are nine unassigned consultants is only useful next to the door that
 * leads to assigning them. Each one names its destination in the language of
 * the task rather than the language of the schema.
 */
const SHORTCUTS = [
    {
        to: '/management/approvals',
        icon: ClipboardCheck,
        title: 'Profile approvals',
        body: 'Review the profile changes your consultants have requested.',
        roles: ['ORG_ADMIN', 'RECRUITER'],
    },
    {
        to: '/management/answers',
        icon: MessageSquare,
        title: 'Answer approvals',
        body: 'Approve an answer once and every future application reuses it.',
        roles: ['ORG_ADMIN', 'RECRUITER'],
    },
    {
        to: '/management/postings',
        icon: Briefcase,
        title: 'Job postings',
        body: 'Everything discovered, and what has been queued from it.',
        roles: ['ORG_ADMIN', 'RECRUITER'],
    },
    {
        to: '/management/discovery',
        icon: Radar,
        title: 'Job discovery',
        body: 'Search plans, schedules and what the last sweep returned.',
        roles: ['ORG_ADMIN', 'RECRUITER'],
    },
    {
        to: '/management/assignments',
        icon: Link2,
        title: 'Assignments',
        body: 'Move consultants between recruiters, or place the unassigned.',
        roles: ['ORG_ADMIN'],
    },
    {
        to: '/management/users',
        icon: Users,
        title: 'Users',
        body: 'Add recruiters and consultants, and manage their access.',
        roles: ['ORG_ADMIN'],
    },
];

const ManagementDashboard = () => {
    const { user } = useAuth();
    const [stats, setStats] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/management/stats')
            .then(({ data }) => setStats(data.stats))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <Alert tone="danger">{error}</Alert>;
    if (!stats) return <PageLoader />;

    const isRecruiter = user?.role === 'RECRUITER';
    const shortcuts = SHORTCUTS.filter((s) => s.roles.includes(user?.role));

    return (
        <div className={stack}>
            <PageHeader
                title={user?.organizationName ?? 'Workspace'}
                subtitle={isRecruiter
                    ? 'You see only the consultants currently assigned to you.'
                    : 'Full control within this organization.'}
            />

            <div className={statGrid}>
                {isRecruiter ? (
                    <StatCard
                        icon={Users}
                        label="My consultants"
                        value={stats.myConsultants}
                        hint="assigned to you"
                    />
                ) : (
                    <>
                        <StatCard icon={UserCheck} label="Recruiters" value={stats.recruiters} tone="brand" />
                        <StatCard icon={Users} label="Consultants" value={stats.consultants} tone="info" />
                        <StatCard
                            icon={Link2}
                            label="Unassigned"
                            value={stats.unassigned}
                            tone={stats.unassigned > 0 ? 'warning' : 'neutral'}
                            hint={stats.unassigned > 0 ? 'need a recruiter' : 'everyone is placed'}
                        />
                        <StatCard icon={PauseCircle} label="Suspended" value={stats.suspended_users} tone="warning" />
                        <StatCard icon={UserX} label="Terminated" value={stats.terminated_users} tone="danger" />
                    </>
                )}
            </div>

            <section>
                <h2 className={sectionTitle}>Jump back in</h2>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {shortcuts.map(({ to, icon: Icon, title, body }) => (
                        <Link key={to} to={to} className={`${cardInteractive} group flex gap-3.5 p-4`}>
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl
                                             bg-brand-50 text-brand-600">
                                <Icon className="h-[1.15rem] w-[1.15rem]" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5 font-display text-sm
                                                 font-semibold text-slate-900">
                                    {title}
                                    <ArrowRight className="h-3.5 w-3.5 text-slate-300 transition-transform
                                                           duration-150 group-hover:translate-x-0.5
                                                           group-hover:text-brand-600" />
                                </span>
                                <span className="mt-1 block text-xs leading-relaxed text-slate-500">{body}</span>
                            </span>
                        </Link>
                    ))}
                </div>
            </section>

            {isRecruiter && stats.myConsultants === 0 && (
                <div className={`${card} p-5`}>
                    <p className={sectionTitle}>No consultants yet</p>
                    <p className="mt-1 text-sm text-slate-500">
                        An organization admin assigns consultants to you. Once they do, they appear
                        under <strong className="font-medium text-slate-700">My Consultants</strong>.
                    </p>
                </div>
            )}
        </div>
    );
};

export default ManagementDashboard;
