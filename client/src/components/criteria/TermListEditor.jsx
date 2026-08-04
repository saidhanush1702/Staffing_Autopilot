import { useState } from 'react';
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react';
import { inputBase, btnSm, badge, TONE, fieldLabel, fieldHint } from '../../design/tokens.js';

/**
 * An ordered list of short strings — job titles, keywords, excluded companies.
 *
 * `orderable` is only true for job titles, where the order IS the priority.
 * Keywords and companies are sets, so offering arrows there would imply a
 * meaning the matching engine will not honour.
 *
 * Duplicates are rejected here case-insensitively, matching what the server
 * does on save. Catching it in the field means the user sees why, rather than
 * typing a duplicate and watching it silently vanish after saving.
 */
const TermListEditor = ({
    label, hint, placeholder, values, onChange, orderable = false, tone = 'neutral', disabled,
}) => {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');

    const add = () => {
        const value = draft.trim();
        if (!value) return;
        if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
            setError(`"${value}" is already in this list.`);
            return;
        }
        onChange([...values, value]);
        setDraft('');
        setError('');
    };

    const remove = (i) => onChange(values.filter((_, idx) => idx !== i));

    const move = (i, delta) => {
        const next = [...values];
        const target = i + delta;
        if (target < 0 || target >= next.length) return;
        [next[i], next[target]] = [next[target], next[i]];
        onChange(next);
    };

    return (
        <div>
            <span className={fieldLabel}>{label}</span>
            {hint && <p className={fieldHint}>{hint}</p>}

            {!disabled && (
                <div className="mt-1.5 flex gap-2">
                    <input
                        value={draft}
                        onChange={(e) => { setDraft(e.target.value); setError(''); }}
                        // Enter adds a term; it must not submit the whole form,
                        // which would save a half-typed criteria set.
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); add(); }
                        }}
                        maxLength={200}
                        placeholder={placeholder}
                        className={inputBase}
                    />
                    <button type="button" onClick={add} className={btnSm.secondary} title={`Add to ${label}`}>
                        <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                </div>
            )}

            {error && <p className="mt-1 text-xs text-danger-700">{error}</p>}

            {values.length === 0 ? (
                <p className="mt-2 text-xs text-slate-400">None yet.</p>
            ) : (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                    {values.map((v, i) => (
                        <li key={`${v}-${i}`} className={`${badge} ${TONE[tone]} gap-1`}>
                            {orderable && <span className="tabular-nums opacity-60">{i + 1}.</span>}
                            <span className="max-w-[16rem] truncate">{v}</span>

                            {orderable && !disabled && (
                                <>
                                    <button
                                        type="button" onClick={() => move(i, -1)} disabled={i === 0}
                                        aria-label={`Move ${v} up`} title="Higher priority"
                                        className="opacity-60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                                    >
                                        <ChevronUp className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button" onClick={() => move(i, 1)} disabled={i === values.length - 1}
                                        aria-label={`Move ${v} down`} title="Lower priority"
                                        className="opacity-60 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-20"
                                    >
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    </button>
                                </>
                            )}

                            {!disabled && (
                                <button
                                    type="button" onClick={() => remove(i)}
                                    aria-label={`Remove ${v}`}
                                    className="opacity-60 hover:opacity-100"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default TermListEditor;
