import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { sqs } from "./aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { reportError, reportCritical, classifyOpenAIError } from "./sentry.js";

/** Send a JSON message to a queue. */
export async function sendMessage(queueUrl: string, body: unknown): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) })
  );
}

/** Long-poll a queue for up to `max` messages. */
export async function receiveMessages(queueUrl: string, max = env.SQS_BATCH_SIZE): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
      WaitTimeSeconds: Math.min(Math.max(env.SQS_WAIT_TIME_SECONDS, 0), 20),
      // Needed to know when a message is on its final attempt before the DLQ.
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    })
  );
  return res.Messages ?? [];
}

/** Remove a successfully processed message so it is not redelivered. */
export async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

/**
 * Long-polling consumer with adaptive concurrency.
 *
 * Runs `WORKER_CONCURRENCY` independent worker loops against the queue. Each
 * loop long-polls for one message, processes it, deletes on success (or leaves
 * it for redelivery → DLQ on failure), and repeats. Concurrency is "adaptive"
 * in the sense that a loop only does work when a message is available — when the
 * queue is empty all loops sit on a cheap long-poll and CPU drops to ~0, then
 * ramps straight back up to `WORKER_CONCURRENCY` in-flight jobs the moment a
 * burst arrives. Scale a single worker process by raising WORKER_CONCURRENCY;
 * scale across machines by running more worker instances (see docs/backend/SCALING.md).
 */
export async function consume(
  queueUrl: string,
  label: string,
  handler: (body: any, raw: Message) => Promise<void>
): Promise<void> {
  if (!queueUrl) throw new Error(`${label} queue URL is not configured`);

  const concurrency = Math.max(1, env.WORKER_CONCURRENCY);
  let running = true;
  const stop = () => {
    if (!running) return;
    logger.info(`[${label}] shutdown signal received, draining in-flight work...`);
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  logger.info(`[${label}] consumer started, polling ${queueUrl} (concurrency=${concurrency})`);

  async function processOne(msg: Message): Promise<void> {
    try {
      const body = msg.Body ? JSON.parse(msg.Body) : {};
      await handler(body, msg);
      if (msg.ReceiptHandle) await deleteMessage(queueUrl, msg.ReceiptHandle);
    } catch (err) {
      logger.error(`[${label}] message processing failed (will retry / DLQ)`, err);
      // Intentionally not deleting => SQS redelivers, then routes to DLQ.

      const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
      const quotaReason = classifyOpenAIError(err);
      const extra = { receiveCount, queue: label, body: msg.Body?.slice(0, 500) };

      if (quotaReason) {
        // Credits/auth — a human must act; report immediately, every time.
        reportCritical(`[${label}] ${quotaReason}`, { where: `${label} worker`, extra });
      } else if (receiveCount >= env.SQS_MAX_RECEIVE_COUNT) {
        // Final attempt failed — this message is about to land in the DLQ.
        reportCritical(`[${label}] message exhausted retries → DLQ`, {
          where: `${label} worker`,
          severity: "error",
          extra,
        });
      } else {
        // Transient failure that SQS will retry — track but don't page.
        reportError(err, { where: `${label} worker`, severity: "warning", extra });
      }
    }
  }

  async function workerLoop(slot: number): Promise<void> {
    while (running) {
      let messages: Message[] = [];
      try {
        messages = await receiveMessages(queueUrl, 1); // one in-flight per slot
      } catch (err) {
        logger.error(`[${label}#${slot}] receive failed, backing off 5s`, err);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const msg of messages) await processOne(msg);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => workerLoop(i)));
  logger.info(`[${label}] consumer stopped`);
  process.exit(0);
}
