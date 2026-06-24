import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type QueryCommandInput,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import type { AuditRecord, AuditStatus, Team } from "../types.js";

const TABLE = env.DDB_AUDITS_TABLE;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * `team` is the team-index GSI key and `agent_id` the agent-index key; DynamoDB
 * forbids NULL on a GSI key attribute. Omit them when unset (e.g. a recording
 * whose agent isn't mapped to a team) so the indexes stay sparse.
 */
function toItem(record: AuditRecord): Record<string, unknown> {
  const item: Record<string, unknown> = { ...record };
  if (item.team == null) delete item.team;
  if (item.agent_id == null) delete item.agent_id;
  return item;
}

/** Restore the API contract (team is `null`, never `undefined`). */
function fromItem(item: Record<string, unknown> | undefined): AuditRecord | null {
  if (!item) return null;
  return { ...(item as unknown as AuditRecord), team: (item.team as string) ?? null };
}

export async function getAudit(auditId: string): Promise<AuditRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { audit_id: auditId } }));
  return fromItem(res.Item);
}

/**
 * Create the audit row if it does not already exist. Returns false when a row
 * for this recording already exists — this is the pipeline's dedup guard, so a
 * recording that is re-delivered (S3 retry, replayed event) is processed once.
 */
export async function createAuditIfAbsent(record: AuditRecord): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: toItem(record),
        ConditionExpression: "attribute_not_exists(audit_id)",
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function updateAudit(
  auditId: string,
  // `undefined` leaves an attribute untouched; explicit `null` REMOVEs it
  // (needed for GSI keys like team/agent_id that can't hold NULL, and to clear
  // a stale `error` once an audit is no longer failed).
  patch: { [K in keyof AuditRecord]?: AuditRecord[K] | null }
): Promise<AuditRecord | null> {
  const sets: string[] = ["updated_at = :u"];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const names: Record<string, string> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "audit_id") continue;
    names[`#${k}`] = k;
    // Explicit null clears the attribute (REMOVE). team/agent_id are GSI keys
    // that cannot hold a NULL, so clearing them must drop the attribute too.
    if (v === null) {
      removes.push(`#${k}`);
      continue;
    }
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
  }

  const expr = `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : "");
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { audit_id: auditId },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return fromItem(res.Attributes);
}

export async function setStatus(auditId: string, status: AuditStatus, error?: string) {
  // An error message only belongs to a failed audit. Any other transition
  // (re-queue, transcribe, audit, success) clears a stale one — so a re-audit
  // after, e.g., fixing a team mapping doesn't keep showing the old failure.
  return updateAudit(auditId, { status, error: status === "failed" ? (error ?? null) : null });
}

// ---- scoped, paginated listing -------------------------------------------

export type AuditScope =
  | { kind: "all" }
  | { kind: "team"; team: Team }
  | { kind: "agent"; agentId: string };

export interface AuditQuery {
  flagged?: boolean;
  status?: string; // exact status match (e.g. "failed")
  from?: string; // ISO
  to?: string;   // ISO
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  items: AuditRecord[];
  nextCursor?: string;
}

function encodeCursor(key?: Record<string, unknown>): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64") : undefined;
}
function decodeCursor(cursor?: string): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Build the non-key FilterExpression (flagged and/or status). Returns undefined
 * when neither is set. Mutates `names`/`values` with the bindings it uses.
 */
function buildNonKeyFilter(q: AuditQuery, names: Record<string, string>, values: Record<string, unknown>) {
  const parts: string[] = [];
  if (q.flagged !== undefined) {
    names["#flagged"] = "flagged";
    values[":flagged"] = q.flagged;
    parts.push("#flagged = :flagged");
  }
  if (q.status) {
    names["#status"] = "status";
    values[":status"] = q.status;
    parts.push("#status = :status");
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

/**
 * List audits for a scope with server-side pagination. Date range is pushed to
 * the GSI sort key (`call_datetime`) for team/agent scopes, so pagination stays
 * correct; `flagged` is applied as a FilterExpression. The `all` scope uses a
 * Scan (acceptable until volume warrants a fixed-partition GSI — see docs).
 */
export async function listAudits(scope: AuditScope, q: AuditQuery = {}): Promise<AuditPage> {
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const start = decodeCursor(q.cursor);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  if (scope.kind === "all") {
    const filters: string[] = [];
    const f = buildNonKeyFilter(q, names, values);
    if (f) filters.push(f);
    if (q.from || q.to) {
      names["#dt"] = "call_datetime";
      if (q.from) { values[":from"] = q.from; filters.push("#dt >= :from"); }
      if (q.to) { values[":to"] = q.to; filters.push("#dt <= :to"); }
    }
    const input: ScanCommandInput = {
      TableName: TABLE,
      Limit: limit,
      ExclusiveStartKey: start,
      FilterExpression: filters.length ? filters.join(" AND ") : undefined,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    };
    const res = await ddb.send(new ScanCommand(input));
    return { items: ((res.Items as Record<string, unknown>[]) ?? []).map((i) => fromItem(i)!), nextCursor: encodeCursor(res.LastEvaluatedKey) };
  }

  // team / agent -> GSI query with optional date range on the sort key.
  const indexName = scope.kind === "team" ? "team-index" : "agent-index";
  const pkName = scope.kind === "team" ? "team" : "agent_id";
  names["#pk"] = pkName;
  values[":pk"] = scope.kind === "team" ? scope.team : scope.agentId;
  let keyCond = "#pk = :pk";
  if (q.from && q.to) {
    names["#dt"] = "call_datetime"; values[":from"] = q.from; values[":to"] = q.to;
    keyCond += " AND #dt BETWEEN :from AND :to";
  } else if (q.from) {
    names["#dt"] = "call_datetime"; values[":from"] = q.from; keyCond += " AND #dt >= :from";
  } else if (q.to) {
    names["#dt"] = "call_datetime"; values[":to"] = q.to; keyCond += " AND #dt <= :to";
  }

  const input: QueryCommandInput = {
    TableName: TABLE,
    IndexName: indexName,
    KeyConditionExpression: keyCond,
    FilterExpression: buildNonKeyFilter(q, names, values),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: start,
  };
  const res = await ddb.send(new QueryCommand(input));
  return { items: ((res.Items as Record<string, unknown>[]) ?? []).map((i) => fromItem(i)!), nextCursor: encodeCursor(res.LastEvaluatedKey) };
}

/**
 * Count audits by status for a scope (and optional date range), e.g. how many
 * `audited` vs `skipped` calls a team has. Projects only `status` and paginates
 * fully so the totals are exact. Team/agent scopes use the matching GSI; `all`
 * scans. Returns a map keyed by status (missing statuses are simply absent).
 */
export async function getStatusCounts(
  scope: AuditScope,
  q: { from?: string; to?: string } = {}
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const tally = (items: Record<string, unknown>[] | undefined) => {
    for (const it of items ?? []) {
      const s = String((it as { status?: unknown }).status ?? "unknown");
      counts[s] = (counts[s] ?? 0) + 1;
    }
  };

  if (scope.kind === "all") {
    let start: Record<string, unknown> | undefined;
    do {
      const names: Record<string, string> = { "#s": "status" };
      const values: Record<string, unknown> = {};
      const filters: string[] = [];
      if (q.from) { names["#dt"] = "call_datetime"; values[":from"] = q.from; filters.push("#dt >= :from"); }
      if (q.to) { names["#dt"] = "call_datetime"; values[":to"] = q.to; filters.push("#dt <= :to"); }
      const res = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          ProjectionExpression: "#s",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
          FilterExpression: filters.length ? filters.join(" AND ") : undefined,
          ExclusiveStartKey: start,
        })
      );
      tally(res.Items as Record<string, unknown>[]);
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    return counts;
  }

  const indexName = scope.kind === "team" ? "team-index" : "agent-index";
  const pkName = scope.kind === "team" ? "team" : "agent_id";
  let start: Record<string, unknown> | undefined;
  do {
    const names: Record<string, string> = { "#pk": pkName, "#s": "status" };
    const values: Record<string, unknown> = { ":pk": scope.kind === "team" ? scope.team : scope.agentId };
    let keyCond = "#pk = :pk";
    if (q.from && q.to) {
      names["#dt"] = "call_datetime"; values[":from"] = q.from; values[":to"] = q.to;
      keyCond += " AND #dt BETWEEN :from AND :to";
    } else if (q.from) {
      names["#dt"] = "call_datetime"; values[":from"] = q.from; keyCond += " AND #dt >= :from";
    } else if (q.to) {
      names["#dt"] = "call_datetime"; values[":to"] = q.to; keyCond += " AND #dt <= :to";
    }
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: indexName,
        KeyConditionExpression: keyCond,
        ProjectionExpression: "#s",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: start,
      })
    );
    tally(res.Items as Record<string, unknown>[]);
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return counts;
}
