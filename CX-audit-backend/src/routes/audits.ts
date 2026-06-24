import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { auditScope } from "../services/rbac.js";
import { resolveTeamInfra } from "../services/teamInfra.js";
import { sendMessage } from "../lib/sqs.js";
import { getTranscription, listRecordingKeysByPrefix } from "../lib/s3.js";
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
  const { team, flagged, status, from, to, limit, cursor } = req.query as Record<string, string>;

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
    status: status || undefined,
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
 * POST /api/audits/bulk-reprocess  (super_admin only)
 * Bulk-ingest many recordings through the full pipeline. Provide EITHER:
 *   { recording_keys: ["a.mp3", ...] }   — an explicit list, OR
 *   { prefix: "Scaler/14_06_2026/" }     — every recording under an S3 prefix
 * Pass { dryRun: true } to preview what would run (counts + per-team split)
 * WITHOUT enqueuing — recommended first, since a real run re-incurs OpenAI cost.
 *
 * Each key is validated and routed to its owning team's transcription queue,
 * exactly like /reprocess. Safe to re-run: audit_ids are deterministic, so rows
 * are updated, never duplicated. Capped at MAX_BULK keys per call.
 */
const MAX_BULK = 2000;
auditsRouter.post("/bulk-reprocess", requireRole("super_admin"), async (req, res) => {
  const { recording_keys, prefix, dryRun } = req.body as {
    recording_keys?: unknown;
    prefix?: unknown;
    dryRun?: boolean;
  };

  // 1. Gather candidate keys from an explicit list or an S3 prefix.
  let keys: string[] = [];
  let truncated = false;
  if (Array.isArray(recording_keys) && recording_keys.length) {
    keys = recording_keys.map((k) => String(k).trim()).filter(Boolean);
  } else if (typeof prefix === "string" && prefix.trim()) {
    keys = await listRecordingKeysByPrefix(prefix.trim(), MAX_BULK + 1);
  } else {
    return res.status(400).json({ message: "Provide a non-empty recording_keys[] or a prefix." });
  }

  keys = [...new Set(keys)];
  if (keys.length > MAX_BULK) {
    truncated = true;
    keys = keys.slice(0, MAX_BULK);
  }

  // 2. Validate each key and resolve its team (cached per agent).
  const teamByAgent = new Map<string, string | null>();
  const valid: { key: string; team: string | null }[] = [];
  const errors: { key: string; reason: string }[] = [];
  for (const key of keys) {
    const meta = await resolveRecordingMeta(key);
    if (!meta) {
      errors.push({ key, reason: "not a recognized recording key" });
      continue;
    }
    let team = teamByAgent.get(meta.agent_id);
    if (team === undefined) {
      team = (await getUserByAgentId(meta.agent_id))?.team ?? null;
      teamByAgent.set(meta.agent_id, team);
    }
    valid.push({ key, team });
  }

  const by_team: Record<string, number> = {};
  for (const v of valid) by_team[v.team ?? "—"] = (by_team[v.team ?? "—"] ?? 0) + 1;

  // 3. Dry run — return the plan without enqueuing anything.
  if (dryRun) {
    return res.json({
      dryRun: true,
      total: keys.length,
      valid: valid.length,
      queued: 0,
      invalid: errors.length,
      by_team,
      errors: errors.slice(0, 50),
      sample: valid.slice(0, 20).map((v) => v.key),
      truncated,
    });
  }

  // 4. Enqueue each valid key to its team's transcription queue (infra cached).
  const infraByTeam = new Map<string, Awaited<ReturnType<typeof resolveTeamInfra>>>();
  let queued = 0;
  for (const v of valid) {
    try {
      const cacheKey = v.team ?? "";
      let infra = infraByTeam.get(cacheKey);
      if (!infra) {
        infra = await resolveTeamInfra(v.team);
        infraByTeam.set(cacheKey, infra);
      }
      await sendMessage(infra.transcription_queue_url, { recording_key: v.key });
      queued++;
    } catch (err) {
      errors.push({ key: v.key, reason: err instanceof Error ? err.message : "enqueue failed" });
    }
  }

  logger.info(`Bulk reprocess by ${req.user!.email}: queued ${queued}/${keys.length} (invalid ${errors.length})`);
  res.json({
    dryRun: false,
    total: keys.length,
    valid: valid.length,
    queued,
    invalid: errors.length,
    by_team,
    errors: errors.slice(0, 50),
    truncated,
  });
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
