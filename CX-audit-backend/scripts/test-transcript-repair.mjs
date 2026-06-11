// Fast, offline regression check for transcript loop-repair (no API/ffmpeg).
//   node scripts/test-transcript-repair.mjs
const { repetitionScore, collapseRepetitions } = await import("../dist/lib/transcript.js");

let pass = true;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
};

// Clean conversational text scores low and is left essentially intact.
const clean =
  "Hello, how can I help you today? I have a question about my course fees. " +
  "Sure, let me check that for you. The transfer fee is one lakh rupees. " +
  "Okay, that seems high. I understand your concern, let me explain the breakdown.";
check("clean text low score", repetitionScore(clean) < 0.2, `score=${repetitionScore(clean).toFixed(2)}`);
check("clean text preserved", collapseRepetitions(clean).length > clean.length * 0.85);

// Consecutive loop (AAAA).
const aaaa = "Hello. ".repeat(200).trim();
check("AAAA scores high", repetitionScore(aaaa) > 0.9, `score=${repetitionScore(aaaa).toFixed(2)}`);
const aaaaC = collapseRepetitions(aaaa);
check("AAAA collapses to ~1", aaaaC.split(/\s+/).length <= 2, `-> "${aaaaC}"`);

// Alternating loop (ABABAB) — windowed collapse must catch it too.
const abab = "Yes it is. No it isn't. ".repeat(100).trim();
check("ABAB scores high", repetitionScore(abab) > 0.9, `score=${repetitionScore(abab).toFixed(2)}`);
const ababC = collapseRepetitions(abab);
check("ABAB collapses to 2", ababC.split(/(?<=[.?!])\s+/).filter(Boolean).length === 2, `-> "${ababC}"`);

// Real backchannel repeats spread apart survive (window-limited collapse).
const spread = Array.from({ length: 6 }, (_, i) =>
  `Okay. Point number ${i} is about the placement support and the interview process here.`
).join(" ");
check("spread-out repeats survive", collapseRepetitions(spread).includes("Point number 5"));

console.log(pass ? "\nPASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
