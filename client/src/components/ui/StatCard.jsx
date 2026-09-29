import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { card, metric, eyebrow, TONE, TONE_TEXT } from '../../design/tokens.js';

/**
 * ── THE NUMBER TILE ───────────────────────────────────────────────────
 *
 * One figure, what it counts, and — when there is one — how it moved.
 *
 * ── WHY THE NUMBER COMES FIRST ────────────────────────────────────────
 *
 * A dashboard is scanned, not read. Putting the figure above its label lets
 * a row of tiles be taken in as a row of figures in one pass, with the labels
 * available underneath for the one that turns out to matter. The reverse
 * order forces a read of every label to reach any number.
 *
 * ── AND WHY `hint` IS NOT A SECOND NUMBER ─────────────────────────────
 *
 * Two figures on one tile is two tiles. `hint` is for the sentence that stops
 * a figure being misread — "of 40 seats", "since Monday".
 */

const TREND = {
    up: { icon: ArrowUpRight, tone: 'success' },
    down: { icon: ArrowDownRight, tone: 'danger' },
    flat: { icon: null, tone: 'neutral' },
};

const StatCard = ({
    icon: Icon,
    label,
    value,
    hint,
    tone = 'brand',
    trend,
    trendLabel,
    onClick,
    className = '',
}) => {
    const Wrapper = onClick ? 'button' : 'div';
    const t = TREND[trend] ?? null;
    const TrendIcon = t?.icon;

    return (
        <Wrapper
            type={onClick ? 'button' : undefined}
            onClick={onClick}
            className={`${card} p-4 text-left transition-all duration-150 ${
                onClick ? 'cursor-pointer hover:border-line-strong hover:shadow-md' : ''} ${className}`}
        >
            <div className="flex items-start justify-between gap-3">
                <p className={eyebrow}>{label}</p>
                {Icon && (
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg
                                      ${TONE[tone] ?? TONE.brand}`}>
                        <Icon className="h-4 w-4" />
                    </span>
                )}
            </div>

            <p className={`mt-3 ${metric}`}>{value ?? '—'}</p>

            {(hint || trendLabel) && (
                <div className="mt-1.5 flex items-center gap-2">
                    {trendLabel && t && (
                        <span className={`inline-flex items-center gap-0.5 text-xs font-medium
                                          ${TONE_TEXT[t.tone]}`}>
                            {TrendIcon && <TrendIcon className="h-3.5 w-3.5" />}
                            {trendLabel}
                        </span>
                    )}
                    {hint && <span className="truncate text-xs text-slate-500">{hint}</span>}
                </div>
            )}
        </Wrapper>
    );
};

export default StatCard;
