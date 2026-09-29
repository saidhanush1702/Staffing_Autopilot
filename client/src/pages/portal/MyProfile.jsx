import { useEffect, useState } from 'react';
import {
    Send, Loader2, AlertCircle, Clock, CheckCircle2, XCircle, MinusCircle,
    Undo2, Download, Check, X,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import ProfileField from '../../components/ProfileField.jsx';
import SkillPicker from '../../components/profile/SkillPicker.jsx';
import SectionEditor from '../../components/profile/SectionEditor.jsx';
import ProfileStrength from '../../components/profile/ProfileStrength.jsx';
import FillWithResume from '../../components/profile/FillWithResume.jsx';
import { SECTION_ORDER, PROFILE_SECTIONS } from '../../config/profileSections.js';
import {
    TONE_ALERT, card, cardPad, cardPadRoomy, pageTitle, pageSubtitle, btn, alertShell,
} from '../../design/tokens.js';
import { formatDateTime } from '../../utils/datetime.js';

/**
 * My Profile — everything about a consultant, one page, one approval.
 *
 * ── WHY THIS USED TO BE TWO PAGES, AND WHY IT IS NOT ANY MORE ─────────
 *
 * My Profile (identity — phone, city, work auth, the base resume) and My
 * Career (skills, work history, education, projects, certifications) were
 * built for the same reason: tell the agency about yourself so the right
 * jobs reach you. They ended up on two different engines — one reviewed
 * field by field before going live, the other saved the instant a consultant
 * touched it — because career facts looked like the consultant's own history
 * and identity facts looked like the agency's liability.
 *
 * The client asked for one page with one reviewer gate over everything a
 * consultant submits, so that is what this is now. Nothing below writes to
 * the server per keystroke — not the identity fields, which never did, and
 * not the career sections, which used to. Every edit lives in this
 * component's own state until ONE "Submit for approval" sends the whole
 * thing at once, and an ORG_ADMIN or RECRUITER decides it with ONE
 * Approve / Reject (see pages/management/ProfileApprovals.jsx).
 *
 * ── WHY SUBMITTING LOCKS EVERYTHING, NOT JUST WHAT CHANGED ─────────────
 *
 * A pending submission — identity, career, or both — locks the whole form.
 * A consultant cannot add a skill while their phone number is under review,
 * even though the two have nothing to do with each other. That is a real
 * trade-off, made deliberately: one submission is one thing a reviewer looks
 * at once, and letting edits keep landing underneath a decision in progress
 * is exactly how a reviewer ends up approving a version nobody submitted.
 */
const MyProfile = () => {
    const [data, setData] = useState(null);
    const [schema, setSchema] = useState(null);
    const [lookups, setLookups] = useState(null);
    const [career, setCareer] = useState(null);       // the live, approved career record
    const [readiness, setReadiness] = useState(null);  // "enough to build a resume?"

    const [draft, setDraft] = useState({});            // identity fields
    const [careerDraft, setCareerDraft] = useState({}); // { skills, education, experience, projects, certifications }

    const [error, setError] = useState('');
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    /* ── loading ──────────────────────────────────────────────────── */

    // A stable local key for a row that already exists live: its own id.
    // Rows added in this sitting get one from SectionEditor/SkillPicker
    // instead, since they have no server id yet.
    const withKey = (rows) => rows.map((r) => ({ ...r, key: r.id }));

    const load = async () => {
        try {
            const [me, sch, lk, full, ready] = await Promise.all([
                api.get('/portal/me'),
                api.get('/profile-schema'),
                api.get('/lookups'),
                api.get('/portal/profile/full'),
                api.get('/portal/career/readiness'),
            ]);
            setData(me.data);
            setSchema(sch.data);
            setLookups(lk.data);
            setCareer(full.data);
            setReadiness(ready.data);

            const d = {};
            for (const name of sch.data.consultantEditable) d[name] = me.data.profile[name] ?? null;
            setDraft(d);

            setCareerDraft({
                skills: (full.data.skills ?? []).map((s) => ({
                    key: String(s.skill_id), skillId: s.skill_id, name: s.name,
                    years: s.years, proficiency: s.proficiency,
                })),
                education: withKey(full.data.education ?? []),
                experience: withKey(full.data.experience ?? []),
                projects: withKey(full.data.projects ?? []),
                certifications: withKey(full.data.certifications ?? []),
            });
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const setField = (name, value) => setDraft((d) => ({ ...d, [name]: value }));

    /* ── career section handlers ─────────────────────────────────── */

    const setSection = (name, rows) => setCareerDraft((c) => ({ ...c, [name]: rows }));

    const addSkill = (payload) => {
        const key = payload.skillId != null ? String(payload.skillId)
            : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setCareerDraft((c) => ({
            ...c,
            skills: [...c.skills, {
                key, skillId: payload.skillId ?? null, name: payload.name ?? null,
                years: null, proficiency: null,
            }],
        }));
    };
    const removeSkill = (key) => setCareerDraft((c) => ({
        ...c, skills: c.skills.filter((s) => s.key !== key),
    }));

    /* ── "fill with resume" ──────────────────────────────────────── */

    const newKey = () => ((typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    /**
     * Put what was read from a resume into the form — and ONLY into places that
     * are still empty. A value the person already typed is never overwritten,
     * and a section that already has entries is left exactly as it is; a resume
     * read is a head start, not an edit of what they wrote.
     *
     * Returns what it actually did, for the card to report.
     */
    const applyPrefill = (found) => {
        const done = { fields: 0, skills: 0, kept: [] };

        const nextDraft = { ...draft };
        for (const [name, value] of Object.entries(found.fields ?? {})) {
            if (!schema.consultantEditable.includes(name)) continue;
            const blank = nextDraft[name] === null || nextDraft[name] === undefined
                || String(nextDraft[name]).trim() === '';
            if (blank) { nextDraft[name] = value; done.fields += 1; }
        }
        setDraft(nextDraft);

        const c = careerDraft;
        const next = { ...c };

        const have = new Set((c.skills ?? []).map((k) => String(k.name ?? '').toLowerCase()));
        const added = (found.skills ?? []).filter((n) => !have.has(n.toLowerCase()));
        done.skills = added.length;
        next.skills = [...(c.skills ?? []), ...added.map((name) => ({
            key: `local-${newKey()}`, skillId: null, name, years: null, proficiency: null,
        }))];

        for (const name of SECTION_ORDER) {
            const rows = found[name] ?? [];
            if (rows.length === 0) continue;
            if ((c[name] ?? []).length > 0) {
                done.kept.push(PROFILE_SECTIONS[name].label.toLowerCase());
                continue;
            }
            next[name] = rows.map((row) => ({ ...row, key: newKey() }));
            done[name] = rows.length;
        }
        setCareerDraft(next);

        return done;
    };

    /* ── dirty check, across everything ──────────────────────────── */

    // Strip the local-only `key` (and any server bookkeeping columns the
    // Joi schemas will strip anyway) before comparing, so a row that is
    // byte-identical in every field the server cares about does not read as
    // "changed" just because it carries a different id or position.
    const stripLocal = ({ key, id, position, created_at: _c, updated_at: _u, ...rest }) => rest;

    const careerSectionDirty = (name) => {
        const live = (career?.[name] ?? []).map((r) => stripLocal(withKey([r])[0]));
        const now = (careerDraft[name] ?? []).map(stripLocal);
        return JSON.stringify(live) !== JSON.stringify(now);
    };
    const skillsDirty = () => {
        const live = (career?.skills ?? []).map((s) => ({
            skillId: s.skill_id, name: s.name, years: s.years ?? null, proficiency: s.proficiency ?? null,
        }));
        const now = (careerDraft.skills ?? []).map((s) => ({
            skillId: s.skillId ?? null, name: s.name ?? null,
            years: s.years ?? null, proficiency: s.proficiency ?? null,
        }));
        return JSON.stringify(live) !== JSON.stringify(now);
    };

    const identityDirty = schema
        ? schema.consultantEditable.some((n) => String(draft[n] ?? '') !== String(data?.profile[n] ?? ''))
        : false;
    const careerIsDirty = career
        ? skillsDirty() || SECTION_ORDER.some((n) => careerSectionDirty(n))
        : false;
    const dirty = identityDirty || careerIsDirty;

    /* ── submit / withdraw ────────────────────────────────────────── */

    const submit = async (e) => {
        e.preventDefault();
        setFormError('');
        setSaving(true);
        try {
            const body = { ...draft };
            if (careerIsDirty) {
                body.career = {
                    skills: careerDraft.skills.map(({ key: _k, ...s }) => s),
                    ...Object.fromEntries(
                        SECTION_ORDER
                            .filter((n) => careerSectionDirty(n))
                            .map((n) => [n, careerDraft[n].map(({ key: _k, ...row }) => row)]),
                    ),
                };
            }
            await api.post('/portal/profile/change-request', body);
            await load();
        } catch (err) {
            setFormError(errorMessage(err, 'Could not submit changes.'));
        } finally {
            setSaving(false);
        }
    };

    const withdraw = async () => {
        if (!window.confirm('Withdraw your pending changes? You can then edit again.')) return;
        try {
            await api.delete('/portal/profile/change-request');
            await load();
        } catch (err) {
            setFormError(errorMessage(err));
        }
    };

    if (error) return <p className="text-sm text-danger-600">{error}</p>;
    if (!data || !schema || !lookups || !career || !readiness) return <PageLoader />;

    const { profile, recruiter, missingFields, isComplete, pendingRequest, lastReviewed } = data;
    const locked = Boolean(pendingRequest);
    const fieldLabel = (n) => schema.fields[n]?.label ?? n;

    // The "about you" links (headline, summary, github, portfolio, coding
    // profile) render through the exact same ProfileField grid as phone and
    // city — they joined config/profileFields.js as five more
    // consultant-editable entries, so nothing here needs to know they used
    // to be a separate page's separate form.
    const identityFields = schema.consultantEditable.filter(
        (n) => !['headline', 'summary', 'github_url', 'portfolio_url', 'coding_profile_url'].includes(n),
    );
    const aboutFields = schema.consultantEditable.filter(
        (n) => ['headline', 'summary', 'github_url', 'portfolio_url', 'coding_profile_url'].includes(n),
    );

    const careerSummaryLine = (summary) => (summary && summary.length > 0
        ? summary.join(', ')
        : null);

    /**
     * The "profile strength" checklist — one row per identity field, plus one
     * per career section (filled if it has at least one entry). Read straight
     * off the draft state the form itself is bound to, so a tick appears the
     * moment a field is filled in, not only after it is saved.
     */
    const isFilled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const strengthItems = [
        ...identityFields.map((n) => ({
            key: n, label: fieldLabel(n), anchor: 'section-details',
            required: schema.fields[n]?.required ?? false,
            filled: isFilled(draft[n]),
        })),
        ...aboutFields.map((n) => ({
            key: n, label: fieldLabel(n), anchor: 'section-about', required: false,
            filled: isFilled(draft[n]),
        })),
        {
            key: 'skills', label: 'Skills', anchor: 'section-skills', required: false,
            filled: (careerDraft.skills ?? []).length > 0,
        },
        ...SECTION_ORDER.map((name) => ({
            key: name, label: PROFILE_SECTIONS[name].label, anchor: `section-${name}`, required: false,
            filled: (careerDraft[name] ?? []).length > 0,
        })),
    ];

    return (
        <div className="max-w-4xl">
            <div className="flex items-center gap-2">
                <h1 className={pageTitle}>My profile</h1>
                <ProfileStrength items={strengthItems} isComplete={isComplete} readiness={readiness} />
            </div>
            <p className={pageSubtitle}>
                Everything here — your details and your career record — is used on every job
                application submitted for you. Fill it in, then submit it once; your recruiter
                or org admin reviews the whole thing before it goes live.
            </p>

            <FillWithResume onApply={applyPrefill} disabled={locked} />

            {/* ── incomplete banner (required identity fields) ── */}
            {!isComplete && !locked && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        <strong>Your profile is incomplete.</strong> Still needed:{' '}
                        {missingFields.map(fieldLabel).join(', ')}.
                    </span>
                </div>
            )}

            {/* ── pending banner ────────────────────────────────── */}
            {locked && (
                <div className="mt-4 rounded-lg border border-info-200 bg-info-50 p-4">
                    <div className="flex items-start gap-2">
                        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-info-700" />
                        <div className="flex-1">
                            <p className="text-sm font-medium text-info-900">
                                Your profile is awaiting approval
                            </p>
                            <p className="mt-0.5 text-xs text-info-700">
                                Submitted {formatDateTime(pendingRequest.submitted_at)}
                                {recruiter && ` · waiting on ${recruiter.name}`}
                            </p>

                            {pendingRequest.fields.length > 0 && (
                                <ul className="mt-2 space-y-1">
                                    {pendingRequest.fields.map((f) => (
                                        <li key={f.field_name} className="text-xs text-info-800">
                                            <span className="font-medium">{fieldLabel(f.field_name)}</span>
                                            {' → '}{f.new_display ?? '(cleared)'}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {pendingRequest.career && (
                                <p className="mt-2 text-xs text-info-800">
                                    <span className="font-medium">Career record:</span>{' '}
                                    {careerSummaryLine(pendingRequest.careerSummary) ?? 'updated'}
                                </p>
                            )}

                            <button
                                type="button"
                                onClick={withdraw}
                                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-info-300 bg-surface px-3 py-1.5 text-xs text-info-800 hover:bg-info-50"
                            >
                                <Undo2 className="h-3.5 w-3.5" /> Withdraw and edit again
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── the form ──────────────────────────────────────── */}
            <form onSubmit={submit} className="mt-6 space-y-6">
                {formError && (
                    <div className={`${alertShell} ${TONE_ALERT.danger}`}>
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                    </div>
                )}

                {/* identity + contact */}
                <div id="section-details" className={`${card} ${cardPadRoomy}`}>
                    <h2 className="text-base font-semibold">Your details</h2>
                    <div className="mt-4 grid gap-5 sm:grid-cols-2">
                        {identityFields.map((name) => (
                            <ProfileField
                                key={name}
                                name={name}
                                field={schema.fields[name]}
                                value={draft[name]}
                                onChange={setField}
                                lookups={lookups}
                                disabled={locked}
                                currentFileName={name === 'base_resume_artifact_id' ? profile.resume_name : undefined}
                                filled={isFilled(draft[name])}
                            />
                        ))}
                    </div>
                </div>

                {/* about you */}
                <div id="section-about" className={`${card} ${cardPadRoomy}`}>
                    <h2 className="text-base font-semibold">About you</h2>
                    <p className="mt-1 text-sm text-muted">
                        Your summary may be reworded for each job when your resume is tailored, but
                        never added to.
                    </p>
                    <div className="mt-4 grid gap-5 sm:grid-cols-2">
                        {aboutFields.map((name) => (
                            <div key={name} className={name === 'summary' ? 'sm:col-span-2' : ''}>
                                <ProfileField
                                    name={name}
                                    field={schema.fields[name]}
                                    value={draft[name]}
                                    onChange={setField}
                                    lookups={lookups}
                                    disabled={locked}
                                    filled={isFilled(draft[name])}
                                />
                            </div>
                        ))}
                    </div>
                </div>

                {/* skills */}
                <div id="section-skills" className={`${card} ${cardPadRoomy}`}>
                    <h2 className="inline-flex items-center gap-1.5 text-base font-semibold">
                        Skills
                        {(careerDraft.skills ?? []).length > 0
                            ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success-600" aria-label="At least one added" />
                            : <AlertCircle className="h-4 w-4 shrink-0 text-warning-500" aria-label="Nothing added yet" />}
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                        What jobs are matched against, and what gets reordered to suit each job
                        description.
                    </p>
                    <div className="mt-4">
                        <SkillPicker
                            skills={careerDraft.skills ?? []}
                            onAdd={addSkill}
                            onRemove={removeSkill}
                            disabled={locked}
                        />
                    </div>
                </div>

                {/* the repeatable career sections */}
                {SECTION_ORDER.map((name) => (
                    <div key={name} id={`section-${name}`} className={`${card} ${cardPad}`}>
                        <SectionEditor
                            section={name}
                            items={careerDraft[name] ?? []}
                            onChange={(rows) => setSection(name, rows)}
                            disabled={locked}
                        />
                    </div>
                ))}

                {!locked && (
                    <div>
                        <button
                            type="submit"
                            disabled={saving || !dirty}
                            title={!dirty ? 'Change something first' : undefined}
                            className={btn.primary}
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            Submit for approval
                        </button>
                        {!dirty && (
                            <p className="mt-2 text-xs text-slate-400">
                                Change something — anywhere on this page — first.
                            </p>
                        )}
                    </div>
                )}
            </form>

            {/* ── read-only info ────────────────────────────────── */}
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">My recruiter</p>
                    <p className="mt-2 text-sm text-slate-800">{recruiter?.name ?? 'Not assigned yet'}</p>
                    <p className="text-xs text-slate-500">{recruiter?.email ?? ''}</p>
                </div>
                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">Set by your agency</p>
                    <dl className="mt-2 space-y-1 text-sm">
                        <div className="flex justify-between">
                            <dt className="text-slate-500">Consent on file</dt>
                            <dd className="text-slate-800">
                                {profile.consent_on_file
                                    ? <CheckCircle2 className="inline h-4 w-4 text-success-600" />
                                    : <span className="text-warning-600">Not yet</span>}
                            </dd>
                        </div>
                    </dl>
                    {profile.base_resume_artifact_id && (
                        <a
                            href={`${import.meta.env.VITE_BACKEND_URL}/api/resumes/${profile.base_resume_artifact_id}/download`}
                            className="mt-3 inline-flex items-center gap-1.5 text-xs text-brand-700 hover:underline"
                        >
                            <Download className="h-3.5 w-3.5" /> Download my current resume
                        </a>
                    )}
                </div>
            </div>

            {/* ── last review outcome — last on the page, after everything
                else here, since it is a record of what already happened
                rather than something to act on right now ──────────── */}
            {!locked && lastReviewed && (() => {
                const approvedWhole = lastReviewed.status === 'APPROVED';
                const tone = approvedWhole
                    ? { border: 'border-success-200', bg: 'bg-success-50', head: 'text-success-900', body: 'text-success-800', icon: CheckCircle2, iconCls: 'text-success-600' }
                    : { border: 'border-danger-200', bg: 'bg-danger-50', head: 'text-danger-900', body: 'text-danger-800', icon: XCircle, iconCls: 'text-danger-600' };
                const Icon = tone.icon;

                return (
                    <div className={`mt-6 rounded-lg border ${tone.border} ${tone.bg} p-4`}>
                        <div className="flex items-start gap-2">
                            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconCls}`} />
                            <div className="flex-1">
                                <p className={`text-sm font-medium ${tone.head}`}>
                                    {approvedWhole
                                        ? 'Your last submission was approved'
                                        : 'Your last submission was not approved'}
                                </p>

                                <p className={`mt-0.5 text-xs ${tone.body}`}>
                                    Reviewed by <strong>{lastReviewed.reviewed_by_name ?? 'your agency'}</strong>
                                    {lastReviewed.reviewed_by_role && (
                                        <span className="ml-1 rounded bg-surface/70 px-1.5 py-0.5 text-[10px] font-medium">
                                            {lastReviewed.reviewed_by_role.replace('_', ' ')}
                                        </span>
                                    )}
                                    {lastReviewed.reviewed_at && (
                                        <> on {formatDateTime(lastReviewed.reviewed_at)}</>
                                    )}
                                </p>

                                {lastReviewed.fields.length > 0 && (
                                    <ul className="mt-2 space-y-1">
                                        {lastReviewed.fields.map((f) => (
                                            <li key={f.field_name} className={`text-xs ${tone.body}`}>
                                                {f.status === 'APPROVED'
                                                    ? <Check className="mr-1 inline h-3 w-3 text-success-600" />
                                                    : <X className="mr-1 inline h-3 w-3 text-danger-600" />}
                                                <span className="font-medium">{fieldLabel(f.field_name)}</span>
                                                {' → '}{f.new_display ?? '(cleared)'}
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                {lastReviewed.career && (
                                    <p className={`mt-2 text-xs ${tone.body}`}>
                                        Your career record was part of this submission.
                                    </p>
                                )}

                                {lastReviewed.review_note && (
                                    <p className={`mt-2 text-xs ${tone.body}`}><em>{lastReviewed.review_note}</em></p>
                                )}

                                {!approvedWhole && (
                                    <p className={`mt-2 text-xs ${tone.body}`}>
                                        Update what needs fixing below and submit again.
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
};

export default MyProfile;
