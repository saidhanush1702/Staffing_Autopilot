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
 */

export const PROFILE_FIELDS = {
    phone: {
        label: 'Phone number',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 30,
        placeholder: '+1 555 010 1234',
    },
    city: {
        label: 'City',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 120,
        placeholder: 'Dallas',
    },
    state: {
        label: 'State',
        type: 'text',
        required: true,
        consultantEditable: true,
        maxLength: 120,
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
