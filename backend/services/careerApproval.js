/**
 * ── THE CAREER HALF OF ONE MERGED APPROVAL ────────────────────────────
 *
 * Everything a consultant's career record needs on top of the existing
 * field-by-field change-request engine in controllers/profileChangeController.js.
 *
 * ── WHY THIS IS A SNAPSHOT, NOT A DIFF-PER-ROW ────────────────────────
 *
 * Phone and city are one value each, so "old value, new value" is the whole
 * story. Skills, jobs, education and projects are each a LIST, and a
 * consultant's edit is "here is the whole list now" — three added, one
 * removed, the rest reordered. Modelling that as individual field rows would
 * mean inventing a synthetic field name per list item, and two submissions
 * touching the same list would collide.
 *
 * So a submission captures the FULL proposed array per section. Approving is
 * "replace the live rows with this array" — simple, auditable, and it cannot
 * half-apply the way a sequence of individual adds and deletes could if one
 * step failed partway through.
 *
 * ── WHY SKILLS RESOLVE AT SUBMIT TIME, NOT AT REVIEW TIME ─────────────
 *
 * A consultant typing "Kubernetes" or "k8s" needs to resolve to the SAME
 * lkp_skills row either way — see config/skills.js — and that resolution
 * should happen once, when the consultant is looking at their own
 * autocomplete, not silently again days later when a reviewer clicks Approve.
 * The snapshot stores resolved skill ids, not raw text.
 */
import { query, withTransaction } from '../db.js';
import { SECTIONS } from '../controllers/profileSectionsController.js';
import { resolveSkill, consultantSkills } from '../config/skills.js';

const CAREER_SECTIONS = ['education', 'experience', 'projects', 'certifications'];

/**
 * Everything a consultant's LIVE (approved) career record holds right now.
 *
 * This is deliberately the exact shape profileSectionsController's
 * `getFullProfile` returns for these keys, so a diff against it is comparing
 * like with like.
 */
export const loadLiveCareer = async (consultantId) => {
    const out = { skills: await consultantSkills(consultantId) };
    for (const name of CAREER_SECTIONS) {
        const { table, columns } = SECTIONS[name];
        const { rows } = await query(
            `SELECT id, ${columns.join(', ')}, position FROM ${table}
              WHERE consultant_id = $1 ORDER BY position, created_at`,
            [consultantId],
        );
        out[name] = rows;
    }
    return out;
};

/**
 * Validate and normalise a proposed career payload.
 *
 * Reuses the EXACT Joi schemas the self-service management endpoints already
 * validate against (`SECTIONS[name].schema`), so a rule tightened there —
 * a max length, a required field — takes effect here automatically rather
 * than needing to be duplicated and kept in sync by hand.
 *
 * `payload` has whichever of {skills, education, experience, projects,
 * certifications} the consultant actually touched. A section absent from
 * the payload is left out of the result entirely — see the migration's
 * header for why that has to stay distinguishable from "submitted empty".
 *
 * @returns {{ ok: true, snapshot }} | {{ ok: false, error }}
 */
