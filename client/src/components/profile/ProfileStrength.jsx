import { useEffect, useRef, useState } from 'react';
import {
    CheckCircle2, AlertCircle, Info, GraduationCap, Sparkles,
} from 'lucide-react';
import {
    card, cardPadRoomy, eyebrow, iconBtnShell, TONE_TEXT, TONE_SOLID, divider,
} from '../../design/tokens.js';

/**
 * ── A NAUKRI-STYLE COMPLETENESS METER, BEHIND ONE INFO ICON ────────────
 *
 * One number ("62% complete") and one checklist — a tick for everything
 * already filled in, an exclamation mark for everything that is not — so a
 * consultant can see at a glance what is still worth adding. It lives behind
 * the (i) icon beside the page title rather than as a permanent block, so
 * the form itself is what fills the page; the same tick/exclamation signal
 * repeats beside each individual field below, which is where it matters most
 * while you are actually typing.
 *
 * Every row is computed from the SAME draft state the form is bound to, so it
 * updates as you type, before anything is submitted. Deliberately
 * equal-weighted rather than scored like a credit model: each item is worth
 * the same one share of 100%, required or not — "14 of 16 things filled in"
 * is a number anyone can audit by eye against the list below it.
 *
 * ── ONE ICON, NOT TWO ───────────────────────────────────────────────────
 *
 * "Is there enough here for a tailored resume?" is a different question from
 * "is the checklist filled in?", but it does not get its own icon — a second
 * (i) beside this one would just be two things to click instead of one. It
 * rides along in the same popover, and it is what decides whether the icon
 * itself reads red or yellow before anyone opens it: red when the profile is
 * still incomplete, yellow when identity is fine but the career record is not
 * yet enough for a tailored resume, and the ordinary idle colour once both
 * are settled.
 */
const TIER = (pct) => {
    if (pct >= 85) return { tone: 'success', label: 'All-star profile' };
    if (pct >= 60) return { tone: 'brand', label: 'Strong profile' };
    if (pct >= 35) return { tone: 'warning', label: 'Needs improvement' };
    return { tone: 'danger', label: 'Just getting started' };
};

/**
 * `readOnly` drops the click-to-scroll behaviour: a viewer looking at
 * someone else's profile (an org admin or recruiter) has no form on the
 * page to jump to — there is nothing here for them to go fix — so the row
 * is a plain line, not a button pretending to navigate somewhere.
 */
const Row = ({ item, onNavigate, readOnly }) => {
    const icon = item.filled
        ? <CheckCircle2 className={`h-4 w-4 shrink-0 ${TONE_TEXT.success}`} />
        : <AlertCircle className={`h-4 w-4 shrink-0 ${TONE_TEXT.warning}`} />;
    const label = <span className={item.filled ? 'text-slate-700' : 'text-slate-500'}>{item.label}</span>;

    if (readOnly) {
        return (
            <div className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-sm">
                {icon}{label}
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={() => {
                document.getElementById(item.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                onNavigate();
            }}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm
                       text-slate-700 transition-colors hover:bg-surface-raised"
        >
            {icon}{label}
        </button>
    );
};

const ProfileStrength = ({ items, isComplete, readiness, readOnly = false }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const total = items.length;
    const filledCount = items.filter((i) => i.filled).length;
    const percent = total > 0 ? Math.round((filledCount / total) * 100) : 0;
    const tier = TIER(percent);

    const required = items.filter((i) => i.required);
    const recommended = items.filter((i) => !i.required);

    // Red beats yellow beats the ordinary idle colour — the icon should
    // never look calmer than the worse of the two things it is reporting.
    const readinessTone = !isComplete ? 'danger' : (readiness && !readiness.ready ? 'warning' : null);
    const ReadinessIcon = readiness?.ready && isComplete ? Sparkles : GraduationCap;

    return (
        <span className="relative inline-flex" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Profile strength — ${percent}% complete`}
                title={`Profile strength — ${percent}% complete`}
                className={`${iconBtnShell} h-6 w-6 ${open ? 'bg-brand-50' : ''} `
                    + `${readinessTone ? TONE_TEXT[readinessTone] : (open ? 'text-brand-600' : '')}`}
            >
                <Info className="h-4 w-4" />
            </button>

            {open && (
                <div
                    role="dialog"
                    aria-label="Profile strength"
                    // Below `sm` this is anchored to the VIEWPORT (fixed, inset from
                    // both edges) rather than to the button — the button can sit
                    // anywhere in a narrow header, and a popover anchored to it would
                    // as easily run off the left edge as the right. From `sm` up there
                    // is room to anchor it under the icon like an ordinary dropdown.
                    className={`fixed inset-x-4 top-20 z-50 mx-auto max-h-[75vh] max-w-[480px]
                                overflow-y-auto
                                sm:absolute sm:inset-x-auto sm:left-0 sm:top-[calc(100%+0.5rem)]
                                sm:mx-0 sm:w-[480px] sm:max-h-none sm:overflow-visible
                                ${card} ${cardPadRoomy} shadow-lg`}
                >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold text-slate-800">Profile strength</p>
                            <p className={`mt-0.5 text-xs font-medium ${TONE_TEXT[tier.tone]}`}>{tier.label}</p>
                        </div>
                        <div className="text-right">
                            <p className="font-display text-2xl font-semibold tabular-nums text-slate-900">
                                {percent}<span className="text-base text-slate-400">%</span>
                            </p>
                            <p className="text-xs text-slate-400">{filledCount} of {total} complete</p>
                        </div>
                    </div>

                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                            className={`h-full rounded-full transition-[width] duration-300 ${TONE_SOLID[tier.tone]}`}
                            style={{ width: `${percent}%` }}
                        />
                    </div>

                    {readiness && (
                        <div className={`mt-4 flex items-start gap-2 pt-4 text-sm ${divider}`}>
                            <ReadinessIcon className={`mt-0.5 h-4 w-4 shrink-0 ${readinessTone ? TONE_TEXT[readinessTone] : TONE_TEXT.success}`} />
                            {readiness.ready ? (
                                <span className="text-slate-600">
                                    There is enough here to build a tailored resume for every job
                                    you are matched to.
                                </span>
                            ) : (
                                <span className="text-slate-600">
                                    <strong className="text-slate-800">Not enough to build a
                                        tailored resume yet.</strong> Still needed:{' '}
                                    {readiness.gaps.join(', ')}. Applications still go out — with
                                    your uploaded resume instead of a tailored one — until this is
                                    filled in.
                                </span>
                            )}
                        </div>
                    )}

                    <div className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                        <div>
                            <p className={eyebrow}>Required for approval</p>
                            <div className="mt-1.5 space-y-0.5">
                                {required.map((item) => (
                                    <Row key={item.key} item={item} readOnly={readOnly} onNavigate={() => setOpen(false)} />
                                ))}
                            </div>
                        </div>
                        <div>
                            <p className={eyebrow}>Recommended — strengthens your matches</p>
                            <div className="mt-1.5 space-y-0.5">
                                {recommended.map((item) => (
                                    <Row key={item.key} item={item} readOnly={readOnly} onNavigate={() => setOpen(false)} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </span>
    );
};

export default ProfileStrength;
