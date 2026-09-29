import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
    ArrowLeft, CheckCircle2, AlertCircle, Clock, Mail, Phone,
    MapPin, ShieldCheck, Linkedin, Pause, UserCircle, Search, MessageSquare, ListChecks,
    FileCheck2,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import EmploymentStatus from '../../components/EmploymentStatus.jsx';
import ResumePreview from '../../components/ResumePreview.jsx';
import ProfileField from '../../components/ProfileField.jsx';
import SkillPicker from '../../components/profile/SkillPicker.jsx';
import CareerSectionView from '../../components/profile/CareerSectionView.jsx';
import ProfileStrength from '../../components/profile/ProfileStrength.jsx';
import CriteriaEditor from '../../components/criteria/CriteriaEditor.jsx';
import ConsultantAnswers from '../../components/answers/ConsultantAnswers.jsx';
import ConsultantJobs from '../../components/queue/ConsultantJobs.jsx';
import ConsultantApplications from '../../components/queue/ConsultantApplications.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { SECTION_ORDER, PROFILE_SECTIONS } from '../../config/profileSections.js';
import { card, cardPad, badge, TONE, TONE_ALERT, pageTitle, pageSubtitle, tabBar, tabNav, tabItem, tabActive, tabIdle, alertShell } from '../../design/tokens.js';
import { formatDate } from '../../utils/datetime.js';

/** Sub-tabs of one consultant's workspace. Phase 3 adds Search Criteria. */
/**
 * `JOBS` replaced a "Job Queue" tab that showed only the un-submitted half of a
 * consultant's jobs. The queue and the applications were two lists with no
 * columns in common, so "what happened to that job?" needed both open at once.
 * `JOBS` is the whole pipeline in one list; `APPLICATIONS` stays because it
 * holds something the overview does not — the exact form, question by question,
 * as the employer asked it.
 */
