/**
 * Custom migration runner (PostgreSQL).
 *
 *   node migrate.js
 *
 * Behaviour
 *   - Reads db/migrations/*.sql, sorted by 3-digit prefix.
 *   - Skips anything already recorded in schema_migrations.
 *   - Runs each remaining file INSIDE ITS OWN TRANSACTION and rolls back on
 *     failure, so a broken file never leaves the schema half-applied.
 *   - Exits with code 1 on any failure so CI catches it.
 *   - Then runs seed functions, each on its own individually-commentable line.
 *
 * Connects as migrator_role (DB_MIGRATION_USER), not the runtime app_role.
 *
 * Note: unlike the MySQL reference, statements are NOT split on ';'. node-pg
 * executes a multi-statement string natively, so functions, triggers and
 * DO $$ ... $$ blocks work without needing to be isolated in their own file.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { runSeed001 } from './db/seeds/001_lookups_seed.js';
import { runSeed002 } from './db/seeds/002_super_admin_seed.js';
import { runSeed003 } from './db/seeds/003_demo_org_seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'db', 'migrations');

const pool = new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_MIGRATION_USER,
    password: process.env.DB_MIGRATION_PASS,
    max: 2,
});

const ensureMigrationsTable = async (client) => {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            migration_name VARCHAR(255) UNIQUE NOT NULL,
            executed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
};

const getExecuted = async (client) => {
    const { rows } = await client.query('SELECT migration_name FROM schema_migrations');
    return new Set(rows.map((r) => r.migration_name));
};

const runMigrations = async (client) => {
    await ensureMigrationsTable(client);
    const executed = await getExecuted(client);

    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    const pending = files.filter((f) => !executed.has(f));

    if (pending.length === 0) {
        console.log('✅ No pending migrations. Schema is up to date.');
        return;
    }

    console.log(`Applying ${pending.length} migration(s)...\n`);

    for (const file of pending) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const started = Date.now();

        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(
                'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
                [file],
            );
            await client.query('COMMIT');
            console.log(`✅ Migration ${file} applied (${Date.now() - started}ms)`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`\n❌ Migration ${file} FAILED — rolled back.`);
            console.error(`   ${err.message}\n`);
            throw err;
        }
    }
};

const main = async () => {
    const client = await pool.connect();
    let failed = false;

    try {
        await runMigrations(client);

        console.log('\nRunning seeds...\n');
        await runSeed001(client);   // lookups
        await runSeed002(client);   // super admin
        await runSeed003(client);   // demo organisation + users + assignments
        console.log('\n✅ All migrations and seeds completed.');
    } catch (err) {
        failed = true;
        console.error('Migration run aborted:', err.message);
    } finally {
        client.release();
        await pool.end();
        process.exit(failed ? 1 : 0);
    }
};

main();
