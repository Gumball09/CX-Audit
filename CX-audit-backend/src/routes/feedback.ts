import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { canEditRubric } from "../services/rbac.js";
import { getAudit } from "../db/audits.js";
import {
  listFeedbackByAudit,
  listFeedbackByTeam,
  getFeedback,
  putFeedback,
  deleteFeedback,
  newFeedbackId,
} from "../db/feedback.js";
import type { Feedback, FeedbackCriterionCorrection, FeedbackDisposition } from "../types.js";

export const feedbackRouter = Router();

const DISPOSITIONS: FeedbackDisposition[] = ["agree", "disagree", "partial"];

/**
 * GET /api/feedback?audit=<id> | ?team=<id>
 * Lists feedback for a single call or for a whole team. Admin+ only, scoped to
 * the team the audit/team belongs to.
 */
feedbackRouter.get("/", requireRole("admin", "super_admin"), async (req, res) => {
  const auditId = (req.query.audit as string) || "";
  const team = (req.query.team as string) || "";

  if (auditId) {
    const audit = await getAudit(auditId);
    if (!audit) return res.status(404).json({ message: "Audit not found." });
    if (!canEditRubric(req.user!, audit.team ?? "")) return res.status(403).json({ message: "Out of scope." });
    return res.json(await listFeedbackByAudit(auditId));
  }
  if (team) {
    if (!canEditRubric(req.user!, team)) return res.status(403).json({ message: "Out of scope." });
    return res.json(await listFeedbackByTeam(team));
  }
  res.status(400).json({ message: "Provide an `audit` or `team` query param." });
});

/**
 * POST /api/feedback — a reviewer's correction of an AI audit. The AI verdict is
 * snapshotted from the audit (per-rubric when the audit has a breakdown) so the
 * divergence signal survives a later re-audit.
 */
feedbackRouter.post("/", requireRole("admin", "super_admin"), async (req, res) => {
  const b = req.body as Partial<Feedback>;
  const auditId = (b.audit_id ?? "").trim();
  if (!auditId) return res.status(400).json({ message: "audit_id is required." });

  const audit = await getAudit(auditId);
  if (!audit) return res.status(404).json({ message: "Audit not found." });
  const team = audit.team;
  if (!team) return res.status(400).json({ message: "This audit has no team; cannot attach feedback." });
  if (!canEditRubric(req.user!, team)) return res.status(403).json({ message: "You can only review your own team's calls." });

  const disposition = (b.disposition ?? "disagree") as FeedbackDisposition;
  if (!DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ message: `disposition must be one of ${DISPOSITIONS.join(", ")}.` });
  }
  if (!b.comment?.trim() && disposition !== "agree") {
    return res.status(400).json({ message: "A comment is required unless you fully agree with the AI." });
  }

  // Snapshot the AI verdict for the rubric being reviewed.
  const rubricId = (b.rubric_id ?? "primary").trim() || "primary";
  const matched = (audit.rubric_results ?? []).find((r) => r.rubric_id === rubricId);
  const ai_score = matched?.score ?? audit.score ?? 0;
  const ai_flagged = matched?.flagged ?? audit.flagged ?? false;
  const rubric_name = matched?.rubric_name ?? "Primary rubric";

  const corrections: FeedbackCriterionCorrection[] | undefined = Array.isArray(b.criteria_corrections)
    ? b.criteria_corrections.map((c) => ({
        name: String(c.name ?? "").slice(0, 120),
        ai_score: Number(c.ai_score ?? 0),
        human_score: Number(c.human_score ?? 0),
        note: c.note ? String(c.note).slice(0, 600) : undefined,
      }))
    : undefined;

  const now = new Date().toISOString();
  const feedback: Feedback = {
    feedback_id: newFeedbackId(),
    audit_id: auditId,
    team,
    agent_id: audit.agent_id,
    rubric_id: rubricId,
    rubric_name,
    reviewer_id: req.user!.user_id,
    reviewer_email: req.user!.email,
    disposition,
    ai_score,
    ai_flagged,
    human_score: b.human_score !== undefined ? Number(b.human_score) : undefined,
    human_flagged: b.human_flagged !== undefined ? Boolean(b.human_flagged) : undefined,
    criteria_corrections: corrections,
    comment: (b.comment ?? "").slice(0, 2000),
    created_at: now,
    updated_at: now,
  };
  await putFeedback(feedback);
  logger.info(`Feedback ${feedback.feedback_id} on audit ${auditId} (${disposition}) by ${req.user!.email}`);
  res.status(201).json(feedback);
});

/** DELETE /api/feedback/:id — author or super_admin. */
feedbackRouter.delete("/:id", requireRole("admin", "super_admin"), async (req, res) => {
  const existing = await getFeedback(req.params.id);
  if (!existing) return res.status(404).json({ message: "Feedback not found." });
  const isAuthor = existing.reviewer_id === req.user!.user_id;
  if (!isAuthor && req.user!.role !== "super_admin") {
    return res.status(403).json({ message: "Only the author or a super_admin can delete this feedback." });
  }
  await deleteFeedback(existing.feedback_id);
  res.json({ ok: true });
});
