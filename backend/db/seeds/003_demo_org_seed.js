/**
 * Seed 003 — demo tenant for RBAC testing.
 *
 * Creates TWO organisations so cross-tenant isolation is actually testable:
 * a user in Org A must never see anything belonging to Org B.
 *
 *   Molina Staffing (molina)
 *     admin@molina.local        ORG_ADMIN    Admin@123
 *     recruiter1@molina.local   RECRUITER    Recruiter@123
 *     recruiter2@molina.local   RECRUITER    Recruiter@123
 *     consultant1..4@molina.local CONSULTANT Consultant@123
 *       c1, c2 -> recruiter1      c3, c4 -> recruiter2
 *
 *   Apex Staffing (apex)
 *     admin@apex.local          ORG_ADMIN    Admin@123
 *     recruiter1@apex.local     RECRUITER    Recruiter@123
 *     consultant1@apex.local    CONSULTANT   Consultant@123
 *
 * Idempotent: existing users are left alone (passwords never reset).
 */
import { v4 as uuidv4 } from 'uuid';
import { encryptPassword } from '../../utils/crypto.js';

const upsertOrg = async (connection, { name, slug }) => {
    const existing = await connection.query(
        'SELECT id FROM organizations WHERE slug = $1',
        [slug],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;

    const id = uuidv4();
    await connection.query(
        `INSERT INTO organizations (id, name, slug, is_active)
         VALUES ($1, $2, $3, TRUE)`,
        [id, name, slug],
    );
    return id;
};

const upsertUser = async (connection, { orgId, name, email, role, password }) => {
    const existing = await connection.query(
        'SELECT id FROM users WHERE email = $1',
        [email],
    );
    if (existing.rows.length > 0) return existing.rows[0].id;

    const { enc, iv, tag } = encryptPassword(password);
    const id = uuidv4();

    await connection.query(
        // is_active is a generated column now — employment_status drives it,
        // and it defaults to ACTIVE.
        `INSERT INTO users
            (id, organization_id, name, email, role,
             password_enc, password_iv, password_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, orgId, name, email, role, enc, iv, tag],
    );
    return id;
};

const assign = async (connection, { orgId, consultantId, recruiterId }) => {
    const existing = await connection.query(
        `SELECT id FROM assignments
         WHERE consultant_id = $1 AND effective_to IS NULL`,
        [consultantId],
    );
    if (existing.rows.length > 0) return;

    await connection.query(
        `INSERT INTO assignments
            (id, organization_id, consultant_id, recruiter_id, effective_from)
         VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
        [uuidv4(), orgId, consultantId, recruiterId],
    );
};

/**
 * Phase 3 demo criteria. Writes the versions in order, so version numbers and
 * the current pointer end up exactly as a real sequence of saves would leave
 * them — rather than a hand-built end state that could not have been reached
 * through the API.
 *
 * Idempotent: if the consultant already has any version, this does nothing.
 */
const seedCriteria = async (connection, { orgId, consultantId, authorId, isActive, versions }) => {
    const existing = await connection.query(
        'SELECT 1 FROM search_criteria_versions WHERE consultant_id = $1 LIMIT 1',
        [consultantId],
    );
    if (existing.rows.length > 0) return;

    await connection.query(
        `INSERT INTO search_criteria (consultant_id, organization_id, is_active, created_by, updated_by)
         VALUES ($1,$2,FALSE,$3,$3)
         ON CONFLICT (consultant_id) DO NOTHING`,
        [consultantId, orgId, authorId],
    );

    const KINDS = {
        jobTitles: 'JOB_TITLE',
        keywordsInclude: 'KEYWORD_INCLUDE',
        keywordsExclude: 'KEYWORD_EXCLUDE',
        excludedCompanies: 'EXCLUDED_COMPANY',
    };

    let versionId = null;
    for (let n = 0; n < versions.length; n += 1) {
        const v = versions[n];
        versionId = uuidv4();

        await connection.query(
            'UPDATE search_criteria_versions SET is_current = FALSE WHERE consultant_id = $1 AND is_current',
            [consultantId],
        );
        await connection.query(
            `INSERT INTO search_criteria_versions
                (id, organization_id, consultant_id, version_no, is_current,
                 min_pay_amount, min_pay_unit, min_pay_currency, change_note, created_by)
             VALUES ($1,$2,$3,$4,TRUE,$5,$6,'USD',$7,$8)`,
            [versionId, orgId, consultantId, n + 1,
                v.minPay?.amount ?? null, v.minPay?.unit ?? null, v.changeNote, authorId],
        );

        for (const [key, kind] of Object.entries(KINDS)) {
            const values = v[key] ?? [];
            for (let i = 0; i < values.length; i += 1) {
                await connection.query(
                    `INSERT INTO search_criteria_terms
                        (id, version_id, organization_id, kind, value, position)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [uuidv4(), versionId, orgId, kind, values[i], i],
                );
            }
        }

        for (let i = 0; i < (v.locations ?? []).length; i += 1) {
            const l = v.locations[i];
            await connection.query(
                `INSERT INTO search_criteria_locations
                    (id, version_id, organization_id, city, state, work_mode, radius_miles, position)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [uuidv4(), versionId, orgId, l.city, l.state, l.workMode, l.radiusMiles, i],
            );
        }

        for (const name of v.workTypes ?? []) {
            await connection.query(
                `INSERT INTO search_criteria_work_types (version_id, work_type_id, organization_id)
                 SELECT $1, id, $2 FROM lkp_work_types WHERE name = $3`,
                [versionId, orgId, name],
            );
        }
    }

    await connection.query(
        `UPDATE search_criteria
            SET current_version_id = $1, is_active = $2, updated_by = $3,
                paused_at = CASE WHEN $2 THEN NULL ELSE now() END
          WHERE consultant_id = $4`,
        [versionId, isActive, authorId, consultantId],
    );
};

export const runSeed003 = async (connection) => {
    console.log('Seeding demo organisations...');

    // ── Org A: Molina Staffing ──────────────────────────────────────
    const molinaId = await upsertOrg(connection, {
        name: 'Molina Staffing',
        slug: 'molina',
    });

    await upsertUser(connection, {
        orgId: molinaId, name: 'Molina Admin',
        email: 'admin@molina.local', role: 'ORG_ADMIN', password: 'Admin@123',
    });

    const r1 = await upsertUser(connection, {
        orgId: molinaId, name: 'Riya Recruiter',
        email: 'recruiter1@molina.local', role: 'RECRUITER', password: 'Recruiter@123',
    });
    const r2 = await upsertUser(connection, {
        orgId: molinaId, name: 'Rahul Recruiter',
        email: 'recruiter2@molina.local', role: 'RECRUITER', password: 'Recruiter@123',
    });

    const consultants = [];
    for (let i = 1; i <= 4; i += 1) {
        consultants.push(await upsertUser(connection, {
            orgId: molinaId, name: `Consultant ${i}`,
            email: `consultant${i}@molina.local`,
            role: 'CONSULTANT', password: 'Consultant@123',
        }));
    }

    await assign(connection, { orgId: molinaId, consultantId: consultants[0], recruiterId: r1 });
    await assign(connection, { orgId: molinaId, consultantId: consultants[1], recruiterId: r1 });
    await assign(connection, { orgId: molinaId, consultantId: consultants[2], recruiterId: r2 });
    await assign(connection, { orgId: molinaId, consultantId: consultants[3], recruiterId: r2 });

    // Phase 3 — two consultants get realistic criteria so the editor, the
    // version history and the paused/not-set-up states are all visible
    // without anyone typing them in first.
    //
    // Consultant 1  active, two versions, so the history and diff have
    //               something real to show
    // Consultant 2  saved but PAUSED
    // Consultants 3 and 4  left untouched, to exercise "Not set up"
    await seedCriteria(connection, {
        orgId: molinaId, consultantId: consultants[0], authorId: r1, isActive: true,
        versions: [
            {
                changeNote: 'Initial brief from intake call',
                jobTitles: ['React Developer', 'Frontend Engineer'],
                keywordsInclude: ['React', 'TypeScript'],
                keywordsExclude: ['Unpaid'],
                excludedCompanies: ['Acme Staffing'],
                locations: [{ city: 'Dallas', state: 'TX', workMode: 'ONSITE', radiusMiles: 40 }],
                workTypes: ['CONTRACT', 'W2'],
                minPay: { amount: 55, unit: 'HOURLY' },
            },
            {
                changeNote: 'Widened to remote after two weeks with no matches',
                jobTitles: ['React Developer', 'Frontend Engineer', 'Full Stack Engineer'],
                keywordsInclude: ['React', 'TypeScript', 'Next.js'],
                keywordsExclude: ['Unpaid', 'Internship'],
                excludedCompanies: ['Acme Staffing'],
                locations: [
                    { city: 'Dallas', state: 'TX', workMode: 'HYBRID', radiusMiles: 40 },
                    { city: null, state: null, workMode: 'REMOTE', radiusMiles: null },
                ],
                workTypes: ['CONTRACT', 'W2', 'C2C'],
                minPay: { amount: 60, unit: 'HOURLY' },
            },
        ],
    });

    await seedCriteria(connection, {
        orgId: molinaId, consultantId: consultants[1], authorId: r1, isActive: false,
        versions: [
            {
                changeNote: 'On hold while visa paperwork clears',
                jobTitles: ['Data Analyst'],
                keywordsInclude: ['SQL', 'Power BI'],
                keywordsExclude: [],
                excludedCompanies: [],
                locations: [{ city: 'Austin', state: 'TX', workMode: 'REMOTE', radiusMiles: null }],
                workTypes: ['FULL_TIME'],
                minPay: { amount: 95000, unit: 'ANNUAL' },
            },
        ],
    });

    // ── Org B: Apex Staffing (exists to prove tenant isolation) ─────
    const apexId = await upsertOrg(connection, {
        name: 'Apex Staffing',
        slug: 'apex',
    });

    await upsertUser(connection, {
        orgId: apexId, name: 'Apex Admin',
        email: 'admin@apex.local', role: 'ORG_ADMIN', password: 'Admin@123',
    });
    const apexR1 = await upsertUser(connection, {
        orgId: apexId, name: 'Apex Recruiter',
        email: 'recruiter1@apex.local', role: 'RECRUITER', password: 'Recruiter@123',
    });
    const apexC1 = await upsertUser(connection, {
        orgId: apexId, name: 'Apex Consultant',
        email: 'consultant1@apex.local', role: 'CONSULTANT', password: 'Consultant@123',
    });
    await assign(connection, { orgId: apexId, consultantId: apexC1, recruiterId: apexR1 });

    console.log('  ✓ Molina Staffing: 1 admin, 2 recruiters, 4 consultants (assigned 2+2)');
    console.log('  ✓ Apex Staffing:   1 admin, 1 recruiter, 1 consultant');
};
