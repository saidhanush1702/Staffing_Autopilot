import { useEffect, useState } from 'react';
import { Briefcase, HelpCircle, Send, UserCheck } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';

const StatCard = ({ icon: Icon, label, value }) => (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex items-center gap-3">
            <span className="rounded-lg bg-brand-50 p-2">
                <Icon className="h-5 w-5 text-brand-600" />
            </span>
            <div>
                <p className="text-2xl font-semibold text-slate-900">{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
            </div>
        </div>
    </div>
);

const ConsultantDashboard = () => {
    const { user } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/portal/dashboard')
            .then(({ data: res }) => setData(res.dashboard))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!data) return <PageLoader />;

    return (
        <div>
            <h1 className="text-xl font-semibold text-slate-900">Welcome, {user?.name}</h1>
            <p className="mt-1 text-sm text-slate-500">
                Your recruiter is{' '}
                <span className="font-medium text-slate-700">
                    {data.recruiterName ?? 'not assigned yet'}
                </span>.
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={Briefcase} label="Jobs in queue" value={data.queuedJobs} />
                <StatCard icon={HelpCircle} label="Questions to answer" value={data.pendingAnswers} />
                <StatCard icon={Send} label="Applications submitted" value={data.applicationsSubmitted} />
                <StatCard icon={UserCheck} label="My recruiter" value={data.recruiterName ? '1' : '0'} />
            </div>

            <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-6">
                <p className="text-sm font-medium text-slate-700">Coming in the next phase</p>
                <p className="mt-1 text-sm text-slate-500">
                    Your job queue, resume history, and the questions needing your answer will
                    appear here. This phase establishes access control only.
                </p>
            </div>
        </div>
    );
};

export default ConsultantDashboard;
