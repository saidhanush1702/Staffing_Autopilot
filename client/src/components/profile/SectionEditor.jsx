import { useState } from 'react';
import {
    Plus, Pencil, Trash2, ChevronUp, ChevronDown, Check, X,
    CheckCircle2, AlertCircle,
} from 'lucide-react';
import {
    PROFILE_SECTIONS, emptyRow, validateRow, toPayload,
} from '../../config/profileSections.js';
import { card, cardPad, input, btn, btnSm } from '../../design/tokens.js';

/**
 * One repeatable career section — education, experience, projects or
 * certifications.
 *
 * ── WHY ONE COMPONENT FOR ALL FOUR ────────────────────────────────────
 *
 * They differ only in their fields, which are declared in
 * config/profileSections.js. Four separate editors would drift: one would
 * validate on blur and another on submit, one would trim and another would
 * not, and a consultant would meet four subtly different forms in the same
 * sitting.
 *
 * ── WHY THIS EDITS LOCAL STATE, NOT THE SERVER ─────────────────────────
 *
 * Add, edit, delete and reorder used to be four instant API calls — this
 * section was self-service, saved the moment a consultant touched it. It is
 * now part of the merged profile: everything a consultant changes, identity
 * and career together, goes to the server ONCE, as one submission for
 * approval (see pages/portal/MyProfile.jsx). So this component only ever
 * mutates the array its parent gave it, via `onChange`, and nothing here
 * calls the API at all.
 *
 * ── WHY EVERY ROW NEEDS A `key` ─────────────────────────────────────────
 *
 * A row loaded from the live, approved record has a server `id`. A row just
 * added in this sitting does not — nothing is persisted until submit — so
 * there is no server id to edit or delete it by. The parent stamps a stable
 * local `key` on every row (the server id when there is one, a generated one
 * when there is not — see MyProfile.jsx), and this component addresses rows
 * by that key alone.
 *
 * ── WHY ORDER IS EDITABLE ─────────────────────────────────────────────
 *
 * This is the order the resume prints in, and the order the tailoring step
 * starts from before it reorders for a specific job. A consultant who wants
 * their most relevant role first should be able to say so. Order lives
 * entirely in array position now — moving a row just reorders the array —
 * which is exactly what the server turns back into a `position` column when
 * the submission is approved.
 */
