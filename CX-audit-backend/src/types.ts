// ---------------------------------------------------------------------------
// Shared domain types for the CX Audit platform.
// ---------------------------------------------------------------------------

/** A CX team. Each team owns its own audit rubric. */
export type Team = "CS" | "RM" | "OORP" | "Escalations";

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
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

/** One scoring dimension within a team rubric. */
export interface Criterion {
  name: string;
  weight: number;       // 0-100, weights across a rubric must sum to 100
  description: string;  // instruction passed to the LLM auditor
}

/**
 * A team's audit rubric. Owned and edited by that team's admin (or any
 * super_admin). Stored in the Teams table.
 */
export interface TeamRubric {
  team_id: Team;                       // partition key
  name: string;
  description: string;
  criteria: Criterion[];
  system_prompt: string;
  flag_threshold: number;              // overall score below this => flagged (default 70)
  critical_criterion_threshold: number; // any criterion below this => flagged (default 60)
  updated_at: string;
  updated_by: string | null;
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

  score?: number;
  flagged?: boolean;
  flag_reason?: string;
  criteria_scores?: CriterionScore[];

  created_at: string;
  transcribed_at?: string;
  audited_at?: string;
  updated_at: string;
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
  rubric_name: string;
  score: number;
  flagged: boolean;
  flag_reason: string;
  criteria_scores: CriterionScore[];
  transcription_key?: string;
  audited_at: string;
}

/** Message envelope placed on the audit queue by the transcription worker. */
export interface AuditQueueMessage {
  audit_id: string;
  agent_id: string;
  transcription_key: string;
}
