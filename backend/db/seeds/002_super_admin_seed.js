/**
 * Seed 002 — the platform SUPER_ADMIN.
 *
 * This is the bootstrap account: the only user with organization_id = NULL.
 * Everything else in the system is created through the UI starting from here.
 *
 * Credentials come from .env so they are not hard-coded in the repo:
 *   SEED_SUPER_ADMIN_EMAIL, SEED_SUPER_ADMIN_PASSWORD, SEED_SUPER_ADMIN_NAME
 *
 * Idempotent: re-running updates the name but never resets the password, so a
 * changed password survives a later `npm run migrate`.
 */
import { v4 as uuidv4 } from 'uuid';
import { encryptPassword } from '../../utils/crypto.js';

export const runSeed002 = async (connection) => {
    console.log('Seeding super admin...');

    const email = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@staffing.local';
    const password = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'SuperAdmin@123';
    const name = process.env.SEED_SUPER_ADMIN_NAME ?? 'Platform Owner';

    const { rows } = await connection.query(
        'SELECT id FROM users WHERE email = $1',
        [email],
    );

    if (rows.length > 0) {
        await connection.query(
            'UPDATE users SET name = $1, is_active = TRUE WHERE id = $2',
            [name, rows[0].id],
        );
        console.log(`  ✓ super admin already exists (${email}) — password untouched`);
        return;
    }

    const { enc, iv, tag } = encryptPassword(password);
    const id = uuidv4();

    await connection.query(
        `INSERT INTO users
            (id, organization_id, name, email, role,
             password_enc, password_iv, password_tag, is_active, created_by)
         VALUES ($1, NULL, $2, $3, 'SUPER_ADMIN', $4, $5, $6, TRUE, $1)`,
        [id, name, email, enc, iv, tag],
    );

    console.log(`  ✓ super admin created: ${email} / ${password}`);
};
