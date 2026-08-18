/**
 * ── THE APP ───────────────────────────────────────────────────────────
 *
 * The main process owns everything that matters: the tray, the timers, the hub
 * client, local state, and the browser. The renderer is a window that displays
 * what it is told and sends back what the consultant clicked — it has no network
 * access, no filesystem access, and no idea a device token exists.
 *
 * That split is deliberate. A renderer is a browser, and a browser is where
 * untrusted content ends up. Keeping the token and the hub client out of it
 * means a compromised page cannot reach either.
 */
const path = require('node:path');
const fs = require('node:fs');
const {
    app, BrowserWindow, Tray, Menu, ipcMain, safeStorage, shell, nativeImage,
} = require('electron');

const config = require('./config.js');
const { Store } = require('./store.js');
const { Outbox } = require('./outbox.js');
const { Secrets } = require('./secrets.js');
const { fingerprint } = require('./fingerprint.js');
const { HubClient } = require('./hubClient.js');
const { BrowserSessions } = require('./browser/session.js');
const { CycleEngine, nextWakeMs } = require('./cycle.js');

// Two copies pulling one queue would apply to the same job twice, under one
// person's name. The OS-level lock is the only thing that reliably prevents a
// second launch.
if (!app.requestSingleInstanceLock()) app.quit();

let tray = null;
let win = null;
let paths = null;
let store = null;
let outbox = null;
let secrets = null;
let hub = null;
let sessions = null;
let engine = null;
let heartbeatTimer = null;
let cycleTimer = null;
let status = { state: 'STARTING', detail: '' };

const RENDERER_DEV = 'http://localhost:5273';

/* ── status, and the tray that shows it ───────────────────────────────── */

const TRAY_TEXT = {
    STARTING: 'Starting…',
    NEEDS_ACTIVATION: 'Not activated',
    IDLE: 'Idle',
    WORKING: 'Working',
    NEEDS_YOU: 'Needs you',
    PAUSED: 'Paused',
    REVOKED: 'Access revoked',
    OFFLINE: 'Cannot reach the hub',
};

const setStatus = (state, detail = '') => {
    status = { state, detail };
    if (tray) {
        tray.setToolTip(`SmartApply — ${TRAY_TEXT[state] ?? state}${detail ? `: ${detail}` : ''}`);
        buildTrayMenu();
    }
    win?.webContents.send('status', { ...status, ...snapshot() });
};

const snapshot = () => ({
    consultant: store?.get('consultant') ?? null,
    dailyCap: store?.get('dailyCap') ?? 0,
    paused: store?.get('paused') ?? false,
    pausedBoards: store?.get('pausedBoards') ?? [],
    queue: store?.get('queue') ?? [],
    lastCycleAt: store?.get('lastCycleAt') ?? null,
    nextCycleAt: store?.get('nextCycleAt') ?? null,
    cycleLog: (store?.get('cycleLog') ?? []).slice(-10).reverse(),
    pendingReports: outbox?.pending ?? 0,
    activated: Boolean(store?.get('activatedAt')),
});

const buildTrayMenu = () => {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: `SmartApply — ${TRAY_TEXT[status.state] ?? status.state}`, enabled: false },
        { type: 'separator' },
        { label: 'Open', click: showWindow },
        {
            label: 'Check for work now',
            enabled: status.state !== 'REVOKED' && Boolean(store?.get('activatedAt')),
            click: () => { runCycle('manual'); },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.quit(); } },
    ]));
};

/* ── window ───────────────────────────────────────────────────────────── */

const showWindow = () => {
    if (win) { win.show(); win.focus(); return; }

    win = new BrowserWindow({
        width: 980,
        height: 720,
        show: false,
        title: 'SmartApply',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            // The renderer gets no Node and no direct access to anything. Every
            // capability it has is an explicit channel in the preload.
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    const built = path.join(__dirname, '../../dist-renderer/index.html');
    if (fs.existsSync(built)) win.loadFile(built);
    else win.loadURL(RENDERER_DEV);

    win.once('ready-to-show', () => {
        win.show();
        win.webContents.send('status', { ...status, ...snapshot() });
    });

    // Closing the window leaves the app running in the tray, which is what a
    // background agent should do. Quitting is an explicit tray action.
    win.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); win.hide(); }
    });
    win.on('closed', () => { win = null; });

    // Anything that wants a new window goes to the real browser instead.
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
};

/* ── revocation ───────────────────────────────────────────────────────── */

/**
 * R-21: revoking kills the app immediately.
 *
 * There is no push channel and nothing to keep in sync — the hub simply answers
 * 401, and this runs. Everything the device held about a consultant's jobs is
 * deleted, including the browser sessions: a revoked machine must not keep a
 * signed-in LinkedIn window pointed at their account.
 */
const handleRevoked = async (reason) => {
    setStatus('REVOKED', reason ?? 'Access was revoked.');
    clearInterval(heartbeatTimer);
    clearTimeout(cycleTimer);

    secrets?.clear();
    store?.wipe();
    try { await sessions?.closeAll(); } catch { /* nothing open */ }
    for (const dir of [paths.profiles, paths.work]) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    showWindow();
};

