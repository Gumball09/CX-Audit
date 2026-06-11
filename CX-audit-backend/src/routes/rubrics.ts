import { Router } from "express";
import { logger } from "../logger.js";
import { validateCriteria } from "../validation.js";
import { requireRole } from "../services/auth.js";
import { canEditRubric } from "../services/rbac.js";
import { getTeam } from "../db/teams.js";
import { listRubricsByTeam, getRubric, putRubric, deleteRubric, updateRubricFields, newRubricId } from "../db/rubrics.js";
import type { Rubric } from "../types.js";

export const rubricsRouter = Router();

/** GET /api/rubrics?team=<id> — additional rubrics for a team (admin+ of that team). */
rubricsRouter.get("/", requireRole("admin", "super_admin"), async (req, res) => {
  const team = (req.query.team as string) || "";
  if (!team) return res.status(400).json({ message: "team query param required." });
  if (!canEditRubric(req.user!, team)) return res.status(403).json({ message: "Out of scope." });
  res.json(await listRubricsByTeam(team));
});

/** POST /api/rubrics — add an additional rubric to a team (admin own team / super_admin). */
rubricsRouter.post("/", requireRole("admin", "super_admin"), async (req, res) => {
  const b = req.body as Partial<Rubric>;
  const team_id = (b.team_id ?? "").trim();
  if (!team_id || !(await getTeam(team_id))) return res.status(400).json({ message: `Unknown team "${team_id}".` });
  if (!canEditRubric(req.user!, team_id)) return res.status(403).json({ message: "You can only add rubrics to your own team." });
  if (!b.name?.trim()) return res.status(400).json({ message: "Rubric name required." });
  const v = validateCriteria(b.criteria);
  if (!v.valid) return res.status(400).json({ message: "Validation failed", errors: v.errors });

  const now = new Date().toISOString();
  const rubric: Rubric = {
    rubric_id: newRubricId(),
    team_id,
    name: b.name.trim(),
    description: b.description ?? "",
    criteria: b.criteria!,
    system_prompt: b.system_prompt ?? "You are a CX quality auditor. Score the transcript against each criterion.",
    scale_max: b.scale_max ?? 100,
    flag_threshold: b.flag_threshold ?? 70,
    critical_criterion_threshold: b.critical_criterion_threshold ?? 60,
    active: b.active !== false,
    created_at: now,
    created_by: req.user!.user_id,
    updated_at: now,
    updated_by: req.user!.user_id,
  };
  await putRubric(rubric);
  logger.info(`Rubric ${rubric.rubric_id} added to team ${team_id} by ${req.user!.email}`);
  res.status(201).json(rubric);
});

/** PATCH /api/rubrics/:id — edit an additional rubric. */
rubricsRouter.patch("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const existing = await getRubric(req.params.id);
  if (!existing) return res.status(404).json({ message: "Rubric not found." });
  if (!canEditRubric(req.user!, existing.team_id)) return res.status(403).json({ message: "Out of scope." });

  const patch = req.body as Partial<Rubric>;
  if (patch.criteria !== undefined) {
    const v = validateCriteria(patch.criteria);
    if (!v.valid) return res.status(400).json({ message: "Validation failed", errors: v.errors });
  }
  const updated = await updateRubricFields(
    existing.rubric_id,
    {
      name: patch.name, description: patch.description, criteria: patch.criteria,
      system_prompt: patch.system_prompt, scale_max: patch.scale_max,
      flag_threshold: patch.flag_threshold, critical_criterion_threshold: patch.critical_criterion_threshold,
      active: patch.active,
    },
    req.user!.user_id
  );
  res.json(updated);
});

/** DELETE /api/rubrics/:id — remove an additional rubric. */
rubricsRouter.delete("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const existing = await getRubric(req.params.id);
  if (!existing) return res.status(404).json({ message: "Rubric not found." });
  if (!canEditRubric(req.user!, existing.team_id)) return res.status(403).json({ message: "Out of scope." });
  await deleteRubric(existing.rubric_id);
  logger.info(`Rubric ${existing.rubric_id} deleted from team ${existing.team_id} by ${req.user!.email}`);
  res.json({ ok: true });
});
