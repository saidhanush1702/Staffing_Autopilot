/**
 * Reversible password storage — AES-256-GCM.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY NOTE (recorded once, deliberately, then not repeated)
 *
 * Passwords here are ENCRYPTED, not hashed. Anyone holding both a database
 * dump and PASSWORD_ENC_KEY recovers every user's plaintext password. Because
 * people reuse passwords, that also compromises their other accounts.
 *
 * The industry standard is a one-way hash (bcrypt/argon2), where nobody —
 * including the platform owner — can read a password. This reversible design
 * was chosen deliberately by the product owner.
 *
 * If you keep it, then at minimum:
 *   - PASSWORD_ENC_KEY must never live in version control
 *   - in production, keep the key off the database host (secrets manager)
 *   - rotate the key if either the database or the key is ever exposed
 * ─────────────────────────────────────────────────────────────────────────
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey = null;

const getKey = () => {
    if (cachedKey) return cachedKey;

    const hex = process.env.PASSWORD_ENC_KEY;
    if (!hex) {
        throw new Error('PASSWORD_ENC_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('PASSWORD_ENC_KEY must be exactly 64 hex characters (32 bytes).');
    }

    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
};

/**
 * Encrypt a plaintext password.
 * @returns {{ enc: string, iv: string, tag: string }} columns for the users table
 */
export const encryptPassword = (plain) => {
    if (typeof plain !== 'string' || plain.length === 0) {
        throw new Error('Password must be a non-empty string.');
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

    return {
        enc: encrypted.toString('base64'),
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
    };
};

/**
 * Decrypt a stored password back to plaintext.
 * Throws if the ciphertext or auth tag has been tampered with.
 */
export const decryptPassword = ({ enc, iv, tag }) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([
        decipher.update(Buffer.from(enc, 'base64')),
        decipher.final(),
    ]).toString('utf8');
};

/**
 * Compare a candidate password against a stored row.
 *
 * Both sides are SHA-256 digested first so timingSafeEqual always receives
 * equal-length buffers — comparing raw strings of differing length throws,
 * and comparing with === leaks length information through timing.
 */
export const verifyPassword = (plain, row) => {
    try {
        const actual = decryptPassword({
            enc: row.password_enc,
            iv: row.password_iv,
            tag: row.password_tag,
        });

        const a = crypto.createHash('sha256').update(actual, 'utf8').digest();
        const b = crypto.createHash('sha256').update(String(plain), 'utf8').digest();

        return crypto.timingSafeEqual(a, b);
    } catch {
        // Bad key, tampered ciphertext, or malformed row — never leak why.
        return false;
    }
};
