/**
 * The shape of each career section, as the form renders it.
 *
 * ── WHY THIS IS DATA AND NOT FOUR FORMS ───────────────────────────────
 *
 * The four sections differ only in their fields. Written as four components
 * they would drift — one gets a validation message the others miss, one forgets
 * to trim, one orders its inputs differently for no reason. Declared as data,
 * they are rendered by one editor and behave identically by construction.
 *
 * These definitions mirror the Joi schemas in
 * backend/controllers/profileSectionsController.js. The server is the authority
 * — it revalidates everything — but matching here means a consultant is told
 * what is wrong while they are typing rather than after they submit.
 */

const YEAR = { min: 1950, max: 2100 };

export const PROFILE_SECTIONS = {
    education: {
        label: 'Education',
        singular: 'qualification',
        // What each row shows when collapsed.
        title: (r) => [r.degree, r.field_of_study].filter(Boolean).join(', ') || r.level,
        subtitle: (r) => [r.institution, r.end_year].filter(Boolean).join(' · '),
        fields: [
            {
                name: 'level',
                label: 'Level',
                type: 'select',
                required: true,
                options: [
                    { value: 'SECONDARY', label: 'Secondary / 10th' },
                    { value: 'SENIOR_SECONDARY', label: 'Senior secondary / 12th' },
                    { value: 'DIPLOMA', label: 'Diploma' },
                    { value: 'BACHELORS', label: "Bachelor's" },
                    { value: 'MASTERS', label: "Master's" },
                    { value: 'DOCTORATE', label: 'Doctorate' },
                    { value: 'OTHER', label: 'Other' },
                ],
                default: 'BACHELORS',
            },
            { name: 'institution', label: 'School or college', type: 'text', required: true, max: 255 },
            { name: 'board', label: 'Board or university', type: 'text', max: 255, hint: 'If different from the institution — CBSE, a state board, the awarding university' },
            { name: 'degree', label: 'Degree', type: 'text', max: 255, hint: 'B.Tech, B.Sc, MBA…' },
            { name: 'field_of_study', label: 'Specialisation', type: 'text', max: 255 },
            { name: 'location', label: 'Location', type: 'text', max: 255 },
            { name: 'start_year', label: 'Start year', type: 'number', ...YEAR },
            { name: 'end_year', label: 'End year', type: 'number', ...YEAR },
            { name: 'is_current', label: 'Still studying here', type: 'checkbox' },
            // Free text, because "8.7 CGPA", "76.4%" and "3.8/4.0" are all real
            // answers and forcing one number would make some markets wrong.
            { name: 'score', label: 'Marks', type: 'text', max: 40, hint: '8.7, 76.4, 3.8 — just the number' },
            {
                name: 'score_type',
                label: 'Marks are in',
                type: 'select',
                options: [
                    { value: '', label: '—' },
                    { value: 'PERCENTAGE', label: 'Percentage' },
                    { value: 'CGPA', label: 'CGPA' },
                    { value: 'GPA', label: 'GPA' },
                    { value: 'GRADE', label: 'Grade' },
                ],
            },
            { name: 'details', label: 'Anything else', type: 'textarea', max: 1000 },
        ],
    },

    experience: {
        label: 'Work experience',
        singular: 'role',
        title: (r) => r.title,
        subtitle: (r) => [r.company, r.is_current ? 'Present' : r.end_date].filter(Boolean).join(' · '),
        fields: [
            { name: 'title', label: 'Job title', type: 'text', required: true, max: 255 },
            { name: 'company', label: 'Company', type: 'text', required: true, max: 255 },
            { name: 'location', label: 'Location', type: 'text', max: 255 },
            { name: 'employment_type', label: 'Type', type: 'text', max: 30, hint: 'Full time, Contract, Internship…' },
            // Text, not a date picker: people write "Mar 2021" and turning that
            // into a day invents precision they never gave.
            { name: 'start_date', label: 'Started', type: 'text', max: 40, hint: 'Mar 2021' },
            { name: 'end_date', label: 'Ended', type: 'text', max: 40, hint: 'Leave blank if this is current' },
            { name: 'is_current', label: 'I still work here', type: 'checkbox' },
            {
                name: 'bullets',
                label: 'What you did',
                type: 'list',
                hint: 'One point per line. These are what get reordered and reworded for each job — '
                    + 'nothing is ever added that you did not write here.',
            },
            { name: 'tech_used', label: 'Tech used', type: 'taglist', hint: 'Comma separated' },
        ],
    },

    projects: {
        label: 'Projects',
        singular: 'project',
        title: (r) => r.name,
        subtitle: (r) => [r.role, r.duration].filter(Boolean).join(' · '),
        fields: [
            { name: 'name', label: 'Project name', type: 'text', required: true, max: 255 },
            { name: 'description', label: 'What it is', type: 'textarea', max: 2000 },
            { name: 'role', label: 'Your role', type: 'text', max: 255 },
            { name: 'duration', label: 'Duration', type: 'text', max: 80, hint: '3 months, Jan–Apr 2024' },
            { name: 'team_size', label: 'Team size', type: 'number', min: 1, max: 10000 },
            { name: 'deployed_url', label: 'Live link', type: 'url', max: 500 },
            { name: 'repo_url', label: 'Code link', type: 'url', max: 500 },
            { name: 'bullets', label: 'What you did on it', type: 'list' },
            { name: 'tech_used', label: 'Tech used', type: 'taglist', hint: 'Comma separated' },
        ],
    },

    certifications: {
        label: 'Certifications and achievements',
        singular: 'entry',
        title: (r) => r.name,
        subtitle: (r) => [r.issuer, r.issued_on].filter(Boolean).join(' · '),
        fields: [
            {
                name: 'kind',
                label: 'Type',
                type: 'select',
                required: true,
                options: [
                    { value: 'CERTIFICATION', label: 'Certification' },
                    { value: 'COURSE', label: 'Course completed' },
                    { value: 'AWARD', label: 'Award or win' },
                    { value: 'PARTICIPATION', label: 'Participation' },
                ],
                default: 'CERTIFICATION',
            },
            { name: 'name', label: 'Name', type: 'text', required: true, max: 255 },
            { name: 'issuer', label: 'Issued by', type: 'text', max: 255 },
            { name: 'issued_on', label: 'Issued', type: 'text', max: 40, hint: '2023, Mar 2023' },
            { name: 'expires_on', label: 'Expires', type: 'text', max: 40 },
            { name: 'credential_id', label: 'Credential ID', type: 'text', max: 255 },
            { name: 'credential_url', label: 'Verify link', type: 'url', max: 500 },
            { name: 'details', label: 'Anything else', type: 'textarea', max: 1000 },
        ],
    },
};

