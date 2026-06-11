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

// Genuinely distinct long sentences (low mutual similarity) all survive.
const distinct =
  "The customer asked whether transferring their enrolled course to another student is possible. " +
  "They also complained that placement support never scheduled the Hyderabad interview properly. " +
  "Finally they reported scoring sixty nine on the second coding challenge round.";
const distinctC = collapseRepetitions(distinct);
check("distinct long content survives", distinctC.includes("Hyderabad") && distinctC.includes("sixty nine"));

// Paraphrased "restart" loop (near-verbatim, spread apart) collapses to one.
const para =
  "Hello, so you are saying that just to transfer the course it is going to cost me one point three lakh rupees additional. " +
  "There is a separate charge for that and I will take it up with the team and get back to you. " +
  "Hello, so you are saying that just to transfer the course it is going to cost me one point three four lakh rupees additional. " +
  "Separately, I scored sixty nine on the coding round two test which I cleared.";
const paraC = collapseRepetitions(para, { nearDupSimilarity: 0.8 });
check("paraphrased restart collapsed", (paraC.match(/transfer the course/g) || []).length === 1, paraC.slice(0, 140));
check("distinct content kept after fuzzy", paraC.includes("coding round two"));

console.log(pass ? "\nPASS" : "\nFAIL");
process.exit(pass ? 0 : 1);
