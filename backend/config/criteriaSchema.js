/**
 * ── THE SEARCH CRITERIA SHAPE ─────────────────────────────────────────
 *
 * One definition of what a criteria set contains, in the same spirit as
 * profileFields.js. Validation, normalisation and change detection all read
 * from here, so the API, the diff engine and the client cannot disagree
 * about what a criteria set is.
 *
 * A criteria set has four kinds of content:
 *
 *   TERMS       ordered lists of strings — job titles, include keywords,
 *               exclude keywords, excluded companies
 *   LOCATIONS   city/state plus a work mode and an optional radius
 *   WORK TYPES  ids from lkp_work_types
 *   MIN PAY     amount + unit + currency, which travel together
 *
 * Every rule below is mirrored by a CHECK constraint in migrations 017/018.
 * The API rule gives a readable message; the database rule is what makes the
 * bad state actually unstorable.
 */
import Joi from 'joi';

/** Term kinds, and the payload key each one maps to. */
export const TERM_KINDS = {
    jobTitles: 'JOB_TITLE',
    keywordsInclude: 'KEYWORD_INCLUDE',
    keywordsExclude: 'KEYWORD_EXCLUDE',
    excludedCompanies: 'EXCLUDED_COMPANY',
};

export const TERM_LABELS = {
    jobTitles: 'Job titles',
    keywordsInclude: 'Include keywords',
    keywordsExclude: 'Exclude keywords',
    excludedCompanies: 'Excluded companies',
};

export const WORK_MODES = ['ONSITE', 'HYBRID', 'REMOTE'];
export const PAY_UNITS = ['HOURLY', 'ANNUAL'];

const MAX_TERMS = 50;
const MAX_LOCATIONS = 25;

/**
 * Case-insensitive de-duplication, preserving the first spelling typed.
 *
 * `search_criteria_terms` has UNIQUE (version_id, kind, value), so an exact
 * duplicate would throw. Folding case as well means "React" and "react" do
 * not both survive — two spellings of one term is a data-entry slip, and
 * downstream matching would treat them as one anyway.
 */
