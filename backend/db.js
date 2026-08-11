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

/**
 * Managed Postgres (Neon, Supabase, Render) hands out one connection string and
 * requires TLS. A local install has neither. Both are supported here so the
 * same code path serves development and deployment: set DATABASE_URL and the
 * discrete DB_* vars are ignored.
 *
 * rejectUnauthorized:false encrypts the traffic without shipping the provider's
 * CA bundle. It does not prove which server answered, which is why DB_SSL is
 * opt-in rather than always on — a self-hosted database on a private network
 * should not silently get the weaker check.
 */
export const dbConnection = () => {
    const base = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT ?? 5432),
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
        };

    return process.env.DB_SSL === 'true'
        ? { ...base, ssl: { rejectUnauthorized: false } }
        : base;
};

export const pool = new Pool({
    ...dbConnection(),
    max: 10,
    idleTimeoutMillis: 30_000,
    // 10s, not 5s: a free-tier database that scales to zero between bursts can
    // take several seconds to wake, and that wake happens on a real request.
    connectionTimeoutMillis: 10_000,
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
