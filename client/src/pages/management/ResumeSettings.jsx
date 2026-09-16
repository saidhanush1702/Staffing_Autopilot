import { useEffect, useState } from 'react';
import {
    FileText, Check, Loader2, AlertCircle, Users, Sparkles,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, cardPadRoomy, pageTitle, pageSubtitle, btn,
    alertShell, TONE_ALERT,
} from '../../design/tokens.js';

/**
 * How this agency builds resumes.
 *
 * Two settings, and the readiness count that makes the first one a decision
 * rather than a guess.
 *
 * ── WHY THE COUNT IS THE MOST IMPORTANT THING ON THIS PAGE ────────────
 *
 * Switching to profile-built resumes before consultants have filled their
 * profiles in means every application that morning goes out untailored. It
 * still goes out — nothing breaks — but the agency loses the thing it switched
 * for, and nobody finds out until they look at a badge on a job.
 *
 * So the page says plainly how many consultants could produce a resume today.
 * "4 of 12 ready" is a decision; a toggle with no number beside it is a gamble.
 */
const ResumeSettings = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState('');

    const load = async () => {
        try {
            const { data: settings } = await api.get('/management/resume-settings');
            setData(settings);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const save = async (patch) => {
        setSaving(true);
        setSaved('');
        setError('');
        try {
            const { data: next } = await api.patch('/management/resume-settings', patch);
            setSaved(next.changed?.length ? next.changed.join('; ') : 'No change.');
            await load();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSaving(false);
        }
    };

    if (error && !data) {
        return <div className={`${alertShell} ${TONE_ALERT.danger}`}>{error}</div>;
    }
    if (!data) return <PageLoader />;

    const { readiness } = data;
    const profileMode = data.resumeSource === 'PROFILE';
    // The number that decides whether switching is safe yet.
    const shortfall = readiness.total - readiness.ready;

    const sourceCard = (value, title, description, stat) => {
        const active = data.resumeSource === value;
        return (
            <button
                type="button"
                disabled={!isAdmin || saving}
                onClick={() => save({ resumeSource: value })}
                className={`${card} ${cardPad} text-left transition
                            ${active ? 'border-brand-400 ring-1 ring-brand-400/30' : ''}
                            ${isAdmin ? 'hover:border-brand-300' : 'cursor-default'}`}
            >
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="font-medium">{title}</p>
                        <p className="mt-1 text-sm text-muted">{description}</p>
                    </div>
                    {active && <Check className="h-5 w-5 shrink-0 text-brand-600" />}
                </div>
                <p className="mt-3 text-xs text-muted">{stat}</p>
            </button>
        );
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className={pageTitle}>Resume generation</h1>
                <p className={pageSubtitle}>
                    Where tailored resumes are built from, and which layout they print in.
                    Changes apply to the next job prepared — resumes already generated are
                    left as they are.
                </p>
            </div>

            {!isAdmin && (
                <div className={`${alertShell} ${TONE_ALERT.info}`}>
                    These settings are the org admin&rsquo;s to change. Shown here so you can
                    see why a resume looks the way it does.
                </div>
            )}
            {error && <div className={`${alertShell} ${TONE_ALERT.danger}`}>{error}</div>}
            {saved && <div className={`${alertShell} ${TONE_ALERT.success}`}>Saved. {saved}</div>}

            {/* ── source ────────────────────────────────────────────── */}
            <section className="space-y-3">
                <h2 className="text-base font-semibold">What the resume is built from</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                    {sourceCard('BASE_RESUME', 'The uploaded resume',
                        'Take the file each consultant uploaded and reword it for the job. '
                        + 'Works with whatever is already on file.',
                        `${readiness.with_base_resume} of ${readiness.total} consultants have one uploaded`)}

                    {sourceCard('PROFILE', 'Their career profile',
                        'Build the resume from the structured profile — skills, experience, '
                        + 'projects, education — into the template below. Nothing can be '
                        + 'unreadable, and the no-fabrication check compares against fields '
                        + 'rather than extracted text.',
                        `${readiness.ready} of ${readiness.total} consultants have enough filled in`)}
                </div>

                {/* The warning that stops a bad switch, shown only when it applies. */}
                {profileMode && shortfall > 0 && (
                    <div className={`${alertShell} ${TONE_ALERT.warning} flex items-start gap-2`}>
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <p>
                            <strong>{shortfall} of {readiness.total} consultants</strong> have not
                            filled in enough of their profile to build a resume from. Their
                            applications still go out — carrying their uploaded resume, marked
                            &ldquo;not tailored&rdquo; — until they do.
                        </p>
                    </div>
                )}

                {!profileMode && readiness.ready > 0 && (
                    <div className={`${alertShell} ${TONE_ALERT.info} flex items-start gap-2`}>
                        <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                        <p>
                            {readiness.ready} of {readiness.total} consultants already have enough
                            in their profile to build from.
                        </p>
                    </div>
                )}
            </section>

            {/* ── template ──────────────────────────────────────────── */}
            <section className="space-y-3">
                <div>
                    <h2 className="text-base font-semibold">Layout</h2>
                    <p className="text-sm text-muted">
                        One template for the whole agency. All three are single column with no
                        tables or graphics — the devices that make a resume look designed are
                        the ones that make it unreadable to an applicant tracking system.
                    </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                    {data.templates.map((t) => {
                        const active = data.resumeTemplate === t.name;
                        return (
                            <button
                                key={t.name}
                                type="button"
                                disabled={!isAdmin || saving}
                                onClick={() => save({ resumeTemplate: t.name })}
                                className={`${card} ${cardPad} text-left transition
                                            ${active ? 'border-brand-400 ring-1 ring-brand-400/30' : ''}
                                            ${isAdmin ? 'hover:border-brand-300' : 'cursor-default'}`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <p className="flex items-center gap-1.5 font-medium">
                                        <FileText className="h-4 w-4 text-muted" />
                                        {t.label}
                                    </p>
                                    {active && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                                </div>
                                <p className="mt-2 text-sm text-muted">{t.description}</p>

                                {/* The running order is the real difference between
                                    the three, so it is shown rather than described. */}
                                <p className="mt-3 text-xs text-muted">
                                    {t.sections.slice(0, 5).join(' → ')}
                                </p>
                            </button>
                        );
                    })}
                </div>
            </section>

            <div className="flex items-center gap-2 text-sm text-muted">
                <Users className="h-4 w-4" />
                {readiness.total} active consultant{readiness.total === 1 ? '' : 's'}
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
        </div>
    );
};

export default ResumeSettings;
