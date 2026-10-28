import { useEffect, useState } from 'react';
import {
    Timer, RadioTower, Zap, Sparkles, ListChecks, Power, Eye, Rocket, SlidersHorizontal,
    TriangleAlert, Loader2,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import Card from '../ui/Card.jsx';
import StatCard from '../ui/StatCard.jsx';
import Alert from '../ui/Alert.jsx';
import Modal, { ModalActions } from '../ui/Modal.jsx';
import {
    btn, btnSm, input, fieldLabel, fieldHint, checkbox,
    segmentGroup, segmentItem, segmentActive, segmentIdle,
    toggleTrack, toggleTrackOn, toggleTrackOff, toggleKnob, toggleKnobOn, toggleKnobOff,
    sectionTitle, sectionSubtitle, proseMuted,
} from '../../design/tokens.js';
import { formatDuration } from '../../utils/relativeTime.js';
import { MODES } from './atsLabels.js';

/** The numeric tuning fields, in one place so the form and the diff agree. */
const TUNING = [
    ['minIntervalS', 'Fastest a board may be read', 'seconds', 'A board that just changed is read this often. Employers\' own caches mean going under 60 gains nothing.', 60, 86400],
    ['maxIntervalS', 'Slowest a quiet board slows to', 'seconds', 'A board that keeps being unchanged drifts towards this.', 300, 604800],
    ['bootstrapAgeHours', 'First-read freshness window', 'hours', 'On first contact a board lists everything it has ever opened. Only jobs published within this window are treated as news; the rest are remembered silently.', 0, 720],
    ['maxIngestPerPoll', 'Most jobs added per read', 'jobs', 'A bound, so one board cannot flood the queues. The rest wait for the next read.', 1, 500],
    ['detailCapPerPoll', 'Most detail lookups per read', 'requests', 'Greenhouse, Workday and SmartRecruiters need a second request per new job for its description.', 1, 200],
];

const AtsOverview = ({ data, isAdmin, onChanged, goToBoards }) => {
    const { settings, serverLoopRunning, boards, last24h, latency, families } = data;

    const [form, setForm] = useState(settings);
    const [busy, setBusy] = useState('');
    const [banner, setBanner] = useState(null);
    const [confirmLive, setConfirmLive] = useState(false);
    const [showTuning, setShowTuning] = useState(false);

    // Re-seed the form when the server's copy changes (after a save or reload).
    useEffect(() => { setForm(settings); }, [settings]);

    const dirty = TUNING.some(([k]) => Number(form[k]) !== Number(settings[k]))
        || form.closeOnRemoval !== settings.closeOnRemoval;

    const patch = async (name, body, okText) => {
        setBusy(name);
        setBanner(null);
        try {
            await api.patch('/management/ats/settings', body);
            if (okText) setBanner({ tone: 'success', text: okText });
            await onChanged();
        } catch (err) {
            setBanner({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy('');
        }
    };

    const saveTuning = () => patch('tuning', {
        minIntervalS: Number(form.minIntervalS),
        maxIntervalS: Number(form.maxIntervalS),
        bootstrapAgeHours: Number(form.bootstrapAgeHours),
        maxIngestPerPoll: Number(form.maxIngestPerPoll),
        detailCapPerPoll: Number(form.detailCapPerPoll),
        closeOnRemoval: form.closeOnRemoval,
    }, 'Settings saved.');

    const on = settings.isEnabled;
    const active = boards.byStatus.ACTIVE ?? 0;
    const trouble = (boards.byStatus.FAILING ?? 0) + (boards.byStatus.NOT_FOUND ?? 0);

    // The headline. "—" when nothing has been MEASURED yet, never a zero: a
    // median of no data is not zero seconds, and showing it would read as "instant".
    const medianLabel = latency.medianSeconds === null ? '—' : formatDuration(latency.medianSeconds);

    return (
        <div className="space-y-6">
            {banner && <Alert tone={banner.tone} onDismiss={() => setBanner(null)}>{banner.text}</Alert>}

            {isAdmin && !serverLoopRunning && (
                <Alert tone="warning" title="The background loop is not running on the server">
                    Boards are only read when you press <strong>Poll now</strong>. To read them continuously, set{' '}
                    <code>ATS_MIRROR_ENABLED=true</code> in the backend environment and restart the server.
                </Alert>
            )}

            {/* ── the numbers ─────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatCard
                    icon={Timer} tone="brand" label="Typical time to notice"
                    value={medianLabel}
                    hint={latency.measured
                        ? `Median of ${latency.measured} job${latency.measured === 1 ? '' : 's'} over 7 days`
                        : 'Measured once a board has published something new'}
                />
                <StatCard
                    icon={RadioTower} tone="info" label="Boards watched"
                    value={active}
                    hint={trouble ? `${trouble} need attention` : `${boards.jobsOpen.toLocaleString()} jobs open across them`}
                />
                <StatCard
                    icon={Zap} tone="success" label="Reads that cost nothing"
                    value={last24h.polls ? `${last24h.notModifiedShare}%` : '—'}
                    hint={`${last24h.polls.toLocaleString()} reads in 24 h, ${last24h.megabytes} MB`}
                />
                <StatCard
                    icon={Sparkles} tone="brand" label="New jobs noticed"
                    value={last24h.newJobs}
                    hint="In the last 24 hours"
                />
                <StatCard
                    icon={ListChecks} tone="success" label="Queued for consultants"
                    value={last24h.queued}
                    hint={settings.mode === 'LIVE' ? 'In the last 24 hours' : 'Zero by design while observing'}
                />
            </div>

            {boards.total === 0 && (
                <Alert tone="info" title="Start by adding employer boards">
                    The mirror reads each employer&apos;s own careers system, so it needs a list of them.{' '}
                    <button type="button" className="font-semibold underline" onClick={goToBoards}>
                        Add boards
                    </button>{' '}
                    by pasting careers links, or let it find boards for the companies already in your pool
                    ({data.poolCompanies.toLocaleString()} of them).
                </Alert>
            )}

            {/* ── the switch ──────────────────────────────────────────── */}
            <Card
                title="Live mirror"
                subtitle="Read employers' own career systems directly, minutes after a job is published."
                action={isAdmin && (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label="Live mirror on or off"
                        disabled={busy !== ''}
                        onClick={() => patch('enabled', { isEnabled: !on },
                            on ? 'The mirror is off. Nothing will be read on a schedule.' : 'The mirror is on.')}
                        className={`${toggleTrack} ${on ? toggleTrackOn : toggleTrackOff}`}
                    >
                        <span className={`${toggleKnob} ${on ? toggleKnobOn : toggleKnobOff}`} />
                    </button>
                )}
            >
                <p className={proseMuted}>
                    {on
                        ? 'On. Boards are read on their own schedule — often every couple of minutes for ones that keep publishing, hours apart for quiet ones.'
                        : 'Off. Nothing is read on a schedule. You can still add boards and press Poll now to check one — a manual read never adds anything to the pool while this is off.'}
                </p>

                <div className="mt-5">
                    <p className={fieldLabel}>What happens to a new job</p>
                    <div className={`mt-2 ${segmentGroup}`} role="group" aria-label="Mode">
                        {Object.entries(MODES).map(([key, m]) => (
                            <button
                                key={key}
                                type="button"
                                disabled={!isAdmin || busy !== ''}
                                aria-pressed={settings.mode === key}
                                onClick={() => {
                                    if (key === settings.mode) return;
                                    if (key === 'LIVE') setConfirmLive(true);
                                    else patch('mode', { mode: 'OBSERVE' }, 'Observe mode: new jobs are noticed but nothing is added.');
                                }}
                                className={`${segmentItem} ${settings.mode === key ? segmentActive : segmentIdle} inline-flex items-center gap-1.5`}
                            >
                                {key === 'LIVE' ? <Rocket className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <p className={`mt-2 ${fieldHint}`}>{MODES[settings.mode].blurb}</p>
                    {settings.mode === 'OBSERVE' && (
                        <p className={`mt-1 ${fieldHint}`}>
                            Start here. Watch the &ldquo;time to notice&rdquo; number and the Live feed for a few days, then switch to Live
                            once you trust what it finds.
                        </p>
                    )}
                </div>
            </Card>

            {/* ── tuning ──────────────────────────────────────────────── */}
            <Card
                title="Tuning"
                subtitle="Sensible defaults. Change these only if you know why."
                action={(
                    <button type="button" className={btnSm.secondary} onClick={() => setShowTuning((v) => !v)}>
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        {showTuning ? 'Hide' : 'Show'}
                    </button>
                )}
            >
                {!showTuning ? (
                    <p className={proseMuted}>
                        Boards are read as often as every {formatDuration(settings.minIntervalS)} and as rarely as every{' '}
                        {formatDuration(settings.maxIntervalS)}; at most {settings.maxIngestPerPoll} jobs are added per read.
                    </p>
                ) : (
                    <>
                        <div className="grid gap-4 sm:grid-cols-2">
                            {TUNING.map(([key, label, unit, hint, min, max]) => (
                                <label key={key} className="block">
                                    <span className={fieldLabel}>{label}</span>
                                    <div className="relative">
                                        <input
                                            type="number" min={min} max={max}
                                            disabled={!isAdmin}
                                            value={form[key]}
                                            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                                            className={`${input} pr-20`}
                                        />
                                        <span className="pointer-events-none absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 text-xs text-slate-400">
                                            {unit}
                                        </span>
                                    </div>
                                    <span className={fieldHint}>{hint}</span>
                                </label>
                            ))}
                        </div>

                        <label className="mt-5 flex items-start gap-3">
                            <input
                                type="checkbox" className={`${checkbox} mt-0.5`}
                                disabled={!isAdmin}
                                checked={form.closeOnRemoval}
                                onChange={(e) => setForm({ ...form, closeOnRemoval: e.target.checked })}
                            />
                            <span>
                                <span className={fieldLabel}>Retire a posting when the employer takes the job down</span>
                                <span className={`block ${fieldHint}`}>
                                    Marks the posting inactive once it has been missing from two complete reads of its board.
                                    Off by default because it can also retire a posting another source found.
                                </span>
                            </span>
                        </label>

                        {isAdmin && (
                            <div className="mt-5 flex justify-end">
                                <button type="button" className={btn.primary} disabled={!dirty || busy !== ''} onClick={saveTuning}>
                                    {busy === 'tuning' && <Loader2 className="h-4 w-4 animate-spin" />}
                                    Save settings
                                </button>
                            </div>
                        )}
                    </>
                )}
            </Card>

            {/* ── what it can read ────────────────────────────────────── */}
            <div>
                <h2 className={sectionTitle}>Career systems it can read</h2>
                <p className={sectionSubtitle}>
                    {families.map((f) => f.label).join(', ')}. Each is read at no cost, using the system&apos;s own public listing.
                </p>
            </div>

            {confirmLive && (
                <Modal
                    size="sm" tone="warning" icon={TriangleAlert}
                    title="Switch to Live?"
                    onClose={() => setConfirmLive(false)}
                    footer={(
                        <ModalActions
                            onCancel={() => setConfirmLive(false)}
                            confirmLabel="Switch to Live"
                            variant="primary"
                            busy={busy === 'mode'}
                            onConfirm={async () => {
                                await patch('mode', { mode: 'LIVE' }, 'Live mode: new jobs now flow into the pool and the queues.');
                                setConfirmLive(false);
                            }}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        From now on, new jobs found on watched boards are added to the pool and matched against every
                        consultant on the bench. Matches are <strong>queued</strong>, and AI resume preparation is
                        started for them — which uses your model credits.
                    </p>
                    <p className="mt-3 text-sm text-slate-600">
                        Jobs already noticed while observing are not added retroactively. You can switch back to
                        Observe at any time.
                    </p>
                </Modal>
            )}
        </div>
    );
};

export default AtsOverview;