const dedupe = (values) => {
    const seen = new Set();
    const out = [];
    for (const raw of values) {
        const value = String(raw).trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
};

const termList = Joi.array()
    .items(Joi.string().trim().min(1).max(200))
    .max(MAX_TERMS)
    .default([]);

const locationRule = Joi.object({
    workMode: Joi.string().valid(...WORK_MODES).required(),

    // A place is required unless the answer is "remote, anywhere".
    city: Joi.when('workMode', {
        is: 'REMOTE',
        then: Joi.string().trim().max(120).allow('', null).default(null),
        otherwise: Joi.string().trim().min(1).max(120).required()
            .messages({ 'any.required': 'An onsite or hybrid location needs a city.' }),
    }),

    state: Joi.string().trim().max(120).allow('', null).default(null),

    // A radius around "remote" is meaningless, so it is refused rather than
    // quietly dropped — silently ignoring input teaches people it worked.
    radiusMiles: Joi.when('workMode', {
        is: 'REMOTE',
        then: Joi.valid(null).default(null)
            .messages({ 'any.only': 'A remote location cannot have a search radius.' }),
        otherwise: Joi.number().integer().min(1).max(500).allow(null).default(null),
    }),
});

/**
 * Minimum pay. Amount and unit are stored together or not at all: "60" alone
 * is either an hourly rate or a catastrophic salary expectation, and there is
 * no safe default to guess.
 */
const minPayRule = Joi.object({
    amount: Joi.number().min(0).max(9_999_999).allow(null).default(null),
    unit: Joi.string().valid(...PAY_UNITS).allow(null).default(null),
    currency: Joi.string().trim().uppercase().length(3).default('USD'),
})
    .default({ amount: null, unit: null, currency: 'USD' })
    .custom((value, helpers) => {
        const hasAmount = value.amount !== null && value.amount !== undefined;
        const hasUnit = value.unit !== null && value.unit !== undefined;
        if (hasAmount !== hasUnit) return helpers.error('any.invalid');
        return value;
    })
    .messages({
        'any.invalid': 'Minimum pay needs both an amount and a unit — hourly or annual.',
    });

/** Body of PUT /criteria and the restore copy path. */
export const criteriaSchema = Joi.object({
    jobTitles: termList,
    keywordsInclude: termList,
    keywordsExclude: termList,
    excludedCompanies: termList,
    locations: Joi.array().items(locationRule).max(MAX_LOCATIONS).default([]),
    workTypeIds: Joi.array().items(Joi.number().integer().positive()).max(20).default([]),
    minPay: minPayRule,
    changeNote: Joi.string().trim().max(500).allow('', null).default(null),
});

export const toggleActiveSchema = Joi.object({
    isActive: Joi.boolean().required(),
    reason: Joi.string().trim().max(255).allow('', null),
});

export const restoreSchema = Joi.object({
    changeNote: Joi.string().trim().max(500).allow('', null),
});

/**
 * Canonical form of a validated payload — de-duplicated, trimmed, with work
 * type ids sorted. Everything written to the database goes through this, so
 * two saves that mean the same thing produce identical rows.
 */
export const normalise = (input) => ({
    jobTitles: dedupe(input.jobTitles ?? []),
    keywordsInclude: dedupe(input.keywordsInclude ?? []),
    keywordsExclude: dedupe(input.keywordsExclude ?? []),
    excludedCompanies: dedupe(input.excludedCompanies ?? []),
    locations: (input.locations ?? []).map((l) => ({
        city: l.city?.trim() || null,
        state: l.state?.trim() || null,
        workMode: l.workMode,
        radiusMiles: l.radiusMiles ?? null,
    })),
    workTypeIds: [...new Set(input.workTypeIds ?? [])].sort((a, b) => a - b),
    minPay: {
        amount: input.minPay?.amount ?? null,
        unit: input.minPay?.unit ?? null,
        currency: input.minPay?.currency ?? 'USD',
    },
});

/**
 * A stable string identifying the CONTENT of a criteria set.
 *
 * Used to refuse a save that changes nothing. Without it, opening the editor
 * and pressing Save would mint a version identical to the last one, and the
 * history would stop meaning "here is where something changed".
 *
 * `changeNote` is deliberately excluded — a note about nothing is still
 * nothing. Job title ORDER is included because that order is the priority.
 */
export const fingerprint = (c) => JSON.stringify([
    c.jobTitles,
    c.keywordsInclude,
    c.keywordsExclude,
    c.excludedCompanies,
    c.locations.map((l) => [l.city ?? '', l.state ?? '', l.workMode, l.radiusMiles ?? 0]),
    c.workTypeIds,
    [c.minPay.amount === null ? null : Number(c.minPay.amount), c.minPay.unit, c.minPay.currency],
]);

/** Is there anything at all in this set? An empty set matches nothing. */
export const isEmpty = (c) => c.jobTitles.length === 0
    && c.keywordsInclude.length === 0
    && c.keywordsExclude.length === 0
    && c.excludedCompanies.length === 0
    && c.locations.length === 0
    && c.workTypeIds.length === 0
    && c.minPay.amount === null;

/** One-line human summary of what changed between two normalised sets. */
export const describeDiff = (before, after) => {
    const parts = [];

    for (const [key, label] of Object.entries(TERM_LABELS)) {
        const added = after[key].filter((v) => !before[key].includes(v));
        const removed = before[key].filter((v) => !after[key].includes(v));
        const reordered = added.length === 0 && removed.length === 0
            && JSON.stringify(before[key]) !== JSON.stringify(after[key]);

        if (added.length) parts.push(`${label} +${added.join(', ')}`);
        if (removed.length) parts.push(`${label} −${removed.join(', ')}`);
        if (reordered) parts.push(`${label} reordered`);
    }

    if (JSON.stringify(before.locations) !== JSON.stringify(after.locations)) {
        parts.push(`Locations ${before.locations.length} → ${after.locations.length}`);
    }
    if (JSON.stringify(before.workTypeIds) !== JSON.stringify(after.workTypeIds)) {
        parts.push('Work types changed');
    }
    if (JSON.stringify(before.minPay) !== JSON.stringify(after.minPay)) {
        parts.push(after.minPay.amount === null
            ? 'Minimum pay cleared'
            : `Minimum pay ${after.minPay.currency} ${after.minPay.amount} ${after.minPay.unit.toLowerCase()}`);
    }

    return parts.length ? parts.join('; ') : 'No content change';
};

/** An empty set, for the first render before anything is saved. */
export const EMPTY_CRITERIA = Object.freeze({
    jobTitles: [],
    keywordsInclude: [],
    keywordsExclude: [],
    excludedCompanies: [],
    locations: [],
    workTypeIds: [],
    minPay: { amount: null, unit: null, currency: 'USD' },
});
