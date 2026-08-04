/**
 * ── THE PROFILE FIELD REGISTRY ────────────────────────────────────────
 *
 * One definition of every consultant profile field. Everything else reads
 * from here:
 *
 *   - the consultant's profile form          (rendered from this)
 *   - the "profile incomplete" sidebar badge (required fields that are null)
 *   - the change-request diff engine         (which fields changed)
 *   - the reviewer's approval screen         (labels + display values)
 *   - the whitelist of what a consultant may propose
 *
 * ── TO ADD A NEW FIELD ────────────────────────────────────────────────
 *   1. Add the column in a NEW migration (e.g. 011_add_profile_visa_expiry.sql)
 *   2. Add one entry below
 * That's it. No controller, form, or approval-screen change needed.
 *
 * Field options:
 *   label              shown in the UI
 *   type               text | textarea | lookup | file | date | url
 *   lookup             key in GET /api/lookups (type: 'lookup' only)
 *   required           counts toward profile completeness
 *   consultantEditable consultant may propose a change to it
 *   adminOnly          only ORG_ADMIN can set it, never proposed
 *   maxLength          validation
 *   placeholder        input hint
 *   pattern            regex SOURCE string the value must match
 *   patternMessage     what to tell the user when it does not
 *   inputMode          mobile keyboard hint ('numeric', 'tel', …)
 *
 * `pattern` is stored as a string, not a RegExp, because this whole registry
 * is serialised to the client by GET /api/profile-schema. Both sides compile
 * the same source, so a rule cannot be tightened on one side only — which is
 * how client and server validation normally drift apart.
 *
 * The client rule is a convenience. The server rule is the one that counts:
 * every schema below is rebuilt from these same entries.
 */

export const PROFILE_FIELDS = {
    phone: {
        label: 'Phone number',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 10,
        pattern: '^[0-9]{10}$',
        patternMessage: 'Phone number must be exactly 10 digits, no spaces or symbols.',
        inputMode: 'numeric',
        placeholder: '5550101234',
    },
    city: {
        label: 'City',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 120,
        // Letters, spaces, hyphens and apostrophes — enough for real place
        // names (St. John's, Winston-Salem) without allowing digits or symbols.
        pattern: "^[A-Za-z][A-Za-z .'-]*$",
        patternMessage: 'City may only contain letters, spaces, hyphens and apostrophes.',
        placeholder: 'Dallas',
    },
    state: {
        label: 'State',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 120,
        pattern: "^[A-Za-z][A-Za-z .'-]*$",
        patternMessage: 'State may only contain letters, spaces, hyphens and apostrophes.',
        placeholder: 'TX',
    },
    work_auth_status_id: {
        label: 'Work authorization',
        type: 'lookup',
        lookup: 'workAuthStatuses',
        required: true,
        consultantEditable: true,
    },
    base_resume_artifact_id: {
        label: 'Base resume',
        type: 'file',
        required: true,
        consultantEditable: true,
    },

    // ── optional, consultant-editable ─────────────────────────────────
    work_auth_notes: {
        label: 'Work authorization notes',
        type: 'textarea',
        required: false,
        consultantEditable: true,
        maxLength: 500,
        placeholder: 'Visa validity, sponsorship details, anything a recruiter should know',
    },
    linkedin_url: {
        label: 'LinkedIn profile',
        type: 'url',
        required: false,
        consultantEditable: true,
        maxLength: 255,
        pattern: '^https?://([a-z]{2,3}\.)?linkedin\.com/.+$',
        patternMessage: 'Must be a linkedin.com profile URL.',
        placeholder: 'https://linkedin.com/in/…',
    },

    // ── admin-only: never proposed by a consultant ────────────────────
    daily_cap: {
        label: 'Daily application cap',
        type: 'number',
        required: false,
        consultantEditable: false,
        adminOnly: true,
    },
    consent_on_file: {
        label: 'Consent form signed',
        type: 'boolean',
        required: false,
        consultantEditable: false,
        adminOnly: true,
    },
    consent_signed_at: {
        label: 'Consent signed on',
        type: 'date',
        required: false,
        consultantEditable: false,
        adminOnly: true,
    },
    is_paused: {
        label: 'Paused',
        type: 'boolean',
        required: false,
        consultantEditable: false,
        adminOnly: true,
    },
    notes: {
        label: 'Internal notes',
        type: 'textarea',
        required: false,
        consultantEditable: false,
        adminOnly: true,
        maxLength: 2000,
    },
};

/**
 * Joi rules for one field, derived from its registry entry.
 * Used by every request schema so no endpoint can disagree with the registry.
 */
export const joiForField = (Joi, name) => {
    const f = PROFILE_FIELDS[name];
    if (!f) return null;

    if (f.type === 'lookup') return Joi.number().integer().allow(null);
    if (f.type === 'file') return Joi.string().guid({ version: 'uuidv4' }).allow(null);
    if (f.type === 'boolean') return Joi.boolean();
    if (f.type === 'number') return Joi.number().integer().min(0).max(1000);
    if (f.type === 'date') return Joi.date().allow(null);

    let rule = Joi.string().max(f.maxLength ?? 255);
    if (f.type === 'url') rule = Joi.string().uri().max(f.maxLength ?? 255);
    if (f.pattern) {
        rule = rule.pattern(new RegExp(f.pattern)).messages({
            'string.pattern.base': f.patternMessage ?? `${f.label} is not in the expected format.`,
        });
    }
    // '' means "clear this field"; the pattern must not fire on an empty value.
    return rule.allow('', null);
};

/** Field names a consultant is allowed to propose changes to. */
export const CONSULTANT_EDITABLE = Object.entries(PROFILE_FIELDS)
    .filter(([, f]) => f.consultantEditable)
    .map(([name]) => name);

/** Field names that count toward "profile complete". */
export const REQUIRED_FIELDS = Object.entries(PROFILE_FIELDS)
    .filter(([, f]) => f.required)
    .map(([name]) => name);

/** Field names only ORG_ADMIN may set. */
export const ADMIN_ONLY_FIELDS = Object.entries(PROFILE_FIELDS)
    .filter(([, f]) => f.adminOnly)
    .map(([name]) => name);

/**
 * Which required fields are still empty on a profile row.
 * Drives the "profile incomplete" badge in the consultant's sidebar.
 */
export const missingRequiredFields = (profile) => {
    if (!profile) return REQUIRED_FIELDS;
    return REQUIRED_FIELDS.filter((name) => {
        const v = profile[name];
        return v === null || v === undefined || v === '';
    });
};

/** Normalise a value to text for storing in a change-request row. */
export const toStoredValue = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
};

/**
 * Human-readable version of a value, for the approval screen.
 * Lookup ids become their name; everything else stays as-is.
 */
export const toDisplayValue = (fieldName, value, lookups = {}) => {
    if (value === null || value === undefined || value === '') return null;

    const field = PROFILE_FIELDS[fieldName];
    if (!field) return String(value);

    if (field.type === 'lookup') {
        const list = lookups[field.lookup] ?? [];
        return list.find((o) => String(o.id) === String(value))?.name ?? String(value);
    }
    if (field.type === 'boolean') return value ? 'Yes' : 'No';
    if (field.type === 'file') return 'Uploaded file';

    return String(value);
};
