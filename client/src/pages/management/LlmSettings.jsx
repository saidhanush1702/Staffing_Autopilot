import { useEffect, useState } from 'react';
import {
    CheckCircle2, XCircle, AlertCircle, Loader2, Save, RotateCcw, FlaskConical, KeyRound, Info,
    ChevronDown, ChevronRight, Trash2,
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

/**
 * One provider's own credential — API key and base URL — for this organisation.
 *
 * Reused across every AI task set to this provider; there is no per-task key.
 * The key field is always blank on load: a saved key is never sent back to the
 * browser, so "blank" here means "keep what's already saved", not "there is none".
 */
const ProviderCredentialsRow = ({ info, models, onSaved }) => {
    const [open, setOpen] = useState(false);
    const [apiKey, setApiKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(info.baseUrl ?? '');
    const [testModel, setTestModel] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const [testResult, setTestResult] = useState(null);

    useEffect(() => { setBaseUrl(info.baseUrl ?? ''); }, [info.baseUrl]);

    const known = models.filter((m) => m.provider === info.name);
    const baseUrlChanged = baseUrl !== (info.baseUrl ?? '');

    const save = async () => {
        setBusy(true);
        setMsg(null);
        try {
            await api.put(`/management/llm-providers/${info.name}`, {
                apiKey: apiKey || null,
                baseUrl: baseUrl || null,
            });
            setApiKey('');
            setMsg({ tone: 'success', text: 'Saved. Tasks set to this provider use it on the next AI call.' });
            await onSaved();
        } catch (err) {
            setMsg({ tone: 'danger', text: errorMessage(err, 'Could not save.') });
        } finally {
            setBusy(false);
        }
    };

    const clear = async () => {
        if (!window.confirm(`Remove the organisation's ${info.label} key? Tasks set to it fall back to the server's own key, if it has one.`)) return;
        setBusy(true);
        setMsg(null);
        try {
            await api.delete(`/management/llm-providers/${info.name}`);
            setApiKey('');
            setBaseUrl('');
            setTestResult(null);
            setMsg({ tone: 'success', text: 'Removed.' });
            await onSaved();
        } catch (err) {
            setMsg({ tone: 'danger', text: errorMessage(err, 'Could not remove.') });
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (!apiKey || !testModel) return;
        setTestResult({ busy: true });
        try {
            const { data } = await api.post(`/management/llm-providers/${info.name}/test`, {
                apiKey, baseUrl: baseUrl || null, model: testModel,
            });
            setTestResult(data);
        } catch (err) {
            setTestResult({ ok: false, error: errorMessage(err, 'The test could not run.') });
        }
    };

    return (
        <div className="rounded-lg border border-line">
            <button
                type="button"
                className="flex w-full items-center justify-between gap-3 p-3 text-left"
                onClick={() => setOpen((v) => !v)}
            >
                <span className="flex items-center gap-2">
                    {open ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
                    <span className="font-medium text-slate-800">{info.label}</span>
                </span>
                <span className="flex items-center gap-2">
                    <span className={`${badge} ${info.orgKeyConfigured ? TONE.brand : TONE.neutral}`}>
                        {info.orgKeyConfigured ? 'Organisation key' : 'Using server key'}
                    </span>
                    <span className={`${badge} ${info.serverKeyConfigured ? TONE.success : TONE.neutral}`}>
                        {info.serverKeyConfigured
                            ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                        Server {info.serverKeyConfigured ? 'ready' : 'not set'}
                    </span>
                </span>
            </button>

            {open && (
                <div className="space-y-4 border-t border-line p-3">
                    <label className="block">
                        <span className={fieldLabel}>API key</span>
                        <input
                            type="password"
                            className={input}
                            placeholder={info.orgKeyConfigured ? 'Saved — leave blank to keep it' : 'Not set — paste a key to enable'}
                            value={apiKey}
                            maxLength={500}
                            autoComplete="off"
                            onChange={(e) => setApiKey(e.target.value)}
                        />
                        <p className={fieldHint}>
                            Stored encrypted and never shown again. Leave blank to keep the saved key and change
                            only the base URL.
                        </p>
                    </label>

                    <label className="block">
                        <span className={fieldLabel}>Base URL (optional)</span>
                        <input
                            className={input}
                            placeholder={info.defaultBaseUrl ?? "Provider's own API"}
                            value={baseUrl}
                            maxLength={300}
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                        <p className={fieldHint}>
                            {info.defaultBaseUrl
                                ? `For a self-hosted or compatible endpoint. Left blank, ${info.label} calls go to ${info.defaultBaseUrl}.`
                                : "For a self-hosted or compatible endpoint. Leave blank to use the provider's own API."}
                        </p>
                    </label>

                    {known.length > 0 && (
                        <label className="block">
                            <span className={fieldLabel}>Model to test with</span>
                            <select className={input} value={testModel} onChange={(e) => setTestModel(e.target.value)}>
                                <option value="">Choose a model…</option>
                                {known.map((m) => <option key={m.model} value={m.model}>{m.model}</option>)}
                            </select>
                        </label>
                    )}

                    {msg && (
                        <div className={`${alertShell} ${TONE_ALERT[msg.tone]}`}>
                            {msg.tone === 'success'
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                                : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
                            {msg.text}
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            className={btn.primary}
                            onClick={save}
                            disabled={busy || (!apiKey && !baseUrlChanged)}
                        >
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
                        </button>
                        <button
                            type="button"
                            className={btnSm.secondary}
                            onClick={test}
                            disabled={busy || !apiKey || !testModel}
                        >
                            <FlaskConical className="h-3.5 w-3.5" /> Test this key
                        </button>
                        {info.orgKeyConfigured && (
                            <button type="button" className={btn.secondary} onClick={clear} disabled={busy}>
                                <Trash2 className="h-4 w-4" /> Remove
                            </button>
                        )}
                    </div>
                    <TestResult result={testResult} />
                </div>
            )}
        </div>
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
                    {p.label}{p.keyConfigured ? '' : ' — no key configured'}
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
                            {label(primaryProvider)} has no key yet — add one in Provider credentials above, or
                            set {providerInfo(primaryProvider).keyEnv} on the server.
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
                            {label(fbProvider)} has no key yet, so this fallback cannot run until one is added in
                            Provider credentials above or on the server.
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
    const [providersData, setProvidersData] = useState(null);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('parse');

    const load = async () => {
        try {
            const [{ data: d }, { data: p }] = await Promise.all([
                api.get('/management/llm-settings'),
                api.get('/management/llm-providers'),
            ]);
            setData(d);
            setProvidersData(p);
        } catch (err) {
            setError(errorMessage(err));
        }
    };

    useEffect(() => { load(); }, []);

    if (error) return <p className="text-sm text-danger-600">{error}</p>;
    if (!data || !providersData) return <PageLoader />;

    return (
        <div className="max-w-5xl">
            <h1 className={pageTitle}>AI models</h1>
            <p className={pageSubtitle}>
                Choose which model runs each AI task, and how. Anything left on “Server default” follows the
                server's own configuration. Changes apply to the next AI call — nothing to restart.
            </p>

            {/* ── this organisation's own provider keys ─────────────── */}
            <div className={`mt-5 ${card} p-4`}>
                <p className={eyebrow}>Provider credentials</p>
                <p className="mt-1 text-xs text-slate-500">
                    Add your own API key for a provider and every AI task set to use it runs on that key instead
                    of the platform's. Leave a provider alone and its tasks keep running on the server's key, if
                    it has one — expand a provider below to see which applies.
                </p>
                <div className="mt-3 space-y-2">
                    {providersData.providers.map((p) => (
                        <ProviderCredentialsRow key={p.name} info={p} models={data.models} onSaved={load} />
                    ))}
                </div>
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
