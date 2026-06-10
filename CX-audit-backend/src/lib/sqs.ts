import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { sqs } from "./aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/** Send a JSON message to a queue. */
export async function sendMessage(queueUrl: string, body: unknown): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) })
  );
}

/** Long-poll a queue for a batch of messages. */
export async function receiveMessages(queueUrl: string): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(env.SQS_BATCH_SIZE, 1), 10),
      WaitTimeSeconds: Math.min(Math.max(env.SQS_WAIT_TIME_SECONDS, 0), 20),
    })
  );
  return res.Messages ?? [];
}

/** Remove a successfully processed message so it is not redelivered. */
export async function deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

/**
 * Generic long-polling consumer loop. Calls `handler` for each message; on
 * success the message is deleted, on failure it is left to become visible
 * again (and ultimately routed to the DLQ after maxReceiveCount).
 */
export async function consume(
  queueUrl: string,
  label: string,
  handler: (body: any, raw: Message) => Promise<void>
): Promise<void> {
  if (!queueUrl) throw new Error(`${label} queue URL is not configured`);
  logger.info(`[${label}] consumer started, polling ${queueUrl}`);

  let running = true;
  const stop = () => {
    logger.info(`[${label}] shutdown signal received, draining...`);
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    let messages: Message[] = [];
    try {
      messages = await receiveMessages(queueUrl);
    } catch (err) {
      logger.error(`[${label}] receive failed, backing off 5s`, err);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const msg of messages) {
      try {
        const body = msg.Body ? JSON.parse(msg.Body) : {};
        await handler(body, msg);
        if (msg.ReceiptHandle) await deleteMessage(queueUrl, msg.ReceiptHandle);
      } catch (err) {
        logger.error(`[${label}] message processing failed (will retry / DLQ)`, err);
        // Intentionally not deleting => SQS redelivers, then routes to DLQ.
      }
    }
  }

  logger.info(`[${label}] consumer stopped`);
  process.exit(0);
}
