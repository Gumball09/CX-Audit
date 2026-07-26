import { OpenAI } from "openai";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { normalizeWeights } from "../../validation.js";
import { collapseRepetitions } from "../../lib/transcript.js";
import { splitAudioOnSilence, probeBufferDurationSec, normalizeForAsr } from "../../lib/audio.js";
import type { CriterionScore, Feedback } from "../../types.js";
import { TranscriptValidationError } from "./types.js";
import type {
  AuditResult,
  Scorable,
  SpeakerRoles,
  SuggestionOutput,
  TranscribeOptions,
  TranscriptTurn,
  TranscriptionResult,
} from "./types.js";

/**
 * Sarvam AI provider.
 *
 * Two halves, with very different shapes:
 *
 *  - Auditing is easy. Sarvam's chat API is OpenAI-wire-compatible, so we reuse
 *    the `openai` SDK against api.sarvam.ai/v1. Two mandatory differences:
 *    sarvam-105b has reasoning ON by default and reasoning tokens count against
 *    max_tokens, so a small budget truncates the JSON mid-answer.
 *
 *  - Transcription is not. The synchronous endpoint caps at 30 seconds of audio
 *    and our floor for auditing a call is 600, so the asynchronous Batch job API
 *    is mandatory: init -> get presigned upload URLs -> PUT the audio -> start ->
 *    poll -> download a presigned result JSON. Batch is also the only transport
 *    that offers diarization, which is what separates agent from customer.
 */

const BASE = env.SARVAM_BASE_URL.replace(/\/+$/, "");
const KEY = env.SARVAM_API_KEY;

/** True when running without a Sarvam key (deterministic stub mode). */
export const isStubMode = !KEY;

/**
 * Chat client. Sarvam accepts `Authorization: Bearer` for OpenAI-compatible
 * tooling, so the official SDK works unchanged against a different baseURL.
 */
const chat = KEY
  ? new OpenAI({ apiKey: KEY, baseURL: `${BASE}/v1`, maxRetries: 3, timeout: 120_000 })
  : null;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Sarvam returns 403 (not 401) for a bad key, and 429 for both quota and rate. */
export class SarvamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "SarvamError";
  }
}

function classify(status: number, body: string): SarvamError {
  const retryable = status === 429 || status >= 500;
  const hint =
    status === 403
      ? "invalid SARVAM_API_KEY (Sarvam returns 403, not 401, for auth failures)"
      : status === 429
        ? "quota exhausted or rate limit hit"
        : `HTTP ${status}`;
  return new SarvamError(`Sarvam ${hint}: ${body.slice(0, 300)}`, status, retryable);
}

async function api<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      "api-subscription-key": KEY,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Batch speech-to-text
// ---------------------------------------------------------------------------

interface SignedUrl {
  file_url: string;
  file_metadata?: Record<string, unknown> | null;
}
interface InitResponse {
  job_id: string;
  job_state: string;
}
/**
 * The live API returns `upload_urls` / `download_urls` as an OBJECT keyed by file
 * name, not the array the published OpenAPI schema implies. Accept either: being
 * keyed by name is actually the better contract (no positional assumption), but
 * the docs were wrong once here, so don't bet the pipeline on the shape.
 */
type SignedUrlSet = Record<string, SignedUrl> | SignedUrl[];
interface UploadResponse {
  job_id: string;
  upload_urls?: SignedUrlSet;
  storage_container_type?: string;
}
interface DownloadResponse {
  job_id: string;
  download_urls?: SignedUrlSet;
  storage_container_type?: string;
}

/** Resolve a signed URL for `fileName`, tolerating both response shapes. */
function signedUrlFor(set: SignedUrlSet | undefined, fileName: string, index: number): string | null {
  if (!set) return null;
  if (Array.isArray(set)) return set[index]?.file_url ?? null;
  return set[fileName]?.file_url ?? null;
}

/**
 * Sarvam stages batch audio in Azure Blob Storage and hands back SAS URLs. Azure
 * rejects a bare PUT to a block-blob SAS URL with 400 unless this header is
 * present, so it is required rather than optional.
 */
function blobUploadHeaders(url: string): Record<string, string> {
  const azure = url.includes("blob.core.windows.net");
  return {
    "Content-Type": "application/octet-stream",
    ...(azure ? { "x-ms-blob-type": "BlockBlob" } : {}),
  };
}
interface TaskFile {
  file_name: string;
  file_id?: string;
}
interface TaskDetail {
  inputs?: TaskFile[];
  outputs?: TaskFile[];
  state?: string;
  error_message?: string | null;
}
interface StatusResponse {
  job_id: string;
  job_state: "Accepted" | "Pending" | "Running" | "Completed" | "Failed" | string;
  successful_files_count?: number;
  failed_files_count?: number;
  error_message?: string | null;
  job_details?: TaskDetail[];
}