export const SECTION_ORDER = ['experience', 'education', 'projects', 'certifications'];

/** A blank row, with any declared defaults already applied. */
export const emptyRow = (sectionName) => {
    const out = {};
    for (const f of PROFILE_SECTIONS[sectionName].fields) {
        if (f.type === 'list' || f.type === 'taglist') out[f.name] = [];
        else if (f.type === 'checkbox') out[f.name] = false;
        else out[f.name] = f.default ?? '';
    }
    return out;
};

/**
 * Client-side validation, mirroring the server's.
 *
 * Deliberately only the rules a person can act on while typing. The server
 * revalidates everything regardless — this exists so a required field is
 * flagged before a save round trip, not so the server can trust the browser.
 */
export const validateRow = (sectionName, row) => {
    const errors = {};
    for (const f of PROFILE_SECTIONS[sectionName].fields) {
        const v = row[f.name];
        if (f.required && (v === null || v === undefined || String(v).trim() === '')) {
            errors[f.name] = `${f.label} is required.`;
        }
        if (f.type === 'url' && v && !/^https?:\/\/.+/i.test(String(v))) {
            errors[f.name] = 'Must start with http:// or https://';
        }
        if (f.type === 'number' && v !== '' && v !== null && v !== undefined) {
            const n = Number(v);
            if (Number.isNaN(n)) errors[f.name] = 'Must be a number.';
            else if (f.min !== undefined && n < f.min) errors[f.name] = `Must be ${f.min} or more.`;
            else if (f.max !== undefined && n > f.max) errors[f.name] = `Must be ${f.max} or less.`;
        }
    }
    return errors;
};

/** Form values → the JSON the API expects. */
export const toPayload = (sectionName, row) => {
    const out = {};
    for (const f of PROFILE_SECTIONS[sectionName].fields) {
        const v = row[f.name];
        if (f.type === 'list' || f.type === 'taglist') {
            out[f.name] = Array.isArray(v) ? v.filter((x) => String(x).trim()) : [];
        } else if (f.type === 'checkbox') {
            out[f.name] = Boolean(v);
        } else if (f.type === 'number') {
            out[f.name] = v === '' || v === null || v === undefined ? null : Number(v);
        } else {
            // '' and null mean the same thing to the server, and sending null
            // keeps empty optional fields out of the generated resume.
            out[f.name] = String(v ?? '').trim() || null;
        }
    }
    return out;
};
