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

/**
 * Remove dense repetition loops. A sentence is dropped when its normalized form
 * already appears within the last `window` kept sentences — this collapses both
 * consecutive (AAAA) and alternating (ABABAB) loops while letting a phrase recur
 * naturally if it's spread far enough apart in genuine conversation.
 */
export function collapseRepetitions(text: string, window = 8): string {
  const out: string[] = [];
  const recentNorms: string[] = [];
  for (const sentence of sentences(text)) {
    const key = norm(sentence);
    if (recentNorms.includes(key)) continue;
    out.push(sentence);
    recentNorms.push(key);
    if (recentNorms.length > window) recentNorms.shift();
  }
  return out.join(" ");
}
