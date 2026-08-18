import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Clock, Timer, AlertCircle, CalendarClock, Coins, Save, TriangleAlert,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import {
    card, cardPad, badge, sectionTitle, TONE, TONE_ALERT, TONE_TEXT,
    readout, readoutLarge, readoutLabel, btnSm, input, fieldLabel,
    toggleTrack, toggleTrackOn, toggleTrackOff, toggleKnob, toggleKnobOn, toggleKnobOff,
} from '../../design/tokens.js';

const two = (n) => String(n).padStart(2, '0');

/** Google's own recency vocabulary. Nothing finer than a day exists. */
const WINDOWS = [
    ['day', 'Last 24 hours'],
    ['3days', 'Last 3 days'],
    ['week', 'Last week'],
    ['month', 'Last month'],
];

/** Whole hours down to seconds — a countdown nobody has to interpret. */
const formatCountdown = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${two(Math.floor(total / 3600))}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
};

/**
 * The automatic 4-hour cycle: switch, clock, and countdown.
 *
 * ── WHY THE CLOCK COMES FROM THE SERVER ───────────────────────────────
 *
 * The countdown is against the machine that actually runs the cron, not the
 * one displaying it. A laptop whose clock is ten minutes fast would otherwise
 * show a countdown that is ten minutes wrong, and the run would appear to be
 * late every single cycle. So the API returns its own `serverTime` beside
 * `nextRunAt`, this component measures the offset once, and every tick after
 * that is drawn against the server's clock.
 *
 * ── TWO SWITCHES, NOT ONE ─────────────────────────────────────────────
 *
 * `enabled` is this organisation's choice. `schedulerAvailable` is whether the
 * server process runs the cycle at all (DISCOVERY_ENABLED). Both must be true
 * for anything to fire, so when the second one is false this says so plainly
 * rather than showing an armed-looking switch that will never do anything.
 */
