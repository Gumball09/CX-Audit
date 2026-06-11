import { validateEnv } from "../env.js";
import { logger } from "../logger.js";
import { initSentry, reportCritical, flushSentry } from "../lib/sentry.js";
import { consumeAcrossTeams } from "../lib/sqs.js";
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
  initSentry("audit");
  // Consume the global audit queue + every active team's own audit queue.
  // processAudit resolves the team's output bucket from the audit row itself.
  await consumeAcrossTeams("audit", "audit", async (body) => {
    const msg = body as AuditQueueMessage;
    if (!msg?.audit_id || !msg?.transcription_key) {
      logger.debug("Malformed audit message; ignoring", body);
      return;
    }
    await processAudit(msg);
  });
}

main().catch(async (err) => {
  logger.error("Audit worker crashed", err);
  reportCritical("Audit worker crashed (process exiting)", {
    where: "audit worker",
    extra: { message: err instanceof Error ? err.message : String(err) },
  });
  await flushSentry();
  process.exit(1);
});
