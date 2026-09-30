/**
 * Reversible storage for org-supplied LLM provider API keys — AES-256-GCM.
 *
 * Same scheme as utils/crypto.js (password storage), kept as its own module
 * with its own key (LLM_KEY_ENC_KEY) so rotating one secret category never
 * touches the other, and a dump of org_llm_providers is useless without a key
 * that nothing else in the system needs.
 *
 * Unlike a password, this one MUST be recoverable — it is sent to the
 * provider on every call — so encryption, not hashing, is the correct choice
 * here, not just a convention carried over from crypto.js.
 */
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey = null;

const getKey = () => {
    if (cachedKey) return cachedKey;

    const hex = process.env.LLM_KEY_ENC_KEY;
    if (!hex) {
        throw new Error('LLM_KEY_ENC_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error('LLM_KEY_ENC_KEY must be exactly 64 hex characters (32 bytes).');
    }

    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
};

/**
 * Encrypt a plaintext secret.
 * @returns {{ enc: string, iv: string, tag: string }} columns to store
 */
export const encryptSecret = (plain) => {
    if (typeof plain !== 'string' || plain.length === 0) {
        throw new Error('Secret must be a non-empty string.');
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
 * Decrypt a stored secret back to plaintext.
 * Throws if the ciphertext or auth tag has been tampered with.
 */
export const decryptSecret = ({ enc, iv, tag }) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([
        decipher.update(Buffer.from(enc, 'base64')),
        decipher.final(),
    ]).toString('utf8');
};
