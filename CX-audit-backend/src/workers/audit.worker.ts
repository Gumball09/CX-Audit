import { env, validateEnv } from "../env.js";
import { logger } from "../logger.js";
import { consume } from "../lib/sqs.js";
import { processAudit } from "../services/pipeline.js";
import type { AuditQueueMessage } from "../types.js";

/**
 * Audit worker.
 *
 * Consumes the audit queue (fed by the transcription worker). For each message
 * it runs pipeline stage 2 (load transcript + resolve team rubric + GPT audit +
 * store result). Run with: `npm run worker:audit`.
 */
async function main() {
  validateEnv("worker");
  await consume(env.SQS_AUDIT_QUEUE_URL, "audit", async (body) => {
    const msg = body as AuditQueueMessage;
    if (!msg?.audit_id || !msg?.transcription_key) {
      logger.debug("Malformed audit message; ignoring", body);
      return;
    }
    await processAudit(msg);
  });
}

main().catch((err) => {
  logger.error("Audit worker crashed", err);
  process.exit(1);
});
