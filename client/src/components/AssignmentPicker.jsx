import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Search, X, AlertCircle, UserMinus } from 'lucide-react';

/** Was this id already selected when the dialog opened? */
const initialHas = (initial, id, isMulti) => (
    isMulti ? initial.includes(id) : initial === id
);

/**
 * Edit assignment links from either end.
 *
 *   mode="multi"    a recruiter's whole roster. Checkboxes, pre-ticked with
 *                   the consultants they already hold.
 *   mode="single"   one consultant's recruiter. Radios plus a "No recruiter"
 *                   choice, because `uq_assignments_one_current` allows a
 *                   consultant exactly one open assignment row — offering
 *                   checkboxes here would promise something the database
 *                   refuses to store.
 *
 * Nothing is written until Save, and Save stays disabled until the selection
 * actually differs from what is stored — an accidental open-and-close cannot
 * write a zero-length history row.
 *
 * The dialog is portalled to <body> for the same reason as LifecycleActions:
 * a `fixed` overlay nested in a table is clipped by the scroll container.
 */
const AssignmentPicker = ({
    title,
    subtitle,
    mode,
    options,          // [{ id, name, email, hint }]  hint = "Currently with Riya"
    initial,          // multi: string[]   single: string | null
    emptyText,
    onSave,           // async (selection) => void
    onClose,
}) => {
    const isMulti = mode === 'multi';

    const [selected, setSelected] = useState(
        () => (isMulti ? [...initial] : initial),
    );
    const [search, setSearch] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return options;
        return options.filter(
            (o) => o.name.toLowerCase().includes(q) || (o.email ?? '').toLowerCase().includes(q),
        );
    }, [options, search]);

    /* What Save would actually change, shown before it is clicked. */
    const diff = useMemo(() => {
        if (!isMulti) {
            return { changed: selected !== initial, added: [], removed: [] };
        }
        const added = selected.filter((id) => !initial.includes(id));
        const removed = initial.filter((id) => !selected.includes(id));
        return { changed: added.length > 0 || removed.length > 0, added, removed };
    }, [isMulti, selected, initial]);

    const toggle = (id) => {
        if (!isMulti) { setSelected(id); return; }
        setSelected((prev) => (prev.includes(id)
            ? prev.filter((x) => x !== id)
            : [...prev, id]));
    };

    const isSelected = (id) => (isMulti ? selected.includes(id) : selected === id);

    const submit = async () => {
        setBusy(true);
        setError('');
        try {
            await onSave(selected, reason.trim() || null);
        } catch (err) {
            // onSave rejects with a ready-made message string.
            setError(typeof err === 'string' ? err : 'Could not save. Please try again.');
            setBusy(false);
        }
    };

    const nameOf = (id) => options.find((o) => o.id === id)?.name ?? id;

    return createPortal(
        <div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4"
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="my-auto flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
            >
                {/* header */}
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
                    <div>
                        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                {/* search */}
                <div className="border-b border-slate-200 p-4">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            autoFocus
                            placeholder="Search by name or email…"
                            className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                        />
                    </div>
                </div>

                {/* list */}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    {options.length === 0 && (
                        <p className="p-6 text-center text-sm text-slate-400">{emptyText}</p>
                    )}
                    {options.length > 0 && visible.length === 0 && (
                        <p className="p-6 text-center text-sm text-slate-400">
                            Nobody matches “{search}”.
                        </p>
                    )}

                    {/* Single mode needs an explicit way to say "nobody" —
                        otherwise unassigning would be impossible from here. */}
                    {!isMulti && options.length > 0 && !search.trim() && (
                        <label className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-5 py-3 hover:bg-slate-50">
                            <input
                                type="radio"
                                checked={selected === null}
                                onChange={() => setSelected(null)}
                                className="h-4 w-4 shrink-0 accent-brand-600"
                            />
                            <span className="flex items-center gap-2 text-sm text-slate-600">
                                <UserMinus className="h-4 w-4 text-slate-400" />
                                No recruiter — leave unassigned
                            </span>
                        </label>
                    )}

                    {visible.map((o) => (
                        <label
                            key={o.id}
                            className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-5 py-3 hover:bg-slate-50"
                        >
                            <input
                                type={isMulti ? 'checkbox' : 'radio'}
                                checked={isSelected(o.id)}
                                onChange={() => toggle(o.id)}
                                className="h-4 w-4 shrink-0 accent-brand-600"
                            />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium text-slate-900">
                                    {o.name}
                                </span>
                                {o.email && (
                                    <span className="block truncate text-xs text-slate-500">{o.email}</span>
                                )}
                            </span>
                            {/* Ticking someone already held elsewhere is a move,
                                not a copy. Say so before Save, not after. */}
                            {o.hint && !isSelected(o.id) && (
                                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                                    {o.hint}
                                </span>
                            )}
                            {o.hint && isSelected(o.id) && !initialHas(initial, o.id, isMulti) && (
                                <span className="shrink-0 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                                    Moving from {o.hint.replace(/^Currently with /, '')}
                                </span>
                            )}
                        </label>
                    ))}
                </div>

                {/* footer */}
                <div className="border-t border-slate-200 p-5">
                    {error && (
                        <div className="mb-3 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {isMulti && diff.changed && (
                        <p className="mb-3 text-xs text-slate-600">
                            {diff.added.length > 0 && (
                                <span className="text-emerald-700">
                                    Adding {diff.added.map(nameOf).join(', ')}.{' '}
                                </span>
                            )}
                            {diff.removed.length > 0 && (
                                <span className="text-red-700">
                                    Releasing {diff.removed.map(nameOf).join(', ')}.
                                </span>
                            )}
                        </p>
                    )}

                    <label className="block">
                        <span className="text-sm text-slate-600">Reason (optional)</span>
                        <input
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Rebalancing workload"
                            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
                        />
                    </label>

                    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="text-xs text-slate-400">
                            {isMulti ? `${selected.length} selected` : ''}
                        </span>
                        <span className="flex flex-col-reverse gap-2 sm:flex-row">
                            <button
                                type="button"
                                onClick={onClose}
                                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={submit}
                                disabled={busy || !diff.changed}
                                title={diff.changed ? undefined : 'Nothing has changed yet'}
                                className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                                Save changes
                            </button>
                        </span>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default AssignmentPicker;
