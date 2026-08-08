import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
    ArrowLeft, CheckCircle2, AlertCircle, Clock, Mail, Phone,
    MapPin, ShieldCheck, Linkedin, Gauge, Pause, UserCircle, Search, MessageSquare, ListChecks,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import ResumePreview from '../../components/ResumePreview.jsx';
import CriteriaEditor from '../../components/criteria/CriteriaEditor.jsx';
import ConsultantAnswers from '../../components/answers/ConsultantAnswers.jsx';
import ConsultantQueue from '../../components/queue/ConsultantQueue.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, badge, TONE, TONE_ALERT, pageTitle, pageSubtitle,
    tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

/** Sub-tabs of one consultant's workspace. Phase 3 adds Search Criteria. */
const TABS = [
    { key: 'PROFILE', label: 'Profile', icon: UserCircle },
    { key: 'CRITERIA', label: 'Search Criteria', icon: Search },
    { key: 'ANSWERS', label: 'Answers', icon: MessageSquare },
    { key: 'QUEUE', label: 'Job Queue', icon: ListChecks },
];

const Row = ({ icon: Icon, label, value, muted }) => (
    <div className="flex items-start gap-3 py-2.5">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
            <p className={`mt-0.5 text-sm ${muted ? 'text-slate-400' : 'text-slate-800'}`}>
                {value ?? 'Not provided'}
            </p>
        </div>
    </div>
);

/**
 * Consultant profile — read-only view for ORG_ADMIN and RECRUITER.
 *
 * Access is decided server-side: an ORG_ADMIN reaches any consultant in their
 * organisation, a RECRUITER only their assigned ones. A recruiter opening
 * someone else's consultant by URL gets a 403.
 */
