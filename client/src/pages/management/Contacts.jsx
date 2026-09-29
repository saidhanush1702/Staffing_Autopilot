import { useCallback, useEffect, useState } from 'react';
import {
    Search, AlertCircle, UserSearch, Coins, Database, ShieldOff, Zap, Save,
} from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import PageLoader from '../../components/PageLoader.jsx';
import Pagination from '../../components/Pagination.jsx';
import Modal, { ModalActions } from '../../components/ui/Modal.jsx';
import StatCard from '../../components/ui/StatCard.jsx';
import ContactCard from '../../components/contacts/ContactCard.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
    card, cardPad, searchInput, searchIcon, input, fieldLabel, badge, TONE,
    btnSm, toggleTrack, toggleTrackOn, toggleTrackOff, toggleKnob, toggleKnobOn, toggleKnobOff,
    pageTitle, pageSubtitle, alertShell, TONE_ALERT, sectionTitle,
} from '../../design/tokens.js';

/**
 * ── THE CONTACT STORE ─────────────────────────────────────────────────
 *
 * Every hiring contact this agency has found, searchable, with the cost of
 * finding them at the top.
 *
 * ── WHY THE COST TILES COME FIRST ─────────────────────────────────────
 *
 * The store exists to stop the same person being bought twice. Whether it is
 * working is a single number — the share of lookups answered for free — and
 * that number is invisible if only the paid calls are counted. A hit rate
 * climbing toward 100% as a bench settles onto a set of employers is the
 * feature paying for itself; a hit rate stuck near zero means something is
 * wrong with de-duplication and the bill is rising for no reason.
 *
 * ── WHY THERE IS NO EXPORT BUTTON ─────────────────────────────────────
 *
 * There is no endpoint behind one. These are real people's work addresses and
 * phone numbers; search is paginated and every page is audited, and that is
 * only meaningful while no single call returns the lot. The missing button is
 * the control, not an oversight.
 */
