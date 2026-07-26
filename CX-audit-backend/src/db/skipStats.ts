import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Daily tallies of calls the gates rejected.
 *
 * Skipped calls no longer get an audit row — they are noise in the logs view and
 * they were the bulk of the table. But dropping them silently would make the
 * volume controls unfalsifiable: without a count there is no way to tell a cap
 * that is working from a pipeline that has stopped receiving calls, and no way
 * to tune the duration threshold.
 *
 * So each skip increments a small per-day counter instead. One item per day
 * regardless of call volume, self-expiring, and never surfaced as an audit.
 *
 * Seconds are tracked alongside counts because audio duration — not call count —
 * is what transcription is billed on, so `*_sec` is the number that translates
 * directly into money not spent.
 */

const TABLE = env.DDB_QUOTA_TABLE;
const RETENTION_DAYS = 90; // outlives the 7-day quota rows; this is reporting data

export type SkipReason = "too_short" | "daily_cap" | "no_team";

export interface SkipStats {
  day: string;
  too_short_count: number;
  too_short_sec: number;
  daily_cap_count: number;
  daily_cap_sec: number;
  no_team_count: number;
  no_team_sec: number;
}

const statsId = (day: string) => `skips#${day}`;

/**
 * Count one skipped call. Best-effort: a failure here must never turn a
 * successfully-avoided cost into a pipeline error, so it logs and moves on.
 */
export async function recordSkip(reason: SkipReason, day: string, durationSec = 0): Promise<void> {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : 0;
  const base = Date.parse(`${day}T00:00:00.000Z`);
  const expiresAt =
    Math.floor((Number.isNaN(base) ? Date.now() : base) / 1000) + RETENTION_DAYS * 24 * 60 * 60;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { quota_id: statsId(day) },
        UpdateExpression: "ADD #count :one, #sec :seconds SET expires_at = :exp",
        ExpressionAttributeNames: { "#count": `${reason}_count`, "#sec": `${reason}_sec` },
        ExpressionAttributeValues: { ":one": 1, ":seconds": seconds, ":exp": expiresAt },
      })
    );
  } catch (err) {
    logger.warn(`Could not record ${reason} skip for ${day}`, err);
  }
}

/** Read one day's tallies. Missing counters read as zero. */
export async function getSkipStats(day: string): Promise<SkipStats> {
  const empty: SkipStats = {
    day,
    too_short_count: 0,
    too_short_sec: 0,
    daily_cap_count: 0,
    daily_cap_sec: 0,
    no_team_count: 0,
    no_team_sec: 0,
  };
  try {
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { quota_id: statsId(day) } }));
    const item = res.Item as Record<string, number> | undefined;
    if (!item) return empty;
    return {
      day,
      too_short_count: Number(item.too_short_count ?? 0),
      too_short_sec: Number(item.too_short_sec ?? 0),
      daily_cap_count: Number(item.daily_cap_count ?? 0),
      daily_cap_sec: Number(item.daily_cap_sec ?? 0),
      no_team_count: Number(item.no_team_count ?? 0),
      no_team_sec: Number(item.no_team_sec ?? 0),
    };
  } catch (err) {
    logger.warn(`Could not read skip stats for ${day}`, err);
    return empty;
  }
}
