/**
 * Transcript repair for telephony audio.
 *
 * Low-bitrate 8 kHz call recordings push the gpt-4o-transcribe models into
 * decoding-loop hallucinations ("Hello. Hello. Hello..." x300). whisper-1 has
 * internal compression-ratio / temperature-fallback guards against this; the
 * gpt-4o-transcribe models do not expose them, so we replicate the idea here:
 *
 *   1. `repetitionScore` — quantify how looped a transcript is.
 *   2. (caller) retry a too-looped transcription and keep the least-looped run.
 *   3. `collapseRepetitions` — drop residual dense repeats as a final safety net.
 *
 * Verified on the real 2009s/8kbps file: a looped chunk (score 0.64–0.88) is
 * recovered to ~0.11 by retry+collapse.
 */

/** Split into sentence-ish units for repetition analysis. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalized comparison key (case/space/trailing-punct insensitive). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[.?!,…]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Word-token set for fuzzy similarity. */
function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
  );
}

/** Jaccard similarity of two token sets, in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/**
 * Fraction of sentences that are redundant: `1 - unique/total`, in [0, 1].
 * Clean speech scores ~0–0.15; loop hallucinations score ~0.6–0.9. Returns 0
 * for very short text (too little signal to judge).
 */
export function repetitionScore(text: string): number {
  const s = sentences(text).map(norm);
  if (s.length < 4) return 0;
  const unique = new Set(s).size;
  return 1 - unique / s.length;
}

export interface CollapseOptions {
  /** Window (in kept sentences) for exact-match dedup of short backchannels. */
  window?: number;
  /**
   * Jaccard similarity at/above which a long sentence is treated as a
   * near-duplicate of an earlier one and dropped. 1 disables fuzzy collapse
   * (exact-match only). ~0.8 removes paraphrased "restart" loops.
   */
  nearDupSimilarity?: number;
  /** Sentences with at least this many word-tokens are eligible for fuzzy collapse. */
  minTokensForFuzzy?: number;
}

/**
 * Remove repetition loops. Two complementary passes:
 *
 *  - Short sentences (backchannels like "Okay." / "Hello.") are deduped only
 *    against the last `window` kept sentences — this kills dense consecutive
 *    (AAAA) and alternating (ABABAB) loops while letting a phrase recur
 *    naturally when it's spread far apart in real conversation.
 *  - Long sentences are deduped against ALL prior kept long sentences using
 *    fuzzy (Jaccard) similarity — this catches the model's "restart"
 *    hallucination where it re-tells the opening several times with slightly
 *    different wording (1.3 vs 1.34 vs 3.89...), which exact-match misses.
 */
export function collapseRepetitions(text: string, opts: CollapseOptions = {}): string {
  const window = opts.window ?? 8;
  const sim = opts.nearDupSimilarity ?? 0.8;
  const minTokens = opts.minTokensForFuzzy ?? 6;

  const out: string[] = [];
  const recentNorms: string[] = [];
  const keptLongTokens: Set<string>[] = [];

  for (const sentence of sentences(text)) {
    const tokens = tokenSet(sentence);
    if (sim < 1 && tokens.size >= minTokens) {
      if (keptLongTokens.some((prev) => jaccard(tokens, prev) >= sim)) continue;
    } else {
      const key = norm(sentence);
      if (recentNorms.includes(key)) continue;
    }
    out.push(sentence);
    if (tokens.size >= minTokens) keptLongTokens.push(tokens);
    recentNorms.push(norm(sentence));
    if (recentNorms.length > window) recentNorms.shift();
  }
  return out.join(" ");
}
