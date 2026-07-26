import { Router } from "express";
import { logger } from "../logger.js";
import { requireRole } from "../services/auth.js";
import { getSettings, putSettings } from "../db/settings.js";
import { PROVIDERS, isProvider, isStubMode, defaultModels } from "../services/ai/index.js";

export const settingsRouter = Router();

/** A model id must be a non-empty, reasonably short token (no whitespace). */
function validModel(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= 100 && !/\s/.test(v.trim());
}

/**
 * Which providers this deployment could actually run, so the dashboard can
 * disable an unusable option instead of letting someone select it and silently
 * get stub audits.
 *
 * Caveat worth knowing: the API and the workers are separate ECS services, so
 * this reports whether the *API* has each key. They are configured from the same
 * secrets, so in practice it matches — but it is a report, not a guarantee.
 */
function providerAvailability() {
  return PROVIDERS.map((id) => ({
    id,
    configured: !isStubMode(id),
    default_models: defaultModels(id),
  }));
}

/** GET /api/settings — current platform settings (any admin can view). */
settingsRouter.get("/", requireRole("admin", "super_admin"), async (_req, res) => {
  const settings = await getSettings();
  res.json({ ...settings, providers: providerAvailability() });
});

/**
 * PATCH /api/settings  { ai_provider?, transcription_model?, audit_model?, min_audit_duration_sec? }
 * Change the provider and models used by the pipeline (super_admin only). Takes
 * effect within ~60s as the workers' settings cache refreshes.
 */
settingsRouter.patch("/", requireRole("super_admin"), async (req, res) => {
  const { ai_provider, transcription_model, audit_model, min_audit_duration_sec } = req.body as {
    ai_provider?: string;
    transcription_model?: string;
    audit_model?: string;
    min_audit_duration_sec?: number;
  };

  if (ai_provider !== undefined) {
    if (!isProvider(ai_provider)) {
      return res
        .status(400)
        .json({ message: `ai_provider must be one of: ${PROVIDERS.join(", ")}.` });
    }
    // Refuse rather than accept-and-degrade. A provider with no key runs in stub
    // mode, which writes plausible-looking fake scores to real audit rows — the
    // worst possible failure for this switch, and a silent one.
    if (isStubMode(ai_provider)) {
      return res.status(400).json({
        message:
          `Cannot switch to ${ai_provider}: no API key is configured for it, so it would ` +
          `produce stub audits. Set the key on the API and worker services first.`,
      });
    }
  }
  if (transcription_model !== undefined && !validModel(transcription_model)) {
    return res.status(400).json({ message: "transcription_model must be a non-empty model id with no spaces." });
  }
  if (audit_model !== undefined && !validModel(audit_model)) {
    return res.status(400).json({ message: "audit_model must be a non-empty model id with no spaces." });
  }
  if (
    min_audit_duration_sec !== undefined &&
    (!Number.isFinite(min_audit_duration_sec) || min_audit_duration_sec < 0 || min_audit_duration_sec > 86400)
  ) {
    return res.status(400).json({ message: "min_audit_duration_sec must be a number between 0 and 86400 seconds." });
  }
  if (
    ai_provider === undefined &&
    transcription_model === undefined &&
    audit_model === undefined &&
    min_audit_duration_sec === undefined
  ) {
    return res
      .status(400)
      .json({ message: "Provide ai_provider, transcription_model, audit_model, and/or min_audit_duration_sec." });
  }

  const updated = await putSettings(
    {
      ai_provider: ai_provider as "sarvam" | "openai" | undefined,
      transcription_model: transcription_model?.trim(),
      audit_model: audit_model?.trim(),
      min_audit_duration_sec:
        min_audit_duration_sec !== undefined ? Math.round(min_audit_duration_sec) : undefined,
    },
    req.user!.user_id
  );
  logger.info(
    `Platform settings updated by ${req.user!.email}: provider=${updated.ai_provider} ` +
      `transcription=${updated.transcription_model} audit=${updated.audit_model}`
  );
  res.json({ ...updated, providers: providerAvailability() });
});
