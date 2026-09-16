import { useEffect, useRef, useState } from 'react';
import { Plus, X, Loader2, Search } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import { input, btnSm } from '../../design/tokens.js';

/**
 * Skills, with suggestions as you type.
 *
 * ── WHY THE SUGGESTIONS MATTER MORE THAN THEY LOOK ────────────────────
 *
 * A free-text skills box produces "React", "ReactJS", "React.js" and "react"
 * as four different skills. A consultant claiming one and a job asking for
 * another then fail to match, and nothing on any screen explains why — the
 * matcher is working perfectly against data that lies.
 *
 * So the list is the point. Every suggestion is a row in the shared
 * vocabulary, and picking one is what keeps a consultant's claim and an
 * employer's requirement the same string. Typing something genuinely new is
 * still allowed — the server checks aliases first, so "k8s" joins the
 * existing Kubernetes rather than founding a rival entry.
 *
 * Suggestions are ordered by how often each skill appears in the job postings
 * the system has actually ingested, so what a consultant is offered reflects
 * what employers in their market are asking for.
 */
const SkillPicker = ({ skills = [], onAdd, onRemove, disabled = false }) => {
    const [term, setTerm] = useState('');
    const [options, setOptions] = useState([]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [highlight, setHighlight] = useState(0);
    const boxRef = useRef(null);

    const claimed = new Set(skills.map((s) => s.skill_id ?? s.id));

    /* ── suggestions ──────────────────────────────────────────────── */

    useEffect(() => {
        if (!open) return undefined;

        // Debounced: a request per keystroke would fire six times for "python"
        // and the answers could arrive out of order, so the box would settle on
        // whichever response happened to be slowest rather than the latest.
        const timer = setTimeout(async () => {
            try {
                const { data } = await api.get('/skills/search', {
                    params: { q: term, limit: 10 },
                });
                setOptions(data.items ?? []);
                setHighlight(0);
            } catch {
                setOptions([]);
            }
        }, 180);

        return () => clearTimeout(timer);
    }, [term, open]);

    /* ── close on an outside click ────────────────────────────────── */

    useEffect(() => {
        const onClick = (e) => {
            if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    const add = async (option) => {
        const name = option?.name ?? term.trim();
        if (!name || busy) return;

        setBusy(true);
        setError('');
        try {
            // An id when it came from the list, a name when it was typed. The
            // server resolves the second through the alias table.
            await onAdd(option?.id ? { skillId: option.id } : { name });
            setTerm('');
            setOptions([]);
            setOpen(false);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    const onKeyDown = (e) => {
        if (!open) return;
        const usable = options.filter((o) => !claimed.has(o.id));

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, usable.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            // Enter on a highlighted suggestion takes it; Enter on free text
            // adds what was typed. Both are things people expect to work.
            add(usable[highlight] ?? null);
        } else if (e.key === 'Escape') {
            setOpen(false);
        }
    };

    const suggestions = options.filter((o) => !claimed.has(o.id));

    return (
        <div className="space-y-3">
            {/* ── what is already claimed ───────────────────────────── */}
            <div className="flex flex-wrap gap-2">
                {skills.length === 0 && (
                    <p className="text-sm text-muted">
                        No skills yet. Start typing below — this is what jobs are matched against.
                    </p>
                )}
                {skills.map((s) => (
                    <span
                        key={s.skill_id ?? s.id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line
                                   bg-surface-2 px-3 py-1 text-sm"
                    >
                        {s.name}
                        {!disabled && (
                            <button
                                type="button"
                                onClick={() => onRemove(s.skill_id ?? s.id)}
                                className="rounded-full p-0.5 text-muted hover:text-danger-600"
                                aria-label={`Remove ${s.name}`}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </span>
                ))}
            </div>

            {/* ── the search box ────────────────────────────────────── */}
            {!disabled && (
                <div ref={boxRef} className="relative">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4
                                           -translate-y-1/2 text-muted" />
                        <input
                            type="text"
                            value={term}
                            onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
                            onFocus={() => setOpen(true)}
                            onKeyDown={onKeyDown}
                            placeholder="Search skills — try java, k8s, react…"
                            className={`${input} mt-0 pl-9`}
                            aria-autocomplete="list"
                            aria-expanded={open}
                        />
                        {busy && (
                            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2
                                                animate-spin text-muted" />
                        )}
                    </div>

                    {open && (suggestions.length > 0 || term.trim()) && (
                        <ul
                            role="listbox"
                            className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg
                                       border border-line bg-surface shadow-lg"
                        >
                            {suggestions.map((o, i) => (
                                <li key={o.id}>
                                    <button
                                        type="button"
                                        onMouseEnter={() => setHighlight(i)}
                                        onClick={() => add(o)}
                                        className={`flex w-full items-center justify-between px-3 py-2
                                                    text-left text-sm
                                                    ${i === highlight ? 'bg-surface-2' : ''}`}
                                    >
                                        <span>{o.name}</span>
                                        {o.category && (
                                            <span className="text-xs text-muted">{o.category}</span>
                                        )}
                                    </button>
                                </li>
                            ))}

                            {/* Typing something the vocabulary does not know is
                                allowed — the list will never be complete, and a
                                consultant should not have to leave out a real
                                skill because we had not heard of it. */}
                            {term.trim()
                                && !suggestions.some(
                                    (o) => o.name.toLowerCase() === term.trim().toLowerCase(),
                                ) && (
                                <li className="border-t border-line">
                                    <button
                                        type="button"
                                        onClick={() => add(null)}
                                        className="flex w-full items-center gap-2 px-3 py-2
                                                   text-left text-sm text-brand-600"
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                        Add “{term.trim()}” as a new skill
                                    </button>
                                </li>
                            )}
                        </ul>
                    )}
                </div>
            )}

            {error && <p className="text-sm text-danger-600">{error}</p>}
        </div>
    );
};

export default SkillPicker;
