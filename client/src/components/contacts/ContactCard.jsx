import {
    Mail, Phone, Linkedin, Building2, MapPin, ShieldOff, BadgeCheck,
    HelpCircle, Clock,
} from 'lucide-react';
import { card, cardPad, badge, TONE, TONE_ALERT, alertShellSm } from '../../design/tokens.js';

/**
 * ── ONE HIRING CONTACT ────────────────────────────────────────────────
 *
 * Used in the queue drawer, on an application, and in the consultant's portal.
 * The same card everywhere, because the same person is the same person no
 * matter which screen found them.
 *
 * ── WHY THE SOURCE AND THE DATE ARE ON THE CARD ───────────────────────
 *
 * Because somebody is about to email this address, and the two questions that
 * decide whether they should are "where did this come from" and "how old is
 * it". A contact reused from the store can be up to ninety days old; a
 * `guessed` email is a provider's arithmetic on a naming pattern, not a fact.
 * Presenting both the same way as a verified address pulled this morning would
 * be presenting a guess as a finding.
 *
 * ── AND WHY "POSTER" VERSUS "COMPANY" IS PROMINENT ────────────────────
 *
 * A POSTER contact wrote the advert. A COMPANY_FALLBACK contact is a stranger
 * who happens to recruit for the same employer. The opening line of an email
 * to each of those is not the same opening line, and only one of them has any
 * idea what job you mean.
 */

const EMAIL_STATUS = {
    verified: { tone: 'success', icon: BadgeCheck, label: 'Verified' },
    guessed: { tone: 'warning', icon: HelpCircle, label: 'Guessed' },
    unavailable: { tone: 'neutral', icon: HelpCircle, label: 'Unavailable' },
};

const LINK_REASON = {
    POSTER: { tone: 'success', label: 'Posted this job' },
    COMPANY_FALLBACK: { tone: 'info', label: 'Recruits for this company' },
    MANUAL: { tone: 'brand', label: 'Looked up on request' },
};

/** "today", "3 days ago", "2 months ago" — a number a person can weigh. */
export const agedFrom = (iso) => {
    if (!iso) return null;
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    return months === 1 ? 'a month ago' : `${months} months ago`;
};

const ContactCard = ({ contact, onDoNotContact = null, busy = false }) => {
    const status = EMAIL_STATUS[String(contact.email_status ?? '').toLowerCase()];
    const reason = LINK_REASON[contact.link_reason];
    const pulled = agedFrom(contact.email_pulled_at ?? contact.created_at);

    return (
        <div className={`${card} ${cardPad} ${contact.do_not_contact ? 'opacity-75' : ''}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{contact.full_name}</p>
                    <p className="text-xs text-slate-500">{contact.title ?? 'Title unknown'}</p>
                </div>
                <span className="flex flex-wrap items-center gap-1.5">
                    {reason && (
                        <span className={`${badge} ${TONE[reason.tone]}`}>{reason.label}</span>
                    )}
                    {status && (
                        <span className={`${badge} ${TONE[status.tone]}`} title="How much to trust the address">
                            <status.icon className="h-3 w-3" /> {status.label}
                        </span>
                    )}
                </span>
            </div>

            {/*
                The flag comes before the contact details, deliberately. Placed
                underneath, it would be read after the address it is supposed to
                stop somebody using.
            */}
            {contact.do_not_contact && (
                <p className={`mt-3 ${alertShellSm} ${TONE_ALERT.danger}`}>
                    <ShieldOff className="h-3.5 w-3.5 shrink-0" />
                    <span>
                        <strong>Do not contact.</strong>
                        {contact.dnc_reason ? ` ${contact.dnc_reason}` : ' Marked by your team.'}
                    </span>
                </p>
            )}

            <dl className="mt-3 space-y-1.5 text-xs text-slate-600">
                <div className="flex items-center gap-2">
                    <Building2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span>{contact.company}</span>
                </div>
                {contact.location && (
                    <div className="flex items-center gap-2">
                        <MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>{contact.location}</span>
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    {contact.email && !contact.do_not_contact
                        ? (
                            <a href={`mailto:${contact.email}`} className="text-brand-600 hover:underline">
                                {contact.email}
                            </a>
                        )
                        : <span className="text-slate-400">{contact.email ?? 'No address found'}</span>}
                </div>
                {contact.phone && (
                    <div className="flex items-center gap-2">
                        <Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <span>{contact.phone}</span>
                    </div>
                )}
                {contact.linkedin_url && (
                    <div className="flex items-center gap-2">
                        <Linkedin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                        <a
                            href={contact.linkedin_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-600 hover:underline"
                        >
                            LinkedIn profile
                        </a>
                    </div>
                )}
            </dl>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2
                            border-t border-line-soft pt-2 text-2xs text-slate-400">
                <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {contact.provider ? `via ${contact.provider}` : 'entered by hand'}
                    {pulled ? ` · pulled ${pulled}` : ''}
                </span>

                {onDoNotContact && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDoNotContact(contact)}
                        className="font-medium text-slate-500 underline-offset-2
                                   hover:text-danger-600 hover:underline disabled:opacity-50"
                    >
                        {contact.do_not_contact ? 'Allow contact again' : 'Mark do not contact'}
                    </button>
                )}
            </div>
        </div>
    );
};

export default ContactCard;
