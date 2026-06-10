import { env, validateEnv } from "../env.js";
import { logger } from "../logger.js";
import { initSentry, reportCritical, flushSentry } from "../lib/sentry.js";
import { consume } from "../lib/sqs.js";
import { processTranscription } from "../services/pipeline.js";

/**
 * Transcription worker.
 *
 * Consumes the transcription queue. Messages arrive in one of two shapes:
 *   1. An S3 event notification (recording uploaded)  -> { Records: [{ s3: {...} }] }
 *   2. A manual backfill/reprocess message            -> { recording_key: "..." }
 *
 * For each recording key it runs pipeline stage 1 (download + Whisper + store +
 * enqueue for audit). Run with: `npm run worker:transcribe`.
 */

/** Extract recording keys from an SQS message body (handles both shapes). */
function extractKeys(body: any): string[] {
  if (body?.Event === "s3:TestEvent") return []; // S3 config test ping
  if (typeof body?.recording_key === "string") return [body.recording_key];
  if (Array.isArray(body?.Records)) {
    return body.Records
      .filter((r: any) => r?.s3?.object?.key)
      .map((r: any) => decodeURIComponent(String(r.s3.object.key).replace(/\+/g, " ")));
  }
  return [];
}

async function main() {
  validateEnv("worker");
  initSentry("transcribe");
  await consume(env.SQS_TRANSCRIPTION_QUEUE_URL, "transcribe", async (body) => {
    const keys = extractKeys(body);
    if (keys.length === 0) {
      logger.debug("No recording keys in message; ignoring");
      return;
    }
    for (const key of keys) {
      await processTranscription(key);
    }
  });
}

main().catch(async (err) => {
  logger.error("Transcription worker crashed", err);
  reportCritical("Transcription worker crashed (process exiting)", {
    where: "transcribe worker",
    extra: { message: err instanceof Error ? err.message : String(err) },
  });
  await flushSentry();
  process.exit(1);
});
