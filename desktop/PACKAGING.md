# Packaging and release

How the consultant desktop app becomes something a person can install.

```bash
npm run dist
```

That builds the renderer and hands the result to electron-builder, which
produces an NSIS installer on Windows and a DMG on macOS. Each platform must be
built on its own operating system — a Mac build cannot be produced on Windows.

## What ends up inside

Only four things are packaged: `src/main`, `src/preload`, `dist-renderer`, and
`package.json`. Production dependencies come along automatically; devDependencies
do not, and that distinction has already caused one bug worth remembering.

### The browser is not bundled

`playwright` — the package that ships its own ~150MB Chromium — is a
**devDependency**. `playwright-core`, the same driver with no browser attached,
is a real dependency. So a packaged build has the driver and no browser, and
drives **the consultant's installed Google Chrome** instead, through
`channel: 'chrome'`.

`src/main/browser/engine.js` makes that choice and says which it found. Running
from source you get the bundled Chromium; running the installer you get system
Chrome. It still uses its own profile directory either way, so the consultant's
everyday browsing, cookies and saved passwords are never touched.

**This means Chrome is a prerequisite for the installed app.** If you would
rather ship a self-contained browser, move `playwright` into `dependencies` and
expect the installer to grow by roughly 150MB per platform.

## Updates

`src/main/updater.js` checks GitHub releases on start and every six hours, and
installs on quit rather than restarting immediately — the app is usually mid-pass,
possibly with a half-filled application a consultant is about to read, and
restarting under them would throw that away.

Updates are skipped entirely when the build is not packaged, so development is
unaffected.

## Crash and error capture

`src/main/diagnostics.js` catches uncaught exceptions, unhandled rejections and
dead renderer or child processes, and appends them to `logs/errors.log` in the
app's data directory, rotating at 2MB.

**Nothing is uploaded.** `uploadToServer: false` is deliberate: a crash dump is a
snapshot of memory, and this process holds a device token, a consultant's
personal details and the contents of application forms. R-27 says none of that
travels before the security review. The hub already knows when a device stops
checking in — the heartbeat stops — which is the signal a recruiter needs. The
local log is for whoever then has to work out why.

## Code signing — not configured, and it should be

Both installers currently build **unsigned**. What that costs:

- **Windows** — SmartScreen shows "Windows protected your PC" and hides the
  install button behind *More info*. Reputation accrues per certificate, so an
  unsigned app never stops warning.
- **macOS** — Gatekeeper refuses to open it at all by the normal route. The
  `hardenedRuntime` and entitlements are already set in `package.json`, so the
  configuration is ready; only the identity is missing.

To enable it, set these in the build environment — never in the repository:

| Platform | Variables |
|---|---|
| Windows | `CSC_LINK` (path or base64 of the .pfx), `CSC_KEY_PASSWORD` |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

electron-builder picks them up with no further configuration, and notarises the
Mac build automatically when the Apple variables are present.

Certificates are a purchase decision for the owner:

- Windows **OV** — cheaper, but reputation still has to build up before
  SmartScreen stops warning.
- Windows **EV** — roughly $400–600/yr, requires a hardware token, and carries
  SmartScreen reputation immediately. For an app installed by consultants who
  have no reason to trust an unfamiliar publisher, this is the one worth paying
  for.
- Apple Developer Program — $99/yr, required for macOS at all.

`build/entitlements.mac.plist` grants JIT and unsigned executable memory. Those
are not optional decoration: Chromium is a child process that JIT-compiles, and
without them the hardened runtime kills it on launch — which looks, from the
outside, exactly like an app that cannot open a browser.
