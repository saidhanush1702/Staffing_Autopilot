/**
 * ── RUN v1 AND v2 SIDE BY SIDE ON AN ORGANISATION'S OWN POSTINGS ──────
 *
 *   node scripts/matcher-compare.mjs [organisation name or id] [--limit 400] [--show 12]
 *
 * Read-only: it reads postings and consultants and writes nothing. This is the
 * "shadow" step before an organisation is switched to v2 — it answers, with the
 * organisation's real data, what would change:
 *
 *   · how many postings v1 and v2 each link to somebody
 *   · which jobs v2 would add, with the reason it gives
 *   · which jobs v2 would drop that v1 queued — these matter most, because a
 *     job v2 stops sending is a regression until proven otherwise
 *   · how many v2 would hand to a recruiter as a suggestion instead
 *
 * A consultant who is not on the bench (no active criteria) is invisible to both
 * matchers; the report says so up front rather than leaving it to be
 * rediscovered as "v2 matched nothing".
 */
import { query, pool } from '../db.js';
import { evaluate } from '../config/jobMatcher.js';
import { loadMatchableConsultants } from '../controllers/discoveryController.js';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
};
const target = process.argv.slice(2).find((a) => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--limit'
    && process.argv[process.argv.indexOf(a) - 1] !== '--show');
const limit = Number(arg('limit', 400));
const show = Number(arg('show', 12));

const { rows: orgs } = await query(
    target
        ? 'SELECT id, name FROM organizations WHERE id = $1 OR lower(name) = lower($1)'
        : 'SELECT id, name FROM organizations WHERE is_active ORDER BY created_at',
    target ? [target] : [],
);

for (const org of orgs) {
    const bench = await loadMatchableConsultants(org.id);
    const { rows: [{ n: total }] } = await query('SELECT count(*)::int n FROM users WHERE organization_id = $1 AND role = \'CONSULTANT\'', [org.id]);
    const { rows: postings } = await query(
        `SELECT p.id, p.company, p.title, p.description, p.location_text, p.is_remote,
                p.pay_min, p.pay_max, p.pay_unit, w.name AS work_type
           FROM job_postings p LEFT JOIN lkp_work_types w ON w.id = p.work_type_id
          WHERE p.organization_id = $1 AND p.is_active ORDER BY p.first_seen_at DESC LIMIT $2`,
        [org.id, limit],
    );
    if (postings.length === 0 || bench.length === 0) {
        console.log(`\n== ${org.name}: ${bench.length} of ${total} consultants on the bench, ${postings.length} postings — nothing to compare`);
        continue;
    }

    const stats = { v1: { linked: 0 }, v2: { auto: 0, suggest: 0, linked: 0 }, added: [], lost: [], pairs: { v1: 0, auto: 0, suggest: 0 } };
    for (const row of postings) {
        const posting = {
            company: row.company, title: row.title, description: row.description,
            locationText: row.location_text, isRemote: row.is_remote,
            payMin: row.pay_min == null ? null : Number(row.pay_min),
            payMax: row.pay_max == null ? null : Number(row.pay_max), payUnit: row.pay_unit,
        };
        let v1Any = false; let autoAny = false; let suggestAny = false;
        for (const c of bench) {
            const a = evaluate(posting, c.criteria, { workTypeName: row.work_type, version: 1 });
            const b = evaluate(posting, c.criteria, { workTypeName: row.work_type, version: 2 });
            if (a.matched) { v1Any = true; stats.pairs.v1 += 1; }
            if (b.bucket === 'AUTO') { autoAny = true; stats.pairs.auto += 1; }
            if (b.bucket === 'SUGGEST') { suggestAny = true; stats.pairs.suggest += 1; }
            if (b.bucket === 'AUTO' && !a.matched) stats.added.push({ c: c.name, row, b });
            if (a.matched && b.bucket !== 'AUTO') stats.lost.push({ c: c.name, row, a, b });
        }
        if (v1Any) stats.v1.linked += 1;
        if (autoAny) stats.v2.auto += 1;
        if (suggestAny) stats.v2.suggest += 1;
        if (autoAny || suggestAny) stats.v2.linked += 1;
    }

    const pct = (n) => `${Math.round((100 * n) / postings.length)}%`;
    console.log(`\n== ${org.name}`);
    console.log(`consultants on the bench: ${bench.length} of ${total}   postings compared: ${postings.length}`);
    console.log(`postings with at least one consultant:`);
    console.log(`   v1 queues         ${String(stats.v1.linked).padStart(4)}  (${pct(stats.v1.linked)})`);
    console.log(`   v2 queues         ${String(stats.v2.auto).padStart(4)}  (${pct(stats.v2.auto)})`);
    console.log(`   v2 suggests       ${String(stats.v2.suggest).padStart(4)}  (${pct(stats.v2.suggest)})   for a recruiter, not the queue`);
    console.log(`   v2 queue + suggest ${String(stats.v2.linked).padStart(3)}  (${pct(stats.v2.linked)})`);
    console.log(`consultant×job pairs: v1 ${stats.pairs.v1} · v2 queue ${stats.pairs.auto} · v2 suggest ${stats.pairs.suggest}`);
    console.log(`v2 would ADD ${stats.added.length} pairs, and would NOT queue ${stats.lost.length} that v1 queued`);

    const line = (x) => `   ${x.c.padEnd(22)} ${String(x.row.title).slice(0, 38).padEnd(38)} ${String(x.row.location_text ?? '').slice(0, 22).padEnd(22)}`;
    if (stats.added.length) {
        console.log('\nadded by v2 (sample):');
        for (const x of stats.added.slice(0, show)) console.log(`${line(x)} ${x.b.score}  ${String(x.b.reason).slice(0, 110)}`);
    }
    if (stats.lost.length) {
        console.log('\nqueued by v1, NOT queued by v2 — read these:');
        for (const x of stats.lost.slice(0, show)) console.log(`${line(x)} v1 ${x.a.score} → v2 ${x.b.bucket} ${x.b.score}  ${String(x.b.reason).slice(0, 90)}`);
    }
}
await pool.end();