const SectionEditor = ({
    section, items, onChange, disabled = false,
}) => {
    const def = PROFILE_SECTIONS[section];
    const [editing, setEditing] = useState(null);     // a row's key, or 'new'
    const [draft, setDraft] = useState({});
    const [errors, setErrors] = useState({});

    const startNew = () => {
        setDraft(emptyRow(section));
        setErrors({});
        setEditing('new');
    };

    const startEdit = (row) => {
        // Arrays arrive as arrays but the list inputs edit them as text, so
        // they are normalised here rather than in three separate places.
        const d = { ...row };
        for (const f of def.fields) {
            if (f.type === 'list' || f.type === 'taglist') {
                d[f.name] = Array.isArray(row[f.name]) ? row[f.name] : [];
            }
            if (d[f.name] === null || d[f.name] === undefined) {
                d[f.name] = f.type === 'checkbox' ? false : '';
            }
        }
        setDraft(d);
        setErrors({});
        setEditing(row.key);
    };

    const cancel = () => { setEditing(null); setDraft({}); setErrors({}); };

    const save = () => {
        const found = validateRow(section, draft);
        if (Object.keys(found).length > 0) { setErrors(found); return; }

        const payload = toPayload(section, draft);

        if (editing === 'new') {
            const key = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            onChange([...items, { ...payload, key }]);
        } else {
            onChange(items.map((row) => (row.key === editing ? { ...row, ...payload } : row)));
        }
        cancel();
    };

    const remove = (key) => {
        onChange(items.filter((row) => row.key !== key));
    };

    const move = (index, delta) => {
        const next = [...items];
        const to = index + delta;
        if (to < 0 || to >= next.length) return;
        [next[index], next[to]] = [next[to], next[index]];
        onChange(next);
    };

    /* ── one input ─────────────────────────────────────────────────── */

    const field = (f) => {
        const v = draft[f.name];
        const set = (value) => setDraft((d) => ({ ...d, [f.name]: value }));
        const invalid = errors[f.name];

        const common = {
            id: `${section}-${f.name}`,
            className: `${input} ${invalid ? 'border-danger-400' : ''}`,
        };

        return (
            <div key={f.name} className={f.type === 'textarea' || f.type === 'list' ? 'sm:col-span-2' : ''}>
                <label htmlFor={common.id} className="text-sm font-medium">
                    {f.label}
                    {f.required && <span className="ml-0.5 text-danger-600">*</span>}
                </label>

                {f.type === 'select' && (
                    <select {...common} value={v ?? ''} onChange={(e) => set(e.target.value)}>
                        {f.options.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                )}

                {f.type === 'textarea' && (
                    <textarea {...common} rows={3} value={v ?? ''} maxLength={f.max}
                        onChange={(e) => set(e.target.value)} />
                )}

                {/* One point per line. A textarea is the honest control here —
                    people paste bullets from an existing resume, and a
                    row-by-row widget makes that a chore. */}
                {f.type === 'list' && (
                    <textarea {...common} rows={4}
                        value={Array.isArray(v) ? v.join('\n') : ''}
                        placeholder="One point per line"
                        onChange={(e) => set(e.target.value.split('\n'))} />
                )}

                {f.type === 'taglist' && (
                    <input {...common} type="text"
                        value={Array.isArray(v) ? v.join(', ') : ''}
                        onChange={(e) => set(e.target.value.split(',').map((x) => x.trim()))} />
                )}

                {f.type === 'checkbox' && (
                    <label className="mt-1.5 flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={Boolean(v)}
                            onChange={(e) => set(e.target.checked)} />
                        <span className="text-muted">Yes</span>
                    </label>
                )}

                {['text', 'number', 'url'].includes(f.type) && (
                    <input {...common}
                        type={f.type === 'number' ? 'number' : 'text'}
                        value={v ?? ''} maxLength={f.max}
                        min={f.min} max={f.type === 'number' ? f.max : undefined}
                        onChange={(e) => set(e.target.value)} />
                )}

                {invalid && <p className="mt-1 text-xs text-danger-600">{invalid}</p>}
                {!invalid && f.hint && <p className="mt-1 text-xs text-muted">{f.hint}</p>}
            </div>
        );
    };

    const form = (
        <div className={`${card} ${cardPad} border-brand-300`}>
            <div className="grid gap-4 sm:grid-cols-2">
                {def.fields.map(field)}
            </div>
            <div className="mt-4 flex gap-2">
                <button type="button" className={btn.primary} onClick={save}>
                    <Check className="h-4 w-4" /> Save
                </button>
                <button type="button" className={btn.ghost} onClick={cancel}>
                    <X className="h-4 w-4" /> Cancel
                </button>
            </div>
        </div>
    );

    return (
        <section className="space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-1.5 text-base font-semibold">
                    {def.label}
                    {items.length > 0 && (
                        <span className="text-sm font-normal text-muted">{items.length}</span>
                    )}
                    {items.length > 0
                        ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success-600" aria-label="At least one added" />
                        : <AlertCircle className="h-4 w-4 shrink-0 text-warning-500" aria-label="Nothing added yet" />}
                </h3>
                {!disabled && editing !== 'new' && (
                    <button type="button" className={btnSm.ghost} onClick={startNew}>
                        <Plus className="h-3.5 w-3.5" /> Add {def.singular}
                    </button>
                )}
            </div>

            {editing === 'new' && form}

            {items.length === 0 && editing !== 'new' && (
                <p className="text-sm text-muted">
                    Nothing added yet.
                </p>
            )}

            {items.map((row, i) => (
                editing === row.key ? (
                    <div key={row.key}>{form}</div>
                ) : (
                    <div key={row.key} className={`${card} ${cardPad} flex items-start justify-between gap-4`}>
                        <div className="min-w-0">
                            <p className="truncate font-medium">{def.title(row) || '—'}</p>
                            <p className="truncate text-sm text-muted">{def.subtitle(row)}</p>
                        </div>

                        {!disabled && (
                            <div className="flex shrink-0 items-center gap-1">
                                {/* This is the order the resume prints in. */}
                                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}
                                    className="rounded p-1.5 text-muted hover:text-ink disabled:opacity-30"
                                    aria-label="Move up">
                                    <ChevronUp className="h-4 w-4" />
                                </button>
                                <button type="button" onClick={() => move(i, 1)}
                                    disabled={i === items.length - 1}
                                    className="rounded p-1.5 text-muted hover:text-ink disabled:opacity-30"
                                    aria-label="Move down">
                                    <ChevronDown className="h-4 w-4" />
                                </button>
                                <button type="button" onClick={() => startEdit(row)}
                                    className="rounded p-1.5 text-muted hover:text-ink"
                                    aria-label="Edit">
                                    <Pencil className="h-4 w-4" />
                                </button>
                                <button type="button" onClick={() => remove(row.key)}
                                    className="rounded p-1.5 text-muted hover:text-danger-600"
                                    aria-label="Delete">
                                    <Trash2 className="h-4 w-4" />
                                </button>
                            </div>
                        )}
                    </div>
                )
            ))}
        </section>
    );
};

export default SectionEditor;
