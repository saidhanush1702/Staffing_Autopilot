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
    crashReporter, Notification,
} = require('electron');

const config = require('./config.js');
const { Attention } = require('./attention.js');
const { Store } = require('./store.js');
const { Outbox } = require('./outbox.js');
const { Secrets } = require('./secrets.js');
const { fingerprint } = require('./fingerprint.js');
const { HubClient } = require('./hubClient.js');
const { BrowserSessions } = require('./browser/session.js');
const { EmbeddedSessions } = require('./browser/embedded.js');
const { resolveBrowser } = require('./browser/engine.js');
const { CycleEngine, nextPollMs } = require('./cycle.js');
const { startDiagnostics } = require('./diagnostics.js');
const { startUpdater } = require('./updater.js');

// Two copies pulling one queue would apply to the same job twice, under one
// person's name. The OS-level lock is the only thing that reliably prevents a
// second launch.
if (!app.requestSingleInstanceLock()) app.quit();

// Opened BEFORE the app is ready, because that is the only time it can be.
// Playwright connects to this to drive the board views inside our own window —
// see browser/embedded.js. Bound to loopback: it is a debugging port, and one
// listening on anything else would let any machine on the network drive this
// consultant's signed-in job boards.
if (config.EMBED_BROWSER) {
    app.commandLine.appendSwitch('remote-debugging-port', String(config.CDP_PORT));
    // Chromium 111+ refuses a DevTools websocket whose Origin it does not
    // recognise, and Playwright's connection is exactly that. Without this the
    // port listens, answers /json/version, and then never completes the
    // handshake — which surfaces as a flat 30-second connect timeout with
    // nothing to say why.
    app.commandLine.appendSwitch('remote-allow-origins', '*');
}

let tray = null;
let win = null;
let paths = null;
let store = null;
let outbox = null;
let secrets = null;
let hub = null;
let sessions = null;
let engine = null;
let diagnostics = null;
let stopUpdater = null;
let heartbeatTimer = null;
let cycleTimer = null;
let status = { state: 'STARTING', detail: '' };

const RENDERER_DEV = 'http://localhost:5273';

/* ── status, and the tray that shows it ───────────────────────────────── */

const TRAY_TEXT = {
    STARTING: 'Starting…',
    STOPPED: 'Stopped',
    NEEDS_ACTIVATION: 'Not activated',
    IDLE: 'Idle',
    WORKING: 'Working',
    NEEDS_YOU: 'Needs you',
    PAUSED: 'Paused',
    REVOKED: 'Access revoked',
    OFFLINE: 'Cannot reach the hub',
};

/**
 * Push something to the window, if there is still a window to push to.
 *
 * ── WHY `win?.` WAS NOT THE CHECK IT LOOKED LIKE ──────────────────────
 *
 * `win?.webContents.send(...)` only asks whether the VARIABLE is set. A
 * BrowserWindow object outlives its renderer: close the window, or catch it
 * mid-reload, and `win` is still an object while the frame behind it is gone.
 * `send` then throws "Render frame was disposed before WebFrameMain could be
 * accessed" -- which is what filled the terminal during a run, once per
 * activity line, from five different call sites.
 *
 * It was never dangerous: the throw happened inside a fire-and-forget
 * notification, so the automation carried on correctly and only the UI missed
 * an update it had no window to show anyway. But noise like that buries the
 * errors that DO matter, which is reason enough to stop making it.
 *
 * Failure stays silent for the same reason it was harmless: a consultant who
 * has closed the window is not waiting to be told that closing it worked.
 */
const toRenderer = (channel, payload) => {
    if (!win || win.isDestroyed()) return false;
    const wc = win.webContents;
    if (!wc || wc.isDestroyed()) return false;
    try {
        wc.send(channel, payload);
        return true;
    } catch {
        // The frame went away between the check and the send. Nothing to do,
        // and nothing worth saying about it.
        return false;
    }
};

const setStatus = (state, detail = '') => {
    status = { state, detail };
    if (tray) {
        tray.setToolTip(`SmartApply — ${TRAY_TEXT[state] ?? state}${detail ? `: ${detail}` : ''}`);
        buildTrayMenu();
    }
    toRenderer('status', { ...status, ...snapshot() });
};

/**
 * ── ONE STORY PER BOARD ───────────────────────────────────────────────
 *
 * A single flat log interleaves three boards into something nobody can follow.
 * These keep each board's own account of what happened: its current state, the
 * job it is on, and the last few things it did.
 *
 * In memory rather than on disk: it is a running commentary, and a consultant
 * who restarts the app wants to know what is happening NOW, not what happened
 * before the restart. The durable record is the hub's.
 */
