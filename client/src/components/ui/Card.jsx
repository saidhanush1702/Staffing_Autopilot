import {
    card, cardPad, cardPadTight, cardPadRoomy,
    cardHeader, cardFooter, sectionTitle, sectionSubtitle,
} from '../../design/tokens.js';

const PAD = {
    tight: cardPadTight,
    normal: cardPad,
    roomy: cardPadRoomy,
    none: '',
};

/**
 * The card. Every panel in the app is one of these, so radius, border, shadow
 * and padding cannot drift between screens.
 *
 *   <Card>…</Card>
 *   <Card title="Current assignments" pad="tight">…</Card>
 *   <Card pad="none"><table …/></Card>            a card wrapping its own layout
 *   <Card title="Devices" divided action={…}>…</Card>
 *
 * ── `divided` ─────────────────────────────────────────────────────────
 *
 * Promotes the title into a proper header strip: its own tinted band with a
 * rule under it, and the body padded separately. Use it when the card holds a
 * list rather than a paragraph — the band gives the list a lid, which is what
 * stops a column of rows reading as part of the page behind it.
 */
const Card = ({
    title,
    subtitle,
    action,
    footer,
    pad = 'normal',
    divided = false,
    className = '',
    bodyClassName = '',
    children,
}) => {
    const body = PAD[pad] ?? cardPad;

    if (divided && (title || action)) {
        return (
            <section className={`${card} overflow-hidden ${className}`}>
                <div className={cardHeader}>
                    <div className="min-w-0">
                        <h2 className={sectionTitle}>{title}</h2>
                        {subtitle && <p className={sectionSubtitle}>{subtitle}</p>}
                    </div>
                    {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
                </div>
                <div className={`${body} ${bodyClassName}`}>{children}</div>
                {footer && <div className={cardFooter}>{footer}</div>}
            </section>
        );
    }

    return (
        <section className={`${card} ${body} ${className}`}>
            {(title || action) && (
                <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        {title && <h2 className={sectionTitle}>{title}</h2>}
                        {subtitle && <p className={sectionSubtitle}>{subtitle}</p>}
                    </div>
                    {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
                </div>
            )}
            <div className={bodyClassName || undefined}>{children}</div>
            {footer && <div className="mt-4 border-t border-line pt-4">{footer}</div>}
        </section>
    );
};

export default Card;
