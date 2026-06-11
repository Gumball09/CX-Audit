import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { canEditRubric } from "../services/rbac.js";
import { getTeam } from "../db/teams.js";
import { getRubric } from "../db/rubrics.js";
import { listFeedbackByTeam } from "../db/feedback.js";
import {
  listSuggestionsByTeam,
  getSuggestion,
  putSuggestion,
  deleteSuggestion,
  setSuggestionStatus,
  newSuggestionId,
} from "../db/suggestions.js";
import { suggestRubricImprovements, type Scorable } from "../services/openai.js";
import { getModelSettingsCached } from "../db/settings.js";
import type { RubricSuggestion, SuggestionStatus } from "../types.js";

export const suggestionsRouter = Router();

const STATUSES: SuggestionStatus[] = ["open", "applied", "dismissed"];

/** GET /api/suggestions?team=<id> — improvement suggestions for a team. */
suggestionsRouter.get("/", requireRole("admin", "super_admin"), async (req, res) => {
  const team = (req.query.team as string) || "";
  if (!team) return res.status(400).json({ message: "team query param required." });
  if (!canEditRubric(req.user!, team)) return res.status(403).json({ message: "Out of scope." });
  res.json(await listSuggestionsByTeam(team));
});

/**
 * POST /api/suggestions/generate — analyze the team's feedback for one rubric
 * and produce a fresh improvement suggestion. body: { team, rubric_id? }.
 */
suggestionsRouter.post("/generate", requireRole("admin", "super_admin"), async (req, res) => {
  const team = (req.body?.team as string)?.trim() || "";
  const rubricId = (req.body?.rubric_id as string)?.trim() || "primary";
  if (!team) return res.status(400).json({ message: "team is required." });
  if (!canEditRubric(req.user!, team)) return res.status(403).json({ message: "Out of scope." });

  // Resolve the rubric being improved (primary lives on the team row).
  let spec: (Scorable & { description?: string }) | null = null;
  let rubricName = "Primary rubric";
  if (rubricId === "primary") {
    const t = await getTeam(team);
    if (!t) return res.status(404).json({ message: `Unknown team "${team}".` });
    spec = t;
    rubricName = t.name;
  } else {
    const r = await getRubric(rubricId);
    if (!r || r.team_id !== team) return res.status(404).json({ message: "Rubric not found for this team." });
    spec = r;
    rubricName = r.name;
  }

  const feedback = (await listFeedbackByTeam(team)).filter((f) => f.rubric_id === rubricId);
  if (feedback.length === 0) {
    return res.status(400).json({ message: "No feedback yet for this rubric — collect some reviewer feedback first." });
  }

  const { audit_model } = await getModelSettingsCached();
  const out = await suggestRubricImprovements(spec, feedback, audit_model);

  const now = new Date().toISOString();
  const suggestion: RubricSuggestion = {
    suggestion_id: newSuggestionId(),
    team,
    rubric_id: rubricId,
    rubric_name: rubricName,
    status: "open",
    summary: out.summary,
    suggested_system_prompt: out.suggested_system_prompt,
    criteria_changes: out.criteria_changes,
    based_on_feedback_count: feedback.length,
    created_at: now,
    created_by: req.user!.user_id,
    updated_at: now,
    updated_by: req.user!.user_id,
  };
  await putSuggestion(suggestion);
  logger.info(`Suggestion ${suggestion.suggestion_id} generated for ${team}/${rubricId} from ${feedback.length} feedback items by ${req.user!.email}`);
  res.status(201).json(suggestion);
});

/** PATCH /api/suggestions/:id — set status (applied/dismissed/open). */
suggestionsRouter.patch("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const existing = await getSuggestion(req.params.id);
  if (!existing) return res.status(404).json({ message: "Suggestion not found." });
  if (!canEditRubric(req.user!, existing.team)) return res.status(403).json({ message: "Out of scope." });
  const status = req.body?.status as SuggestionStatus;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ message: `status must be one of ${STATUSES.join(", ")}.` });
  }
  const updated = await setSuggestionStatus(existing.suggestion_id, status, req.user!.user_id);
  res.json(updated);
});

/** DELETE /api/suggestions/:id */
suggestionsRouter.delete("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const existing = await getSuggestion(req.params.id);
  if (!existing) return res.status(404).json({ message: "Suggestion not found." });
  if (!canEditRubric(req.user!, existing.team)) return res.status(403).json({ message: "Out of scope." });
  await deleteSuggestion(existing.suggestion_id);
  res.json({ ok: true });
});