const ConsultantDetail = () => {
    const { id } = useParams();
    const { user } = useAuth();
    const [data, setData] = useState(null);
    const [schema, setSchema] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('PROFILE');

    useEffect(() => {
        Promise.all([
            api.get(`/management/consultants/${id}`),
            api.get('/profile-schema'),
        ])
            .then(([d, s]) => { setData(d.data); setSchema(s.data); })
            .catch((err) => setError(errorMessage(err)));
    }, [id]);

    if (error) {
        return (
            <div>
                <Link to="/management/consultants" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
                    <ArrowLeft className="h-4 w-4" /> Back to consultants
                </Link>
                <p className="text-sm text-red-600">{error}</p>
            </div>
        );
    }
    if (!data || !schema) return <PageLoader />;

    const { profile, missingFields, isComplete } = data;
    const fieldLabel = (n) => schema.fields[n]?.label ?? n;
    const location = [profile.city, profile.state].filter(Boolean).join(', ');

    return (
        <div>
            <Link
                to="/management/consultants"
                className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
                <ArrowLeft className="h-4 w-4" />
                {user?.role === 'RECRUITER' ? 'Back to my consultants' : 'Back to consultants'}
            </Link>

            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className={pageTitle}>{profile.name}</h1>
                    <p className={pageSubtitle}>{profile.email}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    {isComplete ? (
                        <span className={`${badge} ${TONE.success}`}>
                            <CheckCircle2 className="h-3.5 w-3.5" /> Profile complete
                        </span>
                    ) : (
                        <span className={`${badge} ${TONE.warning}`}>
                            <AlertCircle className="h-3.5 w-3.5" /> {missingFields.length} field(s) missing
                        </span>
                    )}
                    {profile.is_paused && (
                        <span className={`${badge} ${TONE.neutral}`}>
                            <Pause className="h-3.5 w-3.5" /> Paused
                        </span>
                    )}
                    {profile.employment_status !== 'ACTIVE' && (
                        <EmploymentStatus
                            status={profile.employment_status}
                            since={profile.terminated_at ?? profile.suspended_at}
                            reason={profile.termination_reason ?? profile.suspend_reason}
                        />
                    )}
                </div>
            </div>

            {/* ── sub-tabs ────────────────────────────────── */}
            <div className={`mt-6 ${tabBar}`}>
                <nav className={tabNav} aria-label="Consultant sections">
                    {TABS.map((t) => (
                        <button
                            key={t.key}
                            type="button"
                            onClick={() => setTab(t.key)}
                            aria-current={tab === t.key ? 'page' : undefined}
                            className={`${tabItem} ${tab === t.key ? tabActive : tabIdle}`}
                        >
                            <t.icon className="h-4 w-4" />
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>

            {tab === 'CRITERIA' ? (
                <div className="mt-6">
                    <CriteriaEditor consultantId={id} />
                </div>
            ) : tab === 'ANSWERS' ? (
                <div className="mt-6">
                    <ConsultantAnswers consultantId={id} />
                </div>
            ) : tab === 'QUEUE' ? (
                <div className="mt-6">
                    <ConsultantQueue consultantId={id} />
                </div>
            ) : (
            <>
            {!isComplete && (
                <div className={`mt-4 flex items-start gap-2 rounded-lg border border-warning-200 p-3 text-sm ${TONE_ALERT.warning}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        Still needed: {missingFields.map(fieldLabel).join(', ')}.
                        The consultant fills these in from their own portal.
                    </span>
                </div>
            )}

            <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
                {/* ── details ─────────────────────────────────── */}
                <div className="space-y-4">
                    <div className={`${card} ${cardPad}`}>
                        <p className="text-sm font-medium text-slate-700">Contact</p>
                        <div className="mt-2 divide-y divide-slate-100">
                            <Row icon={Mail} label="Email" value={profile.email} />
                            <Row icon={Phone} label="Phone" value={profile.phone} muted={!profile.phone} />
                            <Row icon={MapPin} label="Location" value={location || null} muted={!location} />
                            <Row
                                icon={Linkedin} label="LinkedIn"
                                muted={!profile.linkedin_url}
                                value={profile.linkedin_url
                                    ? <a href={profile.linkedin_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">{profile.linkedin_url}</a>
                                    : null}
                            />
                        </div>
                    </div>

                    <div className={`${card} ${cardPad}`}>
                        <p className="text-sm font-medium text-slate-700">Eligibility</p>
                        <div className="mt-2 divide-y divide-slate-100">
                            <Row
                                icon={ShieldCheck} label="Work authorization"
                                value={profile.work_auth_name} muted={!profile.work_auth_name}
                            />
                            {profile.work_auth_notes && (
                                <Row icon={ShieldCheck} label="Notes" value={profile.work_auth_notes} />
                            )}
                            <Row
                                icon={CheckCircle2} label="Consent on file"
                                value={profile.consent_on_file
                                    ? `Signed${profile.consent_signed_at ? ` ${new Date(profile.consent_signed_at).toLocaleDateString()}` : ''}`
                                    : 'Not signed'}
                                muted={!profile.consent_on_file}
                            />
                            <Row icon={Gauge} label="Daily application cap" value={profile.daily_cap} />
                        </div>
                    </div>

                    {profile.notes && (
                        <div className={`${card} ${cardPad}`}>
                            <p className="text-sm font-medium text-slate-700">Internal notes</p>
                            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{profile.notes}</p>
                        </div>
                    )}
                </div>

                {/* ── resume preview ──────────────────────────── */}
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-700">Resume</p>
                        {profile.resume_uploaded_at && (
                            <span className="flex items-center gap-1 text-xs text-slate-400">
                                <Clock className="h-3 w-3" />
                                {new Date(profile.resume_uploaded_at).toLocaleDateString()}
                            </span>
                        )}
                    </div>
                    <ResumePreview
                        artifactId={profile.base_resume_artifact_id}
                        fileName={profile.resume_name}
                        uploadedAt={profile.resume_uploaded_at}
                    />
                </div>
            </div>
            </>
            )}
        </div>
    );
};

export default ConsultantDetail;
