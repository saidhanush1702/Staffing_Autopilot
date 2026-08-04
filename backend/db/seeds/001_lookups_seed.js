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

    // Mirrors users.employment_status — see migration 015. `name` is the value
    // the database stores and the API returns; `label` is the UI text. If the
    // CHECK constraint on users.employment_status ever gains a state, add it
    // here too or the lookup starts lying again.
    const userStatuses = [
        { name: 'ACTIVE', label: 'Active' },
        { name: 'SUSPENDED', label: 'Suspended' },
        { name: 'TERMINATED', label: 'Terminated' },
    ];
    for (const s of userStatuses) {
        await connection.query(
            `INSERT INTO lkp_user_statuses (name, label) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label`,
            [s.name, s.label],
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

    // Engagement types a consultant will accept — Phase 3 search criteria.
    // `name` is what search_criteria_work_types references; `label` is the
    // only text any screen shows.
    const workTypes = [
        { name: 'CONTRACT', label: 'Contract' },
        { name: 'FULL_TIME', label: 'Full-time' },
        { name: 'PART_TIME', label: 'Part-time' },
        { name: 'C2C', label: 'Corp-to-Corp (C2C)' },
        { name: 'W2', label: 'W2' },
    ];
    for (const w of workTypes) {
        await connection.query(
            `INSERT INTO lkp_work_types (name, label) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET label = EXCLUDED.label`,
            [w.name, w.label],
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
