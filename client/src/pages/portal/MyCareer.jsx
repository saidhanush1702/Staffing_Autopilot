import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Link2, Loader2, Save } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import SkillPicker from '../../components/profile/SkillPicker.jsx';
import SectionEditor from '../../components/profile/SectionEditor.jsx';
import { SECTION_ORDER } from '../../config/profileSections.js';
import {
    card, cardPad, cardPadRoomy, pageTitle, pageSubtitle, input, btn,
    alertShell, TONE_ALERT,
} from '../../design/tokens.js';

/**
 * The consultant's career record — what their tailored resumes are built from.
 *
 * ── WHY THIS IS SEPARATE FROM "MY PROFILE" ────────────────────────────
 *
 * My Profile holds the things an agency is accountable for: legal name,
 * contact details, work authorisation, consent. Every change there is proposed
 * and a recruiter approves it field by field.
 *
 * This page holds the consultant's own history, and it saves immediately. That
 * difference is deliberate: a person's own degree and their own projects are
 * not facts the agency needs to vet, routing forty of them through an approval
 * queue would stall onboarding on somebody else's inbox, and the
 * no-fabrication check already guards the only output that matters — a claim
 * absent from these rows cannot reach a generated resume.
 */
const MyCareer = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [links, setLinks] = useState({});
    const [savingLinks, setSavingLinks] = useState(false);
    const [linksSaved, setLinksSaved] = useState(false);

    const load = async () => {
        try {
            const { data: full } = await api.get('/portal/profile/full');
            setData(full);
            setLinks({
                headline: full.basics?.headline ?? '',
                summary: full.basics?.summary ?? '',
                github_url: full.basics?.github_url ?? '',
                portfolio_url: full.basics?.portfolio_url ?? '',
                coding_profile_url: full.basics?.coding_profile_url ?? '',
            });
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const saveLinks = async () => {
        setSavingLinks(true);
        setLinksSaved(false);
        try {
            await api.patch('/portal/profile-basics', links);
            setLinksSaved(true);
            await load();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSavingLinks(false);
        }
    };

    const addSkill = async (payload) => {
        await api.post('/portal/profile-skills', payload);
        await load();
    };

    const removeSkill = async (skillId) => {
        await api.delete(`/portal/profile-skills/${skillId}`);
        await load();
    };

    if (error && !data) {
        return <div className={`${alertShell} ${TONE_ALERT.danger}`}>{error}</div>;
    }
    if (!data) return <PageLoader />;

    /* ── what is still missing ─────────────────────────────────────── */
    //
    // The same rule the server applies before building a resume: a name, at
    // least one skill, and at least one of experience / projects / education.
    // Shown here so a consultant can see exactly what stands between them and
    // a tailored resume, rather than finding out from a badge on a job.
    const gaps = [];
    if ((data.skills ?? []).length === 0) gaps.push('at least one skill');
    if ((data.experience ?? []).length === 0
        && (data.projects ?? []).length === 0
        && (data.education ?? []).length === 0) {
        gaps.push('a role, a project or a qualification');
    }
    const ready = gaps.length === 0;

    return (
        <div className="space-y-6">
            <div>
                <h1 className={pageTitle}>My career</h1>
                <p className={pageSubtitle}>
                    Everything here is used to build your tailored resume for each job.
                    Changes save straight away.
                </p>
            </div>

            {/* ── readiness ─────────────────────────────────────────── */}
            {ready ? (
                <div className={`${alertShell} ${TONE_ALERT.success} flex items-start gap-2`}>
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                        <strong>Ready.</strong> There is enough here to build a tailored resume
                        for every job you are matched to.
                    </p>
                </div>
            ) : (
                <div className={`${alertShell} ${TONE_ALERT.warning} flex items-start gap-2`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                        <strong>Not enough to build a resume yet.</strong> Still needed:{' '}
                        {gaps.join(', ')}. Until then your applications go out with your
                        uploaded resume instead of a tailored one — they still go out.
                    </p>
                </div>
            )}

            {/* ── summary and links ─────────────────────────────────── */}
            <div className={`${card} ${cardPadRoomy} space-y-4`}>
                <h3 className="text-base font-semibold">About you</h3>

                <div>
                    <label htmlFor="headline" className="text-sm font-medium">Headline</label>
                    <input id="headline" type="text" className={input} maxLength={255}
                        placeholder="Senior Backend Engineer"
                        value={links.headline}
                        onChange={(e) => setLinks({ ...links, headline: e.target.value })} />
                </div>

                <div>
                    <label htmlFor="summary" className="text-sm font-medium">Summary</label>
                    <textarea id="summary" rows={3} className={input} maxLength={4000}
                        placeholder="A few lines about what you do."
                        value={links.summary}
                        onChange={(e) => setLinks({ ...links, summary: e.target.value })} />
                    {/* The rule that governs the whole pipeline, said plainly at
                        the point where somebody might expect otherwise. */}
                    <p className="mt-1 text-xs text-muted">
                        This may be reworded for each job, but never added to.
                    </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                    {[
                        ['github_url', 'GitHub', 'https://github.com/you'],
                        ['portfolio_url', 'Portfolio', 'https://…'],
                        ['coding_profile_url', 'Coding profile', 'LeetCode, HackerRank…'],
                    ].map(([name, label, placeholder]) => (
                        <div key={name}>
                            <label htmlFor={name} className="flex items-center gap-1.5 text-sm font-medium">
                                <Link2 className="h-3.5 w-3.5 text-muted" /> {label}
                            </label>
                            <input id={name} type="text" className={input} maxLength={255}
                                placeholder={placeholder}
                                value={links[name]}
                                onChange={(e) => setLinks({ ...links, [name]: e.target.value })} />
                        </div>
                    ))}
                </div>

                <div className="flex items-center gap-3">
                    <button type="button" className={btn.primary} onClick={saveLinks} disabled={savingLinks}>
                        {savingLinks
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Save className="h-4 w-4" />}
                        Save
                    </button>
                    {linksSaved && <span className="text-sm text-success-600">Saved.</span>}
                </div>
            </div>

            {/* ── skills ────────────────────────────────────────────── */}
            <div className={`${card} ${cardPadRoomy} space-y-3`}>
                <div>
                    <h3 className="text-base font-semibold">Skills</h3>
                    <p className="text-sm text-muted">
                        These are what jobs are matched against, and what gets reordered to
                        suit each job description.
                    </p>
                </div>
                <SkillPicker skills={data.skills ?? []} onAdd={addSkill} onRemove={removeSkill} />
            </div>

            {/* ── the repeatable sections ───────────────────────────── */}
            {SECTION_ORDER.map((name) => (
                <div key={name} className={`${card} ${cardPad}`}>
                    <SectionEditor
                        section={name}
                        items={data[name] ?? []}
                        basePath="/portal/profile"
                        onChanged={load}
                    />
                </div>
            ))}
        </div>
    );
};

export default MyCareer;
