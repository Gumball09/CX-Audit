import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { getSettings, putSettings } from "../db/settings.js";

export const settingsRouter = Router();

/** A model id must be a non-empty, reasonably short token (no whitespace). */
function validModel(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= 100 && !/\s/.test(v.trim());
}

/** GET /api/settings — current platform settings (any admin can view). */
settingsRouter.get("/", requireRole("admin", "super_admin"), async (_req, res) => {
  res.json(await getSettings());
});

/**
 * PATCH /api/settings  { transcription_model?, audit_model? }
 * Change the OpenAI models used by the pipeline (super_admin only). Takes effect
 * within ~60s as the workers' settings cache refreshes.
 */
settingsRouter.patch("/", requireRole("super_admin"), async (req, res) => {
  const { transcription_model, audit_model } = req.body as {
    transcription_model?: string;
    audit_model?: string;
  };

  if (transcription_model !== undefined && !validModel(transcription_model)) {
    return res.status(400).json({ message: "transcription_model must be a non-empty model id with no spaces." });
  }
  if (audit_model !== undefined && !validModel(audit_model)) {
    return res.status(400).json({ message: "audit_model must be a non-empty model id with no spaces." });
  }
  if (transcription_model === undefined && audit_model === undefined) {
    return res.status(400).json({ message: "Provide transcription_model and/or audit_model." });
  }

  const updated = await putSettings(
    {
      transcription_model: transcription_model?.trim(),
      audit_model: audit_model?.trim(),
    },
    req.user!.user_id
  );
  logger.info(
    `Platform models updated by ${req.user!.email}: transcription=${updated.transcription_model} audit=${updated.audit_model}`
  );
  res.json(updated);
});
