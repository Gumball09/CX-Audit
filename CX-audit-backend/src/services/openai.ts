import { OpenAI, toFile } from "openai";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { normalizeWeights } from "../validation.js";
import { splitAudioOnSilence } from "../lib/audio.js";
import type { CriterionScore, Feedback, SuggestedCriterionChange, TeamRubric } from "../types.js";

// auditTranscript works on any rubric-shaped object — the team's primary rubric
// (TeamRubric) or an additional Rubric. Both supply these scoring fields.
export type Scorable = Pick<
  TeamRubric,
  "name" | "criteria" | "system_prompt" | "scale_max" | "flag_threshold" | "critical_criterion_threshold"
>;

export const openai = env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 3, timeout: 120_000 })
  : null;

/** True when running without an OpenAI key (deterministic stub mode). */
export const isStubMode = !openai;

/**
 * Transcribe an audio buffer with Whisper. Returns stub text when no API key
 * is configured so the pipeline can be exercised end-to-end locally.
 */
export async function transcribeAudio(
  buffer: Buffer,
  fileName: string,
  model: string = env.OPENAI_TRANSCRIPTION_MODEL
): Promise<string> {
  if (!openai) {
    logger.warn("OPENAI_API_KEY not set — returning stub transcription");
    return `[STUB TRANSCRIPT for ${fileName}] Agent: Hello, thank you for calling. Customer: Hi, I have a question about my course. Agent: Sure, I can help with that.`;
  }

  try {
    return await transcribeOnce(buffer, fileName, model);
  } catch (err) {
    if (!isInputTooLargeError(err)) throw err;
    logger.warn(
      `"${fileName}" exceeds the ${model} input limit — falling back to silence-based chunked transcription`
    );
    return await transcribeChunked(buffer, fileName, model);
  }
}

/** Single one-shot transcription request. */
async function transcribeOnce(buffer: Buffer, fileName: string, model: string): Promise<string> {
  const file = await toFile(buffer, fileName);
  const res = await openai!.audio.transcriptions.create({ file, model });
  logger.debug(`Transcription complete (${(res.text ?? "").length} chars)`);
  return res.text ?? "";
}

/**
 * True when a transcription call failed because the audio is too long/large for
 * the model's input limit (vs. an auth/quota/transient error we must rethrow).
 */
function isInputTooLargeError(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.message ?? err?.error?.message ?? "").toLowerCase();
  if (status !== 400) return false;
  return (
    msg.includes("too large") ||
    msg.includes("too long") ||
    msg.includes("maximum") ||
    msg.includes("number of tokens") ||
    msg.includes("duration")
  );
}

/**
 * Split a too-long recording on silence and transcribe each chunk with the same
 * (higher-quality) model, then stitch the parts back together in order.
 */
async function transcribeChunked(buffer: Buffer, fileName: string, model: string): Promise<string> {
  const chunks = await splitAudioOnSilence(buffer, fileName, {
    targetSec: env.TRANSCRIPTION_CHUNK_SECONDS,
    maxSec: env.TRANSCRIPTION_CHUNK_MAX_SECONDS,
    silenceDb: env.TRANSCRIPTION_SILENCE_DB,
    minSilenceSec: env.TRANSCRIPTION_SILENCE_MIN_SECONDS,
  });
  if (chunks.length <= 1) {
    throw new Error(
      `Chunking produced ${chunks.length} chunk(s) for "${fileName}" — cannot reduce it below the ${model} limit.`
    );
  }
  logger.info(`Transcribing "${fileName}" as ${chunks.length} chunks (model ${model})`);

  const parts: string[] = [];
  for (const chunk of chunks) {
    const text = await transcribeOnce(chunk.buffer, chunk.fileName, model);
    parts.push(text.trim());
  }
  const stitched = parts.filter(Boolean).join(" ");
  logger.debug(`Chunked transcription complete (${stitched.length} chars from ${chunks.length} chunks)`);
  return stitched;
}

export interface AuditResult {
  score: number;
  flagged: boolean;
  flag_reason: string;
  criteria_scores: CriterionScore[];
}

/**
 * Score a transcript against a team's rubric. Flagging uses the rubric's
 * thresholds: overall below `flag_threshold`, or any criterion below
 * `critical_criterion_threshold`.
 */
