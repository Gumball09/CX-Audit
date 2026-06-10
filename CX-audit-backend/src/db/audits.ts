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

export async function getAudit(auditId: string): Promise<AuditRecord | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { audit_id: auditId } }));
  return (res.Item as AuditRecord) ?? null;
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
        Item: record,
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
  patch: Partial<AuditRecord>
): Promise<AuditRecord | null> {
  const sets: string[] = ["updated_at = :u"];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const names: Record<string, string> = {};

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || k === "audit_id") continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }

  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { audit_id: auditId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    })
  );
  return (res.Attributes as AuditRecord) ?? null;
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

/** Build a `flagged = :flagged` FilterExpression fragment (non-key attribute). */
function flaggedFilter(q: AuditQuery, names: Record<string, string>, values: Record<string, unknown>) {
  if (q.flagged === undefined) return undefined;
  names["#flagged"] = "flagged";
  values[":flagged"] = q.flagged;
  return "#flagged = :flagged";
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
    const f = flaggedFilter(q, names, values);
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
    return { items: (res.Items as AuditRecord[]) ?? [], nextCursor: encodeCursor(res.LastEvaluatedKey) };
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
    FilterExpression: flaggedFilter(q, names, values),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ScanIndexForward: false, // newest first
    Limit: limit,
    ExclusiveStartKey: start,
  };
  const res = await ddb.send(new QueryCommand(input));
  return { items: (res.Items as AuditRecord[]) ?? [], nextCursor: encodeCursor(res.LastEvaluatedKey) };
}
