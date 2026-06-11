import { queryOne, execute } from "../lib/db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { PlatformSettings } from "../types.js";

const SINGLETON = "global";
const CACHE_TTL_MS = 60_000; // read on the pipeline hot path — cache it

export interface ModelSettings {
  transcription_model: string;
  audit_model: string;
}

/** Read the settings row, filling any missing value from the env fallback. */
export async function getSettings(): Promise<PlatformSettings> {
  const item = await queryOne<PlatformSettings>(
    "SELECT * FROM cx_settings WHERE setting_id = $1",
    [SINGLETON]
  );
  return {
    setting_id: SINGLETON,
    transcription_model: item?.transcription_model || env.OPENAI_TRANSCRIPTION_MODEL,
    audit_model: item?.audit_model || env.OPENAI_AUDIT_MODEL,
    updated_at: item?.updated_at ?? "",
    updated_by: item?.updated_by ?? null,
  };
}

let cache: { at: number; val: ModelSettings } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * Resolve the OpenAI models to use, cached for CACHE_TTL_MS. Falls back to the
 * env defaults if the settings row/table is unavailable, so the pipeline keeps
 * working even before any settings row exists.
 */
export async function getModelSettingsCached(): Promise<ModelSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.val;
  let val: ModelSettings = {
    transcription_model: env.OPENAI_TRANSCRIPTION_MODEL,
    audit_model: env.OPENAI_AUDIT_MODEL,
  };
  try {
    const s = await getSettings();
    val = { transcription_model: s.transcription_model, audit_model: s.audit_model };
  } catch (err) {
    logger.warn("Could not load platform settings; using env model defaults", err);
  }
  cache = { at: Date.now(), val };
  return val;
}

/** Persist a settings patch (super_admin). Returns the merged settings row. */
export async function putSettings(
  patch: Partial<Pick<PlatformSettings, "transcription_model" | "audit_model">>,
  updatedBy: string | null
): Promise<PlatformSettings> {
  const current = await getSettings();
  const merged: PlatformSettings = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    setting_id: SINGLETON,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  await execute(
    `INSERT INTO cx_settings (setting_id, transcription_model, audit_model, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (setting_id) DO UPDATE SET
       transcription_model = EXCLUDED.transcription_model,
       audit_model = EXCLUDED.audit_model,
       updated_at = EXCLUDED.updated_at,
       updated_by = EXCLUDED.updated_by`,
    [merged.setting_id, merged.transcription_model, merged.audit_model, merged.updated_at, merged.updated_by]
  );
  invalidateSettingsCache();
  return merged;
}
