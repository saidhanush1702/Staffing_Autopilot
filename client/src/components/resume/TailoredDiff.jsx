import { useMemo } from 'react';
import { AlertTriangle, Cpu, Ruler } from 'lucide-react';
import { card, cardPad, badge, eyebrow, TONE, sectionTitle } from '../../design/tokens.js';

/**
 * ── THE BASE AND THE TAILORED RESUME, SIDE BY SIDE ────────────────────
 *
 * With every flagged claim highlighted where it actually appears, and the
 * checker's reason next to it.
 *
 * ── WHY BOTH, AND WHY IN PLACE ────────────────────────────────────────
 *
 * The reviewer's question is not "is this sentence true" — they have no way to
 * know that. It is "is this sentence supported by what the consultant already
 * wrote". That is a comparison, and it can only be made with both texts in
 * view. A list of flagged claims on its own asks the reviewer to hold the base
 * resume in their head, which is exactly the work the flag was raised to save.
 *
 * ── WHY RULE FLAGS AND MODEL FLAGS LOOK DIFFERENT ─────────────────────
 *
 * A RULE flag is arithmetic: this number, or this capitalised token, does not
 * occur anywhere in the base text. It is either right or the base text is
 * unusual, and it is the flag that catches invented metrics.
 *
 * A MODEL flag is a second model's opinion. It catches rephrasing that a string
 * search cannot — "led a team of engineers" where the base says "worked on a
 * team" — and it is also the one that will occasionally be wrong.
 *
 * Presenting the two identically would train a reviewer to trust both equally
 * and, after a few false positives from the model, to dismiss both equally. The
 * distinction is the difference between "check this" and "this is provably not
 * in the original".
 */

const SEVERITY = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };

/** Escape a claim before it becomes part of a regular expression. */
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wrap every flagged claim found in `text` with a highlight.
 *
 * Returns React nodes rather than HTML — the claims come from a model, and
 * `dangerouslySetInnerHTML` with model output in it is an injection waiting to
 * be discovered by whoever writes the next feature on top of this one.
 */
const highlight = (text, claims) => {
    const usable = claims
        .map((c) => String(c.claim_text ?? '').trim())
        .filter((c) => c.length > 3)
        .sort((a, b) => b.length - a.length);   // longest first, so a short
                                                // claim cannot split a long one

    if (usable.length === 0 || !text) return text;

    const pattern = new RegExp(`(${usable.map(escapeRe).join('|')})`, 'gi');
    const parts = String(text).split(pattern);

    return parts.map((part, i) => {
        const hit = usable.find((c) => c.toLowerCase() === part.toLowerCase());
        if (!hit) return part;
        return (
            <mark
                key={i}
                className="rounded bg-danger-100 px-0.5 text-danger-900 ring-1 ring-danger-200"
            >
                {part}
            </mark>
        );
    });
};

const Column = ({ label, text, claims = [], tone = 'neutral' }) => (
    <div className={`${card} ${cardPad} min-w-0`}>
        <p className={`${eyebrow} ${tone === 'danger' ? 'text-danger-500' : ''}`}>{label}</p>
        <pre className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words
                        font-sans text-xs leading-relaxed text-slate-700">
            {claims.length > 0 ? highlight(text, claims) : text}
        </pre>
    </div>
);

const TailoredDiff = ({ baseText, tailoredText, flags = [], scoreBefore, scoreAfter }) => {
    const { rules, models } = useMemo(() => ({
        rules: flags.filter((f) => f.detected_by === 'RULE'),
        models: flags.filter((f) => f.detected_by !== 'RULE'),
    }), [flags]);

    return (
        <div>
            {(scoreBefore != null || scoreAfter != null) && (
                <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className={`${badge} ${TONE.neutral}`}>ATS before {scoreBefore ?? '—'}</span>
                    <span className={`${badge} ${
                        (scoreAfter ?? 0) >= (scoreBefore ?? 0) ? TONE.success : TONE.warning}`}>
                        ATS after {scoreAfter ?? '—'}
                    </span>
                    {/*
                        The delta is the only evidence the tailoring did
                        anything measurable. Computed in code, never asked of the
                        model that produced the resume.
                    */}
                    {scoreBefore != null && scoreAfter != null && (
                        <span>
                            {scoreAfter - scoreBefore >= 0 ? '+' : ''}
                            {scoreAfter - scoreBefore} points of keyword coverage
                        </span>
                    )}
                </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
                <Column label="Base resume — what the consultant wrote" text={baseText} />
                <Column
                    label="Tailored — flagged claims highlighted"
                    text={tailoredText}
                    claims={flags}
                    tone="danger"
                />
            </div>

            {flags.length > 0 && (
                <div className="mt-5">
                    <h4 className={`${sectionTitle} flex items-center gap-2`}>
                        <AlertTriangle className="h-4 w-4 text-warning-500" />
                        {flags.length} claim{flags.length === 1 ? '' : 's'} with no basis in the base resume
                    </h4>

                    {rules.length > 0 && (
                        <>
                            <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                                <Ruler className="h-3.5 w-3.5" />
                                Found by exact comparison — these strings do not appear in the base resume
                            </p>
                            <ul className="mt-2 space-y-2">
                                {rules.map((f) => <FlagRow key={f.id} flag={f} />)}
                            </ul>
                        </>
                    )}

                    {models.length > 0 && (
                        <>
                            <p className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-600">
                                <Cpu className="h-3.5 w-3.5" />
                                Raised by the checking model — judgement, so worth reading before acting
                            </p>
                            <ul className="mt-2 space-y-2">
                                {models.map((f) => <FlagRow key={f.id} flag={f} />)}
                            </ul>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

const FlagRow = ({ flag }) => (
    <li className={`${card} p-3`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 text-xs text-slate-800">“{flag.claim_text}”</p>
            <span className="flex shrink-0 items-center gap-1.5">
                {flag.section && (
                    <span className={`${badge} ${TONE.neutral}`}>{flag.section}</span>
                )}
                <span className={`${badge} ${TONE[SEVERITY[flag.severity] ?? 'neutral']}`}>
                    {flag.severity}
                </span>
            </span>
        </div>
        {flag.reason && <p className="mt-1.5 text-2xs text-slate-500">{flag.reason}</p>}
    </li>
);

export default TailoredDiff;
