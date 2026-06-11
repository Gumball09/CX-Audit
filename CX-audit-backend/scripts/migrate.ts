/**
 * Apply scripts/schema.sql to the Postgres/Supabase database in DATABASE_URL.
 * Idempotent (all statements are CREATE ... IF NOT EXISTS).
 *
 *   npm run db:migrate
 *
 * Alternatively, paste scripts/schema.sql into the Supabase SQL editor.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../src/lib/db.js";
import { env } from "../src/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set in .env.local — add your Supabase connection string first.");
    process.exit(1);
  }
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  console.log("Applying schema to the database...");
  await pool.query(sql);
  console.log("✓ Schema applied. Tables: cx_users, cx_teams, cx_audits, cx_recording_patterns, cx_performance, cx_settings");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
