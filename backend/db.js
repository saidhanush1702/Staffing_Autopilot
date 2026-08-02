/**
 * PostgreSQL connection pool (runtime).
 *
 * Connects as app_role — CRUD only, no DDL. Schema changes go through
 * migrate.js, which connects as migrator_role instead. That separation is
 * what lets us revoke UPDATE/DELETE on audit tables from the runtime user.
 */
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle database client:', err);
});

/**
 * Run a single parameterised query.
 * Never interpolate values into the SQL string — always use $1, $2, ...
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Run a function inside a transaction. Commits on success, rolls back on throw.
 *
 *   const id = await withTransaction(async (client) => {
 *       await client.query('INSERT ...', [...]);
 *       return newId;
 *   });
 */
export const withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/** Verify the database is reachable. Called once at boot. */
export const assertDbConnection = async () => {
    const { rows } = await pool.query('SELECT current_user, current_database()');
    return rows[0];
};
