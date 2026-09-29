import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Download, Loader2, MonitorDown } from 'lucide-react';
import {
    badge, btn, card, cardPad, codeChip, prose, proseMuted, sectionTitle, TONE,
} from '../design/tokens.js';

/**
 * ── ONE PAGE, THE RIGHT BUTTON, NEVER STALE ───────────────────────────
 *
 * The desktop app is what actually fills and submits applications — the
 * portal cannot do that itself. This is the one place a consultant gets it,
 * and it is built to need no maintenance as new versions ship:
 *
 *   · The button for THEIR operating system is picked from the browser, not
 *     guessed at by the consultant.
 *   · The link is resolved fresh, on every page load, from GitHub's OWN
 *     "latest release" — never a version number baked into this file. Ship a
 *     new build and this page is already pointing at it; there is nothing
 *     here to go and edit.
 *   · Once installed, the app updates itself — checks on launch and every
 *     six hours, installs the next time the consultant quits. This page is
 *     the only download they should ever need to make.
 *
 * Public, unauthenticated GitHub API — the repository is public, so this
 * needs no token and cannot leak one. See release-desktop.yml for how a
 * version actually gets here.
 */
const GITHUB_REPO = 'saidhanush1702/Staffing_Autopilot';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Windows vs Mac vs "something else", from the browser itself. */
const detectOS = () => {
    if (typeof navigator === 'undefined') return 'other';
    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    // iPadOS 13+ reports as Macintosh; excluded so an iPad is not offered a
    // desktop installer it cannot run.
    if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua)) return 'mac';
    return 'other';
};

/** Pick this platform's asset out of a GitHub release's asset list. */
const assetFor = (assets, extension) => (assets ?? []).find((a) => a.name?.toLowerCase().endsWith(extension));

const OS_LABEL = { windows: 'Windows', mac: 'Mac' };

const DownloadDesktopApp = () => {
    const [state, setState] = useState({ status: 'loading' });
    const [os] = useState(detectOS);

    useEffect(() => {
        let cancelled = false;

        fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
            .then(async (res) => {
                // A repo with no published release yet answers 404 — the
                // real, current state of this project, not an error to hide.
                if (res.status === 404) return { status: 'unreleased' };
                if (!res.ok) return { status: 'error' };
                const release = await res.json();
                const windows = assetFor(release.assets, '.exe');
                const mac = assetFor(release.assets, '.dmg');
                if (!windows && !mac) return { status: 'unreleased' };
                return {
                    status: 'ready',
                    version: release.tag_name?.replace(/^desktop-v/, '') ?? release.tag_name,
                    publishedAt: release.published_at,
                    windows,
                    mac,
                };
            })
            .catch(() => ({ status: 'error' }))
            .then((next) => { if (!cancelled) setState(next); });

        return () => { cancelled = true; };
    }, []);

    return (
        <div className={`${card} ${cardPad}`}>
            <div className="flex items-start gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl
                                 bg-brand-50 text-brand-600">
                    <MonitorDown className="h-[1.15rem] w-[1.15rem]" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className={sectionTitle}>Download SmartApply for your computer</h2>
                    <p className={`mt-1 ${prose}`}>
                        This is where applications actually get filled in and submitted — the portal
                        shows your queue, the desktop app does the work.
                    </p>

                    {state.status === 'loading' && (
                        <p className={`mt-4 flex items-center gap-2 ${proseMuted}`}>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Checking for the latest version…
                        </p>
                    )}

                    {state.status === 'error' && (
                        <p className={`mt-4 ${proseMuted}`}>
                            Could not check for the latest version just now. Reload the page to try
                            again, or ask your recruiter for a direct link.
                        </p>
                    )}

                    {state.status === 'unreleased' && (
                        <div className="mt-4 flex items-start gap-2 rounded-lg bg-warning-50 p-3 text-xs
                                        text-warning-800">
                            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                                A build has not been published yet. Nothing to download here until the
                                first release goes out — this page will start working the moment it
                                does, with no change needed.
                            </span>
                        </div>
                    )}

                    {state.status === 'ready' && (
                        <>
                            <div className="mt-4 flex flex-wrap items-center gap-3">
                                {os !== 'mac' && state.windows && (
                                    <a
                                        href={state.windows.browser_download_url}
                                        className={btn.primary}
                                    >
                                        <Download className="h-4 w-4" />
                                        Download for Windows
                                    </a>
                                )}
                                {os === 'mac' && state.mac && (
                                    <a
                                        href={state.mac.browser_download_url}
                                        className={btn.primary}
                                    >
                                        <Download className="h-4 w-4" />
                                        Download for Mac
                                    </a>
                                )}
                                <span className={`${badge} ${TONE.neutral}`}>v{state.version}</span>
                            </div>

                            {/* The OTHER platform, offered quietly underneath — the
                                consultant on a work Windows laptop who also wants it on
                                their personal Mac should not have to hunt for it. */}
                            <p className={`mt-2.5 ${proseMuted}`}>
                                {os !== 'mac' && state.mac && (
                                    <>
                                        On a Mac?{' '}
                                        <a
                                            href={state.mac.browser_download_url}
                                            className="font-medium text-brand-600 underline underline-offset-2
                                                      hover:text-brand-700"
                                        >
                                            Download for Mac
                                        </a>
                                        {' '}instead.
                                    </>
                                )}
                                {os === 'mac' && state.windows && (
                                    <>
                                        On Windows?{' '}
                                        <a
                                            href={state.windows.browser_download_url}
                                            className="font-medium text-brand-600 underline underline-offset-2
                                                      hover:text-brand-700"
                                        >
                                            Download for Windows
                                        </a>
                                        {' '}instead.
                                    </>
                                )}
                                {os === 'other' && (
                                    <>
                                        Pick the one that matches your computer:{' '}
                                        {state.windows && (
                                            <a
                                                href={state.windows.browser_download_url}
                                                className="font-medium text-brand-600 underline underline-offset-2"
                                            >
                                                Windows
                                            </a>
                                        )}
                                        {state.windows && state.mac && ' · '}
                                        {state.mac && (
                                            <a
                                                href={state.mac.browser_download_url}
                                                className="font-medium text-brand-600 underline underline-offset-2"
                                            >
                                                Mac
                                            </a>
                                        )}
                                    </>
                                )}
                            </p>

                            {/* ── ACTIVATION ──────────────────────────────────────
                                Downloading is only half of it: the app does nothing
                                until it is paired with this consultant's account. */}
                            <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-surface-sunken p-3.5">
                                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                                <div className={proseMuted}>
                                    <p className="font-medium text-slate-700">After it installs</p>
                                    <p className="mt-1">
                                        Open SmartApply and enter the activation code your recruiter or
                                        admin gives you — it is issued to you personally and expires
                                        after 48 hours, so ask for a fresh one if yours has lapsed. Once
                                        activated, the app updates itself automatically; you will not
                                        need to come back here for future versions.
                                    </p>
                                </div>
                            </div>

                            <p className={`mt-3 ${proseMuted}`}>
                                Every download is verified against the code your recruiter provided —
                                an activation code works on <span className={codeChip}>one machine</span>{' '}
                                at a time.
                            </p>
                        </>
                    )}

                    {os === 'other' && state.status === 'ready' && !state.windows && !state.mac && (
                        <p className={`mt-4 ${proseMuted}`}>
                            SmartApply currently supports Windows and Mac. If you are on something
                            else, ask your recruiter about your options.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default DownloadDesktopApp;