/** Sarvam's diarized output file, one per input audio file. */
interface SarvamTranscript {
  transcript?: string;
  language_code?: string;
  diarized_transcript?: {
    entries?: {
      transcript?: string;
      start_time_seconds?: number;
      end_time_seconds?: number;
      speaker_id?: string;
    }[];
  };
}

const TERMINAL = new Set(["Completed", "Failed"]);

async function initJob(): Promise<string> {
  const body = {
    job_parameters: {
      model: env.SARVAM_STT_MODEL,
      mode: env.SARVAM_STT_MODE,
      language_code: env.SARVAM_LANGUAGE_CODE,
      with_timestamps: true,
      with_diarization: env.SARVAM_DIARIZATION,
      // Sarvam diarizes more consistently with a known speaker count; 0 = auto.
      ...(env.SARVAM_DIARIZATION && env.SARVAM_NUM_SPEAKERS > 0
        ? { num_speakers: env.SARVAM_NUM_SPEAKERS }
        : {}),
    },
  };
  const res = await api<InitResponse>("/speech-to-text/job/v1", { method: "POST", body });
  return res.job_id;
}

/** Upload each part to its presigned URL. Buffers go straight up — no temp files. */
async function uploadParts(jobId: string, parts: { fileName: string; buffer: Buffer }[]): Promise<void> {
  const res = await api<UploadResponse>("/speech-to-text/job/v1/upload-files", {
    method: "POST",
    body: { job_id: jobId, files: parts.map((p) => p.fileName) },
  });
  for (let i = 0; i < parts.length; i++) {
    const { fileName, buffer } = parts[i];
    const url = signedUrlFor(res.upload_urls, fileName, i);
    if (!url) {
      throw new SarvamError(
        `Sarvam returned no upload URL for "${fileName}" (job ${jobId})`,
        500,
        false
      );
    }
    const put = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(buffer),
      headers: blobUploadHeaders(url),
    });
    if (!put.ok) {
      throw classify(put.status, `upload of ${fileName} failed: ${await put.text().catch(() => "")}`);
    }
  }
}

async function pollUntilDone(
  jobId: string,
  onProgress?: TranscribeOptions["onProgress"]
): Promise<StatusResponse> {
  const deadline = Date.now() + env.SARVAM_POLL_TIMEOUT_MS;
  for (;;) {
    const status = await api<StatusResponse>(`/speech-to-text/job/v1/${jobId}/status`, { method: "GET" });
    if (TERMINAL.has(status.job_state)) return status;
    if (Date.now() >= deadline) {
      // Deliberately NOT an error the caller should treat as terminal: the job id
      // is persisted, so a redelivery resumes this same job instead of paying to
      // transcribe the recording again.
      throw new SarvamError(
        `Sarvam job ${jobId} still ${status.job_state} after ${Math.round(env.SARVAM_POLL_TIMEOUT_MS / 1000)}s`,
        408,
        true
      );
    }
    // Keep the SQS message invisible while we wait on a job that can take minutes.
    await onProgress?.();
    await new Promise((r) => setTimeout(r, env.SARVAM_POLL_INTERVAL_MS));
  }
}

