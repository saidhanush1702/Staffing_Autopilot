import { useEffect, useState } from 'react';
import {
    Coins, Sparkles, Database, ShieldAlert, AlertCircle, MinusCircle, Gauge,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import { SKIP_REASONS } from '../../components/queue/TailoringBadge.jsx';
import {
    card, cardPad, badge, eyebrow, sectionTitle, pageTitle, pageSubtitle,
    alertShell, TONE, TONE_ALERT,
} from '../../design/tokens.js';

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
    const [error, setError] = useState('');

    useEffect(() => {
        (async () => {
            try {
                const [a, c] = await Promise.all([
                    api.get('/management/ai-usage'),
                    api.get('/management/contacts/usage'),
                ]);
                setAi(a.data);
                setContacts(c.data);
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

    if (!ai || !contacts) return <PageLoader />;

    const overBudget = ai.budget.budget > 0 && ai.budget.exhausted;

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
