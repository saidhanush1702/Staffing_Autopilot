import { useEffect, useState } from 'react';
import {
    Send, Loader2, AlertCircle, Clock, CheckCircle2, XCircle, MinusCircle,
    Undo2, Download, ShieldCheck, Check, X,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import ProfileField from '../../components/ProfileField.jsx';
import { TONE_ALERT, card, cardPad, cardPadRoomy } from '../../design/tokens.js';

/**
 * Consultant self-service profile.
 *
 * Edits never write to the live profile. Changed fields become a request that
 * a recruiter or org admin reviews field by field. While a request is pending
 * the form is locked, so there is only ever one set of proposed values.
 */
const MyProfile = () => {
    const [data, setData] = useState(null);
    const [schema, setSchema] = useState(null);
    const [lookups, setLookups] = useState(null);
    const [draft, setDraft] = useState({});
    const [error, setError] = useState('');
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    const load = async () => {
        try {
            const [me, sch, lk] = await Promise.all([
                api.get('/portal/me'),
                api.get('/profile-schema'),
                api.get('/lookups'),
            ]);
            setData(me.data);
            setSchema(sch.data);
            setLookups(lk.data);

            const d = {};
            for (const name of sch.data.consultantEditable) d[name] = me.data.profile[name] ?? null;
            setDraft(d);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    const setField = (name, value) => setDraft((d) => ({ ...d, [name]: value }));

    const submit = async (e) => {
        e.preventDefault();
        setFormError('');
        setSaving(true);
        try {
            await api.post('/portal/profile/change-request', draft);
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

    if (error) return <p className="text-sm text-red-600">{error}</p>;
    if (!data || !schema || !lookups) return <PageLoader />;

    const { profile, recruiter, missingFields, isComplete, pendingRequest, lastReviewed } = data;
    const locked = Boolean(pendingRequest);
    const fieldLabel = (n) => schema.fields[n]?.label ?? n;

    // Anything actually different from the live profile.
    const dirty = schema.consultantEditable.some(
        (n) => String(draft[n] ?? '') !== String(profile[n] ?? ''),
    );

    return (
        <div className="max-w-4xl">
            <h1 className="text-xl font-semibold text-slate-900">My profile</h1>
            <p className="mt-1 text-sm text-slate-500">
                Keep this up to date — it is used on every job application submitted for you.
                Changes are reviewed by your recruiter before they take effect.
            </p>

            {/* ── incomplete banner ─────────────────────────────── */}
            {!isComplete && !locked && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        <strong>Your profile is incomplete.</strong> Still needed:{' '}
                        {missingFields.map(fieldLabel).join(', ')}.
                    </span>
                </div>
            )}

            {isComplete && !locked && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Your profile is complete and approved.</span>
                </div>
            )}

            {/* ── pending banner ────────────────────────────────── */}
            {locked && (
                <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-4">
                    <div className="flex items-start gap-2">
                        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                        <div className="flex-1">
                            <p className="text-sm font-medium text-sky-900">Changes awaiting approval</p>
                            <p className="mt-0.5 text-xs text-sky-700">
                                Submitted {new Date(pendingRequest.submitted_at).toLocaleString()}
                                {recruiter && ` · waiting on ${recruiter.name}`}
                            </p>
                            <ul className="mt-2 space-y-1">
                                {pendingRequest.fields.map((f) => (
                                    <li key={f.field_name} className="text-xs text-sky-800">
                                        <span className="font-medium">{fieldLabel(f.field_name)}</span>
                                        {' → '}{f.new_display ?? '(cleared)'}
                                    </li>
                                ))}
                            </ul>
                            <button
                                type="button"
                                onClick={withdraw}
                                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs text-sky-800 hover:bg-sky-50"
                            >
                                <Undo2 className="h-3.5 w-3.5" /> Withdraw and edit again
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── last review outcome ───────────────────────────── */}
            {!locked && lastReviewed && (() => {
                const anyRejected = lastReviewed.rejected_count > 0;
                const allApproved = lastReviewed.rejected_count === 0;
                const tone = allApproved
                    ? { border: 'border-emerald-200', bg: 'bg-emerald-50', head: 'text-emerald-900', body: 'text-emerald-800', icon: CheckCircle2, iconCls: 'text-emerald-600' }
                    : anyRejected && lastReviewed.approved_count === 0
                        ? { border: 'border-red-200', bg: 'bg-red-50', head: 'text-red-900', body: 'text-red-800', icon: XCircle, iconCls: 'text-red-600' }
                        : { border: 'border-sky-200', bg: 'bg-sky-50', head: 'text-sky-900', body: 'text-sky-800', icon: MinusCircle, iconCls: 'text-sky-600' };
                const Icon = tone.icon;

                return (
                    <div className={`mt-4 rounded-lg border ${tone.border} ${tone.bg} p-4`}>
                        <div className="flex items-start gap-2">
                            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconCls}`} />
                            <div className="flex-1">
                                <p className={`text-sm font-medium ${tone.head}`}>
                                    {allApproved
                                        ? 'Your last changes were approved'
                                        : lastReviewed.approved_count === 0
                                            ? 'Your last changes were not approved'
                                            : `${lastReviewed.approved_count} approved, ${lastReviewed.rejected_count} not approved`}
                                </p>

                                <p className={`mt-0.5 text-xs ${tone.body}`}>
                                    Reviewed by <strong>{lastReviewed.reviewed_by_name ?? 'your agency'}</strong>
                                    {lastReviewed.reviewed_by_role && (
                                        <span className="ml-1 rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-medium">
                                            {lastReviewed.reviewed_by_role.replace('_', ' ')}
                                        </span>
                                    )}
                                    {lastReviewed.reviewed_at && (
                                        <> on {new Date(lastReviewed.reviewed_at).toLocaleString()}</>
                                    )}
                                </p>

                                <ul className="mt-2 space-y-1">
                                    {lastReviewed.fields.map((f) => (
                                        <li key={f.field_name} className={`text-xs ${tone.body}`}>
                                            {f.status === 'APPROVED'
                                                ? <Check className="mr-1 inline h-3 w-3 text-emerald-600" />
                                                : <X className="mr-1 inline h-3 w-3 text-red-600" />}
                                            <span className="font-medium">{fieldLabel(f.field_name)}</span>
                                            {' → '}{f.new_display ?? '(cleared)'}
                                            {f.review_note && <> — <em>{f.review_note}</em></>}
                                        </li>
                                    ))}
                                </ul>

                                {anyRejected && (
                                    <p className={`mt-2 text-xs ${tone.body}`}>
                                        Update the rejected fields below and submit again.
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* ── editable form ─────────────────────────────────── */}
            <form onSubmit={submit} className={`mt-6 ${card} ${cardPadRoomy}`}>
                {formError && (
                    <div className={`mb-4 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{formError}
                    </div>
                )}

                <div className="grid gap-5 sm:grid-cols-2">
                    {schema.consultantEditable.map((name) => (
                        <ProfileField
                            key={name}
                            name={name}
                            field={schema.fields[name]}
                            value={draft[name]}
                            onChange={setField}
                            lookups={lookups}
                            disabled={locked}
                            currentFileName={name === 'base_resume_artifact_id' ? profile.resume_name : undefined}
                        />
                    ))}
                </div>

                {!locked && (
                    <button
                        type="submit"
                        disabled={saving || !dirty}
                        title={!dirty ? 'Change something first' : undefined}
                        className="mt-6 flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        Submit for approval
                    </button>
                )}
                {!locked && !dirty && (
                    <p className="mt-2 text-xs text-slate-400">
                        Only the fields you change are sent for review.
                    </p>
                )}
            </form>

            {/* ── read-only info ────────────────────────────────── */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">My recruiter</p>
                    <p className="mt-2 text-sm text-slate-800">{recruiter?.name ?? 'Not assigned yet'}</p>
                    <p className="text-xs text-slate-500">{recruiter?.email ?? ''}</p>
                </div>
                <div className={`${card} ${cardPad}`}>
                    <p className="text-sm font-medium text-slate-700">Set by your agency</p>
                    <dl className="mt-2 space-y-1 text-sm">
                        <div className="flex justify-between">
                            <dt className="text-slate-500">Daily application cap</dt>
                            <dd className="text-slate-800">{profile.daily_cap}</dd>
                        </div>
                        <div className="flex justify-between">
                            <dt className="text-slate-500">Consent on file</dt>
                            <dd className="text-slate-800">
                                {profile.consent_on_file
                                    ? <CheckCircle2 className="inline h-4 w-4 text-emerald-600" />
                                    : <span className="text-amber-600">Not yet</span>}
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
        </div>
    );
};

export default MyProfile;