/** Fetch and parse every successful output file, in input order. */
async function downloadResults(jobId: string, status: StatusResponse): Promise<SarvamTranscript[]> {
  const outputs = (status.job_details ?? [])
    .filter((d) => (d.state ?? "").toLowerCase() === "success")
    .flatMap((d) => d.outputs ?? [])
    .map((o) => o.file_name)
    .filter(Boolean);

  if (outputs.length === 0) {
    const why = (status.job_details ?? [])
      .map((d) => d.error_message)
      .filter(Boolean)
      .join("; ");
    throw new SarvamError(
      `Sarvam job ${jobId} produced no transcript${why ? `: ${why}` : ""}`,
      500,
      false
    );
  }

  const res = await api<DownloadResponse>("/speech-to-text/job/v1/download-files", {
    method: "POST",
    body: { job_id: jobId, files: outputs },
  });

  const docs: SarvamTranscript[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const name = outputs[i];
    const url = signedUrlFor(res.download_urls, name, i);
    if (!url) {
      throw new SarvamError(`Sarvam returned no download URL for "${name}" (job ${jobId})`, 500, false);
    }
    const got = await fetch(url);
    if (!got.ok) throw classify(got.status, `download of ${name} failed for job ${jobId}`);
    docs.push((await got.json()) as SarvamTranscript);
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Diarization -> turns, roles, talk time
// ---------------------------------------------------------------------------

/**
 * Flatten one or more output documents into turns. Multi-part recordings (>2h,
 * split on silence) need each part's timestamps shifted by the parts before it,
 * or turn 1 of part 2 would appear to happen before the end of part 1.
 */
function toTurns(docs: SarvamTranscript[], partOffsetsSec: number[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  docs.forEach((doc, i) => {
    const offset = partOffsetsSec[i] ?? 0;
    for (const e of doc.diarized_transcript?.entries ?? []) {
      const text = (e.transcript ?? "").trim();
      if (!text) continue;
      turns.push({
        speaker_id: String(e.speaker_id ?? "?"),
        role: null, // filled in once roles are resolved
        start_sec: Number(e.start_time_seconds ?? 0) + offset,
        end_sec: Number(e.end_time_seconds ?? 0) + offset,
        text,
      });
    }
  });
  return turns;
}

/**
 * Frame padding and rounding can push the last timestamp a little past the probed
 * duration, so allow a margin — but nothing remotely like a decode error, which
 * stretches the timeline by whole multiples.
 */
const TIMELINE_TOLERANCE = 1.1;
const TIMELINE_GRACE_SEC = 2;
/** Below this ratio the timeline is suspicious, but legitimately so sometimes. */
const TIMELINE_SHORT_RATIO = 0.5;

/**
 * Check the diarized timeline against the true audio duration.
 *
 * This is the guard for the worst defect we found in this provider: given audio
 * at a sample rate it doesn't expect, Sarvam returns HTTP 200 with a plausible
 * document containing a stretched timeline and phonetic nonsense. A 48 kHz / 359s
 * file came back with turns ending at 1025s — 2.85x, i.e. 48000/16000. Nothing
 * about the response says it failed.
 *
 * Audio cannot contain speech after it ends, so an over-long timeline is a hard
 * invariant with no false positives, and we already know the truth (`ffprobe`).
 * A *short* timeline is only a hint — a call can legitimately end with minutes of
 * hold music or dead air — so it warns rather than faults.
 *
 * Returns `{fault}` when the transcript must not be trusted, `{warning}` when it
 * is merely odd. `durationSec <= 0` means the probe failed: we don't know the
 * truth, so we don't guess.
 */
export function checkTimeline(
  turns: TranscriptTurn[],
  durationSec: number
): { fault: string | null; warning: string | null } {
  if (durationSec <= 0 || turns.length === 0) return { fault: null, warning: null };

  const maxEnd = turns.reduce((m, t) => Math.max(m, t.end_sec), 0);
  const ratio = maxEnd / durationSec;

  if (maxEnd > durationSec * TIMELINE_TOLERANCE + TIMELINE_GRACE_SEC) {
    return {
      fault:
        `transcript timeline ends at ${maxEnd.toFixed(0)}s but the audio is only ` +
        `${durationSec.toFixed(0)}s long (${ratio.toFixed(2)}x) — the provider mis-decoded ` +
        `the audio, so the transcript is not trustworthy and must not be audited`,
      warning: null,
    };
  }
  if (ratio < TIMELINE_SHORT_RATIO) {
    return {
      fault: null,
      warning:
        `transcript timeline ends at ${maxEnd.toFixed(0)}s on a ${durationSec.toFixed(0)}s ` +
        `recording (${ratio.toFixed(2)}x) — probably a silent tail, but worth watching if it recurs`,
    };
  }
  return { fault: null, warning: null };
}

/** Seconds each speaker id held the floor. */
function talkTimeBySpeaker(turns: TranscriptTurn[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of turns) {
    const d = Math.max(0, t.end_sec - t.start_sec);
    m.set(t.speaker_id, (m.get(t.speaker_id) ?? 0) + d);
  }
  return m;
}

/**
 * Heuristic fallback: on a support call the agent almost always speaks first
 * (greeting) and usually holds the floor longer. Weak on its own — used only to
 * sanity-check a low-confidence LLM answer, or when the LLM is unavailable.
 */
function heuristicRoles(turns: TranscriptTurn[]): SpeakerRoles {
  const ids = [...new Set(turns.map((t) => t.speaker_id))];
  if (ids.length < 2) {
    return { agent: ids[0] ?? null, customer: null, confidence: 0.2, method: "heuristic" };
  }
  const first = turns[0]?.speaker_id ?? ids[0];
  const other = ids.find((i) => i !== first) ?? null;
  return { agent: first, customer: other, confidence: 0.4, method: "heuristic" };
}

/** Coerce whatever the model used to identify a speaker into an id string. */
function pickSpeakerId(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["id", "speaker_id", "speaker", "speakerId"]) {
      if (o[k] != null) return String(o[k]);
    }
  }
  return null;
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Pull the role answer out of whatever shape the model chose.
 *
 * We ask for flat `agent_speaker_id` / `customer_speaker_id` keys, but sarvam-105b
 * frequently answers with a nested `{agent: {id, confidence, evidence}}` instead —
 * the right answer in a different shape. Strict `json_schema` would normally pin
 * this down, but it is broken on this model (it emits the schema's own keys as
 * values), so the parser has to absorb the variation instead of rejecting it.
 * Rejecting it meant silently falling back to a weak greeting heuristic and
 * throwing away a confident, correct answer.
 */
export function extractRoleAnswer(parsed: any): {
  agent: string | null;
  customer: string | null;
  confidence: number;
} {
  const agent =
    pickSpeakerId(parsed?.agent_speaker_id) ??
    pickSpeakerId(parsed?.agent_id) ??
    pickSpeakerId(parsed?.agent);
  const customer =
    pickSpeakerId(parsed?.customer_speaker_id) ??
    pickSpeakerId(parsed?.customer_id) ??
    pickSpeakerId(parsed?.customer);
  const confidence =
    firstNumber(parsed?.confidence, parsed?.agent?.confidence, parsed?.customer?.confidence) ?? 0;
  return { agent, customer, confidence: Math.max(0, Math.min(1, confidence)) };
}

/**
 * Decide which diarization speaker id is the agent.
 *
 * Our recordings are 8 kHz mono, so there is no channel to read this from — it
 * has to be inferred. One cheap chat call does it from the opening exchange; at
 * Sarvam's token prices this is a rounding error per call.
 */
async function resolveRoles(turns: TranscriptTurn[], auditId: string): Promise<SpeakerRoles> {
  const ids = [...new Set(turns.map((t) => t.speaker_id))];
  if (ids.length === 0) return { agent: null, customer: null, confidence: 0, method: "unknown" };
  if (ids.length === 1) {
    return { agent: ids[0], customer: null, confidence: 0.2, method: "heuristic" };
  }
  if (!chat) return heuristicRoles(turns);

  // The opening is where roles are most obvious, and it keeps the prompt cheap.
  const opening = turns
    .slice(0, 12)
    .map((t) => `${t.speaker_id}: ${t.text}`)
    .join("\n")
    .slice(0, 4000);

  try {
    const res = await chat.chat.completions.create({
      model: env.SARVAM_AUDIT_MODEL,
      max_tokens: 500,
      temperature: 0,
      // reasoning_effort:null is REQUIRED, not an optimisation. Reasoning is on by
      // default on sarvam-105b and its tokens are spent before any content is
      // emitted, so without this the response comes back with finish_reason
      // "length", an empty `content`, and the entire answer stranded in
      // `reasoning_content`.
      ...({ reasoning_effort: null } as Record<string, unknown>),
      // json_object, NOT json_schema. Strict structured output is broken on
      // sarvam-105b: it emits the schema's own keys as values and then pads
      // newlines until it hits max_tokens. json_object returns clean JSON.
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You label speakers in a customer-support call transcript. The agent works for the company " +
            "(greets, asks for details, explains policy). The customer has the problem. Reply with JSON only.",
        },
        {
          role: "user",
          content:
            `Speaker ids present: ${ids.join(", ")}.\n\n` +
            `Opening of the call:\n${opening}\n\n` +
            `Which speaker id is the agent and which is the customer? ` +
            `Set confidence between 0 and 1, and quote the line that decided it as evidence.\n` +
            // Spelled out because this model drifts to a nested {agent:{id:…}}
            // shape otherwise. The parser tolerates that, but asking for the flat
            // shape keeps the common case clean.
            `Reply with exactly this flat JSON shape:\n` +
            `{"agent_speaker_id": "<id>", "customer_speaker_id": "<id>", "confidence": 0.0, "evidence": "<quoted line>"}`,
        },
      ],
    });

    const content = res.choices[0]?.message?.content ?? "";
    const { agent, customer, confidence } = extractRoleAnswer(parseJson(content));

    // Only trust ids the diarizer actually produced, and reject the model
    // labelling one speaker as both roles.
    if (!agent || !ids.includes(agent) || agent === customer) {
      logger.warn(
        `Role mapping for ${auditId} returned an unusable answer ` +
          `(finish=${res.choices[0]?.finish_reason}, content=${JSON.stringify(content).slice(0, 200)}); ` +
          `falling back to heuristics`
      );
      return heuristicRoles(turns);
    }

    const guessed = heuristicRoles(turns);
    if (confidence < 0.5 && guessed.agent !== agent) {
      logger.warn(
        `Role mapping for ${auditId} is low-confidence (${confidence.toFixed(2)}) and disagrees with the ` +
          `greeting heuristic (llm=${agent}, heuristic=${guessed.agent}); keeping the model's answer but flagging it`
      );
    }
    return {
      agent,
      customer: customer && ids.includes(customer) ? customer : (ids.find((i) => i !== agent) ?? null),
      confidence,
      method: "llm",
    };
  } catch (err) {
    logger.warn(`Role mapping for ${auditId} failed; falling back to heuristics`, err);
    return heuristicRoles(turns);
  }
}

