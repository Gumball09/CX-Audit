import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type {
  LoginGranularity,
  LoginScopeKind,
  LoginStatBucket,
  LoginStatPoint,
  Role,
} from "../types.js";

const TABLE = env.DDB_LOGIN_STATS_TABLE;
// Daily + monthly is what the dashboard asks for; mirrors the performance table
// shape (pk = `<kind>#<id>`, bucket = `<granularity>#<period>`).
const GRANULARITIES: LoginGranularity[] = ["day", "month"];

/** Derive the day/month period strings from an ISO datetime. */
function periodsOf(iso: string): Record<LoginGranularity, string> {
  // "2026-06-24T11:10:09.000Z" → day "2026-06-24", month "2026-06"
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** Distinct-user count from a stored DynamoDB string set (or 0 when absent). */
function uniqueCount(seen: unknown): number {
  if (seen instanceof Set) return seen.size;
  if (Array.isArray(seen)) return seen.length;
  return 0;
}

/**
 * Increment one (scope, granularity, period) bucket: +1 total sign-in, and add
 * the user to the period's distinct-user set (ADD on a set is idempotent, so a
 * user who signs in five times in a day still counts once toward `unique`).
 */
async function bump(
  kind: LoginScopeKind,
  id: string,
  granularity: LoginGranularity,
  period: string,
  userId: string
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `${kind}#${id}`, bucket: `${granularity}#${period}` },
      UpdateExpression:
        "ADD login_count :one, seen_users :uid " +
        "SET scope_kind = :k, scope_id = :id, granularity = :g, #period = :p, updated_at = :u",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: {
        ":one": 1,
        ":uid": new Set([userId]), // lib-dynamodb marshals a JS Set → DynamoDB SS
        ":k": kind,
        ":id": id,
        ":g": granularity,
        ":p": period,
        ":u": new Date().toISOString(),
      },
    })
  );
}

/**
 * Record one successful sign-in. Updates the day + month buckets for the user's
 * role, the "all" rollup, and (when the user belongs to a team) that team.
 * Best-effort: a failure here must never block a login, so we log and move on
 * (mirrors recordAuditPerformance).
 */
export async function recordLogin(user: {
  user_id: string;
  role: Role;
  team?: string | null;
}): Promise<void> {
  const periods = periodsOf(new Date().toISOString());
  try {
    const writes: Promise<void>[] = [];
    for (const g of GRANULARITIES) {
      const period = periods[g];
      writes.push(bump("role", user.role, g, period, user.user_id));
      writes.push(bump("role", "all", g, period, user.user_id));
      if (user.team) writes.push(bump("team", user.team, g, period, user.user_id));
    }
    await Promise.all(writes);
  } catch (err) {
    logger.warn("Failed to record login stats", err);
  }
}

/**
 * Return the sign-in time series for a scope at a granularity, oldest → newest
 * (natural for a chart x-axis). `from`/`to` are inclusive period strings in the
 * granularity's own shape (e.g. "2026-06" for month).
 */
export async function getLoginStatsSeries(
  kind: LoginScopeKind,
  id: string,
  granularity: LoginGranularity,
  from?: string,
  to?: string
): Promise<LoginStatPoint[]> {
  // `bucket` is a DynamoDB reserved word → reference via an alias.
  const names: Record<string, string> = { "#bucket": "bucket" };
  const values: Record<string, unknown> = { ":pk": `${kind}#${id}` };
  let keyCond = "pk = :pk";

  if (from && to) {
    keyCond += " AND #bucket BETWEEN :lo AND :hi";
    values[":lo"] = `${granularity}#${from}`;
    values[":hi"] = `${granularity}#${to}`;
  } else {
    keyCond += " AND begins_with(#bucket, :prefix)";
    values[":prefix"] = `${granularity}#`;
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: keyCond,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ScanIndexForward: true,
    })
  );

  return ((res.Items as LoginStatBucket[]) ?? []).map((b) => ({
    period: b.period,
    login_count: b.login_count ?? 0,
    unique_count: uniqueCount(b.seen_users),
  }));
}
