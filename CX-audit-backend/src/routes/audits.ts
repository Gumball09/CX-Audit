import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { auditScope } from "../services/rbac.js";
import { resolveTeamInfra } from "../services/teamInfra.js";
import { sendMessage } from "../lib/sqs.js";
import { getTranscription } from "../lib/s3.js";
import { resolveRecordingMeta } from "../lib/filename.js";
import { getAudit, listAudits, setStatus, type AuditScope } from "../db/audits.js";
import { getUserByAgentId } from "../db/users.js";
import type { AuditRecord, User } from "../types.js";

export const auditsRouter = Router();

/** Returns true if `user` is allowed to see this audit row (scope check). */
function canView(user: User, audit: AuditRecord): boolean {
  const scope = auditScope(user.role);
  if (scope === "all") return true;
  if (scope === "team") return audit.team === user.team;
  return audit.agent_id === user.agent_id;
}

/**
 * GET /api/audits — audits visible to the caller, paginated.
 * Scope: super_admin = all, admin = own team, user = own calls.
 * Query: ?team=CS&flagged=true&from=ISO&to=ISO&limit=200&cursor=<opaque>
 * Returns: { items: AuditRecord[], nextCursor?: string }
 *
 * Note: `team` is only honored for super_admins (admins are already pinned to
 * their team, users to their own calls).
 */
auditsRouter.get("/", async (req, res) => {
  const user = req.user!;
  const view = auditScope(user.role);
  const { team, flagged, from, to, limit, cursor } = req.query as Record<string, string>;

  let scope: AuditScope;
  if (view === "all") {
    // super_admin: optional team filter (any team slug); otherwise all teams.
    scope = team ? { kind: "team", team } : { kind: "all" };
  } else if (view === "team") {
    if (!user.team) return res.json({ items: [] });
    scope = { kind: "team", team: user.team };
  } else {
    if (!user.agent_id) return res.json({ items: [] });
    scope = { kind: "agent", agentId: user.agent_id };
  }

  const page = await listAudits(scope, {
    flagged: flagged === "true" ? true : undefined,
    from: from || undefined,
    to: to || undefined,
    limit: limit ? Number(limit) : undefined,
    cursor: cursor || undefined,
  });
  res.json(page);
});

/** GET /api/audits/:id — a single audit (scope enforced). */
auditsRouter.get("/:id", async (req, res) => {
  const audit = await getAudit(req.params.id);
  if (!audit) return res.status(404).json({ message: "Audit not found." });
  if (!canView(req.user!, audit)) return res.status(403).json({ message: "Out of scope." });
  res.json(audit);
});

/** GET /api/audits/:id/transcript — full transcript text (scope enforced). */
auditsRouter.get("/:id/transcript", async (req, res) => {
  const audit = await getAudit(req.params.id);
  if (!audit) return res.status(404).json({ message: "Audit not found." });
  if (!canView(req.user!, audit)) return res.status(403).json({ message: "Out of scope." });
  if (!audit.transcription_key) return res.status(404).json({ message: "No transcript yet." });
  const infra = await resolveTeamInfra(audit.team);
  const text = await getTranscription(audit.transcription_key, infra.output_bucket);
  res.json({ audit_id: audit.audit_id, transcript: text });
});

/**
 * POST /api/audits/reprocess  { recording_key }
 * Re-ingest a recording through the full pipeline (admin+). Useful for backfill
 * or recovering failed rows.
 */
auditsRouter.post("/reprocess", requireRole("admin", "super_admin"), async (req, res) => {
  const { recording_key } = req.body as { recording_key?: string };
  if (!recording_key) return res.status(400).json({ message: "recording_key required." });
  // Route to the owning team's transcription queue (agent → team), else global.
  const meta = await resolveRecordingMeta(recording_key);
  const team = meta ? (await getUserByAgentId(meta.agent_id))?.team ?? null : null;
  const infra = await resolveTeamInfra(team);
  await sendMessage(infra.transcription_queue_url, { recording_key });
  logger.info(`Re-queued recording for processing: ${recording_key} (team=${team ?? "—"}) by ${req.user!.email}`);
  res.json({ ok: true, queued: recording_key });
});

/**
 * POST /api/audits/:id/reaudit — re-run only the audit stage for an already
 * transcribed call (e.g. after a rubric change). Admin+, scope enforced.
 */
auditsRouter.post("/:id/reaudit", requireRole("admin", "super_admin"), async (req, res) => {
  const audit = await getAudit(req.params.id);
  if (!audit) return res.status(404).json({ message: "Audit not found." });
  if (!canView(req.user!, audit)) return res.status(403).json({ message: "Out of scope." });
  if (!audit.transcription_key) return res.status(400).json({ message: "No transcript to re-audit." });

  // Reset so the audit worker doesn't skip it as already-complete.
  await setStatus(audit.audit_id, "transcribed");
  const infra = await resolveTeamInfra(audit.team);
  await sendMessage(infra.audit_queue_url, {
    audit_id: audit.audit_id,
    agent_id: audit.agent_id,
    transcription_key: audit.transcription_key,
  });
  logger.info(`Re-queued audit ${audit.audit_id} by ${req.user!.email}`);
  res.json({ ok: true, queued: audit.audit_id });
});
