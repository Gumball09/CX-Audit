import { env } from "../../env.js";
import { logger } from "../../logger.js";
import * as openaiProvider from "./openai.js";
import * as sarvamProvider from "./sarvam.js";
import type {
  AuditResult,
  Scorable,
  SuggestionOutput,
  TranscribeOptions,
  TranscriptionResult,
} from "./types.js";
import type { Feedback } from "../../types.js";

/**
 * Provider dispatch.
 *
 * Sarvam is the pipeline; OpenAI is a break-glass fallback that stays working and
 * tested. Which one runs is fixed by the AI_PROVIDER constant at deploy time
 * rather than by a runtime setting — an admin toggle for this would invite
 * accidental provider switches, and the two produce differently-shaped
 * transcripts. `validateEnv` rejects any other value at startup, so there is no
 * silent fallback path to be surprised by here.
 */

export type AiProvider = "sarvam" | "openai";

export const activeProvider: AiProvider = env.AI_PROVIDER === "openai" ? "openai" : "sarvam";

const impl = activeProvider === "openai" ? openaiProvider : sarvamProvider;

/** True when the active provider has no API key and is returning stub data. */
export const isStubMode: boolean = impl.isStubMode;

logger.info(
  `AI provider: ${activeProvider}${isStubMode ? " (STUB MODE — no API key configured)" : ""}`
);

/** Default model ids for the active provider, used when settings don't override. */
export function defaultModels(): { transcription: string; audit: string } {
  return activeProvider === "openai"
    ? { transcription: env.OPENAI_TRANSCRIPTION_MODEL, audit: env.OPENAI_AUDIT_MODEL }
    : { transcription: env.SARVAM_STT_MODEL, audit: env.SARVAM_AUDIT_MODEL };
}

/**
 * Transcribe a recording. The Sarvam path runs an asynchronous batch job and uses
 * `opts` to report its job id and to heartbeat a long wait; the OpenAI path is
 * synchronous and ignores them.
 */
export function transcribeCall(
  buffer: Buffer,
  fileName: string,
  model?: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  return activeProvider === "openai"
    ? openaiProvider.transcribeCall(buffer, fileName, model)
    : sarvamProvider.transcribeCall(buffer, fileName, model, opts);
}

export function auditTranscript(
  transcript: string,
  rubric: Scorable,
  meta: { audit_id: string; agent_id: string; team: string },
  model?: string
): Promise<AuditResult> {
  return impl.auditTranscript(transcript, rubric, meta, model);
}

export function suggestRubricImprovements(
  rubric: Scorable & { description?: string },
  feedback: Feedback[],
  model?: string
): Promise<SuggestionOutput> {
  return impl.suggestRubricImprovements(rubric, feedback, model);
}

export type {
  AuditResult,
  Scorable,
  SpeakerRoles,
  SuggestionOutput,
  TranscribeOptions,
  TranscriptTurn,
  TranscriptionResult,
} from "./types.js";
