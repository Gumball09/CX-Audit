import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env.local");
dotenv.config({ path: envPath });

function getEnv(key: string, required: boolean = false, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (required && !value) {
    throw new Error(`Environment variable ${key} is required but not set in .env.local`);
  }
  return value ?? "";
}

export const env = {
  // ---- Server ----
  PORT: Number(getEnv("PORT", false, "4000")),
  NODE_ENV: getEnv("NODE_ENV", false, "development"),
  LOG_LEVEL: getEnv("LOG_LEVEL", false, "info"),
  CORS_ORIGIN: getEnv("CORS_ORIGIN", false, "*"),
  // Set to "1" when behind a load balancer / reverse proxy so rate limiting and
  // client IPs use X-Forwarded-For correctly.
  TRUST_PROXY: getEnv("TRUST_PROXY", false, "") === "1",

  // ---- Auth ----
  JWT_SECRET: getEnv("JWT_SECRET", false, "dev-insecure-secret-change-me"),
  JWT_EXPIRES_IN: getEnv("JWT_EXPIRES_IN", false, "12h"),

  // ---- AWS ----
  AWS_REGION: getEnv("AWS_REGION", false, "us-east-1"),
  AWS_ACCESS_KEY_ID: getEnv("AWS_ACCESS_KEY_ID", false),
  AWS_SECRET_ACCESS_KEY: getEnv("AWS_SECRET_ACCESS_KEY", false),
  // Set only when using temporary/STS credentials (e.g. assumed roles, SSO).
  AWS_SESSION_TOKEN: getEnv("AWS_SESSION_TOKEN", false),

  // ---- S3 ----
  // Source bucket holding the raw call recordings (read-only for this app).
  S3_RECORDING_BUCKET: getEnv("S3_RECORDING_BUCKET", false),
  // Optional key prefix to scope which recordings are processed (e.g. "Scaler/").
  S3_RECORDING_PREFIX: getEnv("S3_RECORDING_PREFIX", false, ""),
  // Destination bucket holding transcriptions + audit result files (read-write).
  S3_OUTPUT_BUCKET: getEnv("S3_OUTPUT_BUCKET", false),
  S3_TRANSCRIPTION_PREFIX: getEnv("S3_TRANSCRIPTION_PREFIX", false, "transcriptions/"),
  S3_AUDIT_PREFIX: getEnv("S3_AUDIT_PREFIX", false, "audits/"),

  // ---- SQS ----
  SQS_TRANSCRIPTION_QUEUE_URL: getEnv("SQS_TRANSCRIPTION_QUEUE_URL", false),
  SQS_AUDIT_QUEUE_URL: getEnv("SQS_AUDIT_QUEUE_URL", false),
  // How many messages a worker pulls per long-poll cycle (1-10).
  SQS_BATCH_SIZE: Number(getEnv("SQS_BATCH_SIZE", false, "5")),
  // Long-poll wait time in seconds (0-20).
  SQS_WAIT_TIME_SECONDS: Number(getEnv("SQS_WAIT_TIME_SECONDS", false, "20")),
  // After this many failed deliveries a message is routed to the DLQ. Used both
  // to provision the redrive policy and to escalate the "last attempt" to a
  // critical Sentry alert. Must match the queue's RedrivePolicy.maxReceiveCount.
  SQS_MAX_RECEIVE_COUNT: Number(getEnv("SQS_MAX_RECEIVE_COUNT", false, "5")),
  // Max messages a single worker processes in parallel. The worker only uses
  // as much concurrency as the queue has work for, and idles to ~0 when empty.
  WORKER_CONCURRENCY: Number(getEnv("WORKER_CONCURRENCY", false, "5")),

  // ---- DynamoDB ----
  DDB_USERS_TABLE: getEnv("DDB_USERS_TABLE", false, "cx_users"),
  DDB_TEAMS_TABLE: getEnv("DDB_TEAMS_TABLE", false, "cx_teams"),
  DDB_AUDITS_TABLE: getEnv("DDB_AUDITS_TABLE", false, "cx_audits"),

  // ---- OpenAI ----
  OPENAI_API_KEY: getEnv("OPENAI_API_KEY", false),
  OPENAI_TRANSCRIPTION_MODEL: getEnv("OPENAI_TRANSCRIPTION_MODEL", false, "whisper-1"),
  OPENAI_AUDIT_MODEL: getEnv("OPENAI_AUDIT_MODEL", false, "gpt-4-turbo-preview"),

  // ---- Sentry (error/alert reporting) ----
  // Leave SENTRY_DSN blank to disable reporting entirely (local/stub mode).
  SENTRY_DSN: getEnv("SENTRY_DSN", false),
  SENTRY_ENVIRONMENT: getEnv("SENTRY_ENVIRONMENT", false, ""),
  SENTRY_RELEASE: getEnv("SENTRY_RELEASE", false, ""),
  SENTRY_TRACES_SAMPLE_RATE: Number(getEnv("SENTRY_TRACES_SAMPLE_RATE", false, "0")),

  // ---- DynamoDB (extra tables for patterns + performance + settings) ----
  DDB_PATTERNS_TABLE: getEnv("DDB_PATTERNS_TABLE", false, "cx_recording_patterns"),
  DDB_PERFORMANCE_TABLE: getEnv("DDB_PERFORMANCE_TABLE", false, "cx_performance"),
  // Holds the singleton platform settings row (e.g. the OpenAI models the
  // super_admin selects at runtime). `OPENAI_*_MODEL` above are the fallbacks.
  DDB_SETTINGS_TABLE: getEnv("DDB_SETTINGS_TABLE", false, "cx_settings"),
  // Additional per-team rubrics (the team row holds the primary rubric).
  DDB_RUBRICS_TABLE: getEnv("DDB_RUBRICS_TABLE", false, "cx_rubrics"),
};

