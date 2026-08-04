import { card, cardPad, cardPadTight, cardPadRoomy, sectionTitle } from '../../design/tokens.js';

const PAD = {
    tight: cardPadTight,
    normal: cardPad,
    roomy: cardPadRoomy,
    none: '',
};

/**
 * The card. Every white panel in the app is one of these, so radius, border
 * and padding cannot drift between screens.
 *
 *   <Card>…</Card>
 *   <Card title="Current assignments" pad="tight">…</Card>
 *   <Card pad="none"><table …/></Card>     a card wrapping its own layout
 */
const Card = ({ title, action, pad = 'normal', className = '', children }) => (
    <div className={`${card} ${PAD[pad] ?? cardPad} ${className}`}>
        {(title || action) && (
            <div className="mb-4 flex items-start justify-between gap-3">
                {title && <h2 className={sectionTitle}>{title}</h2>}
                {action}
            </div>
        )}
        {children}
    </div>
);

export default Card;
