import { logger } from "../logger.js";
import { resolveRecordingMeta, buildAuditId } from "../lib/filename.js";
import {
  getRecordingBuffer,
  saveTranscription,
  saveTranscriptStructured,
  getTranscription,
  saveAuditDocument,
  s3Url,
} from "../lib/s3.js";
import { sendMessage, type Heartbeat } from "../lib/sqs.js";
import { probeBufferDurationSec } from "../lib/audio.js";
import { normalizeTerms, substitutionCount } from "../lib/glossary.js";
import { transcribeCall, auditTranscript } from "./ai/index.js";
// Imported from the contract module rather than the dispatcher so an `instanceof`
// check still works when tests mock the dispatcher.
import { TranscriptValidationError } from "./ai/types.js";
import { getUserByAgentId } from "../db/users.js";
import { getTeam } from "../db/teams.js";
import { createAuditIfAbsent, getAudit, updateAudit, setStatus } from "../db/audits.js";
import { reserveDailySlot, releaseDailySlot } from "../db/quota.js";
import { recordSkip } from "../db/skipStats.js";
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
/**
 * How far ahead to push the SQS visibility timeout on each poll of a running
 * transcription job. Comfortably longer than the poll interval, so one slow
 * status call can't let the message become visible again mid-job.
 */
const VISIBILITY_EXTENSION_SEC = 300;

