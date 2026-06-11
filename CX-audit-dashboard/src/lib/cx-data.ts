// Domain types — mirror of the backend contract (CX-audit-backend/src/types.ts).

export type Role = "super_admin" | "admin" | "user";
// Teams are created at runtime by super_admins, so a team is an open slug string.
export type Team = string;
export type Status = "active" | "inactive";

export interface User {
  user_id: string;
  email: string;
  name: string;
  role: Role;
  team: Team | null;
  agent_id: string | null;
  status: Status;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

export interface Criterion {
  name: string;
  weight?: number;            // relative weight (normalized server-side); optional
  description: string;
  guidance?: string;          // optional extended guidance / examples
  critical_threshold?: number; // optional per-criterion critical override
}

/** Per-team infrastructure overrides (all optional; fall back to global env). */
export interface TeamInfra {
  recording_bucket?: string;
  output_bucket?: string;
  transcription_queue_url?: string;
  audit_queue_url?: string;
  batch_size?: number;
  wait_time_seconds?: number;
  max_receive_count?: number;
  worker_concurrency?: number;
}

export interface TeamRubric {
  team_id: Team;
  name: string;
  description: string;
  criteria: Criterion[];
  system_prompt: string;
  scale_max?: number;          // max score per criterion (default 100)
  flag_threshold: number;
  critical_criterion_threshold: number;
  infra?: TeamInfra;           // per-team buckets/queues/tuning (super_admin)
  active?: boolean;
  created_at?: string;
  created_by?: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface CriterionScore {
  name: string;
  score: number;
  explanation: string;
}

/** An additional, named rubric attached to a team (beyond the primary). */
export interface Rubric {
  rubric_id: string;
  team_id: Team;
  name: string;
  description?: string;
  criteria: Criterion[];
  system_prompt: string;
  scale_max?: number;
  flag_threshold: number;
  critical_criterion_threshold: number;
  active: boolean;
  created_at?: string;
  created_by?: string | null;
  updated_at?: string;
  updated_by?: string | null;
}

/** Per-rubric audit outcome (one entry per rubric a call was scored against). */
export interface RubricResult {
  rubric_id: string;
  rubric_name: string;
  score: number;
  flagged: boolean;
  flag_reason: string;
  criteria_scores: CriterionScore[];
}

export type AuditStatus =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "auditing"
  | "audited"
  | "failed";

export interface Audit {
  audit_id: string;
  recording_key: string;
  recording_url: string;
  agent_id: string;
  session_id: string;
  campaign: string;
  customer_number: string;
  call_datetime: string;
  team: Team | null;
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
  rubric_results?: RubricResult[];   // per-rubric breakdown (primary + additional)
  created_at: string;
  transcribed_at?: string;
  audited_at?: string;
  updated_at: string;
}

export interface RecordingPattern {
  pattern_id: string;
  label: string;
  regex: string;
  flags: string;
  priority: number;
  active: boolean;
  match_count: number;
  is_builtin: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type PerformanceGranularity = "day" | "month" | "year";

export interface PerformancePoint {
  period: string;
  call_count: number;
  avg_score: number;
  flagged_count: number;
}

export interface PerformanceSummary {
  total_calls: number;
  total_flagged: number;
  avg_score: number;
  latest_period: string | null;
  latest_avg_score: number | null;
  latest_calls: number;
  score_delta: number | null;
}

export interface PerformanceResponse {
  scope: { type: "agent" | "team"; id: string } | null;
  granularity: PerformanceGranularity;
  series: PerformancePoint[];
  summary: PerformanceSummary;
}

export interface PlatformSettings {
  setting_id: string;
  transcription_model: string;
  audit_model: string;
  updated_at: string;
  updated_by: string | null;
}

export const TEAMS: Team[] = ["CS", "RM", "OORP", "Escalations"];

// Suggested OpenAI model ids for the Settings UI (free text also allowed).
export const TRANSCRIPTION_MODELS = ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
export const AUDIT_MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini"];
export const ROLES: Role[] = ["super_admin", "admin", "user"];

export function teamClass(t: Team | null) {
  if (!t) return "bg-muted text-muted-foreground border-border";
  const known: Record<string, string> = {
    CS: "bg-[color:var(--cs)]/15 text-[color:var(--cs)] border-[color:var(--cs)]/30",
    RM: "bg-[color:var(--rm)]/15 text-[color:var(--rm)] border-[color:var(--rm)]/30",
    OORP: "bg-[color:var(--oorp)]/15 text-[color:var(--oorp)] border-[color:var(--oorp)]/30",
    Escalations:
      "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30",
  };
  // Dynamically-created teams fall back to a neutral chip.
  return known[t] ?? "bg-surface-2 text-foreground border-border";
}

export function roleClass(r: Role) {
  return {
    super_admin: "bg-[color:var(--amber-role)]/15 text-[color:var(--amber-role)] border-[color:var(--amber-role)]/30",
    admin: "bg-[color:var(--teal)]/15 text-[color:var(--teal)] border-[color:var(--teal)]/30",
    user: "bg-[color:var(--zinc-role)]/15 text-[color:var(--zinc-role)] border-[color:var(--zinc-role)]/30",
  }[r];
}

export function scoreColor(score?: number) {
  if (score === undefined) return "bg-muted text-muted-foreground border-border";
  if (score >= 75) return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (score >= 55) return "bg-[color:var(--oorp)]/15 text-[color:var(--oorp)] border-[color:var(--oorp)]/30";
  return "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30";
}

export function statusClass(s: AuditStatus) {
  if (s === "audited") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "failed") return "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30";
  return "bg-[color:var(--teal)]/15 text-[color:var(--teal)] border-[color:var(--teal)]/30";
}

export function canSeeAdmin(role: Role) {
  return role === "admin" || role === "super_admin";
}
