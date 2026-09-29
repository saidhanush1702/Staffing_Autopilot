import { PROFILE_SECTIONS } from '../../config/profileSections.js';
import { card, cardPad, chip } from '../../design/tokens.js';

/**
 * Read-only rendering of one career section — education, experience,
 * projects or certifications — fully expanded, every field.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM SectionEditor ──────────────────────
 *
 * SectionEditor's collapsed row (title + subtitle) is right for a consultant
 * editing their own record — they already know what a "Software Engineer at
 * Acme" row contains, and the point there is add/edit/reorder. A recruiter or
 * org admin looking at a consultant's page has the opposite need: they came
 * to READ, and a title and one subtitle line hides exactly the fields that
 * matter most here — the bullets, the tech stack, the dates. So this expands
 * every field PROFILE_SECTIONS declares, and renders nothing at all (not
 * this component, not a section) when a row has nothing in that field.
 */
const fieldValue = (f, row) => {
    const v = row[f.name];

    if (f.type === 'list') {
        const items = (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean);
        if (items.length === 0) return null;
        return (
            <ul className="list-disc space-y-0.5 pl-4">
                {items.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
        );
    }

    if (f.type === 'taglist') {
        const items = (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean);
        if (items.length === 0) return null;
        return (
            <div className="flex flex-wrap gap-1.5">
                {items.map((tag, i) => <span key={i} className={chip}>{tag}</span>)}
            </div>
        );
    }

    if (f.type === 'checkbox') return v ? 'Yes' : null;

    if (f.type === 'select') {
        const opt = f.options?.find((o) => o.value === v);
        return opt?.label || v || null;
    }

    if (f.type === 'url') {
        if (!v) return null;
        return (
            <a href={v} target="_blank" rel="noreferrer" className="break-all text-brand-700 hover:underline">
                {v}
            </a>
        );
    }

    return (v || v === 0) ? String(v) : null;
};

const CareerSectionView = ({ section, items = [] }) => {
    const def = PROFILE_SECTIONS[section];

    return (
        <section className="space-y-3">
            <h3 className="text-base font-semibold">
                {def.label}
                {items.length > 0 && (
                    <span className="ml-1.5 text-sm font-normal text-slate-400">{items.length}</span>
                )}
            </h3>

            {items.length === 0 && (
                <p className="text-sm text-slate-400">Nothing on file.</p>
            )}

            {items.map((row, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={row.id ?? i} className={`${card} ${cardPad}`}>
                    <p className="font-medium text-slate-900">{def.title(row) || '—'}</p>
                    {def.subtitle(row) && (
                        <p className="text-sm text-slate-500">{def.subtitle(row)}</p>
                    )}

                    <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                        {def.fields.map((f) => {
                            const value = fieldValue(f, row);
                            if (value === null) return null;
                            const wide = f.type === 'list' || f.type === 'textarea' || f.type === 'taglist';
                            return (
                                <div key={f.name} className={wide ? 'sm:col-span-2' : ''}>
                                    <dt className="text-xs uppercase tracking-wide text-slate-400">{f.label}</dt>
                                    <dd className="mt-0.5 text-sm text-slate-700">{value}</dd>
                                </div>
                            );
                        })}
                    </dl>
                </div>
            ))}
        </section>
    );
};

export default CareerSectionView;
