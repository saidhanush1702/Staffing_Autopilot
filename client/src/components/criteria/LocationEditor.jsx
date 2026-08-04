import { Plus, Trash2 } from 'lucide-react';
import { inputBase, btnSm, fieldLabel, fieldHint } from '../../design/tokens.js';

/**
 * Where the consultant will work.
 *
 * The two rules below mirror CHECK constraints on search_criteria_locations,
 * so the form cannot compose a row the database would reject:
 *
 *   ONSITE / HYBRID  need a city
 *   REMOTE           cannot carry a radius — a radius around "anywhere" is
 *                    meaningless, so the field is disabled and cleared rather
 *                    than accepted and quietly dropped
 */
export const WORK_MODES = [
    { value: 'ONSITE', label: 'Onsite' },
    { value: 'HYBRID', label: 'Hybrid' },
    { value: 'REMOTE', label: 'Remote' },
];

const blank = { city: '', state: '', workMode: 'ONSITE', radiusMiles: null };

const LocationEditor = ({ values, onChange, disabled }) => {
    const update = (i, patch) => onChange(values.map((l, idx) => {
        if (idx !== i) return l;
        const next = { ...l, ...patch };
        // Switching to remote clears what remote cannot hold.
        if (next.workMode === 'REMOTE') next.radiusMiles = null;
        return next;
    }));

    const remove = (i) => onChange(values.filter((_, idx) => idx !== i));

    return (
        <div>
            <span className={fieldLabel}>Locations</span>
            <p className={fieldHint}>
                Onsite and hybrid need a city. Remote covers anywhere, so it takes no radius.
            </p>

            {values.length === 0 && (
                <p className="mt-2 text-xs text-slate-400">No locations yet — add at least one.</p>
            )}

            <div className="mt-2 space-y-2">
                {values.map((l, i) => {
                    const isRemote = l.workMode === 'REMOTE';
                    return (
                        <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem_7rem_auto]">
                            <input
                                value={l.city ?? ''}
                                onChange={(e) => update(i, { city: e.target.value })}
                                placeholder={isRemote ? 'Anywhere' : 'City (required)'}
                                maxLength={120}
                                disabled={disabled}
                                className={inputBase}
                            />
                            <input
                                value={l.state ?? ''}
                                onChange={(e) => update(i, { state: e.target.value })}
                                placeholder="State"
                                maxLength={120}
                                disabled={disabled}
                                className={inputBase}
                            />
                            <select
                                value={l.workMode}
                                onChange={(e) => update(i, { workMode: e.target.value })}
                                disabled={disabled}
                                className={inputBase}
                            >
                                {WORK_MODES.map((m) => (
                                    <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                            </select>
                            <input
                                type="number" min={1} max={500}
                                value={l.radiusMiles ?? ''}
                                onChange={(e) => update(i, {
                                    radiusMiles: e.target.value === '' ? null : Number(e.target.value),
                                })}
                                placeholder={isRemote ? '—' : 'Radius mi'}
                                disabled={disabled || isRemote}
                                title={isRemote ? 'A remote location has no radius' : 'Search radius in miles'}
                                className={inputBase}
                            />
                            {!disabled && (
                                <button
                                    type="button" onClick={() => remove(i)}
                                    aria-label="Remove location"
                                    className={btnSm.danger}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            {!disabled && (
                <button
                    type="button"
                    onClick={() => onChange([...values, { ...blank }])}
                    className={`mt-2 ${btnSm.secondary}`}
                >
                    <Plus className="h-3.5 w-3.5" /> Add location
                </button>
            )}
        </div>
    );
};

export default LocationEditor;
