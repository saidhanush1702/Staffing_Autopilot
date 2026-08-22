/**
 * ── THE BRIDGE ────────────────────────────────────────────────────────
 *
 * The renderer's entire vocabulary. Everything it can do is listed here, and
 * nothing else is reachable: no Node, no filesystem, no network, no device token.
 *
 * This is the boundary that matters. The renderer displays job pages' worth of
 * text and a consultant's own input, and a renderer is a browser — so it is
 * treated as the least trusted part of the app rather than the most convenient
 * place to put things.
 *
 * Note what is absent: there is no channel that returns the device token, and no
 * channel that accepts a portal password. Neither exists anywhere in the app
 * (R-18), and the bridge is where that would be visible if it did.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartapply', {
    /** Current status plus everything the screens need to render. */
    snapshot: () => ipcRenderer.invoke('snapshot'),

    /** Trade the one-time code from the administrator for a bound device. */
    activate: (activationCode) => ipcRenderer.invoke('activate', activationCode),

    /**
     * Begin working the queue, with the consultant's choice about submitting.
     *
     * `autoSubmit` is passed in once, here, because it is a decision taken
     * before starting rather than a switch to flip while jobs are in flight.
     */
    startAutomation: (options) => ipcRenderer.invoke('startAutomation', options),

    /** Stop working. Anything already in progress finishes; nothing new starts. */
    stopAutomation: () => ipcRenderer.invoke('stopAutomation'),

    /**
     * Look for new jobs. This READS — it never applies to anything, which is
     * why it is offered whether or not automation is running.
     */
    checkForJobs: () => ipcRenderer.invoke('checkForJobs'),

    /** Open a board's login page so the consultant can sign in themselves. */
    signIn: (board) => ipcRenderer.invoke('signIn', board),

    /** Hand a link to the real browser instead of opening it in the app. */
    openExternal: (url) => ipcRenderer.invoke('openExternal', url),

    /**
     * Show a board's live page at these coordinates inside the window, or move
     * it out of sight again. The page itself is a native view above the HTML,
     * so the card reserves the space and reports where it ended up.
     */
    showBoardView: (board, bounds) => ipcRenderer.invoke('showBoardView', board, bounds),
    hideBoardView: (board) => ipcRenderer.invoke('hideBoardView', board),
    browserIsEmbedded: () => ipcRenderer.invoke('browserIsEmbedded'),

    /** Everything this consultant has applied to, grouped by job board. */
    applications: () => ipcRenderer.invoke('applications'),

    /** Bring a filled form back in front of the consultant to check. */
    openReview: (itemId) => ipcRenderer.invoke('openReview', itemId),

    /** Record that the consultant already submitted it themselves, in the browser. */
    markSubmitted: (itemId) => ipcRenderer.invoke('markSubmitted', itemId),

    /**
     * Submit from the app, on the consultant's instruction.
     *
     * The one channel that results in a portal's submit button being pressed.
     * It exists because the owner asked for review-and-send in one place; the
     * decision is still a person's, taken after reading every answer. Nothing
     * in the work loop can reach it — it is invoked from the review screen only.
     */
    submitApplication: (itemId) => ipcRenderer.invoke('submitApplication', itemId),

    /** Throw away a filled form the consultant does not want to send. */
    discardReview: (itemId, reason) => ipcRenderer.invoke('discardReview', itemId, reason),

    /**
     * Push updates. Returns an unsubscribe function, because a React effect
     * that cannot detach its listener leaks one per remount.
     */
    onStatus: (fn) => {
        const handler = (_e, payload) => fn(payload);
        ipcRenderer.on('status', handler);
        return () => ipcRenderer.removeListener('status', handler);
    },
    /**
     * The main process asking the UI to bring a board into view — sent when a
     * sign-in is needed, because a login page nobody can see explains nothing.
     */
    onShowBoard: (fn) => {
        const handler = (_e, board) => fn(board);
        ipcRenderer.on('showBoard', handler);
        return () => ipcRenderer.removeListener('showBoard', handler);
    },
    onLog: (fn) => {
        const handler = (_e, line) => fn(line);
        ipcRenderer.on('log', handler);
        return () => ipcRenderer.removeListener('log', handler);
    },
});
