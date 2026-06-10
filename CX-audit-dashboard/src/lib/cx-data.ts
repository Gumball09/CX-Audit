// Domain types — mirror of the backend contract (CX-audit-backend/src/types.ts).

export type Role = "super_admin" | "admin" | "user";
export type Team = "CS" | "RM" | "OORP" | "Escalations";
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
  weight: number;
  description: string;
}

export interface TeamRubric {
  team_id: Team;
  name: string;
  description: string;
  criteria: Criterion[];
  system_prompt: string;
  flag_threshold: number;
  critical_criterion_threshold: number;
  updated_at: string;
  updated_by: string | null;
}

export interface CriterionScore {
  name: string;
  score: number;
  explanation: string;
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
  created_at: string;
  transcribed_at?: string;
  audited_at?: string;
  updated_at: string;
}

export const TEAMS: Team[] = ["CS", "RM", "OORP", "Escalations"];
export const ROLES: Role[] = ["super_admin", "admin", "user"];

export function teamClass(t: Team | null) {
  if (!t) return "bg-muted text-muted-foreground border-border";
  return {
    CS: "bg-[color:var(--cs)]/15 text-[color:var(--cs)] border-[color:var(--cs)]/30",
    RM: "bg-[color:var(--rm)]/15 text-[color:var(--rm)] border-[color:var(--rm)]/30",
    OORP: "bg-[color:var(--oorp)]/15 text-[color:var(--oorp)] border-[color:var(--oorp)]/30",
    Escalations:
      "bg-[color:var(--escalations)]/15 text-[color:var(--escalations)] border-[color:var(--escalations)]/30",
  }[t];
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
