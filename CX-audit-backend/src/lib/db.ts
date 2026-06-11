import pkg from "pg";
import { env } from "../env.js";
import { logger } from "../logger.js";

const { Pool, types } = pkg;

// node-postgres returns bigint (int8) and numeric as strings to avoid precision
// loss. Our values fit safely in a JS number, and the app's domain types expect
// numbers — so parse them back. (Scores, counts, thresholds.)
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric

const isLocal = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL);

/**
 * Shared Postgres connection pool (Supabase). Construction is lazy — no socket
 * is opened until the first query — so importing this module is safe even
 * without DATABASE_URL set (e.g. in unit tests).
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL || undefined,
  ssl: env.DATABASE_SSL && !isLocal ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000,
  keepAlive: true, // hold connections open — fewer reconnects over a flaky link
  connectionTimeoutMillis: 15_000,
});

pool.on("error", (err) => logger.error("Unexpected Postgres pool error", err));

/** Run a parameterized query and return the rows. */
export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

/** Run a query and return the first row (or null). */
export async function queryOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const res = await pool.query(text, params);
  return (res.rows[0] as T) ?? null;
}

/** Run a statement and return how many rows it affected. */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(text, params);
  return res.rowCount ?? 0;
}
