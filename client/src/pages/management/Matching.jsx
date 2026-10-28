import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users, Lightbulb } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Alert from '../../components/ui/Alert.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, cardHeader, pageTitle, pageSubtitle, sectionTitle, sectionSubtitle, btn, btnSm,
    tabBar, tabNav, tabItem, tabActive, tabIdle, proseMuted, badge,
} from '../../design/tokens.js';

const TABS = [
    { key: 'bench', label: 'Who can receive jobs', icon: Users },
    { key: 'suggestions', label: 'Suggested matches', icon: Lightbulb },
];

/** Why a consultant is, or is not, on the bench — in the words the API sends. */
const STATE_LABEL = {
    MATCHABLE: 'Receiving jobs',
    NOT_SET_UP: 'No search criteria',
    CRITERIA_PAUSED: 'Criteria switched off',
    PROFILE_PAUSED: 'Paused',
    NOTHING_TO_LOOK_FOR: 'Criteria too thin',
    NOT_ACTIVE: 'Not active',
};
const STATE_CLASS = {
    MATCHABLE: 'bg-success-50 text-success-700',
    NOT_SET_UP: 'bg-danger-50 text-danger-700',
    CRITERIA_PAUSED: 'bg-warning-50 text-warning-700',
    PROFILE_PAUSED: 'bg-warning-50 text-warning-700',
    NOTHING_TO_LOOK_FOR: 'bg-warning-50 text-warning-700',
    NOT_ACTIVE: 'bg-slate-100 text-slate-600',
};

/**
 * Matching — who can receive jobs, and what the matcher was unsure about.
 *
 * ── TWO QUESTIONS, ONE SCREEN ─────────────────────────────────────────
 *
 * A quiet queue has two possible causes and they need different fixes. Either
 * nobody is on the bench to receive jobs (most consultants had no criteria at
 * all), or the jobs are arriving and the matcher is not sure about them. The
 * first tab answers the first; the second hands the second to a person.
 */
