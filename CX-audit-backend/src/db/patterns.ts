import { query, queryOne, execute } from "../lib/db.js";
import { logger } from "../logger.js";
import type { RecordingPattern } from "../types.js";

const CACHE_TTL_MS = 60_000; // workers parse on the hot path — don't hit the DB per message

export function newPatternId(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `PAT-${rand}`;
}

export async function listPatterns(): Promise<RecordingPattern[]> {
  return query<RecordingPattern>("SELECT * FROM cx_recording_patterns ORDER BY priority");
}

export async function getPattern(id: string): Promise<RecordingPattern | null> {
  return queryOne<RecordingPattern>("SELECT * FROM cx_recording_patterns WHERE pattern_id = $1", [id]);
}

export async function putPattern(p: RecordingPattern): Promise<RecordingPattern> {
  await execute(
    `INSERT INTO cx_recording_patterns
       (pattern_id, label, regex, flags, priority, active, match_count, is_builtin, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (pattern_id) DO UPDATE SET
       label = EXCLUDED.label, regex = EXCLUDED.regex, flags = EXCLUDED.flags,
       priority = EXCLUDED.priority, active = EXCLUDED.active, match_count = EXCLUDED.match_count,
       is_builtin = EXCLUDED.is_builtin, created_by = EXCLUDED.created_by,
       created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
    [p.pattern_id, p.label, p.regex, p.flags, p.priority, p.active, p.match_count, p.is_builtin, p.created_by, p.created_at, p.updated_at]
  );
  invalidatePatternCache();
  return p;
}

export async function deletePattern(id: string): Promise<void> {
  await execute("DELETE FROM cx_recording_patterns WHERE pattern_id = $1", [id]);
  invalidatePatternCache();
}

export async function updatePatternFields(
  id: string,
  patch: Partial<Pick<RecordingPattern, "label" | "regex" | "flags" | "priority" | "active">>
): Promise<RecordingPattern | null> {
  const sets: string[] = ["updated_at = $1"];
  const values: unknown[] = [new Date().toISOString()];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(v);
    sets.push(`${k} = $${values.length}`);
  }
  values.push(id);
  const updated = await queryOne<RecordingPattern>(
    `UPDATE cx_recording_patterns SET ${sets.join(", ")} WHERE pattern_id = $${values.length} RETURNING *`,
    values
  );
  invalidatePatternCache();
  return updated;
}

/** Atomically bump a pattern's usage counter (fire-and-forget on the hot path). */
export async function incrementMatchCount(id: string): Promise<void> {
  await execute(
    "UPDATE cx_recording_patterns SET match_count = match_count + 1, updated_at = $1 WHERE pattern_id = $2",
    [new Date().toISOString(), id]
  );
}

async function setPriority(id: string, priority: number): Promise<void> {
  await execute(
    "UPDATE cx_recording_patterns SET priority = $1, updated_at = $2 WHERE pattern_id = $3",
    [priority, new Date().toISOString(), id]
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

  const all = await query<RecordingPattern>(
    "SELECT * FROM cx_recording_patterns WHERE active = true ORDER BY priority"
  );
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
