import { query, queryOne, pool } from "../lib/db.js";
import type { AuditRecord, AuditStatus, Team } from "../types.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export async function getAudit(auditId: string): Promise<AuditRecord | null> {
  return queryOne<AuditRecord>("SELECT * FROM cx_audits WHERE audit_id = $1", [auditId]);
}

/**
 * Insert the audit row only if it does not already exist. Returns false when a
 * row for this recording already exists — the pipeline's dedup guard, so a
 * re-delivered recording is processed once.
 */
export async function createAuditIfAbsent(record: AuditRecord): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO cx_audits
       (audit_id, recording_key, recording_url, agent_id, session_id, campaign,
        customer_number, call_datetime, team, status, error, transcription_key,
        transcription_url, audit_key, audit_url, score, flagged, flag_reason,
        criteria_scores, performance_recorded, created_at, transcribed_at,
        audited_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19::jsonb,$20,$21,$22,$23,$24)
     ON CONFLICT (audit_id) DO NOTHING`,
    [
      record.audit_id, record.recording_key, record.recording_url ?? null, record.agent_id,
      record.session_id ?? null, record.campaign ?? null, record.customer_number ?? null,
      record.call_datetime ?? null, record.team ?? null, record.status, record.error ?? null,
      record.transcription_key ?? null, record.transcription_url ?? null, record.audit_key ?? null,
      record.audit_url ?? null, record.score ?? null, record.flagged ?? null, record.flag_reason ?? null,
      record.criteria_scores ? JSON.stringify(record.criteria_scores) : null,
      record.performance_recorded ?? false, record.created_at, record.transcribed_at ?? null,
      record.audited_at ?? null, record.updated_at,
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function updateAudit(
  auditId: string,
  patch: Partial<AuditRecord>
): Promise<AuditRecord | null> {
  const sets: string[] = ["updated_at = $1"];
  const values: unknown[] = [new Date().toISOString()];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "audit_id" || k === "updated_at") continue;
    if (k === "criteria_scores") {
      values.push(JSON.stringify(v));
      sets.push(`criteria_scores = $${values.length}::jsonb`);
    } else {
      values.push(v);
      sets.push(`${k} = $${values.length}`);
    }
  }
  values.push(auditId);
  return queryOne<AuditRecord>(
    `UPDATE cx_audits SET ${sets.join(", ")} WHERE audit_id = $${values.length} RETURNING *`,
    values
  );
}

export async function setStatus(auditId: string, status: AuditStatus, error?: string) {
  return updateAudit(auditId, { status, error });
}

// ---- scoped, paginated listing -------------------------------------------

export type AuditScope =
  | { kind: "all" }
  | { kind: "team"; team: Team }
  | { kind: "agent"; agentId: string };

export interface AuditQuery {
  flagged?: boolean;
  from?: string; // ISO
  to?: string;   // ISO
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  items: AuditRecord[];
  nextCursor?: string;
}

// Opaque cursor = a base64-encoded row offset.
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString("base64");
}
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const n = parseInt(Buffer.from(cursor, "base64").toString("utf-8"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * List audits for a scope with offset pagination, newest first. Scope and
 * filters are pushed into SQL; the response keeps the { items, nextCursor }
 * contract so the dashboard is unchanged.
 */
export async function listAudits(scope: AuditScope, q: AuditQuery = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = decodeCursor(q.cursor);

  const where: string[] = [];
  const values: unknown[] = [];
  const add = (clause: string, val: unknown) => {
    values.push(val);
    where.push(clause.replace("$?", `$${values.length}`));
  };

  if (scope.kind === "team") add("team = $?", scope.team);
  else if (scope.kind === "agent") add("agent_id = $?", scope.agentId);
  if (q.flagged !== undefined) add("flagged = $?", q.flagged);
  if (q.from) add("call_datetime >= $?", q.from);
  if (q.to) add("call_datetime <= $?", q.to);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  values.push(limit, offset);
  const rows = await query<AuditRecord>(
    `SELECT * FROM cx_audits ${whereSql}
     ORDER BY call_datetime DESC NULLS LAST
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  return {
    items: rows,
    nextCursor: rows.length === limit ? encodeCursor(offset + limit) : undefined,
  };
}
