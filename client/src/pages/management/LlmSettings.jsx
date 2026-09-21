import { useEffect, useState } from 'react';
import {
    CheckCircle2, XCircle, AlertCircle, Loader2, Save, RotateCcw, FlaskConical, KeyRound, Info,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import {
    card, cardPadRoomy, pageTitle, pageSubtitle, input, fieldLabel, fieldHint, btn, btnSm,
    badge, TONE, TONE_ALERT, alertShell, eyebrow, tabBar, tabNav, tabItem, tabActive, tabIdle,
} from '../../design/tokens.js';

/**
 * AI models — which model runs each AI task, and how. ORG_ADMIN only.
 *
 * Every field is an OVERRIDE: leave it on "Server default" and the organisation
 * gets whatever the server is configured with, exactly as before this screen
 * existed. Saving everything back to default removes the override entirely.
 *
 * API keys are not editable here, on purpose — the screen only shows whether the
 * server has one. Adding a provider is a one-time change to the server's
 * environment; choosing between providers that already have keys is what this
 * screen is for.
 */

const CUSTOM = '__custom__';
const BLANK = {
    provider: '', model: '', temperature: '', maxOutputTokens: '', timeoutSeconds: '',
    fallbackProvider: '', fallbackModel: '',
};

const toForm = (override) => (override ? {
    provider: override.provider ?? '',
    model: override.model ?? '',
    temperature: override.temperature ?? '',
    maxOutputTokens: override.maxOutputTokens ?? '',
    timeoutSeconds: override.timeoutSeconds ?? '',
    fallbackProvider: override.fallbackProvider ?? '',
    fallbackModel: override.fallbackModel ?? '',
} : { ...BLANK });

const same = (a, b) => Object.keys(BLANK).every((k) => String(a[k] ?? '') === String(b[k] ?? ''));

const money = (n) => `$${Number(n).toFixed(2)}`;

/** A model dropdown of everything priced for the provider, plus "another model". */
const ModelPicker = ({ provider, value, onChange, models, disabled, id }) => {
    const known = models.filter((m) => m.provider === provider);
    const isKnown = known.some((m) => m.model === value);
    const [custom, setCustom] = useState(Boolean(value) && !isKnown);

    // A different provider means a different list; a stale custom flag from the
    // last one would show a text box where a dropdown belongs.
    useEffect(() => { setCustom(Boolean(value) && !known.some((m) => m.model === value)); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [provider]);

    const selectValue = custom ? CUSTOM : (isKnown ? value : '');

    return (
        <div>
            <select
                id={id}
                className={input}
                disabled={disabled}
                value={selectValue}
                onChange={(e) => {
                    if (e.target.value === CUSTOM) { setCustom(true); onChange(''); return; }
                    setCustom(false);
                    onChange(e.target.value);
                }}
            >
                <option value="">{disabled ? '—' : 'Choose a model…'}</option>
                {known.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
                <option value={CUSTOM}>Another model (type its id)…</option>
            </select>
            {custom && !disabled && (
                <input
                    className={input}
                    placeholder="Exact model id, as the provider names it"
                    value={value}
                    maxLength={100}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
        </div>
    );
};

const priceLine = (models, provider, model) => {
    if (!provider || !model) return null;
    const m = models.find((x) => x.provider === provider && x.model === model);
    return m
        ? `${money(m.inPrice)} in · ${money(m.outPrice)} out per million tokens`
        : 'Price not in our table — its cost will be recorded as unknown, not zero.';
};

const TestResult = ({ result }) => {
    if (!result) return null;
    if (result.busy) {
        return (
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing…
            </p>
        );
    }
    return result.ok ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-success-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Works — answered in {(result.durationMs / 1000).toFixed(1)}s
            {result.costUsd != null && `, cost $${Number(result.costUsd).toFixed(5)}`}
        </p>
    ) : (
        <p className="flex items-start gap-1.5 text-xs font-medium text-danger-700">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {result.error}
        </p>
    );
};

const StageCard = ({ stage, providers, models, onSaved }) => {
    const initial = toForm(stage.override);
    const [form, setForm] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);       // { tone, text }
    const [tests, setTests] = useState({});     // primary | fallback → result

    // The server is the source of truth: after a save, or a reload, the form
    // follows what it now holds.
    useEffect(() => { setForm(toForm(stage.override)); }, [stage.override]);

    const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
    const dirty = !same(form, initial);
    const providerInfo = (name) => providers.find((p) => p.name === name);

    const runsOn = form.provider || stage.effective.provider;
    const tempMax = providerInfo(runsOn)?.maxTemperature ?? 2;

    const eff = stage.effective;
    const fbEff = eff.fallback;
    const label = (p) => providerInfo(p)?.label ?? p;

    const validate = () => {
        if (Boolean(form.provider) !== Boolean(form.model)) {
            return 'Choose a provider and a model together, or leave both on the server default.';
        }
        if (Boolean(form.fallbackProvider) !== Boolean(form.fallbackModel)) {
            return 'Choose a fallback provider and model together, or leave both on the default.';
        }
        if (form.temperature !== '' && (Number(form.temperature) < 0 || Number(form.temperature) > tempMax)) {
            return `Temperature must be between 0 and ${tempMax} for ${label(runsOn)}.`;
        }
        return null;
    };

    const num = (v) => (v === '' || v === null ? null : Number(v));

    const save = async () => {
        const problem = validate();
        if (problem) { setMsg({ tone: 'danger', text: problem }); return; }
        setBusy(true);
        setMsg(null);
        try {
            await api.put(`/management/llm-settings/${stage.stage}`, {
                provider: form.provider || null,
                model: form.model || null,
                temperature: num(form.temperature),
                maxOutputTokens: num(form.maxOutputTokens),
                timeoutSeconds: num(form.timeoutSeconds),
                fallbackProvider: form.fallbackProvider || null,
                fallbackModel: form.fallbackModel || null,
            });
            setMsg({ tone: 'success', text: 'Saved. The next AI call uses these settings.' });
            await onSaved();
        } catch (err) {
            setMsg({ tone: 'danger', text: errorMessage(err, 'Could not save.') });
        } finally {
            setBusy(false);
        }
    };

    const reset = async () => {
        if (!window.confirm(`Put "${stage.label}" back on the server defaults?`)) return;
        setBusy(true);
        setMsg(null);
        try {
            await api.delete(`/management/llm-settings/${stage.stage}`);
            setTests({});
            setMsg({ tone: 'success', text: 'Back on the server defaults.' });
            await onSaved();
        } catch (err) {
            setMsg({ tone: 'danger', text: errorMessage(err, 'Could not reset.') });
        } finally {
            setBusy(false);
        }
    };

    const test = async (which) => {
        const primary = which === 'primary';
        const provider = primary ? (form.provider || eff.provider)
            : (form.fallbackProvider || fbEff?.provider);
        const model = primary ? (form.model || eff.model) : (form.fallbackModel || fbEff?.model);
        if (!provider || !model) return;

        setTests((t) => ({ ...t, [which]: { busy: true } }));
        try {
            const { data } = await api.post(`/management/llm-settings/${stage.stage}/test`, {
                provider,
                model,
                // Temperature was chosen for the main model only.
                temperature: primary ? num(form.temperature) : null,
                timeoutSeconds: num(form.timeoutSeconds),
            });
            setTests((t) => ({ ...t, [which]: data }));
        } catch (err) {
            setTests((t) => ({ ...t, [which]: { ok: false, error: errorMessage(err, 'The test could not run.') } }));
        }
    };

    const primaryProvider = form.provider || eff.provider;
    const primaryNoKey = primaryProvider && providerInfo(primaryProvider) && !providerInfo(primaryProvider).keyConfigured;
    const fbProvider = form.fallbackProvider || fbEff?.provider;
    const fbNoKey = fbProvider && providerInfo(fbProvider) && !providerInfo(fbProvider).keyConfigured;

    const providerOptions = (defaultText) => (
        <>
            <option value="">{defaultText}</option>
            {providers.map((p) => (
                <option key={p.name} value={p.name}>
                    {p.label}{p.keyConfigured ? '' : ' — no key on server'}
                </option>
            ))}
        </>
    );

    return (
        <section className={`${card} ${cardPadRoomy}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 max-w-2xl">
                    <h2 className="text-base font-semibold text-slate-900">{stage.label}</h2>
                    <p className="mt-1 text-sm text-slate-500">{stage.description}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className={`${badge} ${stage.override ? TONE.brand : TONE.neutral}`}>
                        {stage.override ? 'Customised' : 'Server default'}
                    </span>
                    <span className={`${badge} ${stage.status.available ? TONE.success : TONE.danger}`}>
                        {stage.status.available
                            ? <CheckCircle2 className="h-3.5 w-3.5" />
                            : <XCircle className="h-3.5 w-3.5" />}
                        {stage.status.available ? 'Ready' : 'Not usable'}
                    </span>
                </div>
            </div>

            <dl className="mt-4 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                    <dt className="text-slate-500">Running now</dt>
                    <dd className="min-w-0 truncate font-medium text-slate-800">
                        {eff.provider ? `${label(eff.provider)} · ${eff.model}` : 'Switched off — no provider set'}
                    </dd>
                </div>
                <div className="flex gap-2">
                    <dt className="text-slate-500">Fallback</dt>
                    <dd className="min-w-0 truncate font-medium text-slate-800">
                        {fbEff ? `${label(fbEff.provider)} · ${fbEff.model}` : 'None'}
                    </dd>
                </div>
            </dl>

            {!stage.status.available && stage.status.reason && (
                <div className={`mt-3 ${alertShell} ${TONE_ALERT.warning}`}>
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {stage.status.reason}
                </div>
            )}

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {/* ── main model ─────────────────────────────────────── */}
                <div className="space-y-4">
                    <p className={eyebrow}>Main model</p>

                    <label className="block">
                        <span className={fieldLabel}>Provider</span>
                        <select
                            className={input}
                            value={form.provider}
                            onChange={(e) => { set('provider', e.target.value); set('model', ''); }}
                        >
                            {providerOptions(`Server default (${stage.defaults.provider ?? 'none'})`)}
                        </select>
                    </label>

                    <div>
                        <span className={fieldLabel}>Model</span>
                        <ModelPicker
                            provider={form.provider}
                            value={form.model}
                            onChange={(v) => set('model', v)}
                            models={models}
                            disabled={!form.provider}
                        />
                        <p className={fieldHint}>
                            {form.provider
                                ? priceLine(models, form.provider, form.model)
                                : `Using the server default: ${stage.defaults.model ?? 'none set'}.`}
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <label className="block">
                            <span className={fieldLabel}>Temperature</span>
                            <input
                                type="number" step="0.1" min="0" max={tempMax}
                                className={input}
                                placeholder="Default"
                                value={form.temperature}
                                onChange={(e) => set('temperature', e.target.value)}
                            />
                            <p className={fieldHint}>Suggested {stage.suggestedTemperature}. Max {tempMax}.</p>
                        </label>
                        <label className="block">
                            <span className={fieldLabel}>Timeout (seconds)</span>
                            <input
                                type="number" min="5" max="600"
                                className={input}
                                placeholder="120"
                                value={form.timeoutSeconds}
                                onChange={(e) => set('timeoutSeconds', e.target.value)}
                            />
                            <p className={fieldHint}>5 to 600.</p>
                        </label>
                    </div>

                    <label className="block">
                        <span className={fieldLabel}>Max output tokens</span>
                        <input
                            type="number" min="256" max="64000"
                            className={input}
                            placeholder={`${stage.defaultMaxTokens} (default)`}
                            value={form.maxOutputTokens}
                            onChange={(e) => set('maxOutputTokens', e.target.value)}
                        />
                        <p className={fieldHint}>
                            The longest answer allowed. Too low and answers get cut off, which counts as a failure.
                        </p>
                    </label>

                    {primaryNoKey && (
                        <p className="flex items-start gap-1.5 text-xs text-warning-700">
                            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {label(primaryProvider)} has no key on the server. Add {providerInfo(primaryProvider).keyEnv} to
                            the server's environment first.
                        </p>
                    )}

                    <div className="space-y-1.5">
                        <button
                            type="button"
                            className={btnSm.secondary}
                            onClick={() => test('primary')}
                            disabled={busy || !primaryProvider || !(form.model || eff.model)}
                        >
                            <FlaskConical className="h-3.5 w-3.5" /> Test main model
                        </button>
                        <TestResult result={tests.primary} />
                    </div>
                </div>

                {/* ── fallback ───────────────────────────────────────── */}
                <div className="space-y-4">
                    <p className={eyebrow}>Fallback — used if the main model fails</p>

                    <label className="block">
                        <span className={fieldLabel}>Provider</span>
                        <select
                            className={input}
                            value={form.fallbackProvider}
                            onChange={(e) => { set('fallbackProvider', e.target.value); set('fallbackModel', ''); }}
                        >
                            {providerOptions(
                                `Server default (${stage.defaults.fallback
                                    ? `${stage.defaults.fallback.provider}` : 'none'})`,
                            )}
                        </select>
                    </label>

                    <div>
                        <span className={fieldLabel}>Model</span>
                        <ModelPicker
                            provider={form.fallbackProvider}
                            value={form.fallbackModel}
                            onChange={(v) => set('fallbackModel', v)}
                            models={models}
                            disabled={!form.fallbackProvider}
                        />
                        <p className={fieldHint}>
                            {form.fallbackProvider
                                ? priceLine(models, form.fallbackProvider, form.fallbackModel)
                                : (stage.defaults.fallback
                                    ? `Using the server default: ${stage.defaults.fallback.model}.`
                                    : 'No fallback is set. If the main model fails, the job carries on untailored.')}
                        </p>
                    </div>

                    <div className="rounded-lg bg-surface-sunken p-3 text-xs text-slate-600">
                        <p className="flex items-start gap-1.5">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            The same request is sent once to the fallback on any failure — an outage, a timeout,
                            a missing key or an unusable answer. It runs on that model's own default temperature.
                        </p>
                    </div>

                    {fbNoKey && (
                        <p className="flex items-start gap-1.5 text-xs text-warning-700">
                            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            {label(fbProvider)} has no key on the server, so this fallback cannot run yet.
                        </p>
                    )}

                    <div className="space-y-1.5">
                        <button
                            type="button"
                            className={btnSm.secondary}
                            onClick={() => test('fallback')}
                            disabled={busy || !fbProvider || !(form.fallbackModel || fbEff?.model)}
                        >
                            <FlaskConical className="h-3.5 w-3.5" /> Test fallback
                        </button>
                        <TestResult result={tests.fallback} />
                    </div>
                </div>
            </div>

            {msg && (
                <div className={`mt-5 ${alertShell} ${TONE_ALERT[msg.tone]}`}>
                    {msg.tone === 'success'
                        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                        : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                    {msg.text}
                </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <button type="button" className={btn.primary} onClick={save} disabled={busy || !dirty}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                </button>
                {stage.override && (
                    <button type="button" className={btn.secondary} onClick={reset} disabled={busy}>
                        <RotateCcw className="h-4 w-4" /> Reset to server defaults
                    </button>
                )}
                {!dirty && !stage.override && (
                    <span className="text-xs text-slate-400">Nothing changed — running on the server defaults.</span>
                )}
            </div>
        </section>
    );
};

const LlmSettings = () => {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('parse');

    const load = async () => {
        try {
            const { data: d } = await api.get('/management/llm-settings');
            setData(d);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    if (error) return <p className="text-sm text-danger-600">{error}</p>;
    if (!data) return <PageLoader />;

    return (
        <div className="max-w-5xl">
            <h1 className={pageTitle}>AI models</h1>
            <p className={pageSubtitle}>
                Choose which model runs each AI task, and how. Anything left on “Server default” follows the
                server's own configuration. Changes apply to the next AI call — nothing to restart.
            </p>

            {/* ── which providers have keys ─────────────────────────── */}
            <div className={`mt-5 ${card} p-4`}>
                <p className={eyebrow}>Provider keys on the server</p>
                <div className="mt-2 flex flex-wrap gap-2">
                    {data.providers.map((p) => (
                        <span
                            key={p.name}
                            title={p.keyConfigured ? 'A key is set.' : `Add ${p.keyEnv} to the server's environment.`}
                            className={`${badge} ${p.keyConfigured ? TONE.success : TONE.neutral}`}
                        >
                            {p.keyConfigured ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                            {p.label}
                        </span>
                    ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">
                    Keys are never shown or entered here. To add a provider, set its key in the server's
                    environment once, then choose it below.
                </p>
            </div>

            {/* ── one tab per AI task ───────────────────────────────── */}
            <div className={`mt-6 ${tabBar}`}>
                <nav className={tabNav} aria-label="AI tasks">
                    {data.stages.map((s) => (
                        <button
                            key={s.stage}
                            type="button"
                            onClick={() => setTab(s.stage)}
                            aria-current={tab === s.stage ? 'page' : undefined}
                            className={`${tabItem} ${tab === s.stage ? tabActive : tabIdle}`}
                        >
                            {s.label}
                            {/* Two small signals, so a tab you are not on can still
                                tell you something needs attention. */}
                            {!s.status.available && (
                                <AlertCircle className="h-3.5 w-3.5 text-warning-500" aria-label="Not usable" />
                            )}
                            {s.override && s.status.available && (
                                <span
                                    className="h-1.5 w-1.5 rounded-full bg-brand-500"
                                    title="Customised for this organisation"
                                />
                            )}
                        </button>
                    ))}
                </nav>
            </div>

            {/* Every tab stays mounted and the inactive ones are only hidden, so
                switching tabs never throws away an unsaved edit or a test result. */}
            <div className="mt-6">
                {data.stages.map((stage) => (
                    <div key={stage.stage} className={tab === stage.stage ? '' : 'hidden'}>
                        <StageCard
                            stage={stage}
                            providers={data.providers}
                            models={data.models}
                            onSaved={load}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
};

export default LlmSettings;
