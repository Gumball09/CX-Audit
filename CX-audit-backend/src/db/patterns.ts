import { GetCommand, PutCommand, DeleteCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { RecordingPattern } from "../types.js";

const TABLE = env.DDB_PATTERNS_TABLE;
const CACHE_TTL_MS = 60_000; // workers parse on the hot path — don't hit DDB per message

export function newPatternId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `PAT-${rand}`;
}

export async function listPatterns(): Promise<RecordingPattern[]> {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return ((res.Items as RecordingPattern[]) ?? []).sort((a, b) => a.priority - b.priority);
}

export async function getPattern(id: string): Promise<RecordingPattern | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pattern_id: id } }));
  return (res.Item as RecordingPattern) ?? null;
}

export async function putPattern(p: RecordingPattern): Promise<RecordingPattern> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: p }));
  invalidatePatternCache();
  return p;
}

export async function deletePattern(id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pattern_id: id } }));
  invalidatePatternCache();
}

export async function updatePatternFields(
  id: string,
  patch: Partial<Pick<RecordingPattern, "label" | "regex" | "flags" | "priority" | "active">>
): Promise<RecordingPattern | null> {
  const sets: string[] = ["updated_at = :u"];
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const names: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`#${k} = :${k}`);
    names[`#${k}`] = k;
    values[`:${k}`] = v;
  }
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pattern_id: id },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(pattern_id)",
      ReturnValues: "ALL_NEW",
    })
  );
  invalidatePatternCache();
  return (res.Attributes as RecordingPattern) ?? null;
}

/** Atomically bump a pattern's usage counter (fire-and-forget on the hot path). */
export async function incrementMatchCount(id: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pattern_id: id },
      UpdateExpression: "ADD match_count :one SET updated_at = :u",
      ExpressionAttributeValues: { ":one": 1, ":u": new Date().toISOString() },
    })
  );
}

async function setPriority(id: string, priority: number): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pattern_id: id },
      UpdateExpression: "SET priority = :p, updated_at = :u",
      ExpressionAttributeValues: { ":p": priority, ":u": new Date().toISOString() },
    })
  );
}

// ---- cached active-pattern loader (with auto-promotion) -------------------

let cache: { at: number; patterns: RecordingPattern[] } | null = null;

export function invalidatePatternCache(): void {
  cache = null;
}

/**
 * Return active patterns in priority order, cached for CACHE_TTL_MS. On each
 * cache refresh, runs the promotion rule: if the most-matched pattern is not the
 * current default (lowest priority), it swaps priorities so the more-used format
 * becomes the default that is checked first.
 */
export async function getActivePatternsCached(): Promise<RecordingPattern[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.patterns;

  const all = (await ddb.send(new ScanCommand({ TableName: TABLE })).then((r) => (r.Items as RecordingPattern[]) ?? []))
    .filter((p) => p.active);
  all.sort((a, b) => a.priority - b.priority);

  await maybePromote(all);
  cache = { at: Date.now(), patterns: all };
  return all;
}

/** Promote the most-used pattern to default if it beats the current default. */
async function maybePromote(patterns: RecordingPattern[]): Promise<void> {
  if (patterns.length < 2) return;
  const current = patterns[0]; // lowest priority = current default
  let top = patterns[0];
  for (const p of patterns) if (p.match_count > top.match_count) top = p;

  if (top.pattern_id !== current.pattern_id && top.match_count > current.match_count) {
    try {
      const topPriority = top.priority;
      await Promise.all([setPriority(top.pattern_id, current.priority), setPriority(current.pattern_id, topPriority)]);
      // Reflect the swap in the in-memory copy so this window uses the new order.
      top.priority = current.priority;
      current.priority = topPriority;
      patterns.sort((a, b) => a.priority - b.priority);
      logger.info(
        `Promoted recording pattern "${top.label}" to default ` +
          `(matches ${top.match_count} > previous default ${current.label} ${current.match_count})`
      );
    } catch (err) {
      logger.warn("Pattern promotion failed (will retry next refresh)", err);
    }
  }
}
