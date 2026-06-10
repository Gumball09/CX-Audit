import * as Sentry from "@sentry/node";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Centralized error/alert reporting via Sentry.
 *
 * This is the single sink for "the system is not working properly" signals —
 * worker crashes, pipeline failures that exhaust SQS retries (DLQ-bound), and
 * — most urgently — OpenAI credit/quota exhaustion or auth failures. Sentry's
 * own alert rules route these to email/Slack/PagerDuty so a human is told.
 *
 * Stub-safe: if SENTRY_DSN is unset (local dev, stub mode) every function here
 * is a no-op, so nothing breaks and no events are sent.
 */

let initialized = false;

export function initSentry(context: "api" | "transcribe" | "audit"): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) {
    logger.debug("SENTRY_DSN not set — error reporting disabled");
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // Tag every event with which process it came from so alert rules can route
    // e.g. transcribe vs audit vs api differently.
    initialScope: { tags: { service: context } },
  });
  initialized = true;
  logger.info(`Sentry initialized (service=${context}, env=${env.SENTRY_ENVIRONMENT || env.NODE_ENV})`);
}

export type AlertSeverity = "warning" | "error" | "fatal";

/** Report a handled exception with optional structured context. */
export function reportError(
  err: unknown,
  ctx: { where: string; severity?: AlertSeverity; extra?: Record<string, unknown> } = { where: "unknown" }
): void {
  const severity = ctx.severity ?? "error";
  if (!initialized) return;
  Sentry.withScope((scope) => {
    scope.setLevel(severity);
    scope.setTag("where", ctx.where);
    if (ctx.extra) scope.setContext("detail", ctx.extra);
    Sentry.captureException(err);
  });
}

/**
 * Report an urgent operational message (not necessarily tied to a thrown
 * Error) — e.g. "OpenAI quota exhausted", "message routed to DLQ". Defaults to
 * `fatal` so it surfaces at the top of Sentry alerting.
 */
export function reportCritical(
  message: string,
  ctx: { where: string; severity?: AlertSeverity; extra?: Record<string, unknown> } = { where: "unknown" }
): void {
  logger.error(`[ALERT] ${message}`, ctx.extra);
  if (!initialized) return;
  Sentry.withScope((scope) => {
    scope.setLevel(ctx.severity ?? "fatal");
    scope.setTag("where", ctx.where);
    scope.setTag("alert", "true");
    if (ctx.extra) scope.setContext("detail", ctx.extra);
    Sentry.captureMessage(message);
  });
}

/**
 * Classify an OpenAI/SDK error. Returns a non-null reason when the error is a
 * *critical, human-must-act* condition — exhausted credits, invalid/expired
 * key, or revoked access — as opposed to a transient blip the SDK already
 * retried. Used to escalate quota/auth failures to `fatal` in Sentry.
 */
export function classifyOpenAIError(err: unknown): string | null {
  const e = err as { status?: number; code?: string; type?: string; error?: { code?: string; type?: string } };
  const status = e?.status;
  const code = e?.code ?? e?.error?.code;
  const type = e?.type ?? e?.error?.type;

  if (code === "insufficient_quota" || type === "insufficient_quota") {
    return "OpenAI credits/quota exhausted (insufficient_quota)";
  }
  if (status === 401 || code === "invalid_api_key") {
    return "OpenAI authentication failed — API key invalid or revoked (401)";
  }
  if (status === 403) {
    return "OpenAI access forbidden — key lacks permission or is disabled (403)";
  }
  // 429 without insufficient_quota is ordinary rate limiting; the SDK retries it.
  return null;
}

/** Flush buffered events before the process exits (best-effort, bounded). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* best-effort */
  }
}