const Contacts = () => {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ORG_ADMIN';

    const [rows, setRows] = useState(null);
    const [page, setPage] = useState(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [q, setQ] = useState('');
    const [usage, setUsage] = useState(null);
    const [error, setError] = useState('');

    const [target, setTarget] = useState(null);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    const [providerDraft, setProviderDraft] = useState(null);
    const [savingProvider, setSavingProvider] = useState(false);

    const load = useCallback(async (p = 1, search = '') => {
        try {
            setError('');
            const { data } = await api.get('/management/contacts', {
                params: { page: p, limit: 24, q: search },
            });
            setRows(data.data);
            setPage(data.page);
            setCurrentPage(p);
        } catch (err) {
            setError(errorMessage(err));
            setRows([]);
        }
    }, []);

    const loadUsage = useCallback(async () => {
        try {
            const { data } = await api.get('/management/contacts/usage');
            setUsage(data);
        } catch { /* the tiles are context, not the page */ }
    }, []);

    useEffect(() => { load(1, ''); }, [load]);
    useEffect(() => { loadUsage(); }, [loadUsage]);

    const toggleProvider = async () => {
        if (!usage) return;
        setSavingProvider(true);
        try {
            await api.patch('/management/contacts/provider', { isEnabled: !usage.provider.enabled });
            await loadUsage();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSavingProvider(false);
        }
    };

    const saveProviderDraft = async () => {
        setSavingProvider(true);
        try {
            await api.patch('/management/contacts/provider', {
                monthlyBudget: providerDraft.budget,
                rateLimitMs: providerDraft.rateLimitMs,
            });
            setProviderDraft(null);
            await loadUsage();
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setSavingProvider(false);
        }
    };

    /** Debounced so typing a company name is not one request per keystroke. */
    useEffect(() => {
        const t = setTimeout(() => { load(1, q); }, 300);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q]);

    const confirmDnc = async () => {
        setBusy(true);
        try {
            await api.post(`/management/contacts/${target.id}/do-not-contact`, {
                reason,
                undo: target.do_not_contact,
            });
            setTarget(null);
            setReason('');
            await load(currentPage, q);
        } catch (err) {
            setError(errorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    if (rows === null) return <PageLoader />;

    return (
        <div className="mx-auto max-w-6xl">
            <h1 className={pageTitle}>Contacts</h1>
            <p className={pageSubtitle}>
                People found for the jobs your consultants applied to. Reused for
                {' '}90 days before a fresh lookup is paid for.
            </p>

            {usage && (
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard
                        icon={Database}
                        label="Answered from the store"
                        value={`${usage.month.storeHitRate}%`}
                        hint={`${usage.month.store_hits} of ${usage.month.lookups} lookups this month`}
                        tone="success"
                    />
                    <StatCard
                        icon={Coins}
                        label="Credits used this month"
                        value={usage.provider.used}
                        hint={usage.provider.budget
                            ? `of ${usage.provider.budget} · ${usage.provider.remaining} left`
                            : 'no ceiling set'}
                        tone={usage.provider.remaining === 0 ? 'danger' : 'brand'}
                    />
                    <StatCard
                        icon={UserSearch}
                        label="People on file"
                        value={usage.store.contacts}
                        hint="de-duplicated by person and company"
                    />
                    <StatCard
                        icon={ShieldOff}
                        label="Do not contact"
                        value={usage.store.do_not_contact}
                        hint="never attached to a new job"
                        tone={usage.store.do_not_contact > 0 ? 'warning' : 'neutral'}
                    />
                </div>
            )}

            {usage && !usage.provider.configured && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.warning}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                        No Apollo key is set in the server environment, so no contact lookups
                        can run yet, even once switched on here.
                    </span>
                </div>
            )}

            {usage && !isAdmin && !usage.provider.enabled && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.info}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>
                        Contact discovery is switched off for this organisation, so no new
                        contacts are being found. Anything below was found earlier.
                    </span>
                </div>
            )}

            {usage && isAdmin && (
                <div className={`mt-4 ${card} ${cardPad}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h2 className={`flex items-center gap-2 ${sectionTitle}`}>
                                <Zap className="h-4 w-4 text-slate-400" />
                                Apollo (contact enrichment)
                                <span className={`${badge} ${usage.provider.enabled ? TONE.success : TONE.neutral}`}>
                                    {usage.provider.enabled ? 'On' : 'Off'}
                                </span>
                            </h2>
                            <p className="mt-1 max-w-xl text-xs text-slate-500">
                                Finds the hiring contact for a job, once an application goes out.
                                Off by default — switching this on is the moment this agency starts
                                spending Apollo credits.
                            </p>
                        </div>

                        <button
                            type="button"
                            role="switch"
                            aria-checked={usage.provider.enabled}
                            aria-label="Apollo contact discovery"
                            disabled={savingProvider}
                            onClick={toggleProvider}
                            className={`${toggleTrack} ${usage.provider.enabled ? toggleTrackOn : toggleTrackOff}`}
                        >
                            <span className={`${toggleKnob} ${usage.provider.enabled ? toggleKnobOn : toggleKnobOff}`} />
                        </button>
                    </div>

                    <div className="mt-4 grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
                        <div>
                            <label className={fieldLabel} htmlFor="apollo-budget">
                                Monthly budget (credits)
                            </label>
                            <input
                                id="apollo-budget"
                                type="number"
                                min={0}
                                value={providerDraft?.budget ?? usage.provider.budget}
                                onChange={(e) => setProviderDraft({
                                    budget: Number(e.target.value),
                                    rateLimitMs: providerDraft?.rateLimitMs ?? usage.provider.rateLimitMs,
                                })}
                                className={input}
                            />
                            <p className="mt-1 text-xs text-slate-400">
                                Used {usage.provider.used} · {usage.provider.remaining} left this month.
                            </p>
                        </div>

                        <div>
                            <label className={fieldLabel} htmlFor="apollo-rate-limit">
                                Milliseconds between calls
                            </label>
                            <input
                                id="apollo-rate-limit"
                                type="number"
                                min={0}
                                value={providerDraft?.rateLimitMs ?? usage.provider.rateLimitMs}
                                onChange={(e) => setProviderDraft({
                                    rateLimitMs: Number(e.target.value),
                                    budget: providerDraft?.budget ?? usage.provider.budget,
                                })}
                                className={input}
                            />
                            <p className="mt-1 text-xs text-slate-400">
                                Paces the search-then-enrich pair inside one lookup.
                            </p>
                        </div>
                    </div>

                    {providerDraft && (
                        <div className="mt-4 flex justify-end">
                            <button
                                type="button"
                                onClick={saveProviderDraft}
                                disabled={savingProvider}
                                className={btnSm.primary}
                            >
                                <Save className="h-3.5 w-3.5" />
                                Save settings
                            </button>
                        </div>
                    )}
                </div>
            )}

            <div className="relative mt-5">
                <Search className={searchIcon} />
                <input
                    className={searchInput}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search by name, company or title…"
                />
            </div>

            {error && (
                <div className={`mt-4 ${alertShell} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {rows.length === 0 ? (
                <div className={`mt-5 ${card} ${cardPad} text-center`}>
                    <UserSearch className="mx-auto h-8 w-8 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-600">
                        {q ? 'Nobody matches that search.' : 'No contacts found yet.'}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                        Contacts are looked up shortly after an application is submitted.
                    </p>
                </div>
            ) : (
                <>
                    <div className="mt-5 grid gap-3 md:grid-cols-2">
                        {rows.map((c) => (
                            <ContactCard
                                key={c.id}
                                contact={c}
                                onDoNotContact={(contact) => {
                                    setTarget(contact);
                                    setReason('');
                                }}
                            />
                        ))}
                    </div>

                    <div className="mt-5">
                        <Pagination page={page} onChange={(p) => load(p, q)} />
                    </div>
                </>
            )}

            {target && (
                <Modal
                    onClose={() => setTarget(null)}
                    tone={target.do_not_contact ? 'neutral' : 'danger'}
                    icon={ShieldOff}
                    title={target.do_not_contact ? 'Allow contact again' : 'Mark do not contact'}
                    footer={(
                        <ModalActions
                            onCancel={() => setTarget(null)}
                            onConfirm={confirmDnc}
                            busy={busy}
                            variant={target.do_not_contact ? 'primary' : 'danger'}
                            confirmLabel={target.do_not_contact ? 'Allow again' : 'Mark do not contact'}
                        />
                    )}
                >
                    <p className="text-sm text-slate-600">
                        {target.do_not_contact
                            ? `${target.full_name} may be attached to jobs again.`
                            : `${target.full_name} at ${target.company} will never be attached `
                              + 'to another job, and their address will not be shown as usable.'}
                    </p>

                    {!target.do_not_contact && (
                        <>
                            <label className={`mt-3 block ${fieldLabel}`} htmlFor="dnc-reason">
                                Why (optional, kept on the record)
                            </label>
                            <input
                                id="dnc-reason"
                                className={input}
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="e.g. Asked us by email not to contact them again."
                            />
                        </>
                    )}
                </Modal>
            )}

        </div>
    );
};

export default Contacts;