/** Render turns as the speaker-labelled transcript the auditor reads. */
function renderTranscript(turns: TranscriptTurn[]): string {
  const label = (t: TranscriptTurn) =>
    t.role === "agent" ? "AGENT" : t.role === "customer" ? "CUSTOMER" : `SPEAKER ${t.speaker_id}`;
  const lines: string[] = [];
  for (const t of turns) {
    const prev = lines.length ? lines[lines.length - 1] : "";
    const tag = label(t);
    // Merge consecutive turns from the same speaker so the transcript reads as
    // speech rather than as diarization chunks.
    if (prev.startsWith(`${tag}: `)) lines[lines.length - 1] = `${prev} ${t.text}`;
    else lines.push(`${tag}: ${t.text}`);
  }
  return lines.join("\n");
}

function stubTranscription(fileName: string): TranscriptionResult {
  const turns: TranscriptTurn[] = [
    { speaker_id: "0", role: "agent", start_sec: 0, end_sec: 4, text: `Namaste, Scaler se baat kar raha hoon. [STUB ${fileName}]` },
    { speaker_id: "1", role: "customer", start_sec: 4.2, end_sec: 9, text: "Haan bhai, mera course access nahi ho raha hai." },
    { speaker_id: "0", role: "agent", start_sec: 9.5, end_sec: 14, text: "Main check karta hoon, ek minute dijiye." },
  ];
  return {
    text: renderTranscript(turns),
    turns,
    roles: { agent: "0", customer: "1", confidence: 1, method: "llm" },
    talkTimeSec: { agent: 8.5, customer: 4.8 },
    languageCode: "hi-IN",
    jobId: null,
  };
}

