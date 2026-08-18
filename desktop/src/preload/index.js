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

    /** Check for work now, rather than waiting for the next cycle. */
    runNow: () => ipcRenderer.invoke('runNow'),

    /** Open a board's login page so the consultant can sign in themselves. */
    signIn: (board) => ipcRenderer.invoke('signIn', board),

    /** Hand a link to the real browser instead of opening it in the app. */
    openExternal: (url) => ipcRenderer.invoke('openExternal', url),

    /**
     * Push updates. Returns an unsubscribe function, because a React effect
     * that cannot detach its listener leaks one per remount.
     */
    onStatus: (fn) => {
        const handler = (_e, payload) => fn(payload);
        ipcRenderer.on('status', handler);
        return () => ipcRenderer.removeListener('status', handler);
    },
    onLog: (fn) => {
        const handler = (_e, line) => fn(line);
        ipcRenderer.on('log', handler);
        return () => ipcRenderer.removeListener('log', handler);
    },
});
