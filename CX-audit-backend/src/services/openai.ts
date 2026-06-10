import { OpenAI, toFile } from "openai";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { CriterionScore, TeamRubric } from "../types.js";

export const openai = env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 3, timeout: 120_000 })
  : null;

/** True when running without an OpenAI key (deterministic stub mode). */
export const isStubMode = !openai;

/**
 * Transcribe an audio buffer with Whisper. Returns stub text when no API key
 * is configured so the pipeline can be exercised end-to-end locally.
 */
export async function transcribeAudio(buffer: Buffer, fileName: string): Promise<string> {
  if (!openai) {
    logger.warn("OPENAI_API_KEY not set — returning stub transcription");
    return `[STUB TRANSCRIPT for ${fileName}] Agent: Hello, thank you for calling. Customer: Hi, I have a question about my course. Agent: Sure, I can help with that.`;
  }

  const file = await toFile(buffer, fileName);
  const res = await openai.audio.transcriptions.create({
    file,
    model: env.OPENAI_TRANSCRIPTION_MODEL,
  });
  logger.debug(`Transcription complete (${res.text.length} chars)`);
  return res.text ?? "";
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
  rubric: TeamRubric,
  meta: { audit_id: string; agent_id: string; team: string }
): Promise<AuditResult> {
  const flagFromScores = (overall: number, scores: CriterionScore[]) =>
    overall < rubric.flag_threshold ||
    scores.some((c) => c.score < rubric.critical_criterion_threshold);

  if (!openai) {
    logger.warn("OPENAI_API_KEY not set — returning stub audit");
    const scores: CriterionScore[] = rubric.criteria.map((c, i) => ({
      name: c.name,
      score: Math.max(40, Math.min(95, 60 + ((i * 13) % 35))),
      explanation: `Stub analysis for ${c.name}.`,
    }));
    const overall = Math.round(
      scores.reduce((s, c, i) => s + c.score * rubric.criteria[i].weight, 0) / 100
    );
    return {
      score: overall,
      flagged: flagFromScores(overall, scores),
      flag_reason: "Stub audit (OpenAI not configured).",
      criteria_scores: scores,
    };
  }

  const criteriaList = rubric.criteria
    .map((c) => `- ${c.name} (${c.weight}%): ${c.description}`)
    .join("\n");

  const instructions =
    `You are auditing a customer call for the "${meta.team}" team.\n` +
    `Score each criterion 0-100 and provide a short explanation citing the transcript.\n` +
    `Then compute an overall weighted score and a flag_reason.\n\n` +
    `Criteria:\n${criteriaList}\n\n` +
    `Transcript:\n${transcript}\n\n` +
    `Respond with JSON only: { "score": number, "flag_reason": string, ` +
    `"audit_criteria_scores": [{ "name": string, "score": number, "explanation": string }] }`;

  logger.info(`Auditing ${meta.audit_id} with rubric ${rubric.name}`);
  const res = await openai.chat.completions.create({
    model: env.OPENAI_AUDIT_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 900,
    messages: [
      { role: "system", content: rubric.system_prompt },
      { role: "user", content: instructions },
    ],
  });

  const parsed = parseJson(res.choices[0]?.message?.content ?? "");
  if (!parsed || typeof parsed.score !== "number") {
    throw new Error("Invalid OpenAI audit response format");
  }

  const criteria_scores: CriterionScore[] = Array.isArray(parsed.audit_criteria_scores)
    ? parsed.audit_criteria_scores.map((item: any) => ({
        name: String(item.name ?? "").slice(0, 120),
        score: clamp(Number(item.score ?? 0)),
        explanation: String(item.explanation ?? "").slice(0, 600),
      }))
    : [];

  const score = clamp(Number(parsed.score));
  return {
    score,
    flagged: flagFromScores(score, criteria_scores),
    flag_reason: String(parsed.flag_reason ?? "No reason provided."),
    criteria_scores,
  };
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));
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
