/**
 * ── FROM A PARSED RESUME TO THE PROFILE FORM ──────────────────────────
 *
 * "Fill with resume" reads a resume the consultant picked from their own
 * computer and turns it into values for the profile form. This file is the
 * translation step: the parsed resume has one shape (config/resumeSchema.js),
 * the profile form another (config/profileFields.js and the four section
 * schemas), and they disagree in small ways — a resume has one `location` line
 * where the profile wants a city and a state, "Present" where the profile wants
 * an is_current flag, "B.Tech" where it wants a level.
 *
 * ── WHAT IS DELIBERATELY LEFT BLANK ───────────────────────────────────
 *
 * Work authorization, and the headline. A resume does not say whether someone
 * may work in the United States, and guessing it would put a legal claim in a
 * consultant's mouth. A headline would have to be invented from a job title.
 * Anything this cannot read with confidence is left empty for the person to
 * fill in, which is always safer than a plausible wrong answer.
 *
 * ── WHY EVERYTHING IS VALIDATED AGAIN HERE ────────────────────────────
 *
 * The values come from a model. Each row is run through the SAME schema the
 * profile submission uses, and one that would be rejected there is dropped here
 * and counted, so the form is never filled with something it would refuse to
 * submit. The person still reviews and edits every value — nothing is saved by
 * this step — and the normal approval gate still applies afterwards.
 */
import { SECTIONS } from '../controllers/profileSectionsController.js';
import { PROFILE_FIELDS } from '../config/profileFields.js';

const clean = (v, max = 255) => {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
};

const matches = (field, value) => {
    const rule = PROFILE_FIELDS[field]?.pattern;
    return !rule || new RegExp(rule).test(value);
};

/* ── contact ───────────────────────────────────────────────────────── */

