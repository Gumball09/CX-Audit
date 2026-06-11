import { Router } from "express";
import { logger } from "../logger.js";
import { validateCriteria } from "../validation.js";
import { requireRole } from "../services/auth.js";
import { canEditRubric } from "../services/rbac.js";
import { listTeams, getTeam, putTeam } from "../db/teams.js";
import type { Team, TeamInfra, TeamRubric } from "../types.js";

export const teamsRouter = Router();

// Team ids (slugs) are letters/digits/dash/underscore, 1-40 chars. The slug is
// the DynamoDB key and the value stored on users/audits, so keep it URL-safe.
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Coerce/validate the optional per-team infra block. Returns undefined if absent. */
function sanitizeInfra(raw: unknown): TeamInfra | undefined {
  if (raw === undefined || raw === null) return undefined;
  const i = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    recording_bucket: str(i.recording_bucket),
    output_bucket: str(i.output_bucket),
    transcription_queue_url: str(i.transcription_queue_url),
    audit_queue_url: str(i.audit_queue_url),
    batch_size: num(i.batch_size),
    wait_time_seconds: num(i.wait_time_seconds),
    max_receive_count: num(i.max_receive_count),
    worker_concurrency: num(i.worker_concurrency),
  };
}

/** GET /api/teams — list all teams (any authenticated user). */
teamsRouter.get("/", async (_req, res) => res.json(await listTeams()));

/** GET /api/teams/:id — a single team. */
teamsRouter.get("/:id", async (req, res) => {
  const team = await getTeam(req.params.id);
  if (!team) return res.status(404).json({ message: "Team not found." });
  res.json(team);
});

/**
 * POST /api/teams — create a new team (super_admin only).
 * Body: { team_id, name, description?, criteria?, system_prompt?, scale_max?,
 *         flag_threshold?, critical_criterion_threshold?, infra? }
 */
teamsRouter.post("/", requireRole("super_admin"), async (req, res) => {
  const b = req.body as Partial<TeamRubric> & { team_id?: string };
  const id = (b.team_id ?? "").trim();

  if (!TEAM_ID_RE.test(id)) {
    return res.status(400).json({ message: "team_id must be 1-40 chars: letters, digits, dash or underscore." });
  }
  if (await getTeam(id)) return res.status(409).json({ message: `Team "${id}" already exists.` });
  if (b.criteria !== undefined) {
    const v = validateCriteria(b.criteria);
    if (!v.valid) return res.status(400).json({ message: "Validation failed", errors: v.errors });
  }

  const now = new Date().toISOString();
  const team: TeamRubric = {
    team_id: id,
    name: b.name?.trim() || id,
    description: b.description ?? "",
    criteria: b.criteria ?? [{ name: "Quality", weight: 100, description: "Overall call quality." }],
    system_prompt: b.system_prompt ?? "You are a CX quality auditor. Score the transcript against each criterion.",
    scale_max: b.scale_max ?? 100,
    flag_threshold: b.flag_threshold ?? 70,
    critical_criterion_threshold: b.critical_criterion_threshold ?? 60,
    infra: sanitizeInfra(b.infra),
    active: true,
    created_at: now,
    created_by: req.user!.user_id,
    updated_at: now,
    updated_by: req.user!.user_id,
  };
  await putTeam(team);
  logger.info(`Team created: ${id} by ${req.user!.email}`);
  res.status(201).json(team);
});

/**
 * PATCH /api/teams/:id — edit a team.
 *  - rubric fields: super_admin (any team) or admin (own team only)
 *  - infra / active:  super_admin only (it's infrastructure config)
 */
teamsRouter.patch("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const id = req.params.id;
  const existing = await getTeam(id);
  if (!existing) return res.status(404).json({ message: "Team not found." });

  const isSuper = req.user!.role === "super_admin";
  if (!canEditRubric(req.user!, id)) {
    return res.status(403).json({ message: "You can only edit your own team's rubric." });
  }

  const patch = req.body as Partial<TeamRubric>;

  // Only super_admins may change infrastructure or active state.
  if (!isSuper && (patch.infra !== undefined || patch.active !== undefined)) {
    return res.status(403).json({ message: "Only a super_admin can change team infrastructure." });
  }
  if (patch.criteria !== undefined) {
    const result = validateCriteria(patch.criteria);
    if (!result.valid) return res.status(400).json({ message: "Validation failed", errors: result.errors });
  }

  const updated: TeamRubric = {
    ...existing,
    ...patch,
    // never let these be overwritten by the patch body
    team_id: id,
    infra: patch.infra !== undefined ? sanitizeInfra(patch.infra) : existing.infra,
    active: patch.active !== undefined ? !!patch.active : existing.active,
    created_at: existing.created_at,
    created_by: existing.created_by,
    updated_at: new Date().toISOString(),
    updated_by: req.user!.user_id,
  };
  await putTeam(updated);
  logger.info(`Team ${id} updated by ${req.user!.email}`);
  res.json(updated);
});
