import { query, execute } from "../lib/db.js";
import { logger } from "../logger.js";
import type {
  PerformanceGranularity,
  PerformancePoint,
  PerformanceScopeType,
} from "../types.js";

const GRANULARITIES: PerformanceGranularity[] = ["day", "month", "year"];

/** Derive the day/month/year period strings from an ISO datetime. */
function periodsOf(iso: string): Record<PerformanceGranularity, string> {
  const date = iso.slice(0, 10); // 2024-04-01
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
  await execute(
    `INSERT INTO cx_performance
       (pk, bucket, scope_type, scope_id, granularity, period, call_count, score_sum, flagged_count, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)
     ON CONFLICT (pk, bucket) DO UPDATE SET
       call_count    = cx_performance.call_count + 1,
       score_sum     = cx_performance.score_sum + EXCLUDED.score_sum,
       flagged_count = cx_performance.flagged_count + EXCLUDED.flagged_count,
       updated_at    = EXCLUDED.updated_at`,
    [
      `${scopeType}#${scopeId}`, `${granularity}#${period}`, scopeType, scopeId,
      granularity, period, score, flagged ? 1 : 0, new Date().toISOString(),
    ]
  );
}

/**
 * Fold one completed audit into the performance aggregates: day/month/year
 * buckets for the agent and (when known) the team. Uses the call datetime so
 * backfills land in the right historical bucket; falls back to "now".
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
 * Return the performance time series for a scope at a granularity, oldest first
 * (natural chart x-axis). `from`/`to` are inclusive period strings matching the
 * granularity (e.g. "2024-01" for month). Avg is computed from sum/count.
 */
export async function getPerformanceSeries(
  scopeType: PerformanceScopeType,
  scopeId: string,
  granularity: PerformanceGranularity,
  from?: string,
  to?: string
): Promise<PerformancePoint[]> {
  const values: unknown[] = [`${scopeType}#${scopeId}`, granularity];
  let sql =
    `SELECT period, call_count, score_sum, flagged_count
     FROM cx_performance
     WHERE pk = $1 AND granularity = $2`;
  if (from) { values.push(from); sql += ` AND period >= $${values.length}`; }
  if (to) { values.push(to); sql += ` AND period <= $${values.length}`; }
  sql += " ORDER BY period ASC";

  const rows = await query<{ period: string; call_count: number; score_sum: number; flagged_count: number }>(sql, values);
  return rows.map((b) => ({
    period: b.period,
    call_count: b.call_count,
    avg_score: b.call_count > 0 ? Math.round(b.score_sum / b.call_count) : 0,
    flagged_count: b.flagged_count,
  }));
}