/**
 * Transcribe a recording via the Batch job API, with diarization.
 *
 * `opts.jobId` resumes an already-submitted job — essential for idempotency,
 * because an SQS redelivery would otherwise submit (and pay for) the same audio
 * again. `opts.onJobId` fires as soon as a job exists so the caller can persist
 * it before the long wait begins.
 */
export async function transcribeCall(
  buffer: Buffer,
  fileName: string,
  _model?: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  if (!KEY) {
    logger.warn("SARVAM_API_KEY not set — returning stub transcription");
    return stubTranscription(fileName);
  }

  // Normalise to 16 kHz mono before anything else. Sarvam silently mis-decodes
  // unexpected sample rates — a 48 kHz file returned timestamps ~2.85x too long
  // and phonetic nonsense, with no error at all. See normalizeForAsr.
  const normalised = await normalizeForAsr(buffer, fileName);
  buffer = normalised.buffer;
  fileName = normalised.fileName;

  // Batch accepts up to 2 hours per file. Longer recordings are split on silence
  // and submitted as multiple files in the same job, then stitched back together.
  const durationSec = await probeBufferDurationSec(buffer, fileName).catch(() => 0);
  let parts: { fileName: string; buffer: Buffer }[] = [{ fileName, buffer }];
  const offsets: number[] = [0];
  if (durationSec > env.SARVAM_MAX_FILE_SECONDS) {
    logger.info(
      `"${fileName}" is ${Math.round(durationSec)}s, over Sarvam's ${env.SARVAM_MAX_FILE_SECONDS}s per-file limit — splitting`
    );
    const chunks = await splitAudioOnSilence(buffer, fileName, {
      targetSec: env.SARVAM_MAX_FILE_SECONDS,
      maxSec: env.SARVAM_MAX_FILE_SECONDS,
      silenceDb: env.TRANSCRIPTION_SILENCE_DB,
      minSilenceSec: env.TRANSCRIPTION_SILENCE_MIN_SECONDS,
    });
    if (chunks.length > 1) {
      parts = chunks.map((c) => ({ fileName: c.fileName, buffer: c.buffer }));
      offsets.length = 0;
      let acc = 0;
      for (const p of parts) {
        offsets.push(acc);
        acc += await probeBufferDurationSec(p.buffer, p.fileName).catch(() => 0);
      }
    }
  }

  let jobId = opts.jobId ?? null;
  if (jobId) {
    logger.info(`Resuming Sarvam job ${jobId} for "${fileName}" (no re-upload, no double billing)`);
  } else {
    jobId = await initJob();
    await opts.onJobId?.(jobId);
    await uploadParts(jobId, parts);
    await api(`/speech-to-text/job/v1/${jobId}/start`, { method: "POST" });
    logger.info(
      `Sarvam job ${jobId} started for "${fileName}" ` +
        `(${parts.length} file(s), mode=${env.SARVAM_STT_MODE}, diarization=${env.SARVAM_DIARIZATION})`
    );
  }

  const status = await pollUntilDone(jobId, opts.onProgress);
  if (status.job_state === "Failed") {
    throw new SarvamError(
      `Sarvam job ${jobId} failed: ${status.error_message ?? "no reason given"}`,
      500,
      false
    );
  }

  const docs = await downloadResults(jobId, status);
  const turns = toTurns(docs, offsets);
  const languageCode = docs.find((d) => d.language_code)?.language_code ?? null;

  // No diarized entries: fall back to the flat transcript so the call is still
  // audited, just without speaker attribution.
  if (turns.length === 0) {
    const flat = docs.map((d) => (d.transcript ?? "").trim()).filter(Boolean).join(" ");
    // Nothing at all is a different matter, and it is not hypothetical: feeding
    // Sarvam un-normalised 48 kHz audio returned a completed job, a well-formed
    // document, zero turns and an empty transcript — no error anywhere. Passing
    // that on would have the auditor score a blank call and invent numbers for a
    // real agent, so refuse it here.
    if (!flat) {
      throw new TranscriptValidationError(
        `Sarvam job ${jobId} for "${fileName}" completed but returned an empty transcript ` +
          `(${docs.length} output doc(s), ${durationSec.toFixed(0)}s of audio) — nothing to audit`
      );
    }
    logger.warn(`Sarvam job ${jobId} returned no diarized turns; auditing "${fileName}" without attribution`);
    return {
      text: collapseRepetitions(flat, { nearDupSimilarity: env.TRANSCRIPTION_NEARDUP_SIMILARITY }),
      turns: [],
      roles: { agent: null, customer: null, confidence: 0, method: "unknown" },
      talkTimeSec: { agent: 0, customer: 0 },
      languageCode,
      jobId,
    };
  }

  // Validate the timeline before spending a chat call on role mapping — and
  // before anything downstream treats this transcript as real.
  const timeline = checkTimeline(turns, durationSec);
  if (timeline.warning) logger.warn(`Sarvam job ${jobId}: ${timeline.warning}`);
  if (timeline.fault) {
    throw new TranscriptValidationError(`Sarvam job ${jobId} for "${fileName}": ${timeline.fault}`);
  }

  const roles = await resolveRoles(turns, fileName);
  for (const t of turns) {
    t.role = t.speaker_id === roles.agent ? "agent" : t.speaker_id === roles.customer ? "customer" : null;
  }

  const bySpeaker = talkTimeBySpeaker(turns);
  const talkTimeSec = {
    agent: Math.round(bySpeaker.get(roles.agent ?? "") ?? 0),
    customer: Math.round(bySpeaker.get(roles.customer ?? "") ?? 0),
  };

  return { text: renderTranscript(turns), turns, roles, talkTimeSec, languageCode, jobId };
}

