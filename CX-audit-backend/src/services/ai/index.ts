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
 * tested. Which one runs is a platform setting a super_admin can change from the
 * dashboard, so every entry point here takes the provider as an explicit
 * argument. Callers read it from settings (`getModelSettingsCached`) and pass it
 * down — this module deliberately does not reach into the database, so dispatch
 * stays pure and the provider in use at each call site is visible in the code.
 *
 * AI_PROVIDER is the default when no setting has been saved. `validateEnv`
 * rejects any other value at startup, so there is no silent fallback here.
 */

export type AiProvider = "sarvam" | "openai";

export const PROVIDERS: readonly AiProvider[] = ["sarvam", "openai"];

/** Default provider when the settings row has no explicit choice. */
export const DEFAULT_PROVIDER: AiProvider = env.AI_PROVIDER === "openai" ? "openai" : "sarvam";

export function isProvider(v: unknown): v is AiProvider {
  return v === "sarvam" || v === "openai";
}

function implFor(provider: AiProvider) {
  return provider === "openai" ? openaiProvider : sarvamProvider;
}

/** True when this provider has no API key and would return stub data. */
export function isStubMode(provider: AiProvider): boolean {
  return implFor(provider).isStubMode;
}

/**
 * Default model ids for a provider. These are the fallbacks the settings layer
 * uses, and what the models are reset to when the provider is switched — model
 * ids are provider-specific, so carrying `gpt-4o` over to Sarvam would fail every
 * audit.
 */
export function defaultModels(provider: AiProvider): { transcription: string; audit: string } {
  return provider === "openai"
    ? { transcription: env.OPENAI_TRANSCRIPTION_MODEL, audit: env.OPENAI_AUDIT_MODEL }
    : { transcription: env.SARVAM_STT_MODEL, audit: env.SARVAM_AUDIT_MODEL };
}

logger.info(
  `AI provider default: ${DEFAULT_PROVIDER} (overridable in platform settings). ` +
    `Keys configured — sarvam: ${!isStubMode("sarvam")}, openai: ${!isStubMode("openai")}`
);

/**
 * Transcribe a recording. The Sarvam path runs an asynchronous batch job and uses
 * `opts` to report its job id and to heartbeat a long wait; the OpenAI path is
 * synchronous and ignores them.
 */
export function transcribeCall(
  provider: AiProvider,
  buffer: Buffer,
  fileName: string,
  model?: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptionResult> {
  return provider === "openai"
    ? openaiProvider.transcribeCall(buffer, fileName, model)
    : sarvamProvider.transcribeCall(buffer, fileName, model, opts);
}

export function auditTranscript(
  provider: AiProvider,
  transcript: string,
  rubric: Scorable,
  meta: { audit_id: string; agent_id: string; team: string },
  model?: string
): Promise<AuditResult> {
  return implFor(provider).auditTranscript(transcript, rubric, meta, model);
}

export function suggestRubricImprovements(
  provider: AiProvider,
  rubric: Scorable & { description?: string },
  feedback: Feedback[],
  model?: string
): Promise<SuggestionOutput> {
  return implFor(provider).suggestRubricImprovements(rubric, feedback, model);
}

export { TranscriptValidationError } from "./types.js";
export type {
  AuditResult,
  Scorable,
  SpeakerRoles,
  SuggestionOutput,
  TranscribeOptions,
  TranscriptTurn,
  TranscriptionResult,
} from "./types.js";
