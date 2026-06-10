import path from "path";
import { logger } from "../logger.js";
import { getActivePatternsCached, incrementMatchCount } from "../db/patterns.js";
import type { RecordingMeta, RecordingPattern } from "../types.js";

/**
 * Built-in recording-filename pattern (the real Scaler dialer format), written
 * with NAMED capture groups so it shares the same assembly path as any custom
 * super_admin pattern.
 *
 *   agent-<agentId>-<sessTs>-<sessSeq>-<campaign>-<YYYY>_<MM>_<DD>_<HH>_<MM>_<SS>-<customer>.<ext>
 *
 * Example:
 *   Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3
 */
export const BUILTIN_PATTERN_SOURCE =
  "^agent-(?<agent_id>\\d+)-(?<session_ts>\\d+)-(?<session_seq>\\d+)-(?<campaign>[^-]+)-" +
  "(?<year>\\d{4})_(?<month>\\d{2})_(?<day>\\d{2})_(?<hour>\\d{2})_(?<minute>\\d{2})_(?<second>\\d{2})-" +
  "(?<customer_number>\\d+)\\.(?<ext>[a-z0-9]+)$";

const BUILTIN_REGEX = new RegExp(BUILTIN_PATTERN_SOURCE, "i");

/** Assemble RecordingMeta from a regex's named capture groups. */
function metaFromGroups(key: string, fileName: string, g: Record<string, string | undefined>): RecordingMeta | null {
  const agent_id = g.agent_id?.trim();
  if (!agent_id) return null; // agent_id is the one truly required field

  const session_id =
    g.session_id?.trim() || [g.session_ts, g.session_seq].filter(Boolean).join("-");

  let call_datetime = "";
  if (g.call_datetime?.trim()) {
    call_datetime = g.call_datetime.trim();
  } else if (g.year && g.month && g.day) {
    const hh = g.hour ?? "00";
    const mi = g.minute ?? "00";
    const ss = g.second ?? "00";
    call_datetime = `${g.year}-${g.month}-${g.day}T${hh}:${mi}:${ss}.000Z`;
  }

  const ext = (g.ext ?? path.extname(fileName).replace(/^\./, "")).toLowerCase();

  return {
    recording_key: key,
    file_name: fileName,
    agent_id,
    session_id,
    campaign: g.campaign?.trim() ?? "",
    customer_number: g.customer_number?.trim() ?? "",
    call_datetime,
    extension: ext,
  };
}

/**
 * Synchronous parse using the BUILT-IN pattern only. Used for backfill listing
 * (`isRecordingKey`) and unit tests. The worker pipeline uses the async
 * `resolveRecordingMeta`, which also honors custom super_admin patterns.
 */
export function parseRecordingMeta(key: string): RecordingMeta | null {
  const fileName = path.basename(key);
  const m = BUILTIN_REGEX.exec(fileName);
  if (!m || !m.groups) {
    logger.debug(`File does not match built-in recording pattern: ${fileName}`);
    return null;
  }
  return metaFromGroups(key, fileName, m.groups);
}

/** Safely compile a stored pattern; returns null on an invalid regex. */
function compile(p: RecordingPattern): { id: string; regex: RegExp } | null {
  try {
    return { id: p.pattern_id, regex: new RegExp(p.regex, p.flags || "i") };
  } catch (err) {
    logger.warn(`Skipping invalid recording pattern ${p.label} (${p.pattern_id})`, err);
    return null;
  }
}

/**
 * Resolve recording metadata using the configured patterns (priority order,
 * cached), then the built-in default as a fallback. The matching pattern's
 * usage counter is incremented (fire-and-forget) to drive auto-promotion.
 */
export async function resolveRecordingMeta(key: string): Promise<RecordingMeta | null> {
  const fileName = path.basename(key);

  let patterns: RecordingPattern[] = [];
  try {
    patterns = await getActivePatternsCached();
  } catch (err) {
    logger.warn("Could not load recording patterns; using built-in default", err);
  }

  for (const p of patterns) {
    const compiled = compile(p);
    if (!compiled) continue;
    const m = compiled.regex.exec(fileName);
    if (m && m.groups) {
      const meta = metaFromGroups(key, fileName, m.groups);
      if (meta) {
        void incrementMatchCount(compiled.id).catch(() => {});
        return meta;
      }
    }
  }

  // Fallback for fresh installs (no patterns seeded yet) or all-invalid configs.
  return parseRecordingMeta(key);
}

/** Deterministic, human-readable audit id used as the Audits table PK. */
export function buildAuditId(meta: RecordingMeta): string {
  return `${meta.agent_id}-${meta.session_id}`;
}

/** Quick predicate for filtering S3 listings / validating event keys. */
export function isRecordingKey(key: string): boolean {
  return BUILTIN_REGEX.test(path.basename(key));
}
