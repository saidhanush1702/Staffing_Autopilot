import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Briefcase, HelpCircle, Send, UserCheck } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import PageHeader from '../../components/ui/PageHeader.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import Alert from '../../components/ui/Alert.jsx';
import DownloadDesktopApp from '../../components/DownloadDesktopApp.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { cardInteractive, sectionTitle, stack, statGrid } from '../../design/tokens.js';

/**
 * The consultant's own view: what is queued for them, what is waiting on them,
 * and what has already gone out under their name.
 *
 * "Questions to answer" is given the warning tone whenever it is non-zero,
 * because it is the only figure on the screen that BLOCKS work — an
 * application with an unanswered required question cannot be sent at all.
 */
const NEXT_STEPS = [
    {
        to: '/portal/answers',
        icon: HelpCircle,
        title: 'Answer your questions',
        body: 'Each answer is approved once by your recruiter, then reused automatically.',
    },
    {
        to: '/portal/profile',
        icon: UserCheck,
        title: 'Keep your profile current',
        body: 'Your profile fills the standard parts of every application form.',
    },
    {
        to: '/portal/criteria',
        icon: Briefcase,
        title: 'Check your search criteria',
        body: 'Titles, locations and pay your recruiter is searching against.',
    },
];

const ConsultantDashboard = () => {
    const { user } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/portal/dashboard')
            .then(({ data: res }) => setData(res.dashboard))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <Alert tone="danger">{error}</Alert>;
    if (!data) return <PageLoader />;

    const firstName = user?.name?.split(' ')[0] ?? 'there';

    return (
        <div className={stack}>
            <PageHeader
                title={`Welcome, ${firstName}`}
                subtitle={data.recruiterName
                    ? `Your recruiter is ${data.recruiterName}.`
                    : 'You have not been assigned a recruiter yet.'}
            />

            {data.pendingAnswers > 0 && (
                <Alert tone="warning" title={`${data.pendingAnswers} question${
                    data.pendingAnswers === 1 ? '' : 's'} waiting on you`}>
                    An application cannot be sent while a required question is unanswered.{' '}
                    <Link to="/portal/answers" className="font-medium underline underline-offset-2">
                        Answer them now
                    </Link>.
                </Alert>
            )}

            <div className={statGrid}>
                <StatCard icon={Briefcase} label="Jobs in queue" value={data.queuedJobs} tone="brand" />
                <StatCard
                    icon={HelpCircle}
                    label="Questions to answer"
                    value={data.pendingAnswers}
                    tone={data.pendingAnswers > 0 ? 'warning' : 'success'}
                    hint={data.pendingAnswers > 0 ? 'blocking applications' : 'nothing outstanding'}
                />
                <StatCard
                    icon={Send}
                    label="Applications submitted"
                    value={data.applicationsSubmitted}
                    tone="success"
                />
                <StatCard
                    icon={UserCheck}
                    label="My recruiter"
                    value={data.recruiterName ?? 'Unassigned'}
                    tone={data.recruiterName ? 'info' : 'neutral'}
                />
            </div>

            <section>
                <h2 className={sectionTitle}>What you can do here</h2>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {NEXT_STEPS.map(({ to, icon: Icon, title, body }) => (
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

            <DownloadDesktopApp />
        </div>
    );
};

export default ConsultantDashboard;
