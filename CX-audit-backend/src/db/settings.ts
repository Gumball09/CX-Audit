import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import type { PlatformSettings } from "../types.js";

const TABLE = env.DDB_SETTINGS_TABLE;
const SINGLETON = "global";
const CACHE_TTL_MS = 60_000; // read on the pipeline hot path — cache it

export interface ModelSettings {
  transcription_model: string;
  audit_model: string;
}

/** Read the settings row, filling any missing value from the env fallback. */
export async function getSettings(): Promise<PlatformSettings> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { setting_id: SINGLETON } }));
  const item = res.Item as PlatformSettings | undefined;
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
 * env defaults if the settings table is unavailable, so the pipeline keeps
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
  const updated: PlatformSettings = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    setting_id: SINGLETON,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
  invalidateSettingsCache();
  return updated;
}
