/**
 * ── THE SHAPE OF A RESUME, DECLARED ONCE ──────────────────────────────
 *
 * One structure, used at three points:
 *
 *   1. PARSING   the base resume is turned into this shape and cached.
 *   2. TAILORING the model is given this shape and must return this shape.
 *   3. RENDERING the PDF writer reads this shape and nothing else.
 *
 * Declaring it once is what makes the tailoring step checkable. The model is
 * not asked to "write a resume"; it is asked to return a known structure whose
 * every field we can compare against the original.
 *
 * ── WHY BOTH A JSON SCHEMA AND A JOI SCHEMA ───────────────────────────
 *
 * They do different jobs and neither replaces the other.
 *
 * The JSON Schema is sent TO the provider. It is a request, not a guarantee —
 * providers implement structured output to varying depths, some silently ignore
 * keywords, and the provider here is deliberately not yet chosen.
 *
 * The Joi schema validates what comes BACK, on our side, identically for every
 * provider. It is the actual gate. A response that fails it is a retry, never a
 * malformed PDF sent to an employer under a consultant's name.
 *
 * ── WHY sectionOrder EXISTS ───────────────────────────────────────────
 *
 * The rule is that tailoring may reorder BULLETS but must not rearrange the
 * resume. Without recording the order the sections came in, "keep the section
 * order" is an instruction nobody can check afterwards. With it, the renderer
 * simply follows the base's order and the question never arises.
 */
import Joi from 'joi';

export const SCHEMA_VERSION = 1;

/** Sections the renderer knows how to draw, in their conventional order. */
export const KNOWN_SECTIONS = [
    'summary', 'skills', 'experience', 'projects', 'education',
    'certifications', 'additional',
];

/* ── what we ask the provider for ──────────────────────────────────── */

const str = { type: 'string' };
const strOrNull = { type: ['string', 'null'] };

export const RESUME_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,

    // ── EVERY SECTION IS REQUIRED, AND THAT IS NOT PEDANTRY ───────────
    //
    // "Required" here means the KEY must be present. An empty array is still a
    // valid answer, so a candidate with no employment history returns
    // `experience: []` and nothing is invented to fill it.
    //
    // It has to be spelled out because a structured-output model treats an
    // optional property as one it may simply not emit. Asked to parse a real
    // graduate CV — 3,400 characters with education, three projects, two skill
    // groups and three certifications — Gemini returned exactly the three
    // fields that were required and omitted every other section. The result
    // passed validation (an absent optional array is legal), was cached as that
    // consultant's parsed resume, and every job tailored from it was built from
    // a summary and nothing else. The tailored resume came out at 44% of the
    // length of the real one and its ATS score went DOWN.
    //
    // Nothing in the pipeline could catch that: no schema rule was broken and
    // no claim was fabricated. Listing the sections here is what makes the
    // model answer the question it was asked.
    //
    // It also matches OpenAI's strict structured-output mode, which requires
    // every property to appear in `required`, so this is the more portable
    // shape as well as the correct one.
    required: [
        'contact', 'sectionOrder', 'summary', 'skills', 'experience',
        'projects', 'education', 'certifications', 'additional',
    ],
    properties: {
        contact: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
                name: str,
                email: strOrNull,
                phone: strOrNull,
                location: strOrNull,
                links: { type: 'array', items: str },
            },
        },

        // The order the base resume presented its sections in. The renderer
        // follows this, which is how "keep the section order" is enforced by
        // construction rather than by asking nicely.
        sectionOrder: { type: 'array', items: str },

        summary: strOrNull,

        skills: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['items'],
                properties: {
                    category: strOrNull,
                    items: { type: 'array', items: str },
                },
            },
        },

        experience: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['company', 'title', 'bullets'],
                properties: {
                    company: str,
                    title: str,
                    location: strOrNull,
                    // Kept as the resume wrote them — "Mar 2021", "2019",
                    // "Present". Parsing them into dates loses information and
                    // invents precision the document never had.
                    startDate: strOrNull,
                    endDate: strOrNull,
                    bullets: { type: 'array', items: str },
                },
            },
        },

        projects: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    name: str,
                    // As the document wrote it — "Jan 2024 – Apr 2024", "3
                    // months", "2025". Free text for the same reason as
                    // experience's dates: it is printed, never computed from.
                    when: strOrNull,
                    description: strOrNull,
                    bullets: { type: 'array', items: str },
                },
            },
        },

        education: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['institution'],
                properties: {
                    institution: str,
                    degree: strOrNull,
                    field: strOrNull,
                    startDate: strOrNull,
                    endDate: strOrNull,
                    details: strOrNull,
                },
            },
        },

        certifications: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    name: str,
                    issuer: strOrNull,
                    date: strOrNull,
                },
            },
        },

        // Anything the resume had that does not fit above — Publications,
        // Awards, Languages. Kept generic so an unusual resume is preserved
        // rather than silently truncated to the sections we anticipated.
        additional: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['heading', 'items'],
                properties: {
                    heading: str,
                    items: { type: 'array', items: str },
                },
            },
        },
    },
};

/* ── what we accept back ───────────────────────────────────────────── */

const nullableString = (max) => Joi.string().allow('', null).max(max).default(null);