export async function processTranscription(
  recordingKey: string,
  queueTeamId: string | null = null,
  heartbeat?: Heartbeat
): Promise<void> {
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
  const infra = await resolveTeamInfra(queueTeamId);

  // Idempotency read. The conditional create below is what actually serializes
  // concurrent first-time deliveries; this earlier read just avoids re-downloading
  // and re-probing a recording that is already done. `failed` and `queued` stay
  // re-processable.
  const prior = await getAudit(auditId);
  if (prior && prior.status !== "failed" && prior.status !== "queued") {
    logger.info(`Skipping ${auditId} — already processed (status=${prior.status})`);
    return;
  }

  const buffer = await getRecordingBuffer(recordingKey, infra.recording_bucket);
  const durationSec = await probeBufferDurationSec(buffer, meta.file_name);
  const settings = await getModelSettingsCached();
  const day = meta.call_datetime.slice(0, 10); // YYYY-MM-DD (the call's own date)

  // ---- Gates -------------------------------------------------------------
  // All three run BEFORE the audit row is created, so a rejected call leaves no
  // row behind: the logs view stays clean and the table only ever holds calls we
  // actually spend money on. Each skip bumps a per-day tally instead, so the
  // volume controls stay measurable without one row per rejected call.
  //
  // Nothing below this point has incurred AI cost yet — only an S3 download and
  // a local ffprobe.

  // Gate 1 — call length: recordings shorter than the configured minimum audit
  // duration are skipped before incurring any transcription/audit cost. Fail
  // open — a 0 (unprobeable) duration is NOT skipped. The threshold is the
  // runtime-configurable `min_audit_duration_sec` (env fallback).
  const minDuration = settings.min_audit_duration_sec;
  if (minDuration > 0 && durationSec > 0 && durationSec < minDuration) {
    await recordSkip("too_short", day, durationSec);
    logger.info(`Skipping ${auditId} — call too short (${durationSec.toFixed(1)}s < ${minDuration}s)`);
    return;
  }

  // Gate 2 — team mapping. Without a team there is no rubric, so the audit can
  // never complete: transcribing it would spend money on a call that is
  // guaranteed to fail at stage 2. Skip before that spend. Recoverable — map the
  // agent and re-ingest the recording. It also has to run BEFORE the cap gate,
  // because the cap is keyed on the team and would otherwise be bypassed
  // entirely for exactly these calls.
  if (!team) {
    await recordSkip("no_team", day, durationSec);
    logger.warn(
      `Skipping ${auditId} — no team mapping for agent ${meta.agent_id}; map the agent and re-ingest to audit it`
    );
    return;
  }

  // Gate 3 — per-agent daily audit cap (per-team, admin-set). `reserveDailySlot`
  // claims a slot with a single conditional write, so concurrent messages for the
  // same agent/day cannot exceed the cap. The reservation is keyed on `audit_id`,
  // making a redelivery of the same recording reuse its slot rather than consume
  // a second one.
  const teamRow = await getTeam(team);
  const cap = teamRow?.daily_audit_cap ?? 0;
  let reserved = false;
  if (cap > 0) {
    const slot = await reserveDailySlot(meta.agent_id, day, cap, auditId);
    if (!slot.granted) {
      await recordSkip("daily_cap", day, durationSec);
      logger.info(`Skipping ${auditId} — daily cap reached for agent ${meta.agent_id} (${slot.used}/${cap} on ${day})`);
      return;
    }
    reserved = true;
  }

  // ---- Past the gates: this call is going to be transcribed, so it earns a row.
  // The conditional create is what serializes two concurrent first-time
  // deliveries of the same recording — the loser backs off here rather than
  // paying to transcribe it twice.
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
    status: "transcribing",
    duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
    created_at: now,
    updated_at: now,
  };
  const created = await createAuditIfAbsent(record);
  if (!created) {
    const existing = await getAudit(auditId);
    if (existing && existing.status !== "failed" && existing.status !== "queued") {
      logger.info(`Skipping ${auditId} — another worker already claimed it (status=${existing.status})`);
      // Deliberately NOT releasing the slot: reservations are keyed on audit_id,
      // so both workers hold the *same* slot. The winner is transcribing under
      // it, and releasing here would free the slot out from under them.
      return;
    }
    await setStatus(auditId, "transcribing");
  }

  const { transcription_model } = settings;
  let result: Awaited<ReturnType<typeof transcribeCall>>;
  let transcriptionKey: string;
  let transcriptJsonKey: string | undefined;
  try {
    result = await transcribeCall(settings.ai_provider, buffer, meta.file_name, transcription_model, {
      // Resume rather than resubmit. Sarvam transcription is a paid job, so a
      // redelivery that re-submitted would bill the same audio twice.
      jobId: prior?.stt_job_id ?? null,
      onJobId: async (id) => {
        await updateAudit(auditId, { stt_job_id: id });
      },
      // Stay owner of the SQS message while a batch job runs for minutes.
      onProgress: heartbeat ? () => heartbeat(VISIBILITY_EXTENSION_SEC) : undefined,
    });

    // Fix known brand-term mis-hearings before anything reads the transcript. On
    // 8 kHz audio "Scaler" never survives ASR — it comes back as Eskillo, Skillo or
    // SKL — and the rubric asks whether the agent gave the standard brand greeting,
    // so without this the auditor penalises a greeting the agent got right.
    // Provider-agnostic on purpose: the OpenAI path transcribes the same audio and
    // has the same problem. Substitutions are logged rather than applied silently,
    // because this edits an artifact a score may later be defended with.
    const fixedText = normalizeTerms(result.text);
    if (substitutionCount(fixedText.substitutions) > 0) {
      logger.info(
        `${auditId}: normalised brand terms in transcript — ` +
          Object.entries(fixedText.substitutions).map(([k, n]) => `${k} x${n}`).join(", ")
      );
    }
    result = {
      ...result,
      text: fixedText.text,
      turns: result.turns.map((t) => ({ ...t, text: normalizeTerms(t.text).text })),
    };

    transcriptionKey = await saveTranscription(result.text, auditId, infra.output_bucket);
    // Sibling artifact with the diarized turns. The .txt above stays the audit
    // input and what the dashboard renders, so nothing downstream has to change.
    if (result.turns.length > 0) {
      transcriptJsonKey = await saveTranscriptStructured(
        {
          audit_id: auditId,
          language_code: result.languageCode,
          speaker_roles: result.roles,
          talk_time_sec: result.talkTimeSec,
          turns: result.turns,
        },
        auditId,
        infra.output_bucket
      );
    }
  } catch (err) {
    // Hand the slot back so a permanently broken recording doesn't hold one of
    // the agent's daily slots. A redelivery re-claims it (idempotently, by
    // audit_id), so a transient failure still only ever consumes one.
    if (reserved) await releaseDailySlot(meta.agent_id, day, auditId);
    // A timeline fault means the provider returned a transcript that contradicts
    // the audio. Terminal, not retryable: the fault is deterministic, so letting
    // SQS redeliver would pay to transcribe the same recording again for the same
    // wrong answer. Fail the row so it is visible, and drop the message.
    if (err instanceof TranscriptValidationError) {
      logger.error(`${auditId} failed transcript validation: ${err.message}`);
      await setStatus(auditId, "failed", err.message);
      return;
    }
    throw err;
  }

  await updateAudit(auditId, {
    status: "transcribed",
    duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
    transcription_key: transcriptionKey,
    transcription_url: s3Url(infra.output_bucket, transcriptionKey),
    transcribed_at: new Date().toISOString(),
    ai_provider: settings.ai_provider,
    transcript_json_key: transcriptJsonKey,
    speaker_roles: result.roles,
    talk_time_sec: result.talkTimeSec,
    detected_language: result.languageCode ?? undefined,
  });

  if (result.roles.agent && result.roles.confidence < 0.5) {
    logger.warn(
      `${auditId}: speaker attribution is low-confidence (${result.roles.confidence.toFixed(2)}, ` +
        `via ${result.roles.method}) — the audit will still run, but treat agent/customer labels with caution`
    );
  }

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
  // An empty transcript is not scoreable, and the auditor will not tell us so — it
  // will return plausible criterion scores for a blank call, which then land on a
  // real agent's record. The provider rejects this case too; this second check
  // covers every path into the audit stage, including older rows and any future
  // provider that returns nothing without saying so.
  if (!transcript.trim()) {
    await setStatus(
      audit_id,
      "failed",
      `Transcript at ${transcription_key} is empty — refusing to score a blank call. Re-ingest the recording to retry.`
    );
    logger.error(`${audit_id}: empty transcript at ${transcription_key}; not auditing`);
    return;
  }
  // Read fresh rather than trusting the provider stamped at transcription time:
  // the transcript is just text, so auditing it with whatever provider is current
  // is correct, and it means a switch takes effect on the audit stage immediately.
  const { audit_model, ai_provider } = await getModelSettingsCached();

  // Score against the primary rubric (the team row) + every active additional
  // rubric for the team. Each produces its own RubricResult.
  const additional = (await listRubricsByTeam(team)).filter((r) => r.active);
  const scorables = [
    { rubric_id: "primary", spec: rubric },
    ...additional.map((r) => ({ rubric_id: r.rubric_id, spec: r })),
  ];

  const rubricResults: RubricResult[] = [];
  for (const s of scorables) {
    const r = await auditTranscript(ai_provider, transcript, s.spec, { audit_id, agent_id, team }, audit_model);
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
