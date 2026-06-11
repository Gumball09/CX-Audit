import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type {
  PerformanceBucket,
  PerformanceGranularity,
  PerformancePoint,
  PerformanceScopeType,
} from "../types.js";

const TABLE = env.DDB_PERFORMANCE_TABLE;
const GRANULARITIES: PerformanceGranularity[] = ["day", "month", "year"];

/** Derive the day/month/year period strings from an ISO datetime. */
function periodsOf(iso: string): Record<PerformanceGranularity, string> {
  // iso like 2024-04-01T11:10:09.000Z → "2024-04-01" / "2024-04" / "2024"
  const date = iso.slice(0, 10);
  return { day: date, month: date.slice(0, 7), year: date.slice(0, 4) };
}

async function bumpBucket(
  scopeType: PerformanceScopeType,
  scopeId: string,
  granularity: PerformanceGranularity,
  period: string,
  score: number,
  flagged: boolean
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `${scopeType}#${scopeId}`, bucket: `${granularity}#${period}` },
      UpdateExpression:
        "ADD call_count :one, score_sum :s, flagged_count :f " +
        "SET scope_type = :st, scope_id = :sid, granularity = :g, #period = :p, updated_at = :u",
      ExpressionAttributeNames: { "#period": "period" },
      ExpressionAttributeValues: {
        ":one": 1,
        ":s": score,
        ":f": flagged ? 1 : 0,
        ":st": scopeType,
        ":sid": scopeId,
        ":g": granularity,
        ":p": period,
        ":u": new Date().toISOString(),
      },
    })
  );
}

/**
 * Fold one completed audit into the performance aggregates. Updates day/month/
 * year buckets for the agent and (when known) the team. `datetimeISO` should be
 * the call datetime so backfills land in the correct historical bucket; falls
 * back to "now" when the call datetime is unknown.
 */
export async function recordAuditPerformance(input: {
  agentId: string;
  team: string | null;
  score: number;
  flagged: boolean;
  datetimeISO?: string;
}): Promise<void> {
  const iso = input.datetimeISO && input.datetimeISO.length >= 10 ? input.datetimeISO : new Date().toISOString();
  const periods = periodsOf(iso);

  const writes: Promise<void>[] = [];
  for (const g of GRANULARITIES) {
    writes.push(bumpBucket("agent", input.agentId, g, periods[g], input.score, input.flagged));
    if (input.team) writes.push(bumpBucket("team", input.team, g, periods[g], input.score, input.flagged));
  }
  try {
    await Promise.all(writes);
  } catch (err) {
    // Performance aggregation must never block the pipeline — log and move on.
    logger.warn("Failed to record performance aggregates", err);
  }
}

/**
 * Return the performance time series for a scope at a granularity, newest last.
 * `from`/`to` are inclusive period strings in the same shape as the granularity
 * (e.g. "2024-01" for month). Computes avg_score from the stored sum/count.
 */
export async function getPerformanceSeries(
  scopeType: PerformanceScopeType,
  scopeId: string,
  granularity: PerformanceGranularity,
  from?: string,
  to?: string
): Promise<PerformancePoint[]> {
  // `bucket` is a DynamoDB reserved keyword, so it must be referenced via an
  // ExpressionAttributeName alias in the KeyConditionExpression.
  const names: Record<string, string> = { "#bucket": "bucket" };
  const values: Record<string, unknown> = { ":pk": `${scopeType}#${scopeId}` };
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
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: values,
      ScanIndexForward: true, // oldest → newest, natural for a chart x-axis
    })
  );

  return ((res.Items as PerformanceBucket[]) ?? []).map((b) => ({
    period: b.period,
    call_count: b.call_count,
    avg_score: b.call_count > 0 ? Math.round(b.score_sum / b.call_count) : 0,
    flagged_count: b.flagged_count,
  }));
}
