import { Router } from "express";
import { logger } from "../logger.js";
import { validateCriteria } from "../validation.js";
import { requireRole } from "../services/auth.js";
import { canEditRubric } from "../services/rbac.js";
import { listTeams, getTeam, putTeam } from "../db/teams.js";
import type { Team, TeamRubric } from "../types.js";

export const teamsRouter = Router();

const TEAMS: Team[] = ["CS", "RM", "OORP", "Escalations"];

/** GET /api/teams — list all team rubrics (any authenticated user). */
teamsRouter.get("/", async (_req, res) => res.json(await listTeams()));

/** GET /api/teams/:id — a single team rubric. */
teamsRouter.get("/:id", async (req, res) => {
  const id = req.params.id as Team;
  if (!TEAMS.includes(id)) return res.status(404).json({ message: "Unknown team." });
  const team = await getTeam(id);
  if (!team) return res.status(404).json({ message: "Team rubric not found." });
  res.json(team);
});

/**
 * PATCH /api/teams/:id — edit a team's rubric.
 * super_admin: any team. admin: own team only. (point 7 owners)
 */
teamsRouter.patch("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const id = req.params.id as Team;
  if (!TEAMS.includes(id)) return res.status(404).json({ message: "Unknown team." });
  if (!canEditRubric(req.user!, id)) {
    return res.status(403).json({ message: "You can only edit your own team's rubric." });
  }

  const existing = (await getTeam(id)) ?? defaultRubric(id);
  const patch = req.body as Partial<TeamRubric>;

  if (patch.criteria !== undefined) {
    const result = validateCriteria(patch.criteria);
    if (!result.valid) return res.status(400).json({ message: "Validation failed", errors: result.errors });
  }

  const updated: TeamRubric = {
    ...existing,
    ...patch,
    team_id: id,
    updated_at: new Date().toISOString(),
    updated_by: req.user!.user_id,
  };
  await putTeam(updated);
  logger.info(`Rubric updated for team ${id} by ${req.user!.email}`);
  res.json(updated);
});

function defaultRubric(id: Team): TeamRubric {
  return {
    team_id: id,
    name: `${id} Rubric`,
    description: "",
    criteria: [{ name: "Quality", weight: 100, description: "Overall call quality." }],
    system_prompt: "You are a CX quality auditor. Score the transcript 0-100 against each criterion.",
    flag_threshold: 70,
    critical_criterion_threshold: 60,
    updated_at: new Date().toISOString(),
    updated_by: null,
  };
}