/**
 * Validates configuration on startup. In development, problems are logged as
 * warnings so the app can still boot for partial/local work. In production,
 * fatal misconfiguration throws so a broken instance never serves traffic.
 */
export function validateEnv(context: "api" | "worker" = "api") {
  const isProd = env.NODE_ENV === "production";
  const fatal: string[] = [];
  const warnings: string[] = [];

  // AWS / S3 are required everywhere.
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    // Allowed in prod ONLY if relying on an instance/role (default chain).
    warnings.push("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set — relying on the default credential chain (IAM role).");
  }
  (env.S3_RECORDING_BUCKET ? warnings : fatal).push(
    env.S3_RECORDING_BUCKET ? "" : "S3_RECORDING_BUCKET is not set."
  );
  (env.S3_OUTPUT_BUCKET ? warnings : fatal).push(
    env.S3_OUTPUT_BUCKET ? "" : "S3_OUTPUT_BUCKET is not set."
  );

  if (context === "worker") {
    if (!env.SQS_TRANSCRIPTION_QUEUE_URL) fatal.push("SQS_TRANSCRIPTION_QUEUE_URL is not set.");
    if (!env.SQS_AUDIT_QUEUE_URL) fatal.push("SQS_AUDIT_QUEUE_URL is not set.");
    if (!env.OPENAI_API_KEY) (isProd ? fatal : warnings).push("OPENAI_API_KEY missing — transcription/audit run in STUB mode.");
  }

  // Sentry is the production alerting channel — warn (don't fail) if it's off.
  if (isProd && !env.SENTRY_DSN) {
    warnings.push("SENTRY_DSN not set in production — crashes and quota-exhaustion alerts will NOT be reported.");
  }

  // JWT + CORS only matter to the API process, not the workers.
  if (context === "api") {
    if (env.JWT_SECRET === "dev-insecure-secret-change-me" || env.JWT_SECRET.length < 16) {
      (isProd ? fatal : warnings).push("JWT_SECRET is weak/default — set a strong random secret (e.g. `openssl rand -hex 32`).");
    }
    if (isProd && env.CORS_ORIGIN === "*") {
      warnings.push("CORS_ORIGIN is '*' in production — restrict it to the dashboard origin.");
    }
  }

  const realFatal = fatal.filter(Boolean);
  const realWarn = warnings.filter(Boolean);

  if (realWarn.length) {
    console.warn("⚠️  Configuration warnings:");
    realWarn.forEach((w) => console.warn(`  - ${w}`));
    console.warn("");
  }
  if (realFatal.length) {
    if (isProd) {
      throw new Error("Fatal configuration errors:\n" + realFatal.map((e) => `  - ${e}`).join("\n"));
    }
    console.warn("⚠️  Configuration errors (would be fatal in production):");
    realFatal.forEach((e) => console.warn(`  - ${e}`));
    console.warn("");
  }
}