export const buildCareerSnapshot = async (payload) => {
    const snapshot = {};

    for (const name of CAREER_SECTIONS) {
        if (!Object.hasOwn(payload, name)) continue;
        const items = Array.isArray(payload[name]) ? payload[name] : [];
        if (items.length > 100) {
            return { ok: false, error: `Too many entries in ${name} — 100 is the limit.` };
        }

        const schema = SECTIONS[name].schema;
        const cleaned = [];
        for (const [i, raw] of items.entries()) {
            const { error, value } = schema.validate(raw, {
                abortEarly: false, stripUnknown: true, convert: true,
            });
            if (error) {
                return {
                    ok: false,
                    error: `${SECTIONS[name].label}, entry ${i + 1}: `
                        + error.details.map((d) => d.message.replace(/"/g, '')).join('; '),
                };
            }
            cleaned.push({ ...value, position: i });
        }
        snapshot[name] = cleaned;
    }

    if (Object.hasOwn(payload, 'skills')) {
        const items = Array.isArray(payload.skills) ? payload.skills : [];
        if (items.length > 200) {
            return { ok: false, error: 'Too many skills — 200 is the limit.' };
        }

        const resolved = [];
        const seen = new Set();
        for (const [i, s] of items.entries()) {
            // Same resolution rule the live autocomplete already used: an id
            // from the picker is trusted as-is; typed text goes through
            // resolveSkill, which checks aliases before minting anything new.
            let skillId = s?.skillId ?? null;
            let name = null;
            if (!skillId) {
                const found = await resolveSkill(s?.name);
                if (!found) continue;              // silently drop an empty entry
                skillId = found.id;
                name = found.name;
            }
            if (seen.has(skillId)) continue;        // the same skill twice collapses to one
            seen.add(skillId);

            resolved.push({
                skillId,
                name,
                years: Number.isFinite(Number(s?.years)) ? Number(s.years) : null,
                proficiency: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'].includes(s?.proficiency)
                    ? s.proficiency : null,
                position: i,
            });
        }

        // The picker-supplied path above trusts the id but not the label, so
        // any row it resolved by id alone still has `name: null` here — look
        // those up in one batch rather than trusting client-supplied text
        // (which could be stale or, from an untrusted caller, spoofed).
        const unnamed = resolved.filter((r) => r.name === null);
        if (unnamed.length > 0) {
            const { rows: named } = await query(
                'SELECT id, name FROM lkp_skills WHERE id = ANY($1::int[])',
                [unnamed.map((r) => r.skillId)],
            );
            const nameById = new Map(named.map((r) => [r.id, r.name]));
            for (const r of unnamed) r.name = nameById.get(r.skillId) ?? null;
        }
        snapshot.skills = resolved;
    }

    return { ok: true, snapshot };
};

/** A value's shape, stripped of anything that cannot affect the comparison. */
const normaliseForCompare = (row, columns) => Object.fromEntries(
    columns.map((c) => [c, row[c] ?? null]),
);

/**
 * Does the proposed snapshot actually differ from what is live?
 *
 * Order counts — it is the printed order on the resume — so a mere reshuffle
 * of the same rows IS a real change, not a no-op. Field content is compared
 * with the row's own id stripped out, since a freshly-submitted row has none.
 *
 * @returns {{ changed: boolean, summary: string[] }}
 *   `summary` is a short, human list for the audit log and the reviewer
 *   screen — "3 skills added", "1 role added, 1 removed" — computed once here
 *   rather than re-derived wherever it is displayed.
 */
export const diffCareer = (live, snapshot) => {
    const summary = [];
    let changed = false;

    if (Object.hasOwn(snapshot, 'skills')) {
        const liveIds = new Set(live.skills.map((s) => s.skill_id));
        const proposedIds = new Set(snapshot.skills.map((s) => s.skillId));
        const added = [...proposedIds].filter((id) => !liveIds.has(id));
        const removed = [...liveIds].filter((id) => !proposedIds.has(id));
        const reordered = live.skills.length === snapshot.skills.length
            && added.length === 0
            && live.skills.some((s, i) => s.skill_id !== snapshot.skills[i]?.skillId);

        if (added.length || removed.length || reordered) {
            changed = true;
            const parts = [];
            if (added.length) parts.push(`${added.length} skill${added.length === 1 ? '' : 's'} added`);
            if (removed.length) parts.push(`${removed.length} removed`);
            if (reordered && !added.length && !removed.length) parts.push('reordered');
            summary.push(parts.join(', '));
        }
    }

    for (const name of CAREER_SECTIONS) {
        if (!Object.hasOwn(snapshot, name)) continue;
        const { columns, label } = SECTIONS[name];
        const liveRows = live[name].map((r) => normaliseForCompare(r, columns));
        const proposedRows = snapshot[name].map((r) => normaliseForCompare(r, columns));

        const same = liveRows.length === proposedRows.length
            && liveRows.every((r, i) => JSON.stringify(r) === JSON.stringify(proposedRows[i]));
        if (same) continue;

        changed = true;
        const delta = proposedRows.length - liveRows.length;
        summary.push(delta === 0
            ? `${label} updated`
            : delta > 0
                ? `${delta} ${label} entr${delta === 1 ? 'y' : 'ies'} added`
                : `${-delta} ${label} entr${-delta === 1 ? 'y' : 'ies'} removed`);
    }

    return { changed, summary };
};

/**
 * Replace a consultant's live career rows with an approved snapshot.
 *
 * Runs inside the caller's transaction — see reviewChangeRequest — so this
 * and the identity-field UPDATE either both land or neither does. DELETE then
 * INSERT rather than a row-by-row merge: the snapshot IS the whole intended
 * state, and reconciling it against whatever the live rows happen to be
 * (which may have moved if an admin edited directly) is exactly the class of
 * bug a wholesale replace avoids.
 */
export const applyCareerSnapshot = async (client, { orgId, consultantId, snapshot }) => {
    if (Object.hasOwn(snapshot, 'skills')) {
        await client.query('DELETE FROM consultant_skills WHERE consultant_id = $1', [consultantId]);
        for (const s of snapshot.skills) {
            await client.query(
                `INSERT INTO consultant_skills
                    (id, organization_id, consultant_id, skill_id, years, proficiency, position)
                 VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6)`,
                [orgId, consultantId, s.skillId, s.years, s.proficiency, s.position],
            );
        }
    }

    for (const name of CAREER_SECTIONS) {
        if (!Object.hasOwn(snapshot, name)) continue;
        const { table, columns, jsonColumns = [] } = SECTIONS[name];

        await client.query(`DELETE FROM ${table} WHERE consultant_id = $1`, [consultantId]);

        for (const row of snapshot[name]) {
            const values = columns.map((c) => (jsonColumns.includes(c)
                ? JSON.stringify(row[c] ?? [])
                : row[c] ?? null));
            const placeholders = columns.map((c, i) => (jsonColumns.includes(c)
                ? `$${i + 4}::jsonb` : `$${i + 4}`)).join(', ');

            await client.query(
                `INSERT INTO ${table}
                    (id, organization_id, consultant_id, position, ${columns.join(', ')})
                 VALUES (gen_random_uuid()::text,$1,$2,$3, ${placeholders})`,
                [orgId, consultantId, row.position, ...values],
            );
        }
    }
};