export const resumeJoiSchema = Joi.object({
    contact: Joi.object({
        name: Joi.string().trim().min(1).max(200).required(),
        email: nullableString(320),
        phone: nullableString(60),
        location: nullableString(200),
        links: Joi.array().items(Joi.string().max(500)).default([]),
    }).required(),

    sectionOrder: Joi.array().items(Joi.string().max(60)).default([]),

    summary: nullableString(4000),

    skills: Joi.array().items(Joi.object({
        category: nullableString(120),
        items: Joi.array().items(Joi.string().max(200)).default([]),
    })).default([]),

    experience: Joi.array().items(Joi.object({
        company: Joi.string().trim().min(1).max(255).required(),
        title: Joi.string().trim().min(1).max(255).required(),
        location: nullableString(200),
        startDate: nullableString(60),
        endDate: nullableString(60),
        bullets: Joi.array().items(Joi.string().max(2000)).default([]),
    })).default([]),

    projects: Joi.array().items(Joi.object({
        name: Joi.string().trim().min(1).max(255).required(),
        when: nullableString(80),
        description: nullableString(2000),
        bullets: Joi.array().items(Joi.string().max(2000)).default([]),
    })).default([]),

    education: Joi.array().items(Joi.object({
        institution: Joi.string().trim().min(1).max(255).required(),
        degree: nullableString(255),
        field: nullableString(255),
        startDate: nullableString(60),
        endDate: nullableString(60),
        details: nullableString(2000),
    })).default([]),

    certifications: Joi.array().items(Joi.object({
        name: Joi.string().trim().min(1).max(255).required(),
        issuer: nullableString(255),
        date: nullableString(60),
    })).default([]),

    additional: Joi.array().items(Joi.object({
        heading: Joi.string().trim().min(1).max(120).required(),
        items: Joi.array().items(Joi.string().max(2000)).default([]),
    })).default([]),
})
    // A provider that adds a field we did not ask for is not a reason to throw
    // the whole resume away — strip it and carry on. A MISSING required field
    // still fails, which is the case that actually matters.
    //
    // stripUnknown ALONE, deliberately: pairing it with .unknown(true) is a
    // contradiction Joi resolves in favour of keeping the key, so the strip
    // silently never happens.
    .options({ stripUnknown: true });

/**
 * Validate a model's answer.
 *
 * @returns {{ ok: true, value }} | {{ ok: false, error }}
 */
export const validateResume = (candidate) => {
    const { value, error } = resumeJoiSchema.validate(candidate, {
        abortEarly: false,
        convert: true,
    });
    if (error) {
        return {
            ok: false,
            error: error.details.map((d) => d.message).join('; ').slice(0, 900),
        };
    }
    return { ok: true, value };
};

/* ── helpers the rest of the pipeline shares ───────────────────────── */

/**
 * Every piece of prose in a structured resume, as one string.
 *
 * The fabrication check compares text, not structure — a claim invented inside
 * a bullet is the case that matters, and it is invisible to a field-by-field
 * comparison. The ATS score reads the same flattening, so both are looking at
 * exactly the same words.
 */
export const flattenResumeText = (resume) => {
    if (!resume || typeof resume !== 'object') return '';
    const out = [];

    const push = (v) => { if (v) out.push(String(v)); };

    push(resume.contact?.name);
    push(resume.contact?.location);
    push(resume.summary);

    for (const group of resume.skills ?? []) {
        push(group.category);
        for (const item of group.items ?? []) push(item);
    }
    for (const role of resume.experience ?? []) {
        push(role.company); push(role.title); push(role.location);
        push(role.startDate); push(role.endDate);
        for (const b of role.bullets ?? []) push(b);
    }
    for (const p of resume.projects ?? []) {
        push(p.name); push(p.when); push(p.description);
        for (const b of p.bullets ?? []) push(b);
    }
    for (const e of resume.education ?? []) {
        push(e.institution); push(e.degree); push(e.field);
        push(e.startDate); push(e.endDate); push(e.details);
    }
    for (const c of resume.certifications ?? []) {
        push(c.name); push(c.issuer); push(c.date);
    }
    for (const s of resume.additional ?? []) {
        push(s.heading);
        for (const item of s.items ?? []) push(item);
    }

    return out.join('\n');
};

/**
 * Does the tailored resume still describe the same career?
 *
 * A structural comparison, before any model is asked anything. Reordering
 * bullets is the job; adding an employer, dropping a degree or inventing a job
 * title is not, and none of those are things a language model should be trusted
 * to self-report. Cheap, deterministic, and it runs first.
 *
 * @returns {string[]} structural violations, empty when the shape is intact
 */
export const compareStructure = (base, tailored) => {
    const problems = [];

    const key = (r) => `${String(r.company ?? '').toLowerCase().trim()}|`
        + `${String(r.title ?? '').toLowerCase().trim()}`;

    const baseRoles = new Set((base.experience ?? []).map(key));
    for (const role of tailored.experience ?? []) {
        if (!baseRoles.has(key(role))) {
            problems.push(`Experience entry "${role.title} at ${role.company}" `
                + 'does not appear in the base resume.');
        }
    }
    if ((tailored.experience ?? []).length > (base.experience ?? []).length) {
        problems.push('The tailored resume has more roles than the base resume.');
    }

    const baseSchools = new Set(
        (base.education ?? []).map((e) => String(e.institution ?? '').toLowerCase().trim()),
    );
    for (const e of tailored.education ?? []) {
        const inst = String(e.institution ?? '').toLowerCase().trim();
        if (!baseSchools.has(inst)) {
            problems.push(`Education entry "${e.institution}" is not in the base resume.`);
        }
    }

    const baseCerts = new Set(
        (base.certifications ?? []).map((c) => String(c.name ?? '').toLowerCase().trim()),
    );
    for (const c of tailored.certifications ?? []) {
        const nm = String(c.name ?? '').toLowerCase().trim();
        if (!baseCerts.has(nm)) {
            problems.push(`Certification "${c.name}" is not in the base resume.`);
        }
    }

    if (String(base.contact?.name ?? '').trim()
        !== String(tailored.contact?.name ?? '').trim()) {
        problems.push('The name on the tailored resume does not match the base resume.');
    }

    return problems;
};
