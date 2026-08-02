import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';

const Field = ({ label, value }) => (
    <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
        <p className="mt-1 text-sm text-slate-800">{value ?? '—'}</p>
    </div>
);

const MyProfile = () => {
    const [profile, setProfile] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get('/portal/me')
            .then(({ data }) => setProfile(data.profile))
            .catch((err) => setError(errorMessage(err)));
    }, []);

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!profile) return <PageLoader />;

    return (
        <div className="max-w-3xl">
            <h1 className="text-xl font-semibold text-slate-900">My profile</h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
                <Lock className="h-3.5 w-3.5" />
                Read-only. Contact your recruiter to request a change.
            </p>

            <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Name" value={profile.name} />
                    <Field label="Email" value={profile.email} />
                    <Field label="Phone" value={profile.phone} />
                    <Field label="Organization" value={profile.organization_name} />
                </div>
            </div>

            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6">
                <p className="text-sm font-medium text-slate-700">My recruiter</p>
                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                    <Field label="Name" value={profile.recruiter_name} />
                    <Field label="Email" value={profile.recruiter_email} />
                    <Field label="Assigned since" value={profile.assigned_since} />
                    <Field
                        label="Last sign-in"
                        value={profile.last_login_at ? new Date(profile.last_login_at).toLocaleString() : 'Never'}
                    />
                </div>
            </div>
        </div>
    );
};

export default MyProfile;