const TABS = [
    { key: 'JOBS', label: 'Jobs', icon: ListChecks },
    { key: 'PROFILE', label: 'Profile', icon: UserCircle },
    { key: 'CRITERIA', label: 'Search Criteria', icon: Search },
    { key: 'ANSWERS', label: 'Answers', icon: MessageSquare },
    { key: 'APPLICATIONS', label: 'Applications', icon: FileCheck2 },
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
    const [lookups, setLookups] = useState(null);
    const [career, setCareer] = useState(null);
    const [readiness, setReadiness] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('JOBS');

    useEffect(() => {
        Promise.all([
            api.get(`/management/consultants/${id}`),
            api.get('/profile-schema'),
            api.get('/lookups'),
            // Same "is there enough here for a tailored resume" data the
            // consultant sees on their own profile — read-only here, since
            // this screen never proposes changes on their behalf.
            api.get(`/management/consultants/${id}/profile/full`),
            api.get(`/management/consultants/${id}/career/readiness`),
        ])
            .then(([d, s, lk, full, ready]) => {
                setData(d.data); setSchema(s.data); setLookups(lk.data);
                setCareer(full.data); setReadiness(ready.data);
            })
            .catch((err) => setError(errorMessage(err)));
    }, [id]);

    if (error) {
        return (
            <div>
                <Link to="/management/consultants" className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
                    <ArrowLeft className="h-4 w-4" /> Back to consultants
                </Link>
                <p className="text-sm text-danger-600">{error}</p>
            </div>
        );
    }
    if (!data || !schema || !lookups || !career || !readiness) return <PageLoader />;

    const { profile, missingFields, isComplete } = data;
    const fieldLabel = (n) => schema.fields[n]?.label ?? n;
    const location = [profile.city, profile.state].filter(Boolean).join(', ');

    // Mirrors MyProfile.jsx's own split. `base_resume_artifact_id` is left out
    // of both — it already has its own dedicated preview further down this
    // page, and a second, disabled file-upload box next to it would just be
    // the same fact shown two different, worse ways.
    const identityFields = schema.consultantEditable.filter(
        (n) => n !== 'base_resume_artifact_id'
            && !['headline', 'summary', 'github_url', 'portfolio_url', 'coding_profile_url'].includes(n),
    );
    const aboutFields = schema.consultantEditable.filter(
        (n) => ['headline', 'summary', 'github_url', 'portfolio_url', 'coding_profile_url'].includes(n),
    );

    // Mirrors the checklist MyProfile.jsx builds for the consultant's own
    // view — one row per identity field the consultant may edit, plus one
    // per career section — read from the LIVE profile and career record
    // rather than a draft, since there is no in-progress edit to reflect here.
    const isFilled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const strengthItems = [
        ...schema.consultantEditable.map((n) => ({
            key: n, label: fieldLabel(n), required: schema.fields[n]?.required ?? false,
            filled: isFilled(profile[n]),
        })),
        {
            key: 'skills', label: 'Skills', required: false,
            filled: (career.skills ?? []).length > 0,
        },
        ...SECTION_ORDER.map((name) => ({
            key: name, label: PROFILE_SECTIONS[name].label, required: false,
            filled: (career[name] ?? []).length > 0,
        })),
    ];

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
                    <div className="flex items-center gap-2">
                        <h1 className={pageTitle}>{profile.name}</h1>
                        <ProfileStrength items={strengthItems} isComplete={isComplete} readiness={readiness} readOnly />
                    </div>
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
            ) : tab === 'APPLICATIONS' ? (
                <div className="mt-6">
                    <ConsultantApplications consultantId={id} />
                </div>
            ) : tab === 'JOBS' ? (
                <div className="mt-6">
                    <ConsultantJobs consultantId={id} scope="management" />
                </div>
            ) : (
            <>
            {!isComplete && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.warning}`}>
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
                        <div className="mt-2 divide-y divide-line-soft">
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
                        <div className="mt-2 divide-y divide-line-soft">
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
                                    ? `Signed${profile.consent_signed_at ? ` ${formatDate(profile.consent_signed_at)}` : ''}`
                                    : 'Not signed'}
                                muted={!profile.consent_on_file}
                            />
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
                                {formatDate(profile.resume_uploaded_at)}
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

            {/* ── everything the consultant filled in themselves ─────
                Same fields, same components, same grouping as their own
                My Profile page — just disabled, since changes here go
                through the consultant's own submission and this screen's
                approval queue, never edited directly from a viewer. */}
            <div className="mt-6 space-y-6">
                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">Details</p>
                    <div className="mt-3 grid gap-5 sm:grid-cols-2">
                        {identityFields.map((name) => (
                            <ProfileField
                                key={name}
                                name={name}
                                field={schema.fields[name]}
                                value={profile[name]}
                                onChange={() => {}}
                                lookups={lookups}
                                disabled
                                filled={isFilled(profile[name])}
                            />
                        ))}
                    </div>
                </div>

                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">About</p>
                    <div className="mt-3 grid gap-5 sm:grid-cols-2">
                        {aboutFields.map((name) => (
                            <div key={name} className={name === 'summary' ? 'sm:col-span-2' : ''}>
                                <ProfileField
                                    name={name}
                                    field={schema.fields[name]}
                                    value={profile[name]}
                                    onChange={() => {}}
                                    lookups={lookups}
                                    disabled
                                    filled={isFilled(profile[name])}
                                />
                            </div>
                        ))}
                    </div>
                </div>

                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">Skills</p>
                    <div className="mt-3">
                        <SkillPicker
                            skills={(career.skills ?? []).map((s) => ({
                                key: String(s.skill_id ?? s.name), skillId: s.skill_id, name: s.name,
                            }))}
                            disabled
                        />
                    </div>
                </div>

                {SECTION_ORDER.map((name) => (
                    <CareerSectionView key={name} section={name} items={career[name] ?? []} />
                ))}
            </div>
            </>
            )}
        </div>
    );
};

export default ConsultantDetail;
