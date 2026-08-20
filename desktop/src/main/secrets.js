/**
 * ── THE DEVICE TOKEN ──────────────────────────────────────────────────
 *
 * Held in the OS credential vault via Electron's `safeStorage`, which is DPAPI
 * on Windows and the Keychain on macOS. The encrypted blob sits in a file, but
 * only this user on this machine can decrypt it.
 *
 * The token is the whole of the app's authority. Anyone who reads it can pull a
 * consultant's queue and report applications in their name, so it must never sit
 * in plain text next to the cache — which is exactly where it would end up if it
 * were treated as ordinary state.
 *
 * `available()` is checked rather than assumed: on a machine with no keyring
 * `safeStorage` is unavailable, and failing loudly at activation is far better
 * than silently writing a plaintext token to disk.
 */
const fs = require('node:fs');
const path = require('node:path');

class Secrets {
    constructor(safeStorage, userDataDir) {
        this.safeStorage = safeStorage;
        this.file = path.join(userDataDir, 'device.bin');
    }

    available() {
        try { return this.safeStorage.isEncryptionAvailable(); } catch { return false; }
    }

    save(token) {
        if (!this.available()) {
            throw new Error('This machine has no secure credential store, so the device '
                + 'token cannot be stored safely. Activation stopped.');
        }
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, this.safeStorage.encryptString(token));
    }

    read() {
        try {
            return this.safeStorage.decryptString(fs.readFileSync(this.file));
        } catch {
            // Missing, unreadable, or encrypted for a different user: all mean
            // the same thing to the caller — there is no usable token.
            return null;
        }
    }

    clear() {
        try { fs.unlinkSync(this.file); } catch { /* already gone */ }
    }
}

module.exports = { Secrets };