// ---------------------------------------------------------------------------
// Auditing
// ---------------------------------------------------------------------------

/**
 * `max_tokens` has to be generous and reasoning has to be off: sarvam-105b
 * reasons by default and those tokens are billed and counted as completion
 * tokens, so a small budget silently truncates the JSON. Structured extraction
 * gains little from chain-of-thought anyway.
 */
const AUDIT_MAX_TOKENS = 2000;

export async function auditTranscript(
  transcript: string,
  rubric: Scorable,
  meta: { audit_id: string; agent_id: string; team: string },
  model: string = env.SARVAM_AUDIT_MODEL
): Promise<AuditResult> {
  const scaleMax = rubric.scale_max && rubric.scale_max > 0 ? rubric.scale_max : 100;
  const weights = normalizeWeights(rubric.criteria);

  const criticalByName = new Map<string, number>(
    rubric.criteria.map((c) => [c.name, c.critical_threshold ?? rubric.critical_criterion_threshold])
  );

  const weightedOverall = (scores: CriterionScore[]): number => {
    const byName = new Map(scores.map((s) => [s.name, s.score]));
    const overall = rubric.criteria.reduce((sum, c, i) => sum + (byName.get(c.name) ?? 0) * weights[i], 0);
    return Math.round(overall);
  };

  const flagFromScores = (overall: number, scores: CriterionScore[]) =>
    overall < rubric.flag_threshold ||
    scores.some((c) => c.score < (criticalByName.get(c.name) ?? rubric.critical_criterion_threshold));

  if (!chat) {
    logger.warn("SARVAM_API_KEY not set — returning stub audit");
    const scores: CriterionScore[] = rubric.criteria.map((c, i) => ({
      name: c.name,
      score: Math.max(
        Math.round(scaleMax * 0.4),
        Math.min(
          Math.round(scaleMax * 0.95),
          Math.round(scaleMax * 0.6) + ((i * 13) % Math.max(1, Math.round(scaleMax * 0.35)))
        )
      ),
      explanation: `Stub analysis for ${c.name}.`,
    }));
    const overall = weightedOverall(scores);
    return {
      score: overall,
      flagged: flagFromScores(overall, scores),
      flag_reason: "Stub audit (Sarvam not configured).",
      criteria_scores: scores,
    };
  }

  const criteriaList = rubric.criteria
    .map((c, i) => {
      const pct = Math.round(weights[i] * 100);
      const guidance = c.guidance ? `\n    Guidance: ${c.guidance}` : "";
      return `- ${c.name} (weight ${pct}%): ${c.description}${guidance}`;
    })
    .join("\n");

  const instructions =
    `You are auditing a customer call for the "${meta.team}" team.\n` +
    `The transcript is speaker-labelled. Score the AGENT only — never penalise the agent ` +
    `for what the CUSTOMER said. Lines labelled "SPEAKER n" could not be attributed; treat them with caution.\n` +
    `The call may mix Hindi and English, written in Roman script. Judge what was meant, not the spelling.\n` +
    `Score each criterion from 0 to ${scaleMax} and give a short explanation citing the transcript.\n` +
    `Then provide a flag_reason summarizing any concerns.\n\n` +
    `Criteria (weights are relative and already normalized to percentages):\n${criteriaList}\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Respond with JSON only: { "flag_reason": string, ` +
    `"audit_criteria_scores": [{ "name": string, "score": number, "explanation": string }] }`;

  logger.info(`Auditing ${meta.audit_id} with rubric ${rubric.name} (sarvam model ${model})`);
  const res = await chat.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    // temperature 0, not 0.3. At 0.3 the same transcript against the same rubric
    // scored 69 / 55 / 39 overall across three runs — a 30-point spread, with one
    // criterion swinging 85/85/20. An agent's score should not depend on sampling
    // luck, and whether a call trips the flag threshold least of all. Scoring
    // against a fixed rubric is extraction, not composition; there is nothing here
    // that benefits from creative variation.
    temperature: 0,
    max_tokens: AUDIT_MAX_TOKENS,
    ...({ reasoning_effort: null } as Record<string, unknown>),
    messages: [
      { role: "system", content: rubric.system_prompt },
      { role: "user", content: instructions },
    ],
  });

  const parsed = parseJson(res.choices[0]?.message?.content ?? "");
  if (!parsed || !Array.isArray(parsed.audit_criteria_scores)) {
    throw new Error("Invalid Sarvam audit response format");
  }

  const criteria_scores: CriterionScore[] = parsed.audit_criteria_scores.map((item: any) => ({
    name: String(item.name ?? "").slice(0, 120),
    score: clamp(Number(item.score ?? 0), scaleMax),
    explanation: String(item.explanation ?? "").slice(0, 600),
  }));

  // Computed here, not asked of the model, so the overall is always consistent
  // with the configured weights.
  const score = weightedOverall(criteria_scores);
  return {
    score,
    flagged: flagFromScores(score, criteria_scores),
    flag_reason: String(parsed.flag_reason ?? "No reason provided."),
    criteria_scores,
  };
}

