/**
 * ── PHONE NUMBERS, DELIBERATELY NOT IMPLEMENTED ───────────────────────
 *
 * An interface and a null implementation. That is the whole file, and it is
 * the whole point.
 *
 * ── WHY A SEAM WITH NOTHING BEHIND IT ─────────────────────────────────
 *
 * Apollo returns a phone number sometimes — on some plans, for some people —
 * and a dedicated phone provider (Lusha, SignalHire) returns one much more
 * often, for more money. Which of those an agency wants is a commercial
 * decision nobody has made yet.
 *
 * The alternative to this file is to write the waterfall now with Apollo's
 * phone inline, and then, when a phone provider is bought, to go back and thread
 * a second provider through the middle of a working paid pipeline. That is the
 * riskiest possible time to change it. A seam costs a few lines today and makes
 * the later change a new file plus one line of wiring.
 *
 * So the waterfall already calls `lookupPhone` on every contact it finds, and
 * already handles "no number" — because that is what `NullPhoneProvider`
 * always answers. The path is exercised from day one instead of being
 * written blind on the day it first matters.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────
 *
 * Same rule as every other connector here: NEVER THROW. A phone provider is the
 * least important thing in the pipeline, and it must never be capable of
 * failing a contact lookup, let alone the submission behind it.
 */

/**
 * @typedef  {object} PhoneResult
 * @property {boolean} ok
 * @property {string|null} phone     E.164 where the provider gives it
 * @property {string|null} source    provider name, for contacts.phone_source
 * @property {number} credits        what the call cost, for the ledger
 * @property {string|null} error
 */

/** The answer when nobody looked. Shared so every path returns the same shape. */
export const NO_PHONE = Object.freeze({
    ok: true, phone: null, source: null, credits: 0, error: null,
});

/**
 * The interface every phone provider implements.
 *
 * @param   {{name: string, company?: string, linkedinUrl?: string, email?: string}} subject
 * @returns {Promise<PhoneResult>}
 */
export class NullPhoneProvider {
    static providerName = 'NONE';

    // eslint-disable-next-line class-methods-use-this, no-unused-vars
    async lookupPhone(subject) {
        return NO_PHONE;
    }
}

/**
 * Which implementation is in use.
 *
 * Read fresh from the environment rather than captured at import, the same rule
 * the model and search connectors follow, so a test can switch providers without
 * re-importing the module graph.
 *
 * There is exactly one implementation today and the switch still exists,
 * because the alternative — call sites reaching for a concrete class — is what
 * makes the second implementation expensive.
 */
export const getPhoneProvider = () => {
    const configured = (process.env.PHONE_PROVIDER ?? '').trim().toUpperCase();

    switch (configured) {
        // case 'LUSHA': return new LushaPhoneProvider();
        default:
            return new NullPhoneProvider();
    }
};

/**
 * Look a number up through whichever provider is configured.
 *
 * Wrapped so that a future provider that throws — SDKs do — still cannot take
 * the waterfall down with it.
 */
export const lookupPhone = async (subject) => {
    try {
        const provider = getPhoneProvider();
        const result = await provider.lookupPhone(subject);
        return result ?? NO_PHONE;
    } catch (err) {
        return {
            ok: false, phone: null, source: null, credits: 0, error: err.message,
        };
    }
};
