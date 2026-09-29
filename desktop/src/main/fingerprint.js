/**
 * ── MACHINE FINGERPRINT ───────────────────────────────────────────────
 *
 * R-21 binds a device token to one person AND one machine. This is the machine
 * half: a stable identifier the hub compares on every call, so a token copied
 * to a second laptop is refused even though the token itself is correct.
 *
 * ── WHAT IT IS BUILT FROM, AND WHY NOT MORE ───────────────────────────
 *
 * Hostname, platform, architecture, CPU model and total memory. Hashed, so the
 * hub stores an opaque value rather than an inventory of the consultant's
 * personal computer.
 *
 * MAC addresses are deliberately excluded. They look like the obvious choice and
 * are actively bad here: they change when a laptop moves between docking
 * stations, Wi-Fi and Ethernet, or when a VPN adapter appears — so the
 * fingerprint would break during ordinary use and lock the consultant out of
 * their own app.
 */
const crypto = require('node:crypto');
const os = require('node:os');

const fingerprint = () => {
    const cpu = os.cpus()[0]?.model ?? 'unknown-cpu';
    const parts = [
        os.hostname(),
        os.platform(),
        os.arch(),
        cpu.trim(),
        // Rounded to whole gigabytes: the raw byte count differs slightly
        // between boots on some machines.
        String(Math.round(os.totalmem() / 1024 ** 3)),
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 64);
};

module.exports = { fingerprint };