const Matching = () => {
    const { user } = useAuth();
    const [params, setParams] = useSearchParams();
    const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'bench';

    const [bench, setBench] = useState(null);
    const [suggestions, setSuggestions] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [busy, setBusy] = useState('');

    const load = useCallback(async () => {
        try {
            const [b, s] = await Promise.all([
                api.get('/management/matching/bench'),
                api.get('/management/matching/suggestions'),
            ]);
            setBench(b.data);
            setSuggestions(s.data);
            setError('');
        } catch (err) {
            setError(errorMessage(err));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const act = async (key, fn, done) => {
        setBusy(key);
        setNotice('');
        try {
            const out = await fn();
            setNotice(typeof done === 'function' ? done(out) : done);
            await load();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy('');
        }
    };

    const draftAll = (activate) => act(
        activate ? 'draft-on' : 'draft',
        () => api.post('/management/criteria/bootstrap', { activate }).then((r) => r.data),
        (d) => `${d.drafted + d.activated} consultant(s) given criteria from their profile `
            + `(${d.activated} switched on); ${d.skipped} skipped.`,
    );

    if (!bench || !suggestions) {
        return error ? <Alert tone="danger">{error}</Alert> : <PageLoader />;
    }

    const notSetUp = bench.summary.NOT_SET_UP ?? 0;
    const isAdmin = user?.role === 'ORG_ADMIN';

    return (
        <div className="space-y-5">
            <div>
                <h1 className={pageTitle}>Matching</h1>
                <p className={pageSubtitle}>
                    {bench.matchable} of {bench.total} consultants can receive jobs right now.
                </p>
            </div>

            {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
            {notice && <Alert tone="success" onDismiss={() => setNotice('')}>{notice}</Alert>}

            <div className={tabBar}>
                <nav className={tabNav}>
                    {TABS.map(({ key, label, icon: Icon }) => (
                        <button
                            key={key}
                            type="button"
                            className={`${tabItem} ${tab === key ? tabActive : tabIdle}`}
                            onClick={() => setParams({ tab: key })}
                        >
                            <Icon className="h-4 w-4" /> {label}
                            {key === 'suggestions' && suggestions.total > 0 && (
                                <span className={`${badge} bg-brand-50 text-brand-700`}>{suggestions.total}</span>
                            )}
                        </button>
                    ))}
                </nav>
            </div>

            {tab === 'bench' && (
                <section className={card}>
                    <div className={cardHeader}>
                        <div>
                            <h2 className={sectionTitle}>Consultants</h2>
                            <p className={sectionSubtitle}>
                                A consultant with no active search criteria is never matched to anything.
                            </p>
                        </div>
                        {notSetUp > 0 && (
                            <div className="flex gap-2">
                                <button type="button" className={btn.secondary} disabled={busy !== ''}
                                    onClick={() => draftAll(false)}>
                                    {busy === 'draft' ? 'Drafting…' : `Draft criteria for ${notSetUp}`}
                                </button>
                                {isAdmin && (
                                    <button type="button" className={btn.primary} disabled={busy !== ''}
                                        onClick={() => draftAll(true)}>
                                        {busy === 'draft-on' ? 'Working…' : 'Draft and switch on'}
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                            <thead className="text-2xs uppercase tracking-wider text-slate-400">
                                <tr>
                                    <th className="px-5 py-2">Consultant</th>
                                    <th className="px-5 py-2">Status</th>
                                    <th className="px-5 py-2">What to do</th>
                                    <th className="px-5 py-2 text-right">Jobs queued</th>
                                    <th className="px-5 py-2" />
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-line-soft">
                                {bench.consultants.map((c) => (
                                    <tr key={c.id}>
                                        <td className="px-5 py-2.5 font-medium text-slate-800">{c.name}</td>
                                        <td className="px-5 py-2.5">
                                            <span className={`${badge} ${STATE_CLASS[c.state] ?? ''}`}>
                                                {STATE_LABEL[c.state] ?? c.state}
                                            </span>
                                        </td>
                                        <td className="px-5 py-2.5 text-slate-500">{c.fix ?? '—'}</td>
                                        <td className="px-5 py-2.5 text-right font-mono tabular-nums">{c.queueItems}</td>
                                        <td className="px-5 py-2.5 text-right">
                                            {c.state === 'MATCHABLE' && (
                                                <button type="button" className={btnSm.subtle} disabled={busy !== ''}
                                                    onClick={() => act(`re-${c.id}`,
                                                        () => api.post(`/management/consultants/${c.id}/criteria/rematch`).then((r) => r.data),
                                                        (d) => `${c.name}: checked ${d.considered} recent jobs — ${d.linked} queued, ${d.suggested} suggested.`)}>
                                                    {busy === `re-${c.id}` ? 'Checking…' : 'Check recent jobs'}
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}

            {tab === 'suggestions' && (
                <section className="space-y-3">
                    <p className={proseMuted}>
                        Jobs the matcher thinks could fit but is not sure enough to queue on its own. Link one to
                        put it in a consultant&rsquo;s list; mark it not a fit and it will not be suggested to them again.
                    </p>
                    {suggestions.suggestions.length === 0 && (
                        <div className={`${card} ${cardPad} text-sm text-slate-500`}>
                            Nothing to review. Suggestions appear once an organisation is switched to the new matcher.
                        </div>
                    )}
                    {suggestions.suggestions.map((s) => (
                        <div key={s.postingId} className={`${card} ${cardPad}`}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <p className="font-medium text-slate-900">{s.title}</p>
                                    <p className="text-sm text-slate-500">
                                        {s.company}{s.location ? ` · ${s.location}` : ''}{s.remote ? ' · remote' : ''}
                                    </p>
                                </div>
                                {s.url && (
                                    <a className={btnSm.subtle} href={s.url} target="_blank" rel="noreferrer">Open posting</a>
                                )}
                            </div>
                            <ul className="mt-3 divide-y divide-line-soft">
                                {s.candidates.map((c) => (
                                    <li key={c.matchId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-slate-800">
                                                {c.consultantName} <span className="font-mono text-xs text-slate-400">· {c.score}</span>
                                            </p>
                                            <p className="text-xs text-slate-500">{c.reason}</p>
                                        </div>
                                        <div className="flex gap-2">
                                            <button type="button" className={btnSm.primary} disabled={busy !== ''}
                                                onClick={() => act(`a-${c.matchId}`,
                                                    () => api.post(`/management/matching/suggestions/${c.matchId}/accept`),
                                                    `Linked to ${c.consultantName}.`)}>
                                                Link
                                            </button>
                                            <button type="button" className={btnSm.secondary} disabled={busy !== ''}
                                                onClick={() => act(`d-${c.matchId}`,
                                                    () => api.post(`/management/matching/suggestions/${c.matchId}/dismiss`, {}),
                                                    'Marked as not a fit.')}>
                                                Not a fit
                                            </button>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
};

export default Matching;