export async function suggestRubricImprovements(
  rubric: Scorable & { description?: string },
  feedback: Feedback[],
  model: string = env.SARVAM_AUDIT_MODEL
): Promise<SuggestionOutput> {
  const items = feedback.map((f, i) => {
    const corrections = (f.criteria_corrections ?? [])
      .map((c) => `${c.name}: AI ${c.ai_score} -> human ${c.human_score}${c.note ? ` (${c.note})` : ""}`)
      .join("; ");
    return (
      `#${i + 1} [${f.disposition}] AI score ${f.ai_score}` +
      `${f.ai_flagged ? " (flagged)" : ""}` +
      `${f.human_score !== undefined ? ` | human score ${f.human_score}` : ""}` +
      `${f.human_flagged !== undefined ? ` | human flagged: ${f.human_flagged}` : ""}` +
      `${corrections ? `\n   criteria: ${corrections}` : ""}` +
      `${f.comment ? `\n   comment: ${f.comment}` : ""}`
    );
  });

  if (!chat) {
    logger.warn("SARVAM_API_KEY not set — returning stub rubric suggestion");
    const disagreements = feedback.filter((f) => f.disposition !== "agree").length;
    return {
      summary:
        `Stub suggestion (Sarvam not configured). Reviewed ${feedback.length} feedback item(s), ` +
        `${disagreements} with disagreement.`,
      suggested_system_prompt: rubric.system_prompt,
      criteria_changes: [],
    };
  }

  const criteriaList = rubric.criteria
    .map((c) => `- ${c.name}: ${c.description}${c.guidance ? ` (guidance: ${c.guidance})` : ""}`)
    .join("\n");

  const instructions =
    `You are improving the scoring rubric "${rubric.name}" used by an AI to audit customer calls.\n` +
    `Reviewers have corrected the AI's scores. Find the PATTERNS where the AI diverges from reviewers ` +
    `and propose concrete rubric changes to close the gap.\n\n` +
    `Current criteria:\n${criteriaList}\n\n` +
    `Current system prompt:\n"""${rubric.system_prompt}"""\n\n` +
    `Reviewer feedback (${feedback.length} items):\n${items.join("\n")}\n\n` +
    `Respond with JSON only: {\n` +
    `  "summary": string (2-4 sentences on the divergence patterns),\n` +
    `  "suggested_system_prompt": string (a full revised system prompt; keep it if no change is warranted),\n` +
    `  "criteria_changes": [{ "criterion": string (existing name, or "NEW: <name>" to add), "change": string, "rationale": string }]\n` +
    `}`;

  logger.info(
    `Generating rubric suggestion for "${rubric.name}" from ${feedback.length} feedback items (sarvam model ${model})`
  );
  const res = await chat.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.4,
    max_tokens: AUDIT_MAX_TOKENS,
    ...({ reasoning_effort: null } as Record<string, unknown>),
    messages: [
      { role: "system", content: "You are a meticulous QA rubric designer. Output strict JSON." },
      { role: "user", content: instructions },
    ],
  });

  const parsed = parseJson(res.choices[0]?.message?.content ?? "");
  if (!parsed) throw new Error("Invalid Sarvam suggestion response format");
  const changes = Array.isArray(parsed.criteria_changes)
    ? parsed.criteria_changes.map((c: any) => ({
        criterion: String(c.criterion ?? "").slice(0, 120),
        change: String(c.change ?? "").slice(0, 600),
        rationale: String(c.rationale ?? "").slice(0, 600),
      }))
    : [];
  return {
    summary: String(parsed.summary ?? "No summary provided.").slice(0, 1200),
    suggested_system_prompt: String(parsed.suggested_system_prompt ?? rubric.system_prompt).slice(0, 4000),
    criteria_changes: changes,
  };
}

function clamp(n: number, max = 100): number {
  return Math.min(max, Math.max(0, Number.isFinite(n) ? n : 0));
}

function parseJson(text: string): any {
  const cleaned = text.trim().replace(/^```json\n?|```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/m);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}

// Exported for tests.
export const __internal = { toTurns, renderTranscript, heuristicRoles, talkTimeBySpeaker, classify };