export async function auditTranscript(
  transcript: string,
  rubric: Scorable,
  meta: { audit_id: string; agent_id: string; team: string },
  model: string = env.OPENAI_AUDIT_MODEL
): Promise<AuditResult> {
  const scaleMax = rubric.scale_max && rubric.scale_max > 0 ? rubric.scale_max : 100;
  const weights = normalizeWeights(rubric.criteria);

  // Per-criterion critical threshold (override) keyed by name, with fallback.
  const criticalByName = new Map<string, number>(
    rubric.criteria.map((c) => [c.name, c.critical_threshold ?? rubric.critical_criterion_threshold])
  );

  /** Compute overall as the rubric-weighted average of the criterion scores. */
  const weightedOverall = (scores: CriterionScore[]): number => {
    const byName = new Map(scores.map((s) => [s.name, s.score]));
    const overall = rubric.criteria.reduce(
      (sum, c, i) => sum + (byName.get(c.name) ?? 0) * weights[i],
      0
    );
    return Math.round(overall);
  };

  const flagFromScores = (overall: number, scores: CriterionScore[]) =>
    overall < rubric.flag_threshold ||
    scores.some((c) => c.score < (criticalByName.get(c.name) ?? rubric.critical_criterion_threshold));

  if (!openai) {
    logger.warn("OPENAI_API_KEY not set — returning stub audit");
    const scores: CriterionScore[] = rubric.criteria.map((c, i) => ({
      name: c.name,
      score: Math.max(Math.round(scaleMax * 0.4), Math.min(Math.round(scaleMax * 0.95), Math.round(scaleMax * 0.6) + ((i * 13) % Math.max(1, Math.round(scaleMax * 0.35))))),
      explanation: `Stub analysis for ${c.name}.`,
    }));
    const overall = weightedOverall(scores);
    return {
      score: overall,
      flagged: flagFromScores(overall, scores),
      flag_reason: "Stub audit (OpenAI not configured).",
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
    `Score each criterion from 0 to ${scaleMax} and give a short explanation citing the transcript.\n` +
    `Then provide a flag_reason summarizing any concerns.\n\n` +
    `Criteria (weights are relative and already normalized to percentages):\n${criteriaList}\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Respond with JSON only: { "flag_reason": string, ` +
    `"audit_criteria_scores": [{ "name": string, "score": number, "explanation": string }] }`;

  logger.info(`Auditing ${meta.audit_id} with rubric ${rubric.name} (model ${model})`);
  const res = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 900,
    messages: [
      { role: "system", content: rubric.system_prompt },
      { role: "user", content: instructions },
    ],
  });

  const parsed = parseJson(res.choices[0]?.message?.content ?? "");
  if (!parsed || !Array.isArray(parsed.audit_criteria_scores)) {
    throw new Error("Invalid OpenAI audit response format");
  }

  const criteria_scores: CriterionScore[] = parsed.audit_criteria_scores.map((item: any) => ({
    name: String(item.name ?? "").slice(0, 120),
    score: clamp(Number(item.score ?? 0), scaleMax),
    explanation: String(item.explanation ?? "").slice(0, 600),
  }));

  // Compute the overall ourselves from the rubric weights so the cumulative
  // score is deterministic and consistent with the configured rubric.
  const score = weightedOverall(criteria_scores);
  return {
    score,
    flagged: flagFromScores(score, criteria_scores),
    flag_reason: String(parsed.flag_reason ?? "No reason provided."),
    criteria_scores,
  };
}

export interface SuggestionOutput {
  summary: string;
  suggested_system_prompt: string;
  criteria_changes: SuggestedCriterionChange[];
}

/**
 * Analyze a batch of reviewer feedback against the AI's scores for one rubric
 * and propose concrete improvements: a refined system prompt plus per-criterion
 * changes. The model is told to focus on the *patterns* of disagreement (where
 * the AI consistently scored differently than reviewers, or missed concerns
 * called out in comments), not one-off corrections.
 */
export async function suggestRubricImprovements(
  rubric: Scorable & { description?: string },
  feedback: Feedback[],
  model: string = env.OPENAI_AUDIT_MODEL
): Promise<SuggestionOutput> {
  // Compact, LLM-friendly view of the divergence signal.
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

  if (!openai) {
    logger.warn("OPENAI_API_KEY not set — returning stub rubric suggestion");
    const disagreements = feedback.filter((f) => f.disposition !== "agree").length;
    return {
      summary:
        `Stub suggestion (OpenAI not configured). Reviewed ${feedback.length} feedback item(s), ` +
        `${disagreements} with disagreement. Connect OpenAI to get real prompt suggestions.`,
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

  logger.info(`Generating rubric suggestion for "${rubric.name}" from ${feedback.length} feedback items (model ${model})`);
  const res = await openai.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.4,
    max_tokens: 1200,
    messages: [
      { role: "system", content: "You are a meticulous QA rubric designer. Output strict JSON." },
      { role: "user", content: instructions },
    ],
  });

  const parsed = parseJson(res.choices[0]?.message?.content ?? "");
  if (!parsed) throw new Error("Invalid OpenAI suggestion response format");
  const changes: SuggestedCriterionChange[] = Array.isArray(parsed.criteria_changes)
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
