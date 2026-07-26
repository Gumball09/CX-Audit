import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { DEFAULT_PROVIDER, defaultModels, isProvider, type AiProvider } from "../services/ai/index.js";
import type { PlatformSettings } from "../types.js";

const TABLE = env.DDB_SETTINGS_TABLE;
const SINGLETON = "global";
const CACHE_TTL_MS = 60_000; // read on the pipeline hot path — cache it

export interface ModelSettings {
  ai_provider: AiProvider;
  transcription_model: string;
  audit_model: string;
  min_audit_duration_sec: number;
}

/**
 * Resolve a stored settings row into effective settings.
 *
 * Pure and exported so the migration rule below can be tested directly — it is
 * the kind of thing that is easy to get wrong once and then never notice.
 *
 * The model fallbacks are provider-scoped, because model ids are not portable
 * between providers. The subtle case is a row written **before** `ai_provider`
 * existed: it holds OpenAI model ids and says nothing about the provider, so
 * resolving the provider to the Sarvam default while keeping `gpt-4o` would send
 * an OpenAI model name to api.sarvam.ai and fail every audit. A row with no
 * `ai_provider` is therefore treated as OpenAI-era: its model ids are honoured
 * only if the effective provider is still OpenAI, and otherwise discarded in
 * favour of the active provider's defaults.
 */
export function resolveSettings(
  item: Partial<PlatformSettings> | undefined,
  defaultProvider: AiProvider = DEFAULT_PROVIDER
): PlatformSettings {
  const declared = isProvider(item?.ai_provider);
  const provider = declared ? (item!.ai_provider as AiProvider) : defaultProvider;
  const fallback = defaultModels(provider);
  // Stored model ids are only trustworthy if we know which provider they were
  // written for — either the row says so, or the provider hasn't changed since.
  const trustStored = declared || provider === "openai";
  return {
    setting_id: SINGLETON,
    ai_provider: provider,
    transcription_model: (trustStored && item?.transcription_model) || fallback.transcription,
    audit_model: (trustStored && item?.audit_model) || fallback.audit,
    min_audit_duration_sec:
      item?.min_audit_duration_sec != null ? item.min_audit_duration_sec : env.MIN_CALL_DURATION_SECONDS,
    updated_at: item?.updated_at ?? "",
    updated_by: item?.updated_by ?? null,
  };
}

/** Read the settings row, filling any missing value from the provider's defaults. */
export async function getSettings(): Promise<PlatformSettings> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { setting_id: SINGLETON } }));
  return resolveSettings(res.Item as PlatformSettings | undefined);
}

let cache: { at: number; val: ModelSettings } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/**
 * Resolve the active provider and its models, cached for CACHE_TTL_MS. Falls back
 * to the env defaults if the settings table is unavailable, so the pipeline keeps
 * working even before any settings row exists.
 *
 * A provider change therefore takes up to CACHE_TTL_MS to reach a running worker.
 * That is intentional: this is read once per recording, and hammering DynamoDB on
 * the hot path to make the toggle instant is not a trade worth making.
 */
export async function getModelSettingsCached(): Promise<ModelSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.val;
  const fallback = defaultModels(DEFAULT_PROVIDER);
  let val: ModelSettings = {
    ai_provider: DEFAULT_PROVIDER,
    transcription_model: fallback.transcription,
    audit_model: fallback.audit,
    min_audit_duration_sec: env.MIN_CALL_DURATION_SECONDS,
  };
  try {
    const s = await getSettings();
    val = {
      ai_provider: isProvider(s.ai_provider) ? s.ai_provider : DEFAULT_PROVIDER,
      transcription_model: s.transcription_model,
      audit_model: s.audit_model,
      min_audit_duration_sec: s.min_audit_duration_sec ?? env.MIN_CALL_DURATION_SECONDS,
    };
  } catch (err) {
    logger.warn("Could not load platform settings; using env defaults", err);
  }
  cache = { at: Date.now(), val };
  return val;
}

/**
 * Persist a settings patch (super_admin). Returns the merged settings row.
 *
 * Switching provider resets both model ids to the new provider's defaults unless
 * the same request supplies them explicitly. Model ids are provider-specific, so
 * carrying the old pair across would leave the pipeline calling one provider with
 * the other's model names — an error on every single call.
 */
export async function putSettings(
  patch: Partial<
    Pick<PlatformSettings, "ai_provider" | "transcription_model" | "audit_model" | "min_audit_duration_sec">
  >,
  updatedBy: string | null
): Promise<PlatformSettings> {
  const current = await getSettings();
  const switching = patch.ai_provider !== undefined && patch.ai_provider !== current.ai_provider;
  const resetModels = switching ? defaultModels(patch.ai_provider as AiProvider) : null;

  const updated: PlatformSettings = {
    ...current,
    ...(resetModels
      ? { transcription_model: resetModels.transcription, audit_model: resetModels.audit }
      : {}),
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    setting_id: SINGLETON,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: updated }));
  invalidateSettingsCache();
  if (switching) {
    logger.warn(
      `AI provider switched ${current.ai_provider} -> ${updated.ai_provider} by ${updatedBy ?? "unknown"}; ` +
        `models now transcription=${updated.transcription_model} audit=${updated.audit_model}`
    );
  }
  return updated;
}