/* ── the loops ────────────────────────────────────────────────────────── */

const heartbeat = async () => {
    if (!secrets.read()) return;
    try {
        const beat = await hub.heartbeat();
        store.set({
            dailyCap: beat.dailyCap,
            paused: beat.paused,
            pausedBoards: beat.pausedBoards ?? [],
        });
        // Reports queued while offline go out as soon as we are back.
        await outbox.drain((p, b) => hub.post(p, b));
        if (status.state === 'OFFLINE' || status.state === 'STARTING') {
            setStatus(beat.paused ? 'PAUSED' : 'IDLE');
        } else {
            setStatus(status.state);
        }
    } catch (err) {
        if (err.name === 'Revoked') return;          // handled by onRevoked
        setStatus('OFFLINE', err.message);
    }
};

const scheduleCycle = (intervalMs = config.CYCLE_DEFAULT_MS) => {
    clearTimeout(cycleTimer);
    const wait = nextWakeMs(intervalMs);
    store.set({ nextCycleAt: new Date(Date.now() + wait).toISOString() });
    cycleTimer = setTimeout(() => { runCycle('scheduled'); }, wait);
};

const runCycle = async (trigger) => {
    if (!secrets.read()) { setStatus('NEEDS_ACTIVATION'); return; }
    setStatus('WORKING', trigger === 'manual' ? 'checking now' : '');
    try {
        const result = await engine.run();
        const needsYou = (result.signInNeeded?.length ?? 0) > 0
            || (result.handedToHuman ?? 0) > 0;
        setStatus(result.paused ? 'PAUSED' : (needsYou ? 'NEEDS_YOU' : 'IDLE'));
    } catch (err) {
        if (err.name !== 'Revoked') setStatus('OFFLINE', err.message);
    } finally {
        scheduleCycle();
    }
};

/* ── IPC: the renderer's entire vocabulary ────────────────────────────── */

const registerIpc = () => {
    ipcMain.handle('snapshot', () => ({ ...status, ...snapshot() }));

    ipcMain.handle('activate', async (_e, activationCode) => {
        if (!secrets.available()) {
            return { ok: false, error: 'This machine has no secure credential store, '
                + 'so a device token cannot be stored safely.' };
        }
        try {
            const fp = fingerprint();
            const res = await hub.activate({
                activationCode,
                machineFingerprint: fp,
                machineLabel: config.machineLabel(),
            });
            secrets.save(res.deviceToken);
            store.set({
                consultant: res.consultant,
                machineFingerprint: fp,
                activatedAt: new Date().toISOString(),
                dailyCap: res.dailyCap ?? 0,
            });
            setStatus('IDLE');
            heartbeat();
            scheduleCycle(config.CYCLE_DEFAULT_MS);
            return { ok: true, consultant: res.consultant };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('runNow', () => { runCycle('manual'); return { ok: true }; });

    // Opening a board's login window is the consultant's action, so it is a
    // channel rather than something the engine does behind their back.
    ipcMain.handle('signIn', async (_e, board) => {
        const { BOARDS } = require('./browser/boards.js');
        const def = BOARDS[board];
        if (!def) return { ok: false, error: `Unknown board ${board}` };
        await sessions.promptSignIn(def);
        return { ok: true };
    });

    ipcMain.handle('openExternal', (_e, url) => { shell.openExternal(url); return { ok: true }; });
};

/* ── boot ─────────────────────────────────────────────────────────────── */

app.on('second-instance', showWindow);
app.on('before-quit', () => { app.isQuitting = true; });
// The tray is the app. Closing the last window must not end it.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
    paths = config.paths(app.getPath('userData'));
    for (const dir of [paths.profiles, paths.work, paths.logs]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    store = new Store(paths.state);
    outbox = new Outbox(paths.outbox);
    secrets = new Secrets(safeStorage, paths.userData);

    hub = new HubClient({
        getToken: () => secrets.read(),
        fingerprint: store.get('machineFingerprint') ?? fingerprint(),
        onRevoked: handleRevoked,
    });

    // Playwright is required here rather than at module load so the pure modules
    // stay testable without it installed.
    // eslint-disable-next-line global-require
    const { chromium } = require('playwright');
    sessions = new BrowserSessions({ chromium, profilesDir: paths.profiles });

    engine = new CycleEngine({
        hub, sessions, store, outbox, paths,
        log: (m) => { win?.webContents.send('log', m); },
    });

    // A 1×1 transparent image: a real icon is a D7 asset, and an empty tray is
    // better than a crash on a missing file.
    tray = new Tray(nativeImage.createEmpty());
    buildTrayMenu();
    tray.on('click', showWindow);

    registerIpc();
    showWindow();

    if (store.get('activatedAt')) {
        setStatus('IDLE');
        heartbeat();
        scheduleCycle();
    } else {
        setStatus('NEEDS_ACTIVATION');
    }

    heartbeatTimer = setInterval(heartbeat, config.HEARTBEAT_MS);
});
