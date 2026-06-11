import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Audio splitting for the long-recording transcription fallback.
 *
 * When a recording exceeds the transcription model's input limit, we split it
 * into chunks at natural pauses (silence) — not at fixed offsets — so cuts land
 * between words and the per-chunk transcription quality stays high. Each chunk
 * is transcribed independently and the texts are stitched in order.
 *
 * Requires `ffmpeg`/`ffprobe` on PATH (added to the worker image; `brew install
 * ffmpeg` locally). Override the binaries with FFMPEG_PATH / FFPROBE_PATH.
 */

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface AudioChunk {
  buffer: Buffer;
  fileName: string;
  /** Zero-based position in the original recording. */
  index: number;
  startSec: number;
  endSec: number;
}

export interface SplitOptions {
  /** Preferred chunk length; the splitter picks the silence nearest this. */
  targetSec: number;
  /** Absolute ceiling; if no silence is found before this, cut hard here. */
  maxSec: number;
  /** silencedetect noise floor in dB (e.g. -30). */
  silenceDb: number;
  /** Minimum pause length (seconds) that qualifies as a cut point. */
  minSilenceSec: number;
}

/** Spawn a process and capture stdout/stderr. Rejects if the binary is missing. */
function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`${cmd} not found on PATH — install ffmpeg (worker image / \`brew install ffmpeg\`).`));
      } else {
        reject(err);
      }
    });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

/** Total duration of the audio file in seconds (0 if unknown). */
async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

/** Timestamps (seconds) where a silent stretch ends — our candidate cut points. */
async function detectSilenceEnds(file: string, silenceDb: number, minSilenceSec: number): Promise<number[]> {
  const { stderr } = await run(FFMPEG, [
    "-i", file,
    "-af", `silencedetect=noise=${silenceDb}dB:d=${minSilenceSec}`,
    "-f", "null", "-",
  ]);
  const ends: number[] = [];
  for (const m of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t)) ends.push(t);
  }
  return ends.sort((a, b) => a - b);
}

/**
 * Greedily choose internal cut points. From each segment start we look for the
 * silence_end closest to `start + targetSec` that falls within `start + maxSec`;
 * if none exists we cut hard at `start + maxSec` to respect the model limit.
 */
function chooseCutPoints(durationSec: number, silenceEnds: number[], targetSec: number, maxSec: number): number[] {
  const cuts: number[] = [];
  let start = 0;
  // Keep cutting while the remaining tail still exceeds the hard ceiling.
  while (durationSec - start > maxSec) {
    const ideal = start + targetSec;
    const hard = start + maxSec;
    const candidates = silenceEnds.filter((s) => s > start + 1 && s <= hard);
    let cut: number;
    if (candidates.length) {
      cut = candidates.reduce((best, s) => (Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best), candidates[0]);
    } else {
      cut = hard; // no usable pause — hard cut to stay under the limit
      logger.warn(`No silence found in [${start.toFixed(0)}s, ${hard.toFixed(0)}s] — hard-cutting at ${hard.toFixed(0)}s`);
    }
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

/** Re-encode a [startSec, endSec) slice to mp3 (accurate seek, decode-then-cut). */
async function extractSegment(input: string, startSec: number, endSec: number, outPath: string): Promise<void> {
  const { code, stderr } = await run(FFMPEG, [
    "-y",
    "-i", input,
    "-ss", startSec.toFixed(3),
    "-to", endSec.toFixed(3),
    "-vn",
    "-c:a", "libmp3lame",
    "-q:a", "5",
    outPath,
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg segment extract failed (code ${code}): ${stderr.slice(-400)}`);
  }
}

/**
 * Split an audio buffer into silence-aligned chunks. Returns the original as a
 * single chunk when it's already short enough to need no splitting.
 */
export async function splitAudioOnSilence(
  buffer: Buffer,
  fileName: string,
  opts: SplitOptions
): Promise<AudioChunk[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "cx-chunk-"));
  try {
    const ext = path.extname(fileName) || ".mp3";
    const input = path.join(dir, `input${ext}`);
    await writeFile(input, buffer);

    const duration = await probeDurationSec(input);
    if (duration <= opts.maxSec) {
      // Short enough already — nothing to split.
      return [{ buffer, fileName, index: 0, startSec: 0, endSec: duration }];
    }

    const silenceEnds = await detectSilenceEnds(input, opts.silenceDb, opts.minSilenceSec);
    const cuts = chooseCutPoints(duration, silenceEnds, opts.targetSec, opts.maxSec);
    const bounds = [0, ...cuts, duration];

    const chunks: AudioChunk[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const startSec = bounds[i];
      const endSec = bounds[i + 1];
      const out = path.join(dir, `chunk_${i}.mp3`);
      await extractSegment(input, startSec, endSec, out);
      chunks.push({ buffer: await readFile(out), fileName: `chunk_${i}.mp3`, index: i, startSec, endSec });
    }
    logger.info(
      `Split ${fileName} (${duration.toFixed(0)}s) into ${chunks.length} chunks at ` +
        `[${cuts.map((c) => c.toFixed(0)).join(", ")}]s`
    );
    return chunks;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
