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
/**
 * ORDER MATTERS. The email rule must run before the company rule, or the company
 * rule matches the domain fragment inside an address — "update@skilla.com" became
 * "update@Scaler.com", wrong case and bypassing the email rule entirely. The
 * company rule additionally refuses to match after an "@" so that a domain variant
 * not yet enumerated below is left intact rather than half-rewritten. Failing to
 * fix is fine; corrupting is not.
 */
const RULES: TermRule[] = [
  {
    label: "support email domain",
    // Enumerated rather than fuzzy on purpose: the customer's own address is
    // usually a real domain (gmail.com appears in these calls), so a permissive
    // pattern here would rewrite the customer's email. Only rewrites the domain of
    // something already shaped like an address, so "Kerala" on its own is untouched.
    pattern: /\b([A-Za-z0-9._%+-]+)@(?:skla|skilla|skilo|skillo|skiller|kerala|scalar)\.com\b/gi,
    replacement: "$1@scaler.com",
  },
  {
    label: "company name",
    // Observed across modes: Eskillo, Skillo, SKL (translit) and Eskilo (codemix).
    // The l-count varies between modes, so match one or two rather than
    // enumerating spellings. "Escalar" is a near-miss of the accented
    // pronunciation. "Scalar" is NOT — see the note above.
    pattern: /(?<!@)\b(?:e?skil{1,2}(?:o|ow|a|er)|escalar|skl)\b/gi,
    replacement: "Scaler",
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
