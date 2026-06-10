import { env } from "../env.js";
import { logger } from "../logger.js";
import { resolveRecordingMeta, buildAuditId } from "../lib/filename.js";
import {
  getRecordingBuffer,
  saveTranscription,
  getTranscription,
  saveAuditDocument,
  s3Url,
} from "../lib/s3.js";
import { sendMessage } from "../lib/sqs.js";
import { transcribeAudio, auditTranscript } from "./openai.js";
import { getUserByAgentId } from "../db/users.js";
import { getTeam } from "../db/teams.js";
import { createAuditIfAbsent, getAudit, updateAudit, setStatus } from "../db/audits.js";
import { recordAuditPerformance } from "../db/performance.js";
import { getModelSettingsCached } from "../db/settings.js";
import type { AuditDocument, AuditQueueMessage, AuditRecord } from "../types.js";

/**
 * STAGE 1 — Transcription.
 *
 * Idempotently registers the recording, transcribes it, stores the transcript
 * in S3, and hands off to the audit queue. Safe to call repeatedly for the same
 * key: the conditional create guarantees a single audit row, and a recording
 * that is already past `queued` is skipped.
 */
export async function processTranscription(recordingKey: string): Promise<void> {
  const meta = await resolveRecordingMeta(recordingKey);
  if (!meta) {
    logger.warn(`Ignoring non-recording key: ${recordingKey}`);
    return;
  }

  const auditId = buildAuditId(meta);

  // Resolve the team up front so it is stored on the row for scope queries.
  const agentUser = await getUserByAgentId(meta.agent_id);
  const team = agentUser?.team ?? null;
  if (!team) {
    logger.warn(`No team mapping for agent ${meta.agent_id} (audit ${auditId})`);
  }

  const now = new Date().toISOString();
  const record: AuditRecord = {
    audit_id: auditId,
    recording_key: recordingKey,
    recording_url: s3Url(env.S3_RECORDING_BUCKET, recordingKey),
    agent_id: meta.agent_id,
    session_id: meta.session_id,
    campaign: meta.campaign,
    customer_number: meta.customer_number,
    call_datetime: meta.call_datetime,
    team,
    status: "queued",
    created_at: now,
    updated_at: now,
  };

  const created = await createAuditIfAbsent(record);
  if (!created) {
    const existing = await getAudit(auditId);
    if (existing && existing.status !== "failed" && existing.status !== "queued") {
      logger.info(`Skipping ${auditId} — already processed (status=${existing.status})`);
      return;
    }
    logger.info(`Re-processing ${auditId} (previous status=${existing?.status})`);
  }

  await setStatus(auditId, "transcribing");
  const buffer = await getRecordingBuffer(recordingKey);
  const { transcription_model } = await getModelSettingsCached();
  const transcript = await transcribeAudio(buffer, meta.file_name, transcription_model);
  const transcriptionKey = await saveTranscription(transcript, auditId);

  await updateAudit(auditId, {
    status: "transcribed",
    transcription_key: transcriptionKey,
    transcription_url: s3Url(env.S3_OUTPUT_BUCKET, transcriptionKey),
    transcribed_at: new Date().toISOString(),
  });

  const message: AuditQueueMessage = {
    audit_id: auditId,
    agent_id: meta.agent_id,
    transcription_key: transcriptionKey,
  };
  await sendMessage(env.SQS_AUDIT_QUEUE_URL, message);
  logger.info(`Enqueued ${auditId} for auditing`);
}

/**
 * STAGE 2 — Auditing.
 *
 * Loads the transcript, selects the team's rubric, scores the call, writes the
 * audit document to S3, and finalizes the audit row.
 */
export async function processAudit(message: AuditQueueMessage): Promise<void> {
  const { audit_id, agent_id, transcription_key } = message;

  const audit = await getAudit(audit_id);
  if (!audit) {
    logger.warn(`Audit row ${audit_id} not found; skipping`);
    return;
  }
  if (audit.status === "audited") {
    logger.info(`Audit ${audit_id} already complete; skipping`);
    return;
  }

  // Team -> rubric resolution (point 7). Falls back gracefully if unmapped.
  const team = audit.team ?? (await getUserByAgentId(agent_id))?.team ?? null;
  if (!team) {
    await setStatus(audit_id, "failed", `No team mapping for agent ${agent_id}; cannot select rubric.`);
    return;
  }
  const rubric = await getTeam(team);
  if (!rubric) {
    await setStatus(audit_id, "failed", `No rubric configured for team ${team}.`);
    return;
  }

  await setStatus(audit_id, "auditing");
  const transcript = await getTranscription(transcription_key);
  const { audit_model } = await getModelSettingsCached();
  const result = await auditTranscript(transcript, rubric, { audit_id, agent_id, team }, audit_model);

  const auditedAt = new Date().toISOString();
  const doc: AuditDocument = {
    audit_id,
    recording_key: audit.recording_key,
    agent_id,
    session_id: audit.session_id,
    campaign: audit.campaign,
    customer_number: audit.customer_number,
    call_datetime: audit.call_datetime,
    team,
    rubric_name: rubric.name,
    score: result.score,
    flagged: result.flagged,
    flag_reason: result.flag_reason,
    criteria_scores: result.criteria_scores,
    transcription_key,
    audited_at: auditedAt,
  };
  const auditKey = await saveAuditDocument(doc, audit_id);

  await updateAudit(audit_id, {
    status: "audited",
    team,
    audit_key: auditKey,
    audit_url: s3Url(env.S3_OUTPUT_BUCKET, auditKey),
    score: result.score,
    flagged: result.flagged,
    flag_reason: result.flag_reason,
    criteria_scores: result.criteria_scores,
    audited_at: auditedAt,
  });

  // Fold the score into the cumulative performance aggregates exactly once. The
  // flag guards against double-counting on SQS redelivery; a manual re-audit
  // (admin correction) deliberately does NOT re-aggregate.
  if (!audit.performance_recorded) {
    await recordAuditPerformance({
      agentId: agent_id,
      team,
      score: result.score,
      flagged: result.flagged,
      datetimeISO: audit.call_datetime,
    });
    await updateAudit(audit_id, { performance_recorded: true });
  }

  logger.info(`Audited ${audit_id}: score=${result.score} flagged=${result.flagged}`);
}