/** Ten digits, or null. A leading US country code is dropped; anything else is not guessed at. */
export const phoneOf = (raw) => {
    let digits = String(raw ?? '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return digits.length === 10 ? digits : null;
};

const place = (part) => {
    const t = clean(part, 120);
    if (!t) return null;
    const stripped = t.replace(/[^A-Za-z .'-]/g, '').trim();
    return stripped && /^[A-Za-z]/.test(stripped) ? stripped : null;
};

/** "Dallas, TX" → { city: 'Dallas', state: 'TX' }. Whatever cannot be read is null. */
export const cityAndState = (location) => {
    const parts = String(location ?? '').split(',').map((p) => p.trim()).filter(Boolean);
    return { city: place(parts[0]), state: place(parts[1]) };
};

const withScheme = (raw) => {
    const t = clean(raw, 255);
    if (!t) return null;
    return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

const CODING_HOSTS = /(leetcode|hackerrank|codeforces|codechef|kaggle|hackerearth|geeksforgeeks)\./i;

/** Sort a resume's links into the profile's four link fields, by where they point. */
export const linksOf = (links = []) => {
    const out = {};
    for (const raw of links) {
        const url = withScheme(raw);
        if (!url) continue;
        if (/linkedin\.com/i.test(url)) {
            if (!out.linkedin_url && matches('linkedin_url', url)) out.linkedin_url = url;
        } else if (/github\.com/i.test(url)) {
            out.github_url ??= url;
        } else if (CODING_HOSTS.test(url)) {
            out.coding_profile_url ??= url;
        } else {
            out.portfolio_url ??= url;
        }
    }
    return out;
};

/* ── sections ──────────────────────────────────────────────────────── */

const CURRENT = /^(present|current|currently|now|ongoing|till date|to date|today)\b/i;
const isCurrent = (end) => CURRENT.test(String(end ?? '').trim());
const yearOf = (v) => {
    const m = String(v ?? '').match(/(19|20)\d{2}/);
    return m ? Number(m[0]) : null;
};

/** The education level a degree name implies, or OTHER when it does not say. */
export const levelOf = (degree, institution = '') => {
    const d = `${degree ?? ''} ${institution ?? ''}`.toLowerCase();
    if (/ph\.?\s?d|doctor/.test(d)) return 'DOCTORATE';
    if (/master|\bm\.?\s?tech|\bm\.?\s?sc\b|\bmba\b|\bmca\b|\bm\.?\s?com\b|\bm\.?\s?s\b|\bm\.?\s?e\b|\bm\.?\s?a\b/.test(d)) {
        return 'MASTERS';
    }
    if (/bachelor|\bb\.?\s?tech|\bb\.?\s?e\b|\bb\.?\s?sc\b|\bb\.?\s?com\b|\bbca\b|\bbba\b|\bb\.?\s?a\b|\bb\.?\s?s\b/.test(d)) {
        return 'BACHELORS';
    }
    if (/diploma|polytechnic/.test(d)) return 'DIPLOMA';
    if (/12th|higher secondary|senior secondary|intermediate|\bhsc\b|a[- ]level/.test(d)) {
        return 'SENIOR_SECONDARY';
    }
    if (/10th|\bssc\b|matric|gcse|secondary/.test(d)) return 'SECONDARY';
    return 'OTHER';
};

const list = (arr, max) => (Array.isArray(arr) ? arr.map((x) => clean(x, 2000)).filter(Boolean).slice(0, max) : []);

const validRows = (section, rows) => {
    const kept = [];
    let dropped = 0;
    for (const row of rows) {
        const { value, error } = SECTIONS[section].schema.validate(row, { stripUnknown: true, convert: true });
        if (error) dropped += 1; else kept.push(value);
    }
    return { kept, dropped };
};

/**
 * @param {object} doc  a validated parsed resume (config/resumeSchema.js)
 * @returns {{ fields, skills, experience, education, projects, certifications, report }}
 */
export const mapParsedResume = (doc) => {
    const fields = {};

    const phone = phoneOf(doc.contact?.phone);
    if (phone) fields.phone = phone;

    const { city, state } = cityAndState(doc.contact?.location);
    if (city && matches('city', city)) fields.city = city;
    if (state && matches('state', state)) fields.state = state;

    Object.assign(fields, linksOf(doc.contact?.links));

    const summary = clean(doc.summary, 4000);
    if (summary) fields.summary = summary;

    const seen = new Set();
    const skills = [];
    for (const group of doc.skills ?? []) {
        for (const item of group.items ?? []) {
            const name = clean(item, 80);
            if (name && !seen.has(name.toLowerCase())) {
                seen.add(name.toLowerCase());
                skills.push(name);
            }
        }
    }

    const experience = validRows('experience', (doc.experience ?? []).map((e) => {
        const current = isCurrent(e.endDate);
        return {
            company: clean(e.company),
            title: clean(e.title),
            location: clean(e.location),
            employment_type: null,
            start_date: clean(e.startDate, 40),
            end_date: current ? null : clean(e.endDate, 40),
            is_current: current,
            bullets: list(e.bullets, 20),
            tech_used: [],
        };
    }));

    const education = validRows('education', (doc.education ?? []).map((e) => {
        const current = isCurrent(e.endDate);
        return {
            level: levelOf(e.degree, e.institution),
            institution: clean(e.institution),
            board: null,
            degree: clean(e.degree),
            field_of_study: clean(e.field),
            location: null,
            start_year: yearOf(e.startDate),
            end_year: current ? null : yearOf(e.endDate),
            is_current: current,
            score: null,
            score_type: null,
            details: clean(e.details, 1000),
        };
    }));

    const projects = validRows('projects', (doc.projects ?? []).map((p) => ({
        name: clean(p.name),
        description: clean(p.description, 2000),
        duration: null,
        team_size: null,
        role: null,
        deployed_url: null,
        repo_url: null,
        bullets: list(p.bullets, 20),
        tech_used: [],
    })));

    const certifications = validRows('certifications', (doc.certifications ?? []).map((c) => ({
        kind: 'CERTIFICATION',
        name: clean(c.name),
        issuer: clean(c.issuer),
        issued_on: clean(c.date, 40),
        expires_on: null,
        credential_id: null,
        credential_url: null,
        details: null,
    })));

    return {
        fields,
        skills: skills.slice(0, 100),
        experience: experience.kept,
        education: education.kept,
        projects: projects.kept,
        certifications: certifications.kept,
        report: {
            fieldsFound: Object.keys(fields).length,
            skills: Math.min(skills.length, 100),
            experience: experience.kept.length,
            education: education.kept.length,
            projects: projects.kept.length,
            certifications: certifications.kept.length,
            // Rows the model returned that the profile would refuse — counted so
            // the person is told something was left out, not left guessing.
            unreadable: experience.dropped + education.dropped + projects.dropped + certifications.dropped,
        },
    };
};