/** Set once the app is ready; read by `snapshot` from the first tick. */
let attention = null;

const BOARD_LOG_MAX = 40;
const boardActivity = new Map();

const recordActivity = (board, state, message) => {
    const entry = boardActivity.get(board) ?? { board, state: 'IDLE', lines: [] };
    entry.state = state;
    entry.at = new Date().toISOString();
    entry.lines = [...entry.lines, { at: entry.at, state, message }].slice(-BOARD_LOG_MAX);
    boardActivity.set(board, entry);
    toRenderer('status', { ...status, ...snapshot() });
};

/** Every board we know about, whether or not it has done anything yet. */
const boardsForDisplay = () => {
    const { BOARDS } = require('./browser/boards.js');
    const stalled = new Map((store?.get('pausedBoards') ?? []).map((b) => [b.board, b]));

    return Object.values(BOARDS).map((b) => {
        const seen = boardActivity.get(b.name);
        const hold = stalled.get(b.name);
        return {
            board: b.name,
            label: b.label,
            // A hold reported by the hub outranks whatever we last did locally:
            // it is the reason nothing is happening.
            state: hold
                ? (hold.state === 'BOT_CHECK' ? 'STOPPED' : 'SIGNED_OUT')
                : (seen?.state ?? 'IDLE'),
            canFill: Boolean(b.verified),
            until: hold?.until ?? null,
            at: seen?.at ?? null,
            lines: seen?.lines ?? [],
        };
    });
};

const snapshot = () => ({
    consultant: store?.get('consultant') ?? null,
    paused: store?.get('paused') ?? false,
    pausedBoards: store?.get('pausedBoards') ?? [],
    queue: store?.get('queue') ?? [],
    lastCheckedAt: store?.get('lastCheckedAt') ?? null,
    lastCycleAt: store?.get('lastCycleAt') ?? null,
    nextCycleAt: store?.get('nextCycleAt') ?? null,
    cycleLog: (store?.get('cycleLog') ?? []).slice(-10).reverse(),
    awaitingReview: store?.get('awaitingReview') ?? [],
    outstandingQuestions: store?.get('outstandingQuestions') ?? 0,
    automationOn: store?.get('automationOn') ?? false,
    autoSubmit: store?.get('autoSubmit') ?? false,
    boards: boardsForDisplay(),
    pendingReports: outbox?.pending ?? 0,
    activated: Boolean(store?.get('activatedAt')),
    // What the bot is waiting for, or null. Carries a deadline rather than a
    // countdown so the renderer can tick on its own clock -- see attention.js.
    attention: attention?.snapshot() ?? null,
});

