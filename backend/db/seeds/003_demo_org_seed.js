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
