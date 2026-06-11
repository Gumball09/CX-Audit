// ---------------------------------------------------------------------------
// Shared domain types for the CX Audit platform.
// ---------------------------------------------------------------------------

/**
 * A CX team, identified by its slug (the `team_id`). Teams are created at
 * runtime by a super_admin (no longer a fixed enum), so this is an open string.
 * The original built-in teams are CS / RM / OORP / Escalations.
 */
export type Team = string;

/** RBAC roles. See docs/RBAC.md for the full permission matrix. */
export type Role = "super_admin" | "admin" | "user";

export type UserStatus = "active" | "inactive";

/**
 * A dashboard user. The same record also acts as the agent -> team mapping:
 * a `user` row carries the dialer `agent_id` so the audit worker can resolve
 * which team (and therefore which rubric) a recording should be scored against.
 */
export interface User {
  user_id: string;        // partition key (UUID-ish, e.g. "USR-<random>")
  email: string;          // login identity (unique, GSI email-index)
  name: string;
  role: Role;
  team: Team | null;      // null for org-wide super_admins
  agent_id: string | null; // dialer agent id, e.g. "495367" (GSI agent-index)
  status: UserStatus;
  // bcrypt hash of the login password. `null` until the user completes the
  // self-service first-login set-password step. NEVER sent to the client —
  // strip via `publicUser()` before returning a user in any API response.
  password_hash: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

/**
 * One scoring dimension within a team rubric.
 *
 * The rubric is intentionally flexible (not a fixed template): `weight` is a
 * *relative* weight that is normalized at scoring time, so admins are not forced
 * to make weights sum to exactly 100. `critical_threshold` optionally overrides
 * the rubric-wide critical threshold for this one dimension, and `guidance`
 * carries free-form extra instruction/examples for the auditor beyond the short
 * `description`.
 */
export interface Criterion {
  name: string;
  weight?: number;            // relative weight (default: equal share). Normalized at scoring.
  description: string;        // primary instruction passed to the LLM auditor
  guidance?: string;          // optional extended guidance / examples (free-form)
  critical_threshold?: number; // optional per-criterion critical override
}

/**
 * Per-team infrastructure overrides, supplied by the super_admin when
 * onboarding a team whose recordings live in their own S3 bucket / flow through
 * their own SQS queues. Any field left unset falls back to the global `env`
 * value, so the original shared teams keep working with no config. DynamoDB
 * tables stay global (shared, partitioned by team) — only the ingestion path
 * (buckets + queues + worker tuning) is per-team.
 */
export interface TeamInfra {
  recording_bucket?: string;        // S3 bucket the team's recordings land in
  output_bucket?: string;           // S3 bucket for this team's transcripts + audit docs
  transcription_queue_url?: string; // SQS queue fed by the team's recording bucket
  audit_queue_url?: string;         // SQS queue the transcribe stage hands off to
  batch_size?: number;              // SQS messages pulled per poll (1-10)
  wait_time_seconds?: number;       // SQS long-poll wait (0-20)
  max_receive_count?: number;       // deliveries before DLQ (must match the queue's redrive policy)
  worker_concurrency?: number;      // parallel jobs per worker loop for this team's queue
}

/**
 * A team record. Owns the team's audit rubric (single rubric today; becomes
 * many in a later change) AND its optional per-team infrastructure config.
 * Created/edited by a super_admin (rubric also editable by the team's admin).
 * Stored in the Teams table; `team_id` is the slug primary key.
 */
export interface TeamRubric {
  team_id: Team;                       // partition key (slug, e.g. "Sales")
  name: string;
  description: string;
  criteria: Criterion[];
  system_prompt: string;
  scale_max?: number;                  // max score per criterion (default 100)
  flag_threshold: number;              // overall score below this => flagged (default 70)
  critical_criterion_threshold: number; // any criterion below this => flagged (default 60)
  infra?: TeamInfra;                   // per-team buckets/queues/tuning (env fallback)
  active?: boolean;                    // soft-disable without deleting (default true)
  created_at?: string;
  created_by?: string | null;
  updated_at: string;
  updated_by: string | null;
}

/**
 * A super_admin-configurable regex for parsing recording filenames. Multiple
 * patterns are tried in `priority` order (lowest first = the "default"); the
 * first whose named capture groups yield a valid recording wins. Each match
 * increments `match_count`, and the most-used pattern is auto-promoted to the
 * default — so when the dialer's naming convention changes, the new format's
 * pattern naturally takes over without manual reordering.
 *
 * Regexes should use named capture groups. Recognized names:
 *   agent_id (required), session_id | session_ts + session_seq, campaign,
 *   customer_number, call_datetime | (year, month, day, hour, minute, second),
 *   ext.
 */
export interface RecordingPattern {
  pattern_id: string;        // partition key
  label: string;             // human-friendly name
  regex: string;             // regex source (named capture groups)
  flags: string;             // regex flags, default "i"
  priority: number;          // lower = tried earlier; the active default is the lowest
  active: boolean;
  match_count: number;       // how many recordings this pattern has parsed
  is_builtin: boolean;       // the seeded Scaler-format default
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Metadata parsed out of a recording's S3 key / filename. */
export interface RecordingMeta {
  recording_key: string;   // full S3 object key
  file_name: string;       // basename
  agent_id: string;        // e.g. "495367"
  session_id: string;      // e.g. "1711950009-255903"
  campaign: string;        // e.g. "Scaler"
  customer_number: string; // e.g. "916353969873"
  call_datetime: string;   // ISO 8601, parsed from filename
  extension: string;       // e.g. "mp3"
}

export type AuditStatus =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "auditing"
  | "audited"
  | "failed";

export interface CriterionScore {
  name: string;
  score: number;       // 0-100
  explanation: string;
}

/**
 * An additional, named rubric attached to a team (beyond the team's primary
 * rubric, which lives on the TeamRubric record). A team can have many. Every
 * call for the team is audited against the primary rubric + all `active`
 * additional rubrics. Stored in the Rubrics table.
 */
export interface Rubric {
  rubric_id: string;                    // partition key, e.g. "RUB-<random>"
  team_id: Team;                        // GSI team-index
  name: string;
  description?: string;
  criteria: Criterion[];
  system_prompt: string;
  scale_max?: number;
  flag_threshold: number;
  critical_criterion_threshold: number;
  active: boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** The audit outcome for a single rubric (one entry per rubric the call is scored against). */
export interface RubricResult {
  rubric_id: string;   // "primary" for the team's main rubric, else the Rubric id
  rubric_name: string;
  score: number;
  flagged: boolean;
  flag_reason: string;
  criteria_scores: CriterionScore[];
}

/**
 * The Audits table row. A single row tracks a recording through the whole
 * pipeline; `status` reflects where it is. The heavy artifacts (full
 * transcript, full audit JSON) live in S3 and are referenced by key here.
 */
export interface AuditRecord {
  audit_id: string;          // partition key: `${agent_id}-${session_id}`
  recording_key: string;
  recording_url: string;     // s3:// url to the source recording
  agent_id: string;
  session_id: string;
  campaign: string;
  customer_number: string;
  call_datetime: string;     // ISO 8601 (also the GSI sort key)
  team: Team | null;         // resolved from the agent record

