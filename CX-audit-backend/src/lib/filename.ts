import path from "path";
import { logger } from "../logger.js";
import type { RecordingMeta } from "../types.js";

/**
 * Parses recording metadata from an S3 key.
 *
 * Expected file name layout (real Scaler dialer format):
 *
 *   agent-<agentId>-<sessTs>-<sessSeq>-<campaign>-<YYYY>_<MM>_<DD>_<HH>_<MM>_<SS>-<customer>.<ext>
 *
 * Example:
 *   Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3
 *     agent_id        = 495367
 *     session_id      = 1711950009-255903
 *     campaign        = Scaler
 *     call_datetime   = 2024-04-01T11:10:09 (local, no tz in source)
 *     customer_number = 916353969873
 */
const RECORDING_REGEX =
  /^agent-(\d+)-(\d+)-(\d+)-([^-]+)-(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})-(\d+)\.([a-z0-9]+)$/i;

export function parseRecordingMeta(key: string): RecordingMeta | null {
  const fileName = path.basename(key);
  const m = RECORDING_REGEX.exec(fileName);
  if (!m) {
    logger.debug(`File does not match recording pattern: ${fileName}`);
    return null;
  }

  const [, agentId, sessTs, sessSeq, campaign, yyyy, mm, dd, hh, min, ss, customer, ext] = m;

  // Source filenames carry no timezone; we keep wall-clock time as ISO.
  const callDatetime = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.000Z`;

  const meta: RecordingMeta = {
    recording_key: key,
    file_name: fileName,
    agent_id: agentId,
    session_id: `${sessTs}-${sessSeq}`,
    campaign,
    customer_number: customer,
    call_datetime: callDatetime,
    extension: ext.toLowerCase(),
  };

  logger.debug("Parsed recording metadata", {
    agent_id: meta.agent_id,
    session_id: meta.session_id,
    campaign: meta.campaign,
  });
  return meta;
}

/** Deterministic, human-readable audit id used as the Audits table PK. */
export function buildAuditId(meta: RecordingMeta): string {
  return `${meta.agent_id}-${meta.session_id}`;
}

/** Quick predicate for filtering S3 listings / validating event keys. */
export function isRecordingKey(key: string): boolean {
  return RECORDING_REGEX.test(path.basename(key));
}
