/**
 * Brand-term normalisation for ASR output.
 *
 * On 8 kHz telephony audio the company name never survives transcription: across
 * four sample calls "Scaler" came back as *Eskillo*, *Skillo*, *SKL* and *SKL*,
 * and the support address as *update@skla.com* and *update@kerala.com*. That is not
 * cosmetic — the CS rubric asks whether the agent gave the standard brand greeting,
 * so the auditor was deducting marks for a name the agent said correctly.
 *
 * Sarvam advertises hotword biasing but does not expose it on the batch STT job
 * API (probed 2026-07-26: `prompt`, `hotwords`, `vocabulary` and friends are all
 * silently dropped from `job_parameters`, while real fields like `num_speakers` are
 * echoed back). Batch is the only transport offering diarization, so there is no
 * way to fix this at the source and post-processing is the only option.
 *
 * ## Scope, and what this deliberately does not do
 *
 * This fixes ONE class of error: known proper nouns with known mis-hearings. It
 * does nothing for the two more dangerous classes also observed in the same calls:
 *
 *   - **Dropped negations.** "I can't" transcribed as "I can" reverses meaning and
 *     reads perfectly fluently. Nothing here detects that.
 *   - **Fluent hallucinations.** "Ready? blouse piece and walk" appeared mid-turn
 *     in a call where nothing like it was said, and "Yeah, we love you" was
 *     attributed to an agent. A glossary cannot know what was never spoken.
 *
 * Every rule below is deliberately narrow, because a false positive corrupts a
 * correct transcript — worse than the problem being solved. Two examples of terms
 * consciously excluded:
 *
 *   - `scalar` — a legitimate technical word, and these are data-science course
 *     calls. Mapping it to "Scaler" would rewrite real content.
 *   - `Kerala` — a real Indian state. Only matched inside an email domain, never as
 *     a standalone word.
 */

/** One normalisation rule. `pattern` must be anchored on word boundaries. */
interface TermRule {
  /** What this rule is for, used in the log line when it fires. */
  label: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Company-name mis-hearings observed in production transcripts.
 *
 * Add a variant only when you have seen it in a real transcript AND it is not a
 * word that could legitimately appear in a customer conversation.
 */
const RULES: TermRule[] = [
  {
    label: "company name",
    // Observed: Eskillo, Skillo, SKL. "Escalar" is included as a near-miss of the
    // Hindi-accented pronunciation. "Scalar" is NOT — see the note above.
    pattern: /\b(?:e?skillo|skillow|eskiller|escalar|skl)\b/gi,
    replacement: "Scaler",
  },
  {
    label: "support email domain",
    // Only rewrites the domain of something already shaped like an address, so
    // "Kerala" on its own is untouched.
    pattern: /\b([A-Za-z0-9._%+-]+)@(?:skla|kerala|skiller|skillo|scalar)\.com\b/gi,
    replacement: "$1@scaler.com",
  },
];

export interface Normalised {
  text: string;
  /** Rule label -> number of replacements, for logging. Empty when nothing changed. */
  substitutions: Record<string, number>;
}

/**
 * Apply brand-term rules to a transcript.
 *
 * Returns the count of replacements per rule so the pipeline can log what it
 * changed. Silent rewriting of an audit artifact would be indefensible if a score
 * is ever disputed; a counted, labelled log line is the minimum bar.
 */
export function normalizeTerms(text: string): Normalised {
  if (!text) return { text, substitutions: {} };
  let out = text;
  const substitutions: Record<string, number> = {};
  for (const rule of RULES) {
    let hits = 0;
    out = out.replace(rule.pattern, (...args) => {
      hits++;
      // Build the replacement using captured groups ($1 etc.) without re-running
      // the regex, so counting and replacing stay in step.
      return rule.replacement.replace(/\$(\d)/g, (_, d) => String(args[Number(d)] ?? ""));
    });
    if (hits > 0) substitutions[rule.label] = hits;
  }
  return { text: out, substitutions };
}

/** Total replacements across all rules — convenience for logging. */
export function substitutionCount(s: Record<string, number>): number {
  return Object.values(s).reduce((a, b) => a + b, 0);
}
