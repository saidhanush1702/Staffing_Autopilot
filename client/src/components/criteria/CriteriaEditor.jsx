import { useEffect, useMemo, useState } from 'react';
import {
    Save, Loader2, AlertCircle, Play, Pause, Search, Info,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../PageLoader.jsx';
import TermListEditor from './TermListEditor.jsx';
import LocationEditor from './LocationEditor.jsx';
import VersionHistory from './VersionHistory.jsx';
import CriteriaView from './CriteriaView.jsx';
import AuditLogPanel from '../layout/AuditLogPanel.jsx';
import {
    card, cardPad, input, inputBase, fieldLabel, fieldHint, btn, badge, sectionTitle,
    TONE, TONE_ALERT,
} from '../../design/tokens.js';
import { useLookups } from '../../context/LookupContext.jsx';

const PAY_UNITS = [
    { value: 'HOURLY', label: 'per hour' },
    { value: 'ANNUAL', label: 'per year' },
];

/** The API payload, as a plain editable object. */
const toDraft = (version) => ({
    jobTitles: [...(version?.jobTitles ?? [])],
    keywordsInclude: [...(version?.keywordsInclude ?? [])],
    keywordsExclude: [...(version?.keywordsExclude ?? [])],
    excludedCompanies: [...(version?.excludedCompanies ?? [])],
    locations: (version?.locations ?? []).map((l) => ({ ...l })),
    workTypeIds: [...(version?.workTypeIds ?? [])],
    minPay: {
        amount: version?.minPay?.amount ?? null,
        unit: version?.minPay?.unit ?? null,
        currency: version?.minPay?.currency ?? 'USD',
    },
});

/**
 * Search criteria for one consultant — the editor.
 *
 * Saving creates a NEW version rather than overwriting; the server refuses a
 * save that would produce an identical one. Pausing does not fork a version,
 * because it is an operational state and not a change to what is being
 * searched for.
 *
 * There is no approval step. Unlike a profile field — a fact about the
 * consultant, which they assert and a reviewer checks — criteria are a
 * business decision the recruiter owns outright (R-23, P-10).
 */
const CriteriaEditor = ({ consultantId }) => {
    const { options } = useLookups();

    const [payload, setPayload] = useState(null);
    const [versions, setVersions] = useState([]);
    const [draft, setDraft] = useState(null);
    const [changeNote, setChangeNote] = useState('');
    const [error, setError] = useState('');
    const [saveError, setSaveError] = useState('');
    const [saving, setSaving] = useState(false);
    const [toggling, setToggling] = useState(false);

    const load = async () => {
        try {
            const [c, v] = await Promise.all([
                api.get(`/management/consultants/${consultantId}/criteria`),
                api.get(`/management/consultants/${consultantId}/criteria/versions`),
            ]);
            setPayload(c.data);
            setVersions(v.data.versions);
            setDraft(toDraft(c.data.version));
            setChangeNote('');
            setSaveError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); /* eslint-disable-next-line */ }, [consultantId]);

    // Compared against the saved version so the Save button can be honest
    // about whether pressing it would do anything.
    const dirty = useMemo(() => {
        if (!payload || !draft) return false;
        return JSON.stringify(toDraft(payload.version)) !== JSON.stringify(draft);
    }, [payload, draft]);

    if (error) return <p className="text-sm text-danger-700">{error}</p>;
    if (!payload || !draft) return <PageLoader />;

    const { criteria, version } = payload;
    const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

    const save = async () => {
        setSaving(true);
        setSaveError('');
        try {
            await api.put(`/management/consultants/${consultantId}/criteria`, {
                ...draft,
                changeNote: changeNote.trim() || null,
            });
            await load();
        } catch (err) {
            setSaveError(errorMessage(err, 'Could not save the criteria.'));
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async () => {
        setToggling(true);
        setSaveError('');
        try {
            await api.post(`/management/consultants/${consultantId}/criteria/toggle-active`, {
                isActive: !criteria.isActive,
            });
            await load();
        } catch (err) {
            setSaveError(errorMessage(err, 'Could not change the discovery state.'));
        } finally {
            setToggling(false);
        }
    };

    const toggleWorkType = (id) => set({
        workTypeIds: draft.workTypeIds.includes(id)
            ? draft.workTypeIds.filter((x) => x !== id)
            : [...draft.workTypeIds, id],
    });

    // Three distinct states, because they mean different things to a recruiter
    // working their bench: never configured, configured but off, and running.
    const status = !criteria.configured
        ? { tone: 'neutral', text: 'Not set up' }
        : criteria.isActive
            ? { tone: 'success', text: 'Active' }
            : { tone: 'warning', text: 'Paused' };

    return (
        <div className="space-y-6">
            {/* ── state bar ──────────────────────────────────────── */}
            <div className={`${card} ${cardPad} flex flex-wrap items-center justify-between gap-3`}>
                <div>
                    <div className="flex items-center gap-2">
                        <h2 className={sectionTitle}>Job discovery</h2>
                        <span className={`${badge} ${TONE[status.tone]}`}>{status.text}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                        {criteria.isActive
                            ? 'These criteria are in force. Version '
                              + `${criteria.currentVersionNo} is what a match would be judged against.`
                            : criteria.configured
                                ? 'Saved, but paused — nothing will be searched for until it is resumed.'
                                : 'Nothing is saved yet. An empty criteria set matches nothing, by design.'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleActive}
                    disabled={toggling || !criteria.configured}
                    title={criteria.configured ? undefined : 'Save some criteria first'}
                    className={criteria.isActive ? btn.secondary : btn.primary}
                >
                    {toggling
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : criteria.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    {criteria.isActive ? 'Pause discovery' : 'Activate discovery'}
                </button>
            </div>

            {/* ── editor ─────────────────────────────────────────── */}
            <div className={`${card} ${cardPad} space-y-6`}>
                <div>
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <Search className="h-4 w-4 text-slate-400" /> What to look for
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                        Saving writes a new version. The previous one stays readable in the history below.
                    </p>
                </div>

                <TermListEditor
                    label="Job titles"
                    hint="In priority order — the first is what we chase hardest."
                    placeholder="React Developer"
                    values={draft.jobTitles}
                    onChange={(v) => set({ jobTitles: v })}
                    orderable
                    tone="brand"
                />

                <div className="grid gap-6 sm:grid-cols-2">
                    <TermListEditor
                        label="Include keywords"
                        hint="Words that make a posting interesting."
                        placeholder="TypeScript"
                        values={draft.keywordsInclude}
                        onChange={(v) => set({ keywordsInclude: v })}
                        tone="success"
                    />
                    <TermListEditor
                        label="Exclude keywords"
                        hint="Words that rule a posting out entirely."
                        placeholder="Unpaid"
                        values={draft.keywordsExclude}
                        onChange={(v) => set({ keywordsExclude: v })}
                        tone="danger"
                    />
                </div>

                <LocationEditor
                    values={draft.locations}
                    onChange={(v) => set({ locations: v })}
                />

                {/* work types — options come from lkp_work_types */}
                <div>
                    <span className={fieldLabel}>Work types</span>
                    <p className={fieldHint}>Which engagement types this consultant will accept.</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                        {options('workTypes').map((w) => {
                            const on = draft.workTypeIds.includes(w.id);
                            return (
                                <button
                                    key={w.id}
                                    type="button"
                                    onClick={() => toggleWorkType(w.id)}
                                    aria-pressed={on}
                                    className={`${badge} border ${on
                                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                                        : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
                                >
                                    {w.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* minimum pay */}
                <div>
                    <span className={fieldLabel}>Minimum pay</span>
                    <p className={fieldHint}>
                        Amount and unit go together — “60” alone could be an hourly rate or a salary.
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                        <input
                            type="number" min={0} step="0.01"
                            value={draft.minPay.amount ?? ''}
                            onChange={(e) => set({
                                minPay: {
                                    ...draft.minPay,
                                    amount: e.target.value === '' ? null : Number(e.target.value),
                                    // Clearing the amount clears the unit, so the pair can
                                    // never be half-filled — the server refuses that anyway.
                                    unit: e.target.value === '' ? null : (draft.minPay.unit ?? 'HOURLY'),
                                },
                            })}
                            placeholder="No minimum"
                            className={`${inputBase} max-w-[10rem]`}
                        />
                        <select
                            value={draft.minPay.unit ?? ''}
                            onChange={(e) => set({
                                minPay: { ...draft.minPay, unit: e.target.value || null },
                            })}
                            disabled={draft.minPay.amount === null}
                            className={`${inputBase} max-w-[10rem]`}
                        >
                            <option value="">Unit…</option>
                            {PAY_UNITS.map((u) => (
                                <option key={u.value} value={u.value}>{u.label}</option>
                            ))}
                        </select>
                    </div>
                </div>

                <TermListEditor
                    label="Excluded companies"
                    hint="Never surface a posting from these employers."
                    placeholder="Acme Staffing"
                    values={draft.excludedCompanies}
                    onChange={(v) => set({ excludedCompanies: v })}
                    tone="warning"
                />

                {/* save */}
                <div className="border-t border-slate-200 pt-5">
                    {saveError && (
                        <div className={`mb-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.danger}`}>
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{saveError}</span>
                        </div>
                    )}

                    <label className="block">
                        <span className={fieldLabel}>Why this change? (optional)</span>
                        <input
                            value={changeNote}
                            onChange={(e) => setChangeNote(e.target.value)}
                            maxLength={500}
                            placeholder="Widened to remote after client feedback"
                            className={input}
                        />
                    </label>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-xs text-slate-400">
                            <Info className="h-3.5 w-3.5" />
                            {dirty
                                ? 'Unsaved changes — this will create a new version.'
                                : 'Nothing changed since the last save.'}
                        </span>
                        <button
                            type="button"
                            onClick={save}
                            disabled={saving || !dirty}
                            title={dirty ? undefined : 'Change something first'}
                            className={btn.primary}
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save criteria
                        </button>
                    </div>
                </div>
            </div>

            {/* ── what is live right now ─────────────────────────── */}
            {criteria.configured && (
                <div className={`${card} ${cardPad}`}>
                    <h2 className={sectionTitle}>
                        In force — version {criteria.currentVersionNo}
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                        What the consultant sees on their portal, and what a match would be judged against.
                    </p>
                    <div className="mt-4">
                        <CriteriaView version={version} />
                    </div>
                </div>
            )}

            <VersionHistory
                consultantId={consultantId}
                versions={versions}
                currentVersion={version?.id ? version : null}
                canEdit
                onRestored={load}
            />

            {/* Renders nothing for a RECRUITER — the panel is ORG_ADMIN only. */}
            <AuditLogPanel module="criteria" />
        </div>
    );
};

export default CriteriaEditor;
