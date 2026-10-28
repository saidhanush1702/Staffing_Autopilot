/**
 * ── LEARNING FROM THE ONES THAT FAIL ──────────────────────────────────
 *
 * A job the app could not finish is information, and until now it was thrown
 * away: the reason went into a log line and the page that caused it was gone by
 * the next job. Fixing "Greenhouse stopped on this" then meant someone finding
 * the page again.
 *
 * Two things are kept instead.
 *
 * ── A SHAPE, NOT A PAGE ───────────────────────────────────────────────
 *
 * When a run ends without a finished form, the page's STRUCTURE is saved: the
 * headings, the labels and types of the fields, the text of the buttons, and
 * where the run stopped. From that a recipe can be corrected and a fixture
 * written for tests/ without having to reproduce the failure.
 *
 * What is NEVER saved is anything the consultant typed or anything the page
 * said about them: no field values, no body text, no query strings, and the
 * address has its identifiers replaced. Labels are the form's own words and
 * belong to the employer, not the applicant.
 *
 * ── A TALLY PER SYSTEM ────────────────────────────────────────────────
 *
 * Counts of how each system's runs ended. They answer the question that
 * decides what to build next — "which system loses us the most applications" —
 * with numbers instead of an impression.
 */
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 40;

/** /jobs/5183044008 → /jobs/:id, so a shape does not name a posting. */
const pathPattern = (url) => {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').map((seg) => (
            /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(seg) || /^\d{4,}$/.test(seg) ? ':id' : seg
        ));
        return `${u.host.replace(/^www\./, '')}${parts.join('/')}`;
    } catch {
        return null;
    }
};

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The structure of a page as the agent saw it, with nothing personal in it.
 *
 * @param observation  as built by agent/observe.js
 */
const shapeOf = (observation = {}) => ({
    title: clip(observation.title, 120),
    headings: (observation.headings ?? []).slice(0, 10).map((h) => clip(h, 120)),
    errors: (observation.errors ?? []).slice(0, 4).map((e) => clip(e, 160)),
    fields: (observation.fields ?? []).slice(0, 80).map((f) => ({
        type: f.type,
        label: clip(f.label, 160),
        required: Boolean(f.required),
        // Whether it held something, never what.
        filled: Boolean(f.value),
        options: Array.isArray(f.options) ? f.options.length : 0,
    })),
    controls: (observation.controls ?? []).slice(0, 45).map((c) => clip(c.text, 80)),
});

/**
 * Save the shape of a page a run could not finish.
 *
 * Best effort and silent: losing a fixture must never cost an application.
 *
 * @returns the file written, or null
 */
const captureFixture = ({
    dir, system, url, outcome, detail, observation,
}) => {
    if (!dir) return null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const at = new Date().toISOString();
        const file = path.join(dir, `${at.replace(/[:.]/g, '-')}-${String(system).toLowerCase()}.json`);
        fs.writeFileSync(file, JSON.stringify({
            at,
            system,
            where: pathPattern(url),
            outcome,
            detail: clip(detail, 300),
            shape: shapeOf(observation),
        }, null, 2), 'utf8');

        // Oldest out, so a long-running machine does not accumulate them.
        const all = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
        for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
            fs.rmSync(path.join(dir, old), { force: true });
        }
        return file;
    } catch {
        return null;
    }
};

/**
 * Count how a run on one system ended.
 *
 * @param stats  the stored tally, `{ [system]: { ready, handedOver, onHold, failed } }`
 * @returns the updated tally; the caller stores it
 */
const tally = (stats = {}, system, result) => {
    const key = String(system || 'UNKNOWN').toUpperCase();
    const bucket = { ready: 0, handedOver: 0, onHold: 0, failed: 0, ...(stats[key] ?? {}) };
    if (result in bucket) bucket[result] += 1;
    return { ...stats, [key]: bucket };
};

module.exports = {
    shapeOf, captureFixture, tally, pathPattern, KEEP,
};
