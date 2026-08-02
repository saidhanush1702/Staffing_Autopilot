/**
 * Seed 001 — lookup tables.
 * Idempotent: safe to run on every migrate.
 */
export const runSeed001 = async (connection) => {
    console.log('Seeding lookups...');

    const genders = ['Male', 'Female', 'Other', 'Prefer not to say'];
    for (const name of genders) {
        await connection.query(
            `INSERT INTO lkp_genders (name) VALUES ($1)
             ON CONFLICT (name) DO NOTHING`,
            [name],
        );
    }

    const userStatuses = ['Active', 'Disabled', 'Invited'];
    for (const name of userStatuses) {
        await connection.query(
            `INSERT INTO lkp_user_statuses (name) VALUES ($1)
             ON CONFLICT (name) DO NOTHING`,
            [name],
        );
    }

    const workAuth = [
        'US Citizen', 'Green Card', 'H1-B', 'OPT', 'CPT', 'TN', 'Other',
    ];
    for (const name of workAuth) {
        await connection.query(
            `INSERT INTO lkp_work_auth_statuses (name) VALUES ($1)
             ON CONFLICT (name) DO NOTHING`,
            [name],
        );
    }

    const roles = [
        { name: 'SUPER_ADMIN', label: 'Super Admin' },
        { name: 'ORG_ADMIN', label: 'Organization Admin' },
        { name: 'RECRUITER', label: 'Recruiter' },
        { name: 'CONSULTANT', label: 'Consultant' },
    ];
    for (const r of roles) {
        await connection.query(
            `INSERT INTO lkp_roles (name, label) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label`,
            [r.name, r.label],
        );
    }

    console.log('  ✓ lookups seeded');
};
