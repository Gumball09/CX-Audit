import type { CriterionScore, SuggestedCriterionChange, TeamRubric } from "../../types.js";

/**
 * The contract every AI provider implements. Two providers exist: Sarvam (the
 * default) and OpenAI (a break-glass fallback). Neither imports the other; the
 * dispatcher in ./index.ts picks one from the AI_PROVIDER constant.
 */

/**
 * auditTranscript works on any rubric-shaped object — the team's primary rubric
 * (TeamRubric) or an additional Rubric. Both supply these scoring fields.
 */
export type Scorable = Pick<
  TeamRubric,
  "name" | "criteria" | "system_prompt" | "scale_max" | "flag_threshold" | "critical_criterion_threshold"
>;

/** Which speaker in a diarized transcript is the agent, and how sure we are. */
export interface SpeakerRoles {
  /** Diarization speaker id for the agent, e.g. "0". */
  agent: string | null;
  customer: string | null;
  /** 0..1. Persisted so reviewers can see when attribution was a guess. */
  confidence: number;
  /** How the mapping was decided, for auditing our own accuracy later. */
  method: "channel" | "llm" | "heuristic" | "unknown";
}

/** One diarized turn. Timestamps are chunk-level; Sarvam has no word-level. */
export interface TranscriptTurn {
  speaker_id: string;
  /** Resolved role, or null when attribution failed. */
  role: "agent" | "customer" | null;
  start_sec: number;
  end_sec: number;
  text: string;
}

export interface TranscriptionResult {
  /**
   * The audit input and the artifact stored at transcriptions/<id>.txt. When
   * diarization succeeded this is speaker-labelled lines ("AGENT: …"); otherwise
   * it's the flat transcript, so the audit still works without attribution.
   */
  text: string;
  /** Structured turns, when the provider diarizes. Empty when it doesn't. */
  turns: TranscriptTurn[];
  roles: SpeakerRoles;
  /** Total seconds each speaker held the floor, keyed by resolved role. */
  talkTimeSec: { agent: number; customer: number };
  /** Provider-detected language, e.g. "hi-IN". */
  languageCode: string | null;
  /** Provider job id, where the provider runs transcription as a job. */
  jobId: string | null;
}

export interface AuditResult {
  score: number;
  flagged: boolean;
  flag_reason: string;
  criteria_scores: CriterionScore[];
}

export interface SuggestionOutput {
  summary: string;
  suggested_system_prompt: string;
  criteria_changes: SuggestedCriterionChange[];
}

/**
 * The provider returned a transcript we refuse to audit.
 *
 * Covers both ways a silent mis-decode has actually shown up in testing, which
 * are not the same and neither of which the provider reports as an error:
 *
 *   - A timeline that contradicts the audio: turns ending long after the
 *     recording does, with a transcript of confident phonetic nonsense.
 *   - Nothing at all: HTTP 200, a well-formed document, zero turns and an empty
 *     transcript.
 *
 * The second is the more dangerous of the two, because an empty transcript looks
 * like valid input to the auditor — it will happily score a blank call and write
 * invented numbers onto a real agent's record.
 *
 * Deliberately its own type so the pipeline can treat it as terminal: the fault is
 * deterministic for a given recording, so retrying re-submits and re-bills the
 * same audio to get the same unusable answer.
 */
export class TranscriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptValidationError";
  }
}

/** Options a caller can pass through to transcription. */
export interface TranscribeOptions {
  /** Resume an already-submitted job instead of paying to submit a new one. */
  jobId?: string | null;
  /** Called as soon as a job id exists, so the caller can persist it. */
  onJobId?: (jobId: string) => Promise<void> | void;
  /** Called periodically while waiting, to heartbeat an SQS visibility timeout. */
  onProgress?: () => Promise<void> | void;
}
