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

// ---- feedback loop -------------------------------------------------------

export type FeedbackDisposition = "agree" | "disagree" | "partial";

export interface FeedbackCriterionCorrection {
  name: string;
  ai_score: number;
  human_score: number;
  note?: string;
}

/** A reviewer's correction of an AI audit (scoped to one rubric). */
export interface Feedback {
  feedback_id: string;
  audit_id: string;
  team: Team;
  agent_id: string;
  rubric_id: string;
  rubric_name: string;
  reviewer_id: string;
  reviewer_email: string;
  disposition: FeedbackDisposition;
  ai_score: number;
  ai_flagged: boolean;
  human_score?: number;
  human_flagged?: boolean;
  criteria_corrections?: FeedbackCriterionCorrection[];
  comment: string;
  created_at: string;
  updated_at: string;
}

export type SuggestionStatus = "open" | "applied" | "dismissed";

export interface SuggestedCriterionChange {
  criterion: string;
  change: string;
  rationale: string;
}

/** An LLM-generated rubric-improvement suggestion derived from feedback. */
export interface RubricSuggestion {
  suggestion_id: string;
  team: Team;
  rubric_id: string;
  rubric_name: string;
  status: SuggestionStatus;
  summary: string;
  suggested_system_prompt?: string;
  criteria_changes: SuggestedCriterionChange[];
  based_on_feedback_count: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export type AuditStatus =
  | "queued"
  | "transcribing"
  | "transcribed"
  | "auditing"
  | "audited"
  | "skipped"
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
  duration_sec?: number;
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

/** Call-outcome counts for a scope, keyed by audit status. */
export interface StatusCountsResponse {
  scope: { type: "agent" | "team"; id: string };
  counts: Record<string, number>;
}

// ---- sign-in (login) activity --------------------------------------------

export type LoginGranularity = "day" | "month";
export type LoginRoleScope = "all" | Role;

export interface LoginStatPoint {
  period: string;
  login_count: number;  // total sign-ins (one user logging in 3x → 3)
  unique_count: number; // distinct users who signed in (DAU / MAU)
}

export interface LoginStatSummary {
  total_logins: number;
  periods: number;
  latest_period: string | null;
  latest_logins: number;
  latest_unique: number;
  unique_delta: number | null;
}

export interface LoginRoleSeries {
  scope: LoginRoleScope;
  series: LoginStatPoint[];
  summary: LoginStatSummary;
}

export interface LoginBreakdownResponse {
  granularity: LoginGranularity;
  breakdown: LoginRoleSeries[];
}

export interface LoginTeamSeries {
  team_id: string;
  name: string;
  series: LoginStatPoint[];
  summary: LoginStatSummary;
}

export interface LoginTeamsResponse {
  granularity: LoginGranularity;
  total_teams: number;
  active_teams: number;
  latest_period: string | null;
  teams: LoginTeamSeries[];
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

// Color band for a score shown against its scale. `max` is the top of the
// scale the score lives on (a rubric's scale_max, or a criterion's weight).
// Bands are by ratio so the same thresholds read correctly on a 0-1, 0-12, or
// 0-100 scale. `max` defaults to 100 to preserve callers that pass a percentage.
export function scoreColor(score?: number, max = 100) {
  if (score === undefined || !(max > 0)) return "bg-muted text-muted-foreground border-border";
  const ratio = score / max;
  if (ratio >= 0.75) return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (ratio >= 0.55) return "bg-[color:var(--oorp)]/15 text-[color:var(--oorp)] border-[color:var(--oorp)]/30";
  return "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30";
}

// Format a points value for display: integers stay integral, fractions show
// one decimal (so a binary 0/1 reads cleanly while weighted scores stay legible).
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toFixed(1);
}

// The auditor scores each criterion on 0..scaleMax. A criterion's contribution
// to the rubric total is its share of that scale times its weight, so we show
// it as `earned / weight` (e.g. a passed binary criterion reads 1 / 1). Weight
// and scaleMax fall back to sane defaults when a rubric omits them.
export function criterionPoints(score: number, scaleMax?: number, weight?: number) {
  const sm = scaleMax && scaleMax > 0 ? scaleMax : 100;
  const max = weight && weight > 0 ? weight : 1;
  return { earned: (score / sm) * max, max };
}

// Resolve a rubric-like source into the scale facts the audit view needs:
// the per-criterion scale max, each criterion's weight (by name), and the
// summed weight that forms the rubric's point total. Missing weights count as
// 1 (equal weighting), mirroring the server's normalization fallback.
export function rubricScale(src?: { scale_max?: number; criteria: Criterion[] }) {
  const scaleMax = src?.scale_max && src.scale_max > 0 ? src.scale_max : 100;
  const criteria = src?.criteria ?? [];
  const weightOf = (c: Criterion) => (c.weight && c.weight > 0 ? c.weight : 1);
  const weightByName = new Map(criteria.map((c) => [c.name, weightOf(c)]));
  const totalWeight = criteria.reduce((s, c) => s + weightOf(c), 0);
  return { scaleMax, weightByName, totalWeight };
}

export function statusClass(s: AuditStatus) {
  if (s === "audited") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "failed") return "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30";
  if (s === "skipped") return "bg-muted text-muted-foreground border-border";
  return "bg-[color:var(--teal)]/15 text-[color:var(--teal)] border-[color:var(--teal)]/30";
}

export function canSeeAdmin(role: Role) {
  return role === "admin" || role === "super_admin";
}
