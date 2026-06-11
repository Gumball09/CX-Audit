// Standalone check for the silence-based splitter (src/lib/audio.ts).
// Generates a synthetic long mp3 (tone / silence / tone ...) so we can assert
// the splitter cuts inside the silent gaps. Requires ffmpeg + a built dist/.
//
//   node scripts/test-chunk-split.mjs
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { splitAudioOnSilence } = await import("../dist/lib/audio.js");

const dir = await mkdtemp(path.join(tmpdir(), "cx-splittest-"));
const src = path.join(dir, "long.mp3");

// 7 "speech" blocks of 200s each, separated by 2s silences -> ~1414s total.
// With targetSec=600/maxSec=900 the splitter should cut in the silent gaps.
const blocks = [];
const filters = [];
const SPEECH = 200, GAP = 2, N = 7;
for (let i = 0; i < N; i++) {
  const freq = 200 + i * 40;
  filters.push(`sine=frequency=${freq}:duration=${SPEECH}[s${i}]`);
  blocks.push(`[s${i}]`);
  if (i < N - 1) {
    filters.push(`anullsrc=r=44100:cl=mono:duration=${GAP}[g${i}]`);
    blocks.push(`[g${i}]`);
  }
}
const concatN = blocks.length;
const fc = `${filters.join(";")};${blocks.join("")}concat=n=${concatN}:v=0:a=1[out]`;

console.log("Generating synthetic test audio...");
const gen = spawnSync("ffmpeg", ["-y", "-filter_complex", fc, "-map", "[out]", "-q:a", "6", src], {
  encoding: "utf8",
});
if (gen.status !== 0) {
  console.error("ffmpeg generation failed:\n", gen.stderr?.slice(-800));
  process.exit(1);
}

const buffer = await readFile(src);
console.log(`Source: ${(buffer.length / 1024).toFixed(0)} KB, ~${(SPEECH * N + GAP * (N - 1))}s expected\n`);

const chunks = await splitAudioOnSilence(buffer, "long.mp3", {
  targetSec: 600,
  maxSec: 900,
  silenceDb: -30,
  minSilenceSec: 0.6,
});

console.log(`\nProduced ${chunks.length} chunk(s):`);
for (const c of chunks) {
  console.log(
    `  #${c.index}: ${c.startSec.toFixed(1)}s -> ${c.endSec.toFixed(1)}s ` +
      `(${(c.endSec - c.startSec).toFixed(1)}s, ${(c.buffer.length / 1024).toFixed(0)} KB)`
  );
}

// Assertions: more than one chunk, none exceeds maxSec, contiguous coverage.
let ok = chunks.length > 1;
for (let i = 0; i < chunks.length; i++) {
  if (chunks[i].endSec - chunks[i].startSec > 900 + 1) ok = false;
  if (i > 0 && Math.abs(chunks[i].startSec - chunks[i - 1].endSec) > 0.05) ok = false;
}
console.log(`\n${ok ? "✅ PASS" : "❌ FAIL"} — multi-chunk, each <= maxSec, contiguous`);

await rm(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
