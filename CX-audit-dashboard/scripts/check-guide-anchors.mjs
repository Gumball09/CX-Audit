#!/usr/bin/env node
/**
 * Verifies every `data-guide` anchor referenced by a guide actually exists in the
 * JSX, and reports anchors nobody uses.
 *
 * A guide step whose anchor has been renamed or deleted fails quietly at runtime
 * — the step is skipped if optional, or degrades to a centered card if not — so
 * the breakage is easy to ship without noticing. This makes it a build-time
 * error instead.
 *
 *   npm run check:guides
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const guidesSrc = readFileSync(join(root, "src/lib/guides.ts"), "utf8");
const referenced = new Set([...guidesSrc.matchAll(/anchor:\s*"([^"]+)"/g)].map((m) => m[1]));

// Dynamic anchor families, expanded from the same lists the components map over.
const NAV_IDS = ["calls", "performance", "users", "teams", "patterns", "bulk", "signins", "settings"];
const INFRA_KEYS = [
  "recording_bucket", "output_bucket", "transcription_queue_url", "audit_queue_url",
  "batch_size", "wait_time_seconds", "max_receive_count", "worker_concurrency",
];

const present = new Set();
for (const file of walk(join(root, "src")).filter((f) => f.endsWith(".tsx"))) {
  const src = readFileSync(file, "utf8");
  // data-guide="literal"
  for (const m of src.matchAll(/data-guide=\{?"([^"{}]+)"/g)) present.add(m[1]);
  // "data-guide": "literal"  (object form used by the per-index helpers)
  for (const m of src.matchAll(/"data-guide":\s*"([^"]+)"/g)) present.add(m[1]);
  // {...g("literal")} — the helper that tags only the first item in a list
  for (const m of src.matchAll(/\bg\("([^"]+)"\)/g)) present.add(m[1]);
  // data-guide={`nav-${n.id}`} and friends
  for (const m of src.matchAll(/data-guide=\{`([^`]+)`\}/g)) {
    const tpl = m[1];
    if (tpl.includes("nav-$")) NAV_IDS.forEach((id) => present.add(`nav-${id}`));
    else if (tpl.includes("infra-$")) INFRA_KEYS.forEach((k) => present.add(`infra-${k}`));
    else present.add(tpl);
  }
}

const missing = [...referenced].filter((a) => !present.has(a)).sort();
const unused = [...present].filter((a) => !referenced.has(a)).sort();

console.log(`guide anchors referenced: ${referenced.size}`);
console.log(`data-guide attrs present: ${present.size}`);

if (unused.length) {
  console.log(`\nanchors present but unused by any guide (${unused.length}) — fine, available for future guides:`);
  for (const u of unused) console.log(`  · ${u}`);
}

if (missing.length) {
  console.error(`\n✗ ${missing.length} guide step(s) reference an anchor that does not exist:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error("\nEither add the data-guide attribute or fix the step in src/lib/guides.ts.");
  process.exit(1);
}

console.log("\n✓ every guide anchor resolves");