const SchedulePanel = ({ canEdit, onCycleFired }) => {
    const [data, setData] = useState(null);
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    // Server clock minus browser clock, measured when the payload arrives.
    const offsetRef = useRef(0);
    const [now, setNow] = useState(() => Date.now());
    // Guards the post-fire refresh so it happens once per boundary, not once
    // per tick while the countdown sits at zero.
    const firedForRef = useRef(null);

    const apply = useCallback((payload) => {
        if (payload.serverTime) {
            offsetRef.current = new Date(payload.serverTime).getTime() - Date.now();
        }
        setData((previous) => ({ ...previous, ...payload }));
        setNow(Date.now() + offsetRef.current);
    }, []);

    const load = useCallback(async () => {
        try {
            const { data: payload } = await api.get('/management/discovery/schedule');
            apply(payload);
        } catch (err) {
            setError(errorMessage(err, 'Could not read the schedule.'));
        }
    }, [apply]);

    useEffect(() => { load(); }, [load]);

    // One interval drives both the clock and the countdown.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now() + offsetRef.current), 1000);
        return () => clearInterval(id);
    }, []);

    const nextRunMs = data?.nextRunAt ? new Date(data.nextRunAt).getTime() : null;
    const remaining = nextRunMs === null ? null : nextRunMs - now;

    // The moment the cycle is due, pick up the run it just started. The server
    // needs a beat to create the row, hence the delay.
    useEffect(() => {
        if (remaining === null || remaining > 0) return undefined;
        if (firedForRef.current === nextRunMs) return undefined;

        firedForRef.current = nextRunMs;
        const id = setTimeout(() => {
            load();
            onCycleFired?.();
        }, 5000);
        return () => clearTimeout(id);
    }, [remaining, nextRunMs, load, onCycleFired]);

    const save = useCallback(async (patch) => {
        if (!canEdit) return;
        setSaving(true);
        setError('');
        try {
            const { data: payload } = await api.patch('/management/discovery/schedule', patch);
            firedForRef.current = null;
            apply(payload);
            setDraft(null);
        } catch (err) {
            setError(errorMessage(err, 'Could not save the discovery settings.'));
        } finally {
            setSaving(false);
        }
    }, [canEdit, apply]);

    if (!data) return null;

    const on = data.enabled;
    const live = on && data.schedulerAvailable;
    const clock = new Date(now);

    // Draft values while the admin is typing, falling back to what is saved.
    const d = draft ?? {};
    const cycleHours = d.cycleHours ?? data.cycleHours;
    const monthlyBudget = d.monthlyBudget ?? data.monthlyBudget;
    const datePosted = d.datePosted ?? data.datePosted;

    const leaseExpiryMinutes = d.leaseExpiryMinutes ?? data.leaseExpiryMinutes;
    const unpreparedExpiryHours = d.unpreparedExpiryHours ?? data.unpreparedExpiryHours;
    const reviewExpiryDays = d.reviewExpiryDays ?? data.reviewExpiryDays;
    const postingStaleDays = d.postingStaleDays ?? data.postingStaleDays;

    const edit = (patch) => setDraft({ ...d, ...patch });
    const FIELDS = ['cycleHours', 'monthlyBudget', 'datePosted', 'leaseExpiryMinutes',
        'unpreparedExpiryHours', 'reviewExpiryDays', 'postingStaleDays'];
    const pending = {
        cycleHours,
        monthlyBudget,
        datePosted,
        leaseExpiryMinutes,
        unpreparedExpiryHours,
        reviewExpiryDays,
        postingStaleDays,
    };
    const dirty = draft !== null && FIELDS.some((f) => pending[f] !== data[f]);

    // The consequence of the number being typed, shown as it is typed. A free
    // number box has no guard rail, so the cost has to be impossible to miss.
    const perDay = 24 / Math.max(1, cycleHours);
    const projected = Math.round(data.creditsPerRun * perDay * 30);
    const overBudget = monthlyBudget > 0 && projected > monthlyBudget;

    return (
        <div className={`mt-4 ${card} ${cardPad}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                        <Timer className="h-4 w-4 text-slate-400" />
                        Automatic cycle
                        <span className={`${badge} ${live ? TONE.success : TONE.neutral}`}>
                            {on ? 'On' : 'Off'}
                        </span>
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                        Runs discovery every {data.cycleHours} hour{data.cycleHours === 1 ? '' : 's'}
                        {' '}on its own &mdash; {data.runsPerDay} time{data.runsPerDay === 1 ? '' : 's'} a day
                        {' '}({data.timezone}). &ldquo;Run discovery now&rdquo; works either way.
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-600">{on ? 'On' : 'Off'}</span>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label="Automatic discovery cycle"
                        disabled={!canEdit || saving}
                        onClick={() => save({ enabled: !data.enabled })}
                        title={canEdit ? undefined : 'Only an organisation admin can change this'}
                        className={`${toggleTrack} ${on ? toggleTrackOn : toggleTrackOff}`}
                    >
                        <span className={`${toggleKnob} ${on ? toggleKnobOn : toggleKnobOff}`} />
                    </button>
                </div>
            </div>

            {error && (
                <p className={`mt-3 rounded-lg p-2 text-xs ${TONE_ALERT.danger}`}>{error}</p>
            )}

            {/* The switch is on but the process is not running the cron at all —
                without this the screen would look armed and never fire. */}
            {on && !data.schedulerAvailable && (
                <div className={`mt-3 flex items-start gap-2 rounded-lg p-3 text-sm ${TONE_ALERT.warning}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        Saved, but the scheduler is not running on the server, so nothing will
                        fire. Set <code className="rounded bg-white/60 px-1">DISCOVERY_ENABLED=true</code>
                        {' '}in the backend environment and restart it.
                    </span>
                </div>
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <div>
                    <p className={`flex items-center gap-1.5 ${readoutLabel}`}>
                        <Clock className="h-3.5 w-3.5" /> Current time
                    </p>
                    <p className={`mt-1 ${readoutLarge}`}>{clock.toLocaleTimeString()}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                        {clock.toLocaleDateString(undefined, {
                            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
                        })}
                    </p>
                </div>

                <div>
                    <p className={`flex items-center gap-1.5 ${readoutLabel}`}>
                        <Timer className="h-3.5 w-3.5" /> Next run in
                    </p>
                    {live && remaining !== null ? (
                        <>
                            <p className={`mt-1 ${readoutLarge}`}>{formatCountdown(remaining)}</p>
                            <p className="mt-0.5 text-xs text-slate-400">
                                {remaining <= 0 ? 'starting…' : 'hours : minutes : seconds'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="mt-1 text-2xl font-semibold text-slate-300">—</p>
                            <p className="mt-0.5 text-xs text-slate-400">
                                {on ? 'scheduler not running' : 'the cycle is switched off'}
                            </p>
                        </>
                    )}
                </div>

                <div>
                    <p className={`flex items-center gap-1.5 ${readoutLabel}`}>
                        <CalendarClock className="h-3.5 w-3.5" /> Scheduled for
                    </p>
                    {live && data.nextRunAt ? (
                        <>
                            <p className={`mt-1 text-lg ${readout}`}>
                                {new Date(data.nextRunAt).toLocaleTimeString()}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-400">
                                {new Date(data.nextRunAt).toLocaleDateString(undefined, {
                                    weekday: 'short', day: 'numeric', month: 'short',
                                })}
                            </p>
                        </>
                    ) : (
                        <p className="mt-1 text-lg text-slate-300">—</p>
                    )}
                    {data.lastScheduledRunAt && (
                        <p className="mt-1 text-xs text-slate-400">
                            Last automatic run {new Date(data.lastScheduledRunAt).toLocaleString()}
                        </p>
                    )}
                </div>
            </div>

            {/* ── settings ───────────────────────────────────────── */}
            <div className="mt-5 border-t border-slate-100 pt-4">
                <div className="grid gap-4 sm:grid-cols-3">
                    <div>
                        <label className={fieldLabel} htmlFor="cycleHours">
                            Run every (hours)
                        </label>
                        <input
                            id="cycleHours"
                            type="number"
                            min={data.minCycleHours}
                            max={data.maxCycleHours}
                            value={cycleHours}
                            disabled={!canEdit || saving}
                            onChange={(e) => edit({ cycleHours: Number(e.target.value) })}
                            className={input}
                        />
                        <p className="mt-1 text-xs text-slate-400">
                            {data.minCycleHours}&ndash;{data.maxCycleHours}.
                            {' '}{perDay % 1 === 0 ? perDay : perDay.toFixed(1)} run(s) per day.
                        </p>
                    </div>

                    <div>
                        <label className={fieldLabel} htmlFor="monthlyBudget">
                            Monthly search budget
                        </label>
                        <input
                            id="monthlyBudget"
                            type="number"
                            min={0}
                            value={monthlyBudget}
                            disabled={!canEdit || saving}
                            onChange={(e) => edit({ monthlyBudget: Number(e.target.value) })}
                            className={input}
                        />
                        <p className="mt-1 text-xs text-slate-400">
                            Credits. Used {data.creditsUsedThisMonth} ({data.percentUsed}%) this month.
                        </p>
                    </div>

                    <div>
                        <label className={fieldLabel} htmlFor="datePosted">
                            Only jobs posted in the
                        </label>
                        <select
                            id="datePosted"
                            value={datePosted}
                            disabled={!canEdit || saving}
                            onChange={(e) => edit({ datePosted: e.target.value })}
                            className={input}
                        >
                            {WINDOWS.map(([value, text]) => (
                                <option key={value} value={value}>{text}</option>
                            ))}
                        </select>
                        <p className="mt-1 text-xs text-slate-400">
                            The narrowest window the provider offers is a day.
                        </p>
                    </div>
                </div>

                {/* Housekeeping. Separate block because these are set once and
                    forgotten, unlike the three above. */}
                <details className="mt-4">
                    <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                        Housekeeping intervals
                    </summary>
                    <div className="mt-3 grid gap-4 sm:grid-cols-4">
                        {[
                            ['leaseExpiryMinutes', leaseExpiryMinutes, 'Lease expiry', 'minutes',
                                'How long the desktop app may hold a job before it is released.'],
                            ['unpreparedExpiryHours', unpreparedExpiryHours, 'Unprepared expiry', 'hours',
                                'A job that never finished preparing returns to the queue.'],
                            ['reviewExpiryDays', reviewExpiryDays, 'Review expiry', 'days',
                                'A filled application nobody reviewed releases its cap slot.'],
                            ['postingStaleDays', postingStaleDays, 'Posting ageing', 'days',
                                'A job not seen by any run for this long is treated as gone.'],
                        ].map(([key, value, text, unit, help]) => (
                            <div key={key}>
                                <label className={fieldLabel} htmlFor={key}>{text}</label>
                                <input
                                    id={key}
                                    type="number"
                                    min={1}
                                    value={value}
                                    disabled={!canEdit || saving}
                                    onChange={(e) => edit({ [key]: Number(e.target.value) })}
                                    className={input}
                                />
                                <p className="mt-1 text-xs text-slate-400">{unit} &middot; {help}</p>
                            </div>
                        ))}
                    </div>
                </details>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className={`flex items-center gap-1.5 text-xs ${
                        overBudget ? TONE_TEXT.danger : TONE_TEXT.warning}`}
                    >
                        {overBudget
                            ? <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                            : <Coins className="h-3.5 w-3.5 shrink-0" />}
                        <span>
                            At this interval, discovery costs up to
                            {' '}<strong>{projected.toLocaleString()} credits a month</strong>
                            {overBudget
                                ? ` — over the ${monthlyBudget.toLocaleString()} budget. Scheduled runs will stop early.`
                                : ` of the ${monthlyBudget.toLocaleString()} budgeted.`}
                        </span>
                    </p>

                    {canEdit && dirty && (
                        <button
                            type="button"
                            onClick={() => save(pending)}
                            disabled={saving}
                            className={btnSm.primary}
                        >
                            <Save className="h-3.5 w-3.5" />
                            Save settings
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SchedulePanel;
