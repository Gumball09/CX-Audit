import type {
  Audit,
  CriterionScore,
  Feedback,
  FeedbackDisposition,
  FeedbackCriterionCorrection,
  LoginBreakdownResponse,
  LoginGranularity,
  LoginTeamsResponse,
  PerformanceGranularity,
  PerformanceResponse,
  PlatformSettings,
  RecordingPattern,
  Role,
  Rubric,
  RubricSuggestion,
  SuggestionStatus,
  Team,
  TeamRubric,
  User,
} from "./cx-data";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000/api";
const TOKEN_KEY = "cx_audit_token";

// ---- token storage -------------------------------------------------------

export function getToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// ---- fetch wrapper -------------------------------------------------------

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message ?? message;
      if (body.errors) message += `: ${body.errors.join("; ")}`;
    } catch {
      /* non-JSON error */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// ---- auth ----------------------------------------------------------------

export type LoginResult =
  | { user: User }                 // signed in (token stored)
  | { needsPasswordSetup: true };  // first login — caller should collect a new password

/**
 * Email + password login. If the account has no password yet (first login),
 * the API returns { needs_password_setup: true } and we surface that so the UI
 * can switch to the set-password step.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const result = await request<{ token?: string; user?: User; needs_password_setup?: boolean }>(
    "/auth/login",
    { method: "POST", body: JSON.stringify({ email, password }) }
  );
  if (result.needs_password_setup) return { needsPasswordSetup: true };
  setToken(result.token!);
  return { user: result.user! };
}

/** Self-service first login: set the initial password and sign in. */
export async function setPassword(email: string, password: string): Promise<{ user: User }> {
  const result = await request<{ token: string; user: User }>("/auth/set-password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(result.token);
  return { user: result.user };
}

export function fetchMe(): Promise<User> {
  return request<User>("/auth/me");
}

// ---- audits --------------------------------------------------------------

export interface AuditFilters {
  team?: Team | "All";
  flagged?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  items: Audit[];
  nextCursor?: string;
}

/** Fetch one page of audits (server returns { items, nextCursor }). */
export function fetchAuditPage(filters: AuditFilters = {}): Promise<AuditPage> {
  const q = new URLSearchParams();
  if (filters.team && filters.team !== "All") q.set("team", filters.team);
  if (filters.flagged) q.set("flagged", "true");
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  if (filters.limit) q.set("limit", String(filters.limit));
  if (filters.cursor) q.set("cursor", filters.cursor);
  const qs = q.toString();
  return request<AuditPage>(`/audits${qs ? `?${qs}` : ""}`);
}

/** Convenience: first page as a flat array (used by the current table view). */
export async function fetchAudits(filters: AuditFilters = {}): Promise<Audit[]> {
  const page = await fetchAuditPage({ limit: 500, ...filters });
  return page.items;
}

export function fetchTranscript(auditId: string): Promise<{ audit_id: string; transcript: string }> {
  return request(`/audits/${encodeURIComponent(auditId)}/transcript`);
}

export function reauditCall(auditId: string): Promise<{ ok: boolean }> {
  return request(`/audits/${encodeURIComponent(auditId)}/reaudit`, { method: "POST" });
}

export function reprocessRecording(recordingKey: string): Promise<{ ok: boolean }> {
  return request(`/audits/reprocess`, {
    method: "POST",
    body: JSON.stringify({ recording_key: recordingKey }),
  });
}

// ---- users ---------------------------------------------------------------

export function fetchUsers(): Promise<User[]> {
  return request<User[]>("/users");
}

export interface NewUser {
  email: string;
  name: string;
  role: Role;
  team?: Team | null;
  agent_id?: string | null;
}

export function createUser(user: NewUser): Promise<User> {
  return request<User>("/users", { method: "POST", body: JSON.stringify(user) });
}

export function updateUser(userId: string, patch: Partial<User>): Promise<User> {
  return request<User>(`/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteUser(userId: string): Promise<{ ok: boolean }> {
  return request(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

// ---- teams / rubrics -----------------------------------------------------

export function fetchTeams(): Promise<TeamRubric[]> {
  return request<TeamRubric[]>("/teams");
}

/** Create a new team (super_admin). `team_id` is the slug; infra is optional. */
export function createTeam(team: Partial<TeamRubric> & { team_id: string }): Promise<TeamRubric> {
  return request<TeamRubric>("/teams", { method: "POST", body: JSON.stringify(team) });
}

export function updateTeam(teamId: Team, patch: Partial<TeamRubric>): Promise<TeamRubric> {
  return request<TeamRubric>(`/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- additional rubrics (per team) ---------------------------------------

export function fetchRubrics(teamId: Team): Promise<Rubric[]> {
  return request<Rubric[]>(`/rubrics?team=${encodeURIComponent(teamId)}`);
}

export function createRubric(rubric: Partial<Rubric> & { team_id: Team; name: string }): Promise<Rubric> {
  return request<Rubric>("/rubrics", { method: "POST", body: JSON.stringify(rubric) });
}

export function updateRubric(rubricId: string, patch: Partial<Rubric>): Promise<Rubric> {
  return request<Rubric>(`/rubrics/${encodeURIComponent(rubricId)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteRubric(rubricId: string): Promise<{ ok: boolean }> {
  return request(`/rubrics/${encodeURIComponent(rubricId)}`, { method: "DELETE" });
}

// ---- feedback loop -------------------------------------------------------

export function fetchAuditFeedback(auditId: string): Promise<Feedback[]> {
  return request<Feedback[]>(`/feedback?audit=${encodeURIComponent(auditId)}`);
}

export function fetchTeamFeedback(teamId: Team): Promise<Feedback[]> {
  return request<Feedback[]>(`/feedback?team=${encodeURIComponent(teamId)}`);
}

export interface NewFeedback {
  audit_id: string;
  rubric_id?: string;
  disposition: FeedbackDisposition;
  human_score?: number;
  human_flagged?: boolean;
  criteria_corrections?: FeedbackCriterionCorrection[];
  comment: string;
}

export function createFeedback(f: NewFeedback): Promise<Feedback> {
  return request<Feedback>("/feedback", { method: "POST", body: JSON.stringify(f) });
}

export function deleteFeedback(feedbackId: string): Promise<{ ok: boolean }> {
  return request(`/feedback/${encodeURIComponent(feedbackId)}`, { method: "DELETE" });
}

export function fetchSuggestions(teamId: Team): Promise<RubricSuggestion[]> {
  return request<RubricSuggestion[]>(`/suggestions?team=${encodeURIComponent(teamId)}`);
}

export function generateSuggestion(team: Team, rubricId = "primary"): Promise<RubricSuggestion> {
  return request<RubricSuggestion>("/suggestions/generate", {
    method: "POST",
    body: JSON.stringify({ team, rubric_id: rubricId }),
  });
}

export function updateSuggestionStatus(id: string, status: SuggestionStatus): Promise<RubricSuggestion> {
  return request<RubricSuggestion>(`/suggestions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function deleteSuggestion(id: string): Promise<{ ok: boolean }> {
  return request(`/suggestions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- recording patterns (super_admin) ------------------------------------

export function fetchPatterns(): Promise<RecordingPattern[]> {
  return request<RecordingPattern[]>("/patterns");
}

export interface NewPattern {
  label: string;
  regex: string;
  flags?: string;
  priority?: number;
  active?: boolean;
}

export function createPattern(p: NewPattern): Promise<RecordingPattern> {
  return request<RecordingPattern>("/patterns", { method: "POST", body: JSON.stringify(p) });
}

export function updatePattern(id: string, patch: Partial<RecordingPattern>): Promise<RecordingPattern> {
  return request<RecordingPattern>(`/patterns/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deletePattern(id: string): Promise<{ ok: boolean }> {
  return request(`/patterns/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function testPattern(regex: string, sample: string, flags?: string): Promise<{ matched: boolean; groups: Record<string, string> | null }> {
  return request("/patterns/test", { method: "POST", body: JSON.stringify({ regex, sample, flags }) });
}

// ---- performance ---------------------------------------------------------

/** The caller's own performance (own agent for users, own team for admins). */
export function fetchMyPerformance(granularity: PerformanceGranularity): Promise<PerformanceResponse> {
  return request<PerformanceResponse>(`/performance/me?granularity=${granularity}`);
}

/** A specific agent's or team's performance series (RBAC-enforced server-side). */
export function fetchPerformance(
  scope: "agent" | "team",
  id: string,
  granularity: PerformanceGranularity
): Promise<PerformanceResponse> {
  const q = new URLSearchParams({ scope, id, granularity });
  return request<PerformanceResponse>(`/performance?${q.toString()}`);
}

// ---- sign-in (login) activity --------------------------------------------

/** Per-team sign-in activity + how many teams are actively opening the app. */
export function fetchLoginTeams(granularity: LoginGranularity): Promise<LoginTeamsResponse> {
  return request<LoginTeamsResponse>(`/login-stats/teams?granularity=${granularity}`);
}

/** Sign-in activity broken down by role (admins / users / super_admins / all). */
export function fetchLoginBreakdown(granularity: LoginGranularity): Promise<LoginBreakdownResponse> {
  return request<LoginBreakdownResponse>(`/login-stats/breakdown?granularity=${granularity}`);
}

// ---- platform settings (models) ------------------------------------------

export function fetchSettings(): Promise<PlatformSettings> {
  return request<PlatformSettings>("/settings");
}

export function updateSettings(patch: Partial<Pick<PlatformSettings, "transcription_model" | "audit_model">>): Promise<PlatformSettings> {
  return request<PlatformSettings>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

export type { CriterionScore };
