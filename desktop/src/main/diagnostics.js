/**
 * ── WHEN SOMETHING GOES WRONG ─────────────────────────────────────────
 *
 * A background agent that dies silently is worse than one that never started:
 * the consultant sees an app that looks fine and a queue that never moves, and
 * the recruiter sees a machine that stopped reporting for no stated reason.
 *
 * ── NOTHING IS SENT ANYWHERE ──────────────────────────────────────────
 *
 * Crash dumps stay on the machine. `uploadToServer: false` is deliberate and
 * not a placeholder: a crash dump is a snapshot of memory, and this process has
 * held a device token, a consultant's personal details and the contents of job
 * application forms. Shipping that to a third-party crash service — or to our
 * own, before the security review — would move exactly the data R-27 says must
 * not travel yet.
 *
 * What DOES travel is already covered: the hub knows a device stopped checking
 * in, because the heartbeat stops. That is the signal a recruiter needs. The
 * local log is for the person who then has to work out why.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Keep the log honest but bounded: a log that fills a disk is its own outage. */
const MAX_BYTES = 2 * 1024 * 1024;

const rotate = (file) => {
    try {
        if (fs.statSync(file).size < MAX_BYTES) return;
        fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet, or already rotated */ }
};

/**
 * Append one line to the error log.
 *
 * Synchronous on purpose. This is called from an uncaught-exception handler,
 * where the process may be about to die — an async write would not land.
 */
const record = (logsDir, kind, detail) => {
    const file = path.join(logsDir, 'errors.log');
    try {
        fs.mkdirSync(logsDir, { recursive: true });
        rotate(file);
        fs.appendFileSync(file, `${new Date().toISOString()}  ${kind}  ${detail}\n`, 'utf8');
    } catch { /* if we cannot even log, there is nothing further to try */ }
};

/**
 * Wire up crash and error capture.
 *
 * @param log optional callback so the same line reaches the app's activity view
 */
const startDiagnostics = ({ app, crashReporter, logsDir, log = () => {} }) => {
    crashReporter.start({
        productName: 'SmartApply',
        companyName: 'MolinaTek',
        submitURL: '',
        uploadToServer: false,
        compress: true,
    });

    const note = (kind, detail) => {
        record(logsDir, kind, detail);
        log(`${kind}: ${String(detail).split('\n')[0]}`);
    };

    process.on('uncaughtException', (err) => {
        note('uncaughtException', err?.stack ?? String(err));
    });
    process.on('unhandledRejection', (reason) => {
        note('unhandledRejection', reason?.stack ?? String(reason));
    });

    // A renderer that dies takes the window with it but leaves the tray, the
    // timers and the work loop running — so this is recorded, not fatal.
    app.on('render-process-gone', (_e, _wc, details) => {
        note('rendererGone', `${details.reason} (exit ${details.exitCode})`);
    });
    app.on('child-process-gone', (_e, details) => {
        note('childProcessGone', `${details.type} ${details.reason}`);
    });

    record(logsDir, 'started', `SmartApply ${app.getVersion()} on ${process.platform}`);

    return { record: (kind, detail) => note(kind, detail), logFile: path.join(logsDir, 'errors.log') };
};

module.exports = { startDiagnostics, record, MAX_BYTES };
