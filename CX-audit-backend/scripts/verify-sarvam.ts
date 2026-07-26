/**
 * Live contract check for the Sarvam provider.
 *
 *   npm run verify:sarvam -- path/to/recording.mp3
 *
 * Why this exists as a command rather than a thing someone remembers to do:
 * every defect we have hit with this provider was invisible from its own
 * documentation and invisible to unit tests, because unit-test fixtures are
 * written from the same assumptions as the code they check. Three examples, all
 * real:
 *
 *   - `upload_urls` is a map keyed by file name, not the array the published
 *     OpenAPI schema shows.
 *   - Audio at an unexpected sample rate is silently mis-decoded: HTTP 200, a
 *     plausible-looking document, a stretched timeline, and phonetic nonsense.
 *   - `json_schema` is advertised but broken on sarvam-105b, and the model
 *     answers role-mapping questions in a shape it invents.
 *
 * So this runs the REAL `transcribeCall` — not a reimplementation of it — against
 * real audio and checks the answer against things we independently know to be
 * true. Run it before shipping any provider or model config change.
 *
 * It is deliberately cheap: point it at a short clip. Batch STT bills by audio
 * duration, so a 40-second clip costs a fraction of a rupee.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transcribeCall } from "../src/services/ai/index.js";
import { probeBufferDurationSec } from "../src/lib/audio.js";
import { env } from "../src/env.js";

/** One contract expectation and whether the live response satisfied it. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
  /** A soft check reports but does not fail the run. */
  advisory?: boolean;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string, advisory = false) {
  checks.push({ name, pass, detail, advisory });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run verify:sarvam -- <path-to-audio>");
    process.exit(2);
  }
  if (!env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY is not set in .env.local — this check must hit the live API.");
    process.exit(2);
  }

  const buffer = await readFile(file);
  const fileName = path.basename(file);

  // Ground truth, established locally and independently of the provider. This is
  // the whole basis of the check: without it we can only confirm that the API
  // replied, not that it replied correctly.
  const trueDuration = await probeBufferDurationSec(buffer, fileName);
  console.log(`\nFile      : ${fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
  console.log(`Duration  : ${trueDuration.toFixed(1)}s (ffprobe — our ground truth)`);
  console.log(`Provider  : sarvam · stt=${env.SARVAM_STT_MODEL} mode=${env.SARVAM_STT_MODE} audit=${env.SARVAM_AUDIT_MODEL}`);
  console.log(`Est. cost : ~₹${((trueDuration / 3600) * 45).toFixed(2)} of batch STT at ₹45/hr\n`);

  const started = Date.now();
  const r = await transcribeCall("sarvam", buffer, fileName);
  const elapsed = (Date.now() - started) / 1000;

  // ---- Contract expectations ---------------------------------------------
  check("job completed", true, `${elapsed.toFixed(1)}s wall clock, job ${r.jobId ?? "—"}`);

  check("transcript is non-empty", r.text.trim().length > 0, `${r.text.length} chars`);

  check("diarization produced turns", r.turns.length > 0, `${r.turns.length} turns`);

  const speakers = [...new Set(r.turns.map((t) => t.speaker_id))];
  check(
    "at least two speakers separated",
    speakers.length >= 2,
    `speaker ids: ${speakers.join(", ") || "none"}`
  );

  // The invariant that catches the silent mis-decode. Audio cannot contain speech
  // after it ends, so a timeline longer than the file is proof of a bad decode.
  const maxEnd = r.turns.reduce((m, t) => Math.max(m, t.end_sec), 0);
  const ratio = trueDuration > 0 ? maxEnd / trueDuration : 0;
  check(
    "timeline fits inside the audio",
    trueDuration > 0 && maxEnd <= trueDuration * 1.1 + 2,
    `turns end at ${maxEnd.toFixed(1)}s vs ${trueDuration.toFixed(1)}s of audio (${ratio.toFixed(2)}x)`
  );

  check(
    "roles resolved by reading the call, not guessed",
    r.roles.method === "llm" || r.roles.method === "channel",
    `method=${r.roles.method} confidence=${r.roles.confidence.toFixed(2)} ` +
      `agent=${r.roles.agent ?? "—"} customer=${r.roles.customer ?? "—"}`
  );

  check(
    "both roles assigned to distinct speakers",
    !!r.roles.agent && !!r.roles.customer && r.roles.agent !== r.roles.customer,
    `agent=${r.roles.agent ?? "—"} customer=${r.roles.customer ?? "—"}`
  );

  const talk = r.talkTimeSec.agent + r.talkTimeSec.customer;
  check(
    "talk time is plausible",
    talk > 0 && talk <= trueDuration * 1.2 + 2,
    `agent ${r.talkTimeSec.agent}s + customer ${r.talkTimeSec.customer}s = ${talk}s`
  );

  check("language detected", !!r.languageCode, r.languageCode ?? "none reported", true);

  // ---- Report -------------------------------------------------------------
  console.log("Contract checks");
  console.log("───────────────");
  for (const c of checks) {
    const mark = c.pass ? "PASS" : c.advisory ? "WARN" : "FAIL";
    console.log(`  [${mark}] ${c.name.padEnd(42)} ${c.detail}`);
  }

  console.log("\nTranscript (first 8 turns, as the auditor will read it)");
  console.log("──────────────────────────────────────────────────────");
  console.log(
    r.text
      .split("\n")
      .slice(0, 8)
      .map((l) => "  " + l.slice(0, 160))
      .join("\n")
  );

  const failed = checks.filter((c) => !c.pass && !c.advisory);
  const warned = checks.filter((c) => !c.pass && c.advisory);
  console.log(
    `\n${failed.length === 0 ? "✓ contract satisfied" : `✗ ${failed.length} check(s) failed`}` +
      `${warned.length ? ` (${warned.length} advisory)` : ""}\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n✗ verify:sarvam threw: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
