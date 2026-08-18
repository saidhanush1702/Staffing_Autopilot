/**
 * ── LOCAL STATE ───────────────────────────────────────────────────────
 *
 * A tiny JSON store with atomic writes. Deliberately not SQLite: the data is a
 * handful of small objects, and `better-sqlite3` is a native module that has to
 * be rebuilt against Electron — on Windows that means Visual Studio build tools
 * and a class of install failure that is entirely avoidable here.
 *
 * ── WHY WRITE-THEN-RENAME ─────────────────────────────────────────────
 *
 * `rename` is atomic on both Windows and POSIX. Writing in place is not: a
 * crash or a power cut midway through leaves a truncated file, and the next
 * start reads corrupt JSON and throws. Writing a temp file and renaming means a
 * reader only ever sees the whole old file or the whole new one.
 */
const fs = require('node:fs');
const path = require('node:path');

const readJson = (file, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // A missing file and a corrupt one are handled the same way: fall back
        // and carry on. Local state is a cache of the hub's truth, so losing it
        // costs a re-sync, never data.
        return fallback;
    }
};

const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
};

const EMPTY = {
    // Device identity. The token itself lives in the OS vault, never here.
    consultant: null,
    machineFingerprint: null,
    activatedAt: null,
    // Last known settings from the hub.
    dailyCap: 0,
    paused: false,
    pausedBoards: [],
    // The cycle's own bookkeeping.
    lastCycleAt: null,
    nextCycleAt: null,
    cycleLog: [],
    // What we last pulled, so the UI has something to show while offline.
    queue: [],
};

class Store {
    constructor(file) {
        this.file = file;
        this.data = { ...EMPTY, ...readJson(file, {}) };
    }

    get(key) { return this.data[key]; }

    set(patch) {
        this.data = { ...this.data, ...patch };
        writeJson(this.file, this.data);
        return this.data;
    }

    /** Keep the last 50 cycles — enough to diagnose, not a log file. */
    appendCycle(entry) {
        const cycleLog = [...(this.data.cycleLog ?? []), entry].slice(-50);
        return this.set({ cycleLog });
    }

    /**
     * Everything except identity. Used on revocation: the device is no longer
     * trusted, so nothing it cached about a consultant's jobs may remain.
     */
    wipe() {
        this.data = { ...EMPTY };
        writeJson(this.file, this.data);
    }
}

module.exports = { Store, readJson, writeJson };
