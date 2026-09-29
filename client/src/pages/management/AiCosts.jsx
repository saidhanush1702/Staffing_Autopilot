import { useEffect, useState } from 'react';
import {
    Coins, Sparkles, Database, ShieldAlert, AlertCircle, MinusCircle, Gauge, Bot, Hand,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import { SKIP_REASONS } from '../../components/queue/TailoringBadge.jsx';
import {
    card, cardPad, badge, eyebrow, sectionTitle, pageTitle, pageSubtitle,
    alertShell, TONE, TONE_ALERT, input, fieldLabel, btn,
} from '../../design/tokens.js';

/**
 * ── THE AI AGENT'S SWITCH ─────────────────────────────────────────────
 *
 * Three positions, because trusting an agent is a process rather than a
 * decision. SHADOW lets it decide on real jobs without typing anything, so an
 * owner can read what it WOULD have done before letting it do it.
 */
const AGENT_MODES = [
    ['OFF', 'Off', 'Jobs the automation cannot fill go straight to consultants.'],
    ['SHADOW', 'Shadow', 'The agent looks at those jobs and records what it would do, but types nothing. Use this first.'],
    ['ON', 'On', 'The agent fills those forms from approved answers and profiles, then stops for the consultant.'],
];

const AgentSettings = ({ settings, onSaved }) => {
    const [mode, setMode] = useState(settings.mode);
    const [cap, setCap] = useState(String(settings.jobCapUsd));
    const [calls, setCalls] = useState(String(settings.maxModelCalls));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    const changed = mode !== settings.mode
        || Number(cap) !== Number(settings.jobCapUsd)
        || Number(calls) !== Number(settings.maxModelCalls);

    const save = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const { data } = await api.put('/management/ai-agent', {
                mode, jobCapUsd: Number(cap), maxModelCalls: Number(calls),
            });
            onSaved(data);
            setMessage({ tone: 'success', text: 'Saved.' });
        } catch (err) {
            setMessage({ tone: 'danger', text: errorMessage(err) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={`mt-3 ${card} ${cardPad}`}>
            <p className={eyebrow}>When the automation cannot fill a job</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI agent mode">
                {AGENT_MODES.map(([value, label, hint]) => (
                    <label
                        key={value}
                        className={`cursor-pointer rounded-lg border p-3 text-sm ${
                            mode === value ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}
                    >
                        <span className="flex items-center gap-2 font-medium text-slate-800">
                            <input
                                type="radio"
                                name="agent-mode"
                                value={value}
                                checked={mode === value}
                                onChange={() => setMode(value)}
                            />
                            {label}
                        </span>
                        <span className="mt-1 block text-xs text-slate-500">{hint}</span>
                    </label>
                ))}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                    <label htmlFor="agent-cap" className={fieldLabel}>Most it may spend on one job (USD)</label>
                    <input
                        id="agent-cap"
                        type="number"
                        min="0.01"
                        max="10"
                        step="0.05"
                        className={input}
                        value={cap}
                        onChange={(e) => setCap(e.target.value)}
                    />
                </div>
                <div>
                    <label htmlFor="agent-calls" className={fieldLabel}>Most model calls on one job</label>
                    <input
                        id="agent-calls"
                        type="number"
                        min="3"
                        max="100"
                        step="1"
                        className={input}
                        value={calls}
                        onChange={(e) => setCalls(e.target.value)}
                    />
                </div>
            </div>

            {!settings.available && (
                <p className="mt-3 text-xs text-slate-500">
                    {settings.unavailableReason} Until a model is configured the agent
                    cannot run, whichever mode is chosen.
                </p>
            )}

            <div className="mt-4 flex items-center gap-3">
                <button
                    type="button"
                    className={btn.primary}
                    disabled={!changed || busy}
                    onClick={save}
                >
                    {busy ? 'Saving…' : 'Save'}
                </button>
                {message && (
                    <span className={`text-sm ${message.tone === 'danger' ? 'text-danger-600' : 'text-success-600'}`}>
                        {message.text}
                    </span>
                )}
            </div>
        </div>
    );
};

/**
 * ── WHAT LAST MONTH COST, AND WHY ─────────────────────────────────────
 *
 * One screen for both paid features: the model calls that tailor resumes, and
 * the provider calls that find hiring contacts.
 *
 * ── WHY THESE FIGURES AND NOT A GRAPH OF SPEND ────────────────────────
 *
 * A spend line answers "how much" and nothing else. The three numbers beside it
 * are the ones that say whether the money is being spent WELL, and each has a
 * specific failure it exists to expose:
 *
 *   cache hit rate    The tailoring prompt puts the base resume and the locked
 *                     rules in a cached prefix reused across every job for one
 *                     consultant. If something volatile leaks in, caching stops
 *                     and the bill roughly triples with no other symptom. This
 *                     falling toward zero IS that bug.
 *
 *   flag rate         The share of tailored resumes the checker stopped. It
 *                     measures the prompt, not the reviewers. Persistently high
 *                     means the rules need tightening, not more review capacity.
 *
 *   store hit rate    The share of contact lookups answered for free from the
 *                     90-day store. It should climb as a bench settles onto a
 *                     set of employers; stuck near zero means de-duplication is
 *                     not working and every application is buying a contact.
 *
 * ── AND WHY THE SKIP REASONS ARE BROKEN OUT ───────────────────────────
 *
 * Every skip is an application that went out with the base resume. There are
 * four causes and they need four different responses — top up the budget, chase
 * a re-upload, ask for a PDF instead of a .doc, or read the logs. A single
 * "not tailored" total would hide which one is actually happening.
 */
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const pct = (n) => (n === null || n === undefined ? '—' : `${n}%`);

const AiCosts = () => {
    const [ai, setAi] = useState(null);
    const [contacts, setContacts] = useState(null);
    const [agentSettings, setAgentSettings] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        (async () => {
            try {
                const [a, c, g] = await Promise.all([
                    api.get('/management/ai-usage'),
                    api.get('/management/contacts/usage'),
                    api.get('/management/ai-agent'),
                ]);
                setAi(a.data);
                setContacts(c.data);
                setAgentSettings(g.data);
            } catch (err) {
                setError(errorMessage(err));
            }
        })();
    }, []);

    if (error) {
        return (
            <div className="mx-auto max-w-5xl">
                <h1 className={pageTitle}>Running costs</h1>
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            </div>
        );
    }

    if (!ai || !contacts || !agentSettings) return <PageLoader />;

    const overBudget = ai.budget.budget > 0 && ai.budget.exhausted;
    const agent = ai.agent ?? { runs: 0, filled: 0, shadow: 0, cost: 0, avgCost: 0, outcomes: {}, hosts: [] };
    const handedOver = Math.max(0, agent.runs - agent.filled - agent.shadow
        - (agent.outcomes.CLOSED ?? 0) - (agent.outcomes.ALREADY_APPLIED ?? 0)
        - (agent.outcomes.RUNNING ?? 0));

    return (
        <div className="mx-auto max-w-5xl">
            <h1 className={pageTitle}>Running costs</h1>
            <p className={pageSubtitle}>
                What resume tailoring and contact discovery have cost this month,
                and whether the savings they depend on are working.
            </p>

            {overBudget && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.warning}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                        This month&rsquo;s AI budget is used up. Applications are still going
                        out — each one carries the consultant&rsquo;s base resume and is
                        marked <strong>Not tailored</strong> until the budget resets.
                    </span>
                </div>
            )}

            {/* ── the money ────────────────────────────────────────── */}
            <h2 className={`mt-6 ${sectionTitle}`}>Resume tailoring</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    icon={Coins}
                    label="AI spend this month"
                    value={money(ai.month.cost)}
                    hint={ai.budget.budget > 0
                        ? `of ${money(ai.budget.budget)} · ${money(ai.budget.remaining)} left`
                        : 'no ceiling set'}
                    tone={overBudget ? 'danger' : 'brand'}
                />
                <StatCard
                    icon={Gauge}
                    label="Prompt cache hit rate"
                    value={pct(ai.month.cacheHitRate)}
                    hint="a fall toward 0% means caching has broken"
                    tone={ai.month.cacheHitRate !== null && ai.month.cacheHitRate < 30
                        ? 'warning' : 'success'}
                />
                <StatCard
                    icon={ShieldAlert}
                    label="Flag rate"
                    value={pct(ai.month.flagRate)}
                    hint="above ~10%, tighten the rules"
                    tone={ai.month.flagRate !== null && ai.month.flagRate > 10
                        ? 'warning' : 'success'}
                />
                <StatCard
                    icon={Sparkles}
                    label="Tailored"
                    value={ai.queue.tailored}
                    hint={`${ai.queue.notTailored} went out untailored`}
                    tone="success"
                />
            </div>

            {ai.budget.unpriced > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                    {/*
                        A model the pricing table does not know counts as $0
                        against the budget. Left unsaid, the ceiling would
                        silently never fire.
                    */}
                    {ai.budget.unpriced} run{ai.budget.unpriced === 1 ? '' : 's'} used a model with
                    no published price, so the figure above understates the real spend.
                </p>
            )}

            {/* ── where it went ────────────────────────────────────── */}
            {ai.month.byStage.length > 0 && (
                <div className={`mt-4 ${card} ${cardPad}`}>
                    <p className={eyebrow}>By stage, this month</p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[34rem] text-sm">
                            <thead>
                                <tr className="text-left text-xs text-slate-400">
                                    <th className="pb-2 font-medium">Stage</th>
                                    <th className="pb-2 text-right font-medium">Runs</th>
                                    <th className="pb-2 text-right font-medium">In</th>
                                    <th className="pb-2 text-right font-medium">Cached</th>
                                    <th className="pb-2 text-right font-medium">Out</th>
                                    <th className="pb-2 text-right font-medium">Cost</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line-soft">
                                {ai.month.byStage.map((s) => (
                                    <tr key={s.stage}>
                                        <td className="py-2 text-slate-700">{s.stage}</td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">{s.runs}</td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">
                                            {Number(s.input_tokens).toLocaleString()}
                                        </td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">
                                            {Number(s.cache_read_tokens).toLocaleString()}
                                        </td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">
                                            {Number(s.output_tokens).toLocaleString()}
                                        </td>
                                        <td className="py-2 text-right tabular-nums text-slate-800">
                                            {money(s.cost)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── the skips ────────────────────────────────────────── */}
            {ai.queue.notTailored > 0 && (
                <div className={`mt-4 ${card} ${cardPad}`}>
                    <p className={`${eyebrow} flex items-center gap-1.5`}>
                        <MinusCircle className="h-3.5 w-3.5" />
                        Why {ai.queue.notTailored} application
                        {ai.queue.notTailored === 1 ? '' : 's'} went out untailored
                    </p>
                    <ul className="mt-3 space-y-2">
                        {Object.entries(ai.queue.skips)
                            .sort((a, b) => b[1] - a[1])
                            .map(([key, n]) => (
                                <li key={key} className="flex items-center justify-between gap-3 text-sm">
                                    <span className="text-slate-700">
                                        {SKIP_REASONS[key] ?? key.toLowerCase().replace(/_/g, ' ')}
                                    </span>
                                    <span className={`${badge} ${
                                        key === 'BUDGET_EXHAUSTED' ? TONE.warning : TONE.neutral}`}>
                                        {n}
                                    </span>
                                </li>
                            ))}
                    </ul>
                </div>
            )}

            {/* ── the AI agent ─────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>AI agent</h2>
            <p className="mt-1 text-sm text-slate-500">
                Fills an application when a site has no coded automation, or its automation
                breaks. It only ever uses a consultant&rsquo;s profile and approved answers,
                and it shares the monthly AI budget above.
            </p>

            <AgentSettings settings={agentSettings} onSaved={setAgentSettings} />

            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    icon={Bot}
                    label="Jobs the agent took this month"
                    value={agent.runs}
                    hint={agent.shadow > 0 ? `${agent.shadow} in shadow mode` : 'recipes could not finish these'}
                />
                <StatCard
                    icon={Sparkles}
                    label="Filled by the agent"
                    value={agent.filled}
                    hint={agent.runs > 0 ? `${Math.round((agent.filled / agent.runs) * 100)}% of the jobs it took` : '—'}
                    tone="success"
                />
                <StatCard
                    icon={Hand}
                    label="Handed to consultants"
                    value={handedOver}
                    hint="a sign-in, a new question, or a page it could not get past"
                    tone={handedOver > agent.filled ? 'warning' : 'neutral'}
                />
                <StatCard
                    icon={Coins}
                    label="Average cost per job"
                    value={money(agent.avgCost)}
                    hint={`${money(agent.cost)} this month`}
                    tone="brand"
                />
            </div>

            {agent.hosts.length > 0 && (
                <div className={`mt-4 ${card} ${cardPad}`}>
                    <p className={eyebrow}>Sites the agent works most — the next recipes worth coding</p>
                    <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[28rem] text-sm">
                            <thead>
                                <tr className="text-left text-xs text-slate-400">
                                    <th className="pb-2 font-medium">Site</th>
                                    <th className="pb-2 text-right font-medium">Jobs</th>
                                    <th className="pb-2 text-right font-medium">Filled</th>
                                    <th className="pb-2 text-right font-medium">Cost</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line-soft">
                                {agent.hosts.map((h) => (
                                    <tr key={h.host}>
                                        <td className="py-2 text-slate-700">{h.host}</td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">{h.runs}</td>
                                        <td className="py-2 text-right tabular-nums text-slate-600">{h.filled}</td>
                                        <td className="py-2 text-right tabular-nums text-slate-800">{money(h.cost)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── contacts ─────────────────────────────────────────── */}
            <h2 className={`mt-8 ${sectionTitle}`}>Contact discovery</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                    icon={Coins}
                    label="Credits used this month"
                    value={contacts.provider.used}
                    hint={contacts.provider.budget
                        ? `of ${contacts.provider.budget} · ${contacts.provider.remaining} left`
                        : 'no ceiling set'}
                    tone={contacts.provider.remaining === 0 ? 'danger' : 'brand'}
                />
                <StatCard
                    icon={Database}
                    label="Answered from the store"
                    value={`${contacts.month.storeHitRate}%`}
                    hint={`${contacts.month.store_hits} of ${contacts.month.lookups} lookups`}
                    tone="success"
                />
                <StatCard
                    icon={Sparkles}
                    label="People on file"
                    value={contacts.store.contacts}
                    hint="reused for 90 days before paying again"
                />
                <StatCard
                    icon={AlertCircle}
                    label="Failed lookups"
                    value={contacts.month.failures}
                    hint="provider errors and refusals this month"
                    tone={contacts.month.failures > 0 ? 'warning' : 'neutral'}
                />
            </div>

            {!contacts.provider.configured && (
                <p className="mt-3 text-xs text-slate-500">
                    No Apollo key is set in the environment, so no contact lookups can run.
                </p>
            )}
        </div>
    );
};

export default AiCosts;
