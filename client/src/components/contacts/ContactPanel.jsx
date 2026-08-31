import { useCallback, useEffect, useState } from 'react';
import { UserSearch, Loader2, Search, AlertCircle } from 'lucide-react';
import api, { errorMessage } from '../../api/axios.js';
import ContactCard from './ContactCard.jsx';
import {
    sectionTitle, btnSm, alertShellSm, TONE_ALERT, cardQuiet, cardPad,
} from '../../design/tokens.js';

/**
 * ── THE CONTACTS FOR ONE JOB ──────────────────────────────────────────
 *
 * Fetches from whichever endpoint the caller names and renders the cards. The
 * endpoint differs by role — management, portal, device — and the scoping lives
 * on the server, so the only thing that changes here is the URL.
 *
 * ── WHY "NOBODY YET" IS A FULL SENTENCE ───────────────────────────────
 *
 * Contact discovery runs AFTER submission, on a background worker. For a minute
 * or so after applying there is genuinely nothing to show, and an empty panel
 * reads as a broken feature rather than as a job that has not run yet. Saying
 * which of the two it is costs one line and saves the support ticket.
 *
 * ── WHY THE MANUAL BUTTON SAYS WHAT IT COSTS ──────────────────────────
 *
 * It spends a credit from the agency's monthly allowance. A button that
 * quietly bills somebody is a button people click twice.
 */
const ContactPanel = ({
    endpoint,
    lookupEndpoint = null,   // when set, the manual "find now" action is offered
    onDoNotContact = null,
    title = 'Hiring contacts',
}) => {
    const [contacts, setContacts] = useState(null);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            setError('');
            const { data } = await api.get(endpoint);
            setContacts(data.contacts ?? []);
        } catch (err) {
            setError(errorMessage(err, 'Could not load contacts.'));
            setContacts([]);
        }
    }, [endpoint]);

    useEffect(() => { load(); }, [load]);

    const findNow = async () => {
        setBusy(true);
        setError('');
        setNote('');
        try {
            const { data } = await api.post(lookupEndpoint);
            setContacts(data.contacts ?? []);
            setNote(data.note ?? '');
        } catch (err) {
            // A 502 here is the provider, not the request. `errorMessage` reads
            // the body either way, and the body carries the reason the
            // waterfall stopped — a budget ceiling, a missing key, an outage.
            setError(err?.response?.data?.note ?? errorMessage(err, 'The lookup failed.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className={`${sectionTitle} flex items-center gap-2`}>
                    <UserSearch className="h-4 w-4 text-slate-400" />
                    {title}
                </h4>

                {lookupEndpoint && (
                    <button
                        type="button"
                        onClick={findNow}
                        disabled={busy}
                        className={btnSm.subtle}
                        title="Runs one paid lookup against this agency's monthly allowance"
                    >
                        {busy
                            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking…</>
                            : <><Search className="h-3.5 w-3.5" /> Find contact (1 credit)</>}
                    </button>
                )}
            </div>

            {error && (
                <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.danger}`}>
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                </p>
            )}
            {note && !error && (
                <p className={`mt-2 ${alertShellSm} ${TONE_ALERT.info}`}>{note}</p>
            )}

            {contacts === null && (
                <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </p>
            )}

            {contacts?.length === 0 && (
                <div className={`mt-3 ${cardQuiet} ${cardPad}`}>
                    <p className="text-xs text-slate-500">
                        No contact found for this job yet.
                    </p>
                    <p className="mt-1 text-2xs text-slate-400">
                        Discovery runs shortly after an application is submitted.
                        {lookupEndpoint ? ' You can look one up now instead.' : ''}
                    </p>
                </div>
            )}

            {contacts?.length > 0 && (
                <div className="mt-3 space-y-3">
                    {contacts.map((c) => (
                        <ContactCard
                            key={c.id}
                            contact={c}
                            busy={busy}
                            onDoNotContact={onDoNotContact
                                ? async (contact) => {
                                    await onDoNotContact(contact);
                                    await load();
                                }
                                : null}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default ContactPanel;
