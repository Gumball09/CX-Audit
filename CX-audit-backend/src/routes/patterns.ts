import { Router } from "express";
import path from "path";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import {
  listPatterns,
  getPattern,
  putPattern,
  updatePatternFields,
  deletePattern,
  newPatternId,
} from "../db/patterns.js";
import type { RecordingPattern } from "../types.js";

export const patternsRouter = Router();

/** Validate a regex string compiles and references the required agent_id group. */
function validateRegex(regex: unknown, flags: unknown): { ok: true; re: RegExp } | { ok: false; error: string } {
  if (typeof regex !== "string" || !regex.trim()) return { ok: false, error: "regex is required." };
  try {
    const re = new RegExp(regex, typeof flags === "string" && flags ? flags : "i");
    if (!regex.includes("(?<agent_id>")) {
      return { ok: false, error: "regex must include a named capture group (?<agent_id>...)." };
    }
    return { ok: true, re };
  } catch (err) {
    return { ok: false, error: `Invalid regex: ${(err as Error).message}` };
  }
}

/** GET /api/patterns — list all recording patterns (super_admin). */
patternsRouter.get("/", requireRole("super_admin"), async (_req, res) => {
  res.json(await listPatterns());
});

/**
 * POST /api/patterns/test  { regex, flags?, sample }
 * Dry-run a pattern against a sample filename/key and return the captured
 * groups — lets the UI preview a new pattern before saving it.
 */
patternsRouter.post("/test", requireRole("super_admin"), async (req, res) => {
  const { regex, flags, sample } = req.body as { regex?: string; flags?: string; sample?: string };
  const v = validateRegex(regex, flags);
  if (!v.ok) return res.status(400).json({ message: v.error });
  if (typeof sample !== "string" || !sample) return res.status(400).json({ message: "sample is required." });
  const m = v.re.exec(path.basename(sample));
  res.json({ matched: !!m, groups: m?.groups ?? null });
});

/** POST /api/patterns — create a new pattern (super_admin). */
patternsRouter.post("/", requireRole("super_admin"), async (req, res) => {
  const { label, regex, flags, priority, active } = req.body as Partial<RecordingPattern>;
  if (typeof label !== "string" || !label.trim()) return res.status(400).json({ message: "label is required." });
  const v = validateRegex(regex, flags);
  if (!v.ok) return res.status(400).json({ message: v.error });

  // New patterns default to the END of the priority order (highest number) so
  // they're tried after the proven default until they earn promotion by usage.
  const existing = await listPatterns();
  const maxPriority = existing.reduce((m, p) => Math.max(m, p.priority), 0);

  const now = new Date().toISOString();
  const pattern: RecordingPattern = {
    pattern_id: newPatternId(),
    label: label.trim(),
    regex: regex as string,
    flags: typeof flags === "string" && flags ? flags : "i",
    priority: typeof priority === "number" ? priority : maxPriority + 1,
    active: active !== false,
    match_count: 0,
    is_builtin: false,
    created_by: req.user!.user_id,
    created_at: now,
    updated_at: now,
  };
  await putPattern(pattern);
  logger.info(`Recording pattern created: ${pattern.label} (${pattern.pattern_id}) by ${req.user!.email}`);
  res.status(201).json(pattern);
});

/** PATCH /api/patterns/:id — edit label/regex/flags/priority/active (super_admin). */
patternsRouter.patch("/:id", requireRole("super_admin"), async (req, res) => {
  const existing = await getPattern(req.params.id);
  if (!existing) return res.status(404).json({ message: "Pattern not found." });

  const { label, regex, flags, priority, active } = req.body as Partial<RecordingPattern>;
  if (regex !== undefined || flags !== undefined) {
    const v = validateRegex(regex ?? existing.regex, flags ?? existing.flags);
    if (!v.ok) return res.status(400).json({ message: v.error });
  }
  const updated = await updatePatternFields(req.params.id, { label, regex, flags, priority, active });
  logger.info(`Recording pattern updated: ${req.params.id} by ${req.user!.email}`);
  res.json(updated);
});

/** DELETE /api/patterns/:id — remove a pattern (super_admin; built-in protected). */
patternsRouter.delete("/:id", requireRole("super_admin"), async (req, res) => {
  const existing = await getPattern(req.params.id);
  if (!existing) return res.status(404).json({ message: "Pattern not found." });
  if (existing.is_builtin) return res.status(400).json({ message: "The built-in default pattern cannot be deleted (deactivate it instead)." });
  await deletePattern(req.params.id);
  logger.info(`Recording pattern deleted: ${req.params.id} by ${req.user!.email}`);
  res.json({ ok: true });
});