const buildTrayMenu = () => {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: `SmartApply — ${TRAY_TEXT[status.state] ?? status.state}`, enabled: false },
        { type: 'separator' },
        { label: 'Open', click: showWindow },
        {
            label: 'Check for new jobs',
            enabled: status.state !== 'REVOKED' && Boolean(store?.get('activatedAt')),
            click: () => { engine?.refresh().catch(() => {}); },
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
        toRenderer('status', { ...status, ...snapshot() });
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
    // Saved cookie jars are sign-ins in a file. A revoked device keeping one
    // would be exactly the "signed-in window pointed at their account" this
    // rule exists to prevent, so `sessions` is wiped with the rest.
    for (const dir of [paths.profiles, paths.sessions, paths.work]) {
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
            paused: beat.paused,
            pausedBoards: beat.pausedBoards ?? [],
            outstandingQuestions: beat.outstandingQuestions ?? 0,
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

/**
 * Come back and look for work again.
 *
 * `hadWork` decides how soon: a queue that just gave us something is likely to
 * have more, and an empty one is not worth checking every ninety seconds.
 */
const scheduleCycle = (hadWork = false) => {
    clearTimeout(cycleTimer);
    // A pass that finishes after Stop was pressed must not book the next one.
    if (!store.get('automationOn')) return;
    const wait = nextPollMs(hadWork);
    store.set({ nextCycleAt: new Date(Date.now() + wait).toISOString() });
    cycleTimer = setTimeout(() => { runCycle('scheduled'); }, wait);
};

const runCycle = async (trigger) => {
    if (!secrets.read()) { setStatus('NEEDS_ACTIVATION'); return; }
    // Nothing works until somebody presses Start. An app that begins applying
    // to jobs the moment it launches is one that applies while its owner is
    // asleep, having never chosen to.
    if (!store.get('automationOn')) { setStatus('STOPPED'); return; }
    setStatus('WORKING', trigger === 'manual' ? 'checking now' : '');
    let hadWork = false;
    try {
        const result = await engine.run();
        hadWork = (result.pulled ?? 0) > 0;
        // Anything waiting on the consultant outranks "idle": a filled form
        // nobody submits is the one state where the app is finished and the
        // work still is not.
        const waiting = (store.get('awaitingReview') ?? []).length;
        const needsYou = waiting > 0
            || (result.signInNeeded?.length ?? 0) > 0
            || (result.handedToHuman ?? 0) > 0;
        setStatus(result.paused ? 'PAUSED' : (needsYou ? 'NEEDS_YOU' : 'IDLE'));
    } catch (err) {
        if (err.name !== 'Revoked') setStatus('OFFLINE', err.message);
    } finally {
        scheduleCycle(hadWork);
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
            });
            setStatus('IDLE');
            heartbeat();
            scheduleCycle(true);
            return { ok: true, consultant: res.consultant };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    /* ── starting and stopping ─────────────────────────────────────────
     *
     * `autoSubmit` is decided here, on the way in, and nowhere else. Changing
     * it mid-run would mean some applications in one pass were left for review
     * and others were sent, with nothing on screen saying which was which.
     */
    ipcMain.handle('startAutomation', (_e, options = {}) => {
        store.set({
            automationOn: true,
            autoSubmit: Boolean(options.autoSubmit),
        });
        engine.allowStart();
        toRenderer('log',
            options.autoSubmit
                ? 'started — applications will be submitted automatically'
                : 'started — applications will stop for you to review');
        runCycle('manual');
        return { ok: true };
    });

    ipcMain.handle('stopAutomation', () => {
        store.set({ automationOn: false });
        clearTimeout(cycleTimer);
        // Clearing the timer only prevents the NEXT pass. This reaches the one
        // already running, which is what makes the button appear to work.
        engine.requestStop();
        toRenderer('log', 'stopped — no more jobs will be worked');
        setStatus('STOPPED');
        return { ok: true, stoppingAfterCurrent: engine.running };
    });

    /**
     * Look for new jobs. Reads only — it never applies to anything.
     *
     * Available whether or not automation is running, because it commits the
     * consultant to nothing. Starting work is a separate, deliberate button.
     */
    // ── THE TWO BUTTONS ON THE COUNTDOWN ──────────────────────────────
    //
    // "Continue now" is a request to LOOK AGAIN, not an assertion that the work
    // is done -- if the challenge is still up or the question still
    // unanswered, the countdown carries on rather than the job being thrown
    // away on somebody's optimism. "Skip" is the opposite: an explicit
    // decision, taken immediately, no recheck.
    ipcMain.handle('attentionContinue', () => ({ ok: Boolean(attention?.continueNow()) }));
    ipcMain.handle('attentionSkip', () => ({ ok: Boolean(attention?.skip()) }));

    ipcMain.handle('checkForJobs', async () => {
        if (!secrets.read()) return { ok: false, error: 'This device is not activated.' };
        try {
            const res = await engine.refresh();
            toRenderer('log',
                res.waiting === 0
                    ? 'checked — no jobs waiting'
                    : `checked — ${res.waiting} job(s) waiting`);
            setStatus(status.state);
            return res;
        } catch (err) {
            if (err.name !== 'Revoked') setStatus('OFFLINE', err.message);
            return { ok: false, error: err.message };
        }
    });

    // Opening a board's login window is the consultant's action, so it is a
    // channel rather than something the engine does behind their back.
    ipcMain.handle('signIn', async (_e, board) => {
        const { BOARDS } = require('./browser/boards.js');
        const def = BOARDS[board];
        if (!def) return { ok: false, error: `Unknown board ${board}` };

        try {
            await sessions.promptSignIn(def);

            // The login now opens in its own window, so there is no need to
            // drag the consultant to the Boards tab — but selecting that board
            // means the automation's page is what they come back to.
            toRenderer('showBoard', def.name);

            // Opening the window is not the end of it. The board is on hold at
            // the hub until something says otherwise, and the only thing that
            // used to say otherwise was a work pass — so a board with no
            // pending work stayed marked "sign-in expired" forever, however
            // many times the consultant actually signed in.
            //
            // So we wait here for them, exactly as a work pass does.
            const deadline = Date.now() + config.SIGNIN_WAIT_MS;
            while (Date.now() < deadline) {
                await new Promise((r) => { setTimeout(r, config.SIGNIN_POLL_MS); });
                if (await sessions.isSignedInNow(def)) {
                    await sessions.finishSignIn?.(def.name);
                    await sessions.saveSession?.(def.name);
                    await hub.boardStatus({
                        board: def.name, state: 'OK', detail: 'Signed in',
                    }).catch(() => {});
                    await heartbeat();
                    toRenderer('log', `${def.label}: signed in`);
                    runCycle('manual');
                    return { ok: true, signedIn: true };
                }
            }
            return { ok: true, signedIn: false };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('openExternal', (_e, url) => { shell.openExternal(url); return { ok: true }; });

    /* ── showing a board's page inside the window ──────────────────────
     *
     * The renderer cannot draw the page itself — a WebContentsView is a native
     * layer sitting ON TOP of the HTML, not inside it. So the card measures the
     * empty space it left for the view and reports those coordinates, and the
     * main process moves the view there. Collapse the card and it is moved off
     * screen again rather than destroyed, so a half-filled application is still
     * there when it is reopened.
     */
    ipcMain.handle('showBoardView', (_e, board, bounds) => {
        if (typeof sessions?.show !== 'function') {
            return { ok: false, error: 'This build opens boards in a separate window.' };
        }
        try {
            sessions.show(board, bounds);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('hideBoardView', (_e, board) => {
        if (typeof sessions?.hide !== 'function') return { ok: true };
        if (board) sessions.hide(board); else sessions.hideAll();
        return { ok: true };
    });

    /** Does this build show boards inside the window? The UI adapts either way. */
    ipcMain.handle('browserIsEmbedded', () => ({ embedded: Boolean(config.EMBED_BROWSER) }));

    // What this consultant has already applied to, grouped by board. Fetched on
    // demand rather than held in the snapshot: it is history, it does not change
    // between pushes, and it can be long.
    /* ── questions blocking applications ───────────────────────────────
     *
     * Answered here rather than on the web, because this is where the job is.
     * The consultant is looking at "3 applications are waiting on your notice
     * period"; asking them to go and find the same question in a portal is how
     * a two-minute job becomes tomorrow's.
     */
    ipcMain.handle('questions', async () => {
        try {
            return { ok: true, ...(await hub.questions()) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    /** The whole bank — every answer the app would type into an application. */
    ipcMain.handle('answerBank', async () => {
        try {
            return { ok: true, ...(await hub.answers()) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('answerQuestion', async (_e, questionId, answerText) => {
        try {
            const res = await hub.answerQuestion(questionId, { answerText });
            // Answering may have freed applications; pull the queue so the
            // count on screen matches what just happened.
            await engine.refresh().catch(() => {});
            setStatus(status.state);
            return { ok: true, ...res };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('applications', async () => {
        try {
            return { ok: true, ...(await hub.applications()) };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    /* ── review and submit ─────────────────────────────────────────────
     *
     * R-02 lives at this boundary. There is a channel that OPENS a filled form
     * for the consultant and a channel that RECORDS what they submitted, and
     * there is deliberately no channel that submits. The renderer could not
     * ask the app to press submit even if something compromised it, because
     * nothing on the other side would answer.
     */

    ipcMain.handle('openReview', async (_e, itemId) => {
        try {
            return await engine.openForReview(itemId);
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // "I already submitted it myself, in the browser."
    ipcMain.handle('markSubmitted', async (_e, itemId) => {
        try {
            const res = await engine.reportSubmitted(itemId);
            setStatus(status.state);
            return res;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // "Submit it for me, now, from here." The consultant has read the answers
    // on the review screen and pressed the button; this performs the click they
    // asked for. It is the only path in the app that presses a portal's submit
    // control (R-02 as amended by the owner).
    ipcMain.handle('submitApplication', async (_e, itemId) => {
        try {
            const res = await engine.submitFromApp(itemId);
            setStatus(status.state);
            return res;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('discardReview', async (_e, itemId, reason) => {
        try {
            const res = await engine.discardReview(itemId, reason);
            setStatus(status.state);
            return res;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
};

/* ── boot ─────────────────────────────────────────────────────────────── */

app.on('second-instance', showWindow);
/**
 * ── LEAVING NOTHING RUNNING ───────────────────────────────────────────
 *
 * Every board and every Workday employer is a whole Chromium, launched as a
 * CHILD of this process but not tied to its life. Quitting without closing
 * them left them running -- invisible, with no window, holding hundreds of
 * megabytes each. They accumulate across restarts until a real browser cannot
 * get memory to render a page, which is exactly how LinkedIn ended up dying
 * with "Aw, Snap! Out of Memory".
 *
 * `closeAll` saves each session before closing it, so tidying up costs the
 * consultant nothing: they are still signed in next time.
 *
 * The quit is deferred once, because closing browsers is asynchronous and
 * Electron will not wait for a promise on its own. `isQuitting` is set first
 * so the window's own close handler stops hiding instead of closing, and the
 * second `app.quit()` runs after the work is done.
 */
let cleaningUp = false;
app.on('before-quit', (e) => {
    app.isQuitting = true;
    stopUpdater?.();

    if (cleaningUp || !sessions) return;
    cleaningUp = true;
    e.preventDefault();
    (async () => {
        try {
            await sessions.closeAll();
        } catch { /* a browser that has already gone is not a problem */ }
        app.quit();
    })();
});
// The tray is the app. Closing the last window must not end it.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
    paths = config.paths(app.getPath('userData'));
    for (const dir of [paths.profiles, paths.work, paths.logs]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Before anything else that can throw: a crash during start-up is exactly
    // the one this needs to catch.
    diagnostics = startDiagnostics({
        app, crashReporter, logsDir: paths.logs,
        log: (m) => { toRenderer('log', m); },
    });

    store = new Store(paths.state);
    outbox = new Outbox(paths.outbox);
    secrets = new Secrets(safeStorage, paths.userData);

    hub = new HubClient({
        getToken: () => secrets.read(),
        fingerprint: store.get('machineFingerprint') ?? fingerprint(),
        onRevoked: handleRevoked,
    });

    // Resolved here rather than at module load so the pure modules stay
    // testable without any browser installed at all.
    const { chromium, launchOptions, source } = resolveBrowser();
    diagnostics.record('browser', `driving ${source}`);

    if (config.EMBED_BROWSER) {
        // Each board's page lives in a view inside our own window, shown on the
        // Boards tab. Nothing else changes: the engine, the filler and the
        // apply flow are handed a Playwright page either way and never learn
        // which kind it is.
        sessions = new EmbeddedSessions({
            chromium,
            cdpEndpoint: `http://127.0.0.1:${config.CDP_PORT}`,
            getWindow: () => win,
            log: (m) => { toRenderer('log', m); },
        });
    } else {
        // The original path, kept because driving Electron's own pages depends
        // on a debugging port that a locked-down machine may refuse to open.
        sessions = new BrowserSessions({
            chromium, profilesDir: paths.profiles, sessionsDir: paths.sessions, launchOptions,
        });
    }

    // ── THE BOT ASKING FOR HELP ───────────────────────────────────────
    //
    // Three ways the consultant finds out, because they may be looking at any
    // of them: an OS notification (they are in another window), the countdown
    // banner in the app, and the browser window itself being brought forward.
    attention = new Attention({
        notify: (a) => {
            try {
                if (!Notification.isSupported()) return;
                new Notification({
                    title: a.headline,
                    body: [a.company, a.message].filter(Boolean).join(' — ').slice(0, 240),
                    urgency: 'critical',
                }).on('click', showWindow).show();
            } catch { /* a notification nobody can show is not worth a crash */ }
        },
        // Straight into the same status push the rest of the UI already uses,
        // so the banner appears without the renderer polling for it.
        publish: () => {
            toRenderer('status', { ...status, ...snapshot() });
            buildTrayMenu();
        },
    });

    engine = new CycleEngine({
        hub, sessions, store, outbox, paths,
        log: (m) => { toRenderer('log', m); },
        activity: recordActivity,
        attention,
    });

    // A 1×1 transparent image: a real icon is a D7 asset, and an empty tray is
    // better than a crash on a missing file.
    tray = new Tray(nativeImage.createEmpty());
    buildTrayMenu();
    tray.on('click', showWindow);

    registerIpc();
    showWindow();

    if (store.get('activatedAt')) {
        // Activated is not the same as running. The heartbeat still goes out —
        // the hub needs to know this device is alive and revocable — but no job
        // is touched until Start.
        setStatus(store.get('automationOn') ? 'IDLE' : 'STOPPED');
        heartbeat();
        if (store.get('automationOn')) scheduleCycle();
    } else {
        setStatus('NEEDS_ACTIVATION');
    }

    heartbeatTimer = setInterval(heartbeat, config.HEARTBEAT_MS);

    stopUpdater = startUpdater({
        app,
        log: (m) => { toRenderer('log', m); },
        record: diagnostics.record,
    });
});