  status: AuditStatus;
  error?: string;

  transcription_key?: string;
  transcription_url?: string;
  audit_key?: string;
  audit_url?: string;

  // Top-level summary: `score` is the PRIMARY rubric's score; `flagged` is true
  // if ANY rubric flagged the call. Per-rubric detail is in `rubric_results`.
  score?: number;
  flagged?: boolean;
  flag_reason?: string;
  criteria_scores?: CriterionScore[];   // primary rubric's criteria scores
  rubric_results?: RubricResult[];      // one entry per rubric the call was scored against

  created_at: string;
  transcribed_at?: string;
  audited_at?: string;
  updated_at: string;

  // Set once the audit's score has been folded into the performance aggregates,
  // so retries / redeliveries don't double-count (see db/performance.ts).
  performance_recorded?: boolean;
}

/**
 * Singleton platform settings, editable at runtime by a super_admin. Currently
 * holds the OpenAI models used for transcription and auditing, so the models can
 * be changed from the dashboard without a redeploy. Missing values fall back to
 * the `OPENAI_*_MODEL` env vars.
 */
export interface PlatformSettings {
  setting_id: string;          // singleton partition key, always "global"
  transcription_model: string;
  audit_model: string;
  updated_at: string;
  updated_by: string | null;
}

/** Scope of a performance aggregate: a single agent or a whole team. */
export type PerformanceScopeType = "agent" | "team";
export type PerformanceGranularity = "day" | "month" | "year";

/** One time-bucketed performance aggregate row in the Performance table. */
export interface PerformanceBucket {
  pk: string;                  // `${scope_type}#${scope_id}` (partition key)
  bucket: string;              // `${granularity}#${period}` (sort key)
  scope_type: PerformanceScopeType;
  scope_id: string;
  granularity: PerformanceGranularity;
  period: string;              // e.g. "2024-04-01" | "2024-04" | "2024"
  call_count: number;
  score_sum: number;
  flagged_count: number;
  updated_at: string;
}

/** A point in a performance time series returned by the API (avg derived). */
export interface PerformancePoint {
  period: string;
  call_count: number;
  avg_score: number;
  flagged_count: number;
}

/** The JSON document persisted to S3 under audits/ for each audited call. */
export interface AuditDocument {
  audit_id: string;
  recording_key: string;
  agent_id: string;
  session_id: string;
  campaign: string;
  customer_number: string;
  call_datetime: string;
  team: Team | null;
  rubric_name: string;           // primary rubric name
  score: number;                 // primary rubric score
  flagged: boolean;              // any rubric flagged
  flag_reason: string;
  criteria_scores: CriterionScore[]; // primary rubric criteria
  rubric_results?: RubricResult[];   // full per-rubric breakdown
  transcription_key?: string;
  audited_at: string;
}

/** Message envelope placed on the audit queue by the transcription worker. */
export interface AuditQueueMessage {
  audit_id: string;
  agent_id: string;
  transcription_key: string;
}
