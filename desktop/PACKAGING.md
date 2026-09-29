# Packaging and release

How the consultant desktop app becomes something a person can install.

```bash
npm run dist
```

That builds the renderer and hands the result to electron-builder, which
produces an NSIS installer on Windows and a DMG on macOS. Each platform must be
built on its own operating system — a Mac build cannot be produced on Windows.
`.github/workflows/release-desktop.yml` does exactly that on GitHub's own
runners — a real Windows machine and a real Mac, rented for the few minutes a
build takes — so a release is never "whoever has both machines handy did it by
hand." See **Releasing a new version** below.

The Mac side builds a single **universal** DMG (both Intel and Apple Silicon in
one file) rather than one artifact per architecture. That costs a larger
download; what it buys is a consultant never having to know which chip their
Mac has — one Mac button on the download page, not two.

`package.json`'s `build.publish` names the exact repository releases go to
(`saidhanush1702/Staffing_Autopilot`) rather than leaving electron-builder to
infer it — this repo has more than one git remote attached, and an inferred
target is exactly the kind of thing that publishes to the wrong place once,
silently, the first time someone builds from a different checkout.

It has to stay a **public** repository for any of this to reach a consultant
at all — GitHub Release assets on a private repo are not fetchable by a bare
link, which is what `DownloadDesktopApp.jsx` and every installed app's
auto-updater both rely on.

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

To enable it, set these as **GitHub Actions repository secrets** — never in the
repository itself:

| Platform | Secret name | What it is |
|---|---|---|
| Windows | `WIN_CSC_LINK` | Path or base64 of the .pfx |
| Windows | `WIN_CSC_KEY_PASSWORD` | The certificate's password |
| macOS | `MAC_CSC_LINK` | Path or base64 of the .p12 |
| macOS | `MAC_CSC_KEY_PASSWORD` | The certificate's password |
| macOS | `APPLE_ID` | The Apple ID used for notarisation |
| macOS | `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID |
| macOS | `APPLE_TEAM_ID` | The Apple Developer team ID |

`release-desktop.yml` already reads every one of these and hands them to
electron-builder — nothing in the workflow needs to change once the
certificates exist. Windows and Mac use separate secret names (`WIN_*` /
`MAC_*`) on purpose: they run in different jobs on different machines, and a
Windows-only certificate must never be reachable from the Mac job's
environment or the reverse.

electron-builder picks them up with no further configuration, and notarises the
Mac build automatically when the Apple variables are present. Until they are
set, both jobs still build and publish successfully — just unsigned, exactly as
today.

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

## Releasing a new version

1. Bump `"version"` in `desktop/package.json` — plain semver.
2. Commit that, then tag it and push the tag:
   ```bash
   git tag desktop-v0.2.0
   git push origin desktop-v0.2.0
   ```
3. That tag alone triggers `release-desktop.yml`: a Windows job and a Mac job
   run in parallel, each builds its own installer, and each publishes it to the
   **same** GitHub release (electron-builder is built for two jobs to publish
   to one release this way — nothing here merges them by hand).
4. Once both jobs finish, the release is live and the download page
   (`client/src/components/DownloadDesktopApp.jsx`) already points at it —
   it reads GitHub's own "latest release" on every page load, so there is
   nothing to go and update.
5. Every already-installed app picks the new version up on its own — on
   launch, or within six hours — and installs it the next time that
   consultant quits. Nobody needs to be told to redownload anything.

**To try the workflow itself without touching a real release**: run it via
"Run workflow" in the Actions tab and leave the tag input blank. Both jobs
build but do not publish — proof the pipeline works before it can ever put a
broken build in front of a consultant.

**First release ever, or anything that needs a human eye first**: publish the
GitHub release as a **draft** (electron-builder's `publish: always` still
creates it as a normal, immediately-visible release — turning it into a draft
first requires either publishing to a draft manually afterward, or passing
`--publish onTagOrDraft` and pre-creating the draft release with the matching
tag before the workflow runs). A draft release is invisible to
`/releases/latest`, so the download page and every installed app's
auto-updater simply do not see it until it is published for real.
