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
import { probeBufferDurationSec } from "../lib/audio.js";
import { transcribeAudio, auditTranscript } from "./openai.js";
import { getUserByAgentId } from "../db/users.js";
import { getTeam } from "../db/teams.js";
import { createAuditIfAbsent, getAudit, updateAudit, setStatus } from "../db/audits.js";
import { listRubricsByTeam } from "../db/rubrics.js";
import { recordAuditPerformance } from "../db/performance.js";
import { getModelSettingsCached } from "../db/settings.js";
import { resolveTeamInfra } from "./teamInfra.js";
import type { AuditDocument, AuditQueueMessage, AuditRecord, RubricResult } from "../types.js";

/**
 * STAGE 1 — Transcription.
 *
 * Idempotently registers the recording, transcribes it, stores the transcript
 * in S3, and hands off to the audit queue. Safe to call repeatedly for the same
 * key: the conditional create guarantees a single audit row, and a recording
 * that is already past `queued` is skipped.
 */
export async function processTranscription(recordingKey: string, queueTeamId: string | null = null): Promise<void> {
  const meta = await resolveRecordingMeta(recordingKey);
  if (!meta) {
    logger.warn(`Ignoring non-recording key: ${recordingKey}`);
    return;
  }

  const auditId = buildAuditId(meta);

  // `queueTeamId` is the team that owns the queue this message came off (null =
  // the shared/global queue). It's authoritative for which infra to use. The
  // row's `team` is that, falling back to the agent→team mapping for shared
  // teams on the global queue.
  const agentUser = await getUserByAgentId(meta.agent_id);
  const team = queueTeamId ?? agentUser?.team ?? null;
  if (!team) {
    logger.warn(`No team mapping for agent ${meta.agent_id} (audit ${auditId})`);
  }
  const infra = await resolveTeamInfra(queueTeamId);

  const now = new Date().toISOString();
  const record: AuditRecord = {
    audit_id: auditId,
    recording_key: recordingKey,
    recording_url: s3Url(infra.recording_bucket, recordingKey),
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
    // `skipped` stays re-processable so lowering MIN_CALL_DURATION_SECONDS and
    // reprocessing can re-evaluate a previously-too-short call.
    if (existing && existing.status !== "failed" && existing.status !== "queued" && existing.status !== "skipped") {
      logger.info(`Skipping ${auditId} — already processed (status=${existing.status})`);
      return;
    }
    logger.info(`Re-processing ${auditId} (previous status=${existing?.status})`);
  }

  await setStatus(auditId, "transcribing");
  const buffer = await getRecordingBuffer(recordingKey, infra.recording_bucket);

  // Gate on call length: recordings shorter than the configured minimum are too
  // short to score, so mark them `skipped` and stop before incurring any
  // transcription/audit cost. Fail open — a 0 (unprobeable) duration is NOT
  // skipped. `duration_sec` is also stored for display on longer calls.
  const durationSec = await probeBufferDurationSec(buffer, meta.file_name);
  const minDuration = env.MIN_CALL_DURATION_SECONDS;
  if (minDuration > 0 && durationSec > 0 && durationSec < minDuration) {
    await updateAudit(auditId, { status: "skipped", duration_sec: Math.round(durationSec) });
    logger.info(`Skipping ${auditId} — call too short (${durationSec.toFixed(1)}s < ${minDuration}s)`);
    return;
  }

  const { transcription_model } = await getModelSettingsCached();
  const transcript = await transcribeAudio(buffer, meta.file_name, transcription_model);
  const transcriptionKey = await saveTranscription(transcript, auditId, infra.output_bucket);

  await updateAudit(auditId, {
    status: "transcribed",
    duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
    transcription_key: transcriptionKey,
    transcription_url: s3Url(infra.output_bucket, transcriptionKey),
    transcribed_at: new Date().toISOString(),
  });

  const message: AuditQueueMessage = {
    audit_id: auditId,
    agent_id: meta.agent_id,
    transcription_key: transcriptionKey,
  };
  await sendMessage(infra.audit_queue_url, message);
  logger.info(`Enqueued ${auditId} for auditing (team=${team ?? "—"})`);
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
  const infra = await resolveTeamInfra(team);

  await setStatus(audit_id, "auditing");
  const transcript = await getTranscription(transcription_key, infra.output_bucket);
  const { audit_model } = await getModelSettingsCached();

  // Score against the primary rubric (the team row) + every active additional
  // rubric for the team. Each produces its own RubricResult.
  const additional = (await listRubricsByTeam(team)).filter((r) => r.active);
  const scorables = [
    { rubric_id: "primary", spec: rubric },
    ...additional.map((r) => ({ rubric_id: r.rubric_id, spec: r })),
  ];

  const rubricResults: RubricResult[] = [];
  for (const s of scorables) {
    const r = await auditTranscript(transcript, s.spec, { audit_id, agent_id, team }, audit_model);
    rubricResults.push({
      rubric_id: s.rubric_id,
      rubric_name: s.spec.name,
      score: r.score,
      flagged: r.flagged,
      flag_reason: r.flag_reason,
      criteria_scores: r.criteria_scores,
    });
  }

  // Top-level summary: primary rubric's score; flagged if ANY rubric flagged.
  const primary = rubricResults[0];
  const anyFlagged = rubricResults.some((r) => r.flagged);
  const flaggedNames = rubricResults.filter((r) => r.flagged).map((r) => r.rubric_name);
  const topFlagReason = anyFlagged
    ? `Flagged by: ${flaggedNames.join(", ")}. ${primary.flagged ? primary.flag_reason : ""}`.trim()
    : primary.flag_reason;

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
    rubric_name: primary.rubric_name,
    score: primary.score,
    flagged: anyFlagged,
    flag_reason: topFlagReason,
    criteria_scores: primary.criteria_scores,
    rubric_results: rubricResults,
    transcription_key,
    audited_at: auditedAt,
  };
  const auditKey = await saveAuditDocument(doc, audit_id, infra.output_bucket);

  await updateAudit(audit_id, {
    status: "audited",
    team,
    audit_key: auditKey,
    audit_url: s3Url(infra.output_bucket, auditKey),
    score: primary.score,
    flagged: anyFlagged,
    flag_reason: topFlagReason,
    criteria_scores: primary.criteria_scores,
    rubric_results: rubricResults,
    audited_at: auditedAt,
  });

  // Fold the score into the cumulative performance aggregates exactly once. The
  // flag guards against double-counting on SQS redelivery; a manual re-audit
  // (admin correction) deliberately does NOT re-aggregate.
  if (!audit.performance_recorded) {
    await recordAuditPerformance({
      agentId: agent_id,
      team,
      score: primary.score,
      flagged: anyFlagged,
      datetimeISO: audit.call_datetime,
    });
    await updateAudit(audit_id, { performance_recorded: true });
  }

  logger.info(`Audited ${audit_id}: score=${primary.score} flagged=${anyFlagged} (${rubricResults.length} rubric(s))`);
}
