import { avatar, AVATAR_SIZE, AVATAR_TONES } from '../../design/tokens.js';

/**
 * Initials on a tinted disc.
 *
 * ── WHY THE COLOUR IS HASHED FROM THE NAME ────────────────────────────
 *
 * A list of thirty consultants in which every avatar is the same grey is a
 * list you have to read. Hashing the name into a fixed six-colour palette
 * means the same person is the same colour on every screen, every session,
 * on every machine — recognisable before the name is read, and with no
 * column in the database spent on it.
 *
 * Six tones, all drawn from the design tokens, so the result is on-palette
 * whatever the name.
 */

const initialsOf = (name = '') => name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('') || '?';

/** Deterministic, order-sensitive, and cheap. djb2, truncated. */
const toneOf = (seed = '') => {
    let h = 5381;
    for (let i = 0; i < seed.length; i += 1) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    return AVATAR_TONES[Math.abs(h) % AVATAR_TONES.length];
};

const Avatar = ({ name, email, size = 'md', tone, className = '' }) => (
    <span
        title={name}
        className={`${avatar} ${AVATAR_SIZE[size] ?? AVATAR_SIZE.md} `
            + `${tone ?? toneOf(email || name || '')} ${className}`}
    >
        {initialsOf(name)}
    </span>
);

export default Avatar;
