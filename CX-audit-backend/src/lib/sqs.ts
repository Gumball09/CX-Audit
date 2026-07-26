import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { sqs } from "./aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { reportError, reportCritical, classifyOpenAIError } from "./sentry.js";
import { resolveQueueTargets } from "../services/teamInfra.js";

/** Send a JSON message to a queue. */
export async function sendMessage(queueUrl: string, body: unknown): Promise<void> {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body) })
  );
}

/** Long-poll a queue for up to `max` messages. */
export async function receiveMessages(
  queueUrl: string,
  max = env.SQS_BATCH_SIZE,
  waitTimeSeconds = env.SQS_WAIT_TIME_SECONDS
): Promise<Message[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
      WaitTimeSeconds: Math.min(Math.max(waitTimeSeconds, 0), 20),
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

/** Extends the in-flight message's visibility timeout by `seconds`. */
export type Heartbeat = (seconds: number) => Promise<void>;

/**
 * Push a message's invisibility further into the future.
 *
 * Needed because Sarvam transcription is an asynchronous batch job that can run
 * for minutes: without extending the visibility timeout, SQS redelivers the
 * message while the first worker is still waiting, and two workers end up
 * tracking the same job. Best-effort — a failure here just means the message may
 * be redelivered, which the pipeline handles idempotently via the stored job id.
 */
export async function extendVisibility(
  queueUrl: string,
  receiptHandle: string,
  seconds: number
): Promise<void> {
  try {
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(30, Math.min(43200, Math.round(seconds))),
      })
    );
  } catch (err) {
    logger.warn("Could not extend message visibility; a redelivery may occur", err);
  }
}

// ---- shared shutdown (registered once, even across many consumers) --------

let shuttingDown = false;
let shutdownRegistered = false;
function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[sqs] shutdown signal received, draining in-flight work...");
    setTimeout(() => process.exit(0), 2000); // brief drain, then exit
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export interface ConsumeOptions {
  concurrency?: number;
  waitTimeSeconds?: number;
  batchSize?: number;
  maxReceiveCount?: number;
}

/**
 * Long-polling consumer with adaptive concurrency for a single queue.
 * Runs `concurrency` independent loops; each long-polls one message, processes
 * it, deletes on success (or leaves it for redelivery → DLQ on failure). Idles
 * to ~0 CPU when the queue is empty. Tuning falls back to the global env.
 */
export async function consume(
  queueUrl: string,
  label: string,
  handler: (body: any, raw: Message, heartbeat?: Heartbeat) => Promise<void>,
  opts: ConsumeOptions = {}
): Promise<void> {
  if (!queueUrl) throw new Error(`${label} queue URL is not configured`);
  registerShutdown();

  const concurrency = Math.max(1, opts.concurrency ?? env.WORKER_CONCURRENCY);
  const waitTime = opts.waitTimeSeconds ?? env.SQS_WAIT_TIME_SECONDS;
  const maxReceive = opts.maxReceiveCount ?? env.SQS_MAX_RECEIVE_COUNT;

  logger.info(`[${label}] consumer started, polling ${queueUrl} (concurrency=${concurrency})`);

  async function processOne(msg: Message): Promise<void> {
    try {
      const body = msg.Body ? JSON.parse(msg.Body) : {};
      // Handlers that wait on long external work call this to stay owner of the
      // message. Bound to this queue and receipt handle so callers need neither.
      const heartbeat = msg.ReceiptHandle
        ? (seconds: number) => extendVisibility(queueUrl, msg.ReceiptHandle!, seconds)
        : undefined;
      await handler(body, msg, heartbeat);
      if (msg.ReceiptHandle) await deleteMessage(queueUrl, msg.ReceiptHandle);
    } catch (err) {
      logger.error(`[${label}] message processing failed (will retry / DLQ)`, err);
      const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? "1");
      const quotaReason = classifyOpenAIError(err);
      const extra = { receiveCount, queue: label, body: msg.Body?.slice(0, 500) };
      if (quotaReason) {
        reportCritical(`[${label}] ${quotaReason}`, { where: `${label} worker`, extra });
      } else if (receiveCount >= maxReceive) {
        reportCritical(`[${label}] message exhausted retries → DLQ`, { where: `${label} worker`, severity: "error", extra });
      } else {
        reportError(err, { where: `${label} worker`, severity: "warning", extra });
      }
    }
  }

  async function workerLoop(slot: number): Promise<void> {
    while (!shuttingDown) {
      let messages: Message[] = [];
      try {
        messages = await receiveMessages(queueUrl, 1, waitTime); // one in-flight per slot
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
}

/**
 * Multi-team consumer. Discovers the queues for `stage` (the global/default
 * queue + one per active team that set its own), starts a consumer per distinct
 * queue with that team's tuning, and re-checks every 60s so newly-onboarded
 * teams' queues get picked up without a restart. The `teamId` (null = global)
 * is passed to the handler so the pipeline can route to the right team infra.
 */
export async function consumeAcrossTeams(
  stage: "transcription" | "audit",
  baseLabel: string,
  handler: (body: any, raw: Message, teamId: string | null, heartbeat?: Heartbeat) => Promise<void>
): Promise<void> {
  registerShutdown();
  process.setMaxListeners(50); // many consumers share the signal handlers
  const started = new Set<string>();

  async function refresh(): Promise<void> {
    let targets;
    try {
      targets = await resolveQueueTargets(stage);
    } catch (err) {
      logger.warn(`[${baseLabel}] could not load team queues; will retry`, err);
      return;
    }
    for (const t of targets) {
      if (!t.queueUrl || started.has(t.queueUrl)) continue;
      started.add(t.queueUrl);
      const label = `${baseLabel}:${t.teamId ?? "global"}`;
      void consume(t.queueUrl, label, (body, raw, hb) => handler(body, raw, t.teamId, hb), {
        concurrency: t.tuning.worker_concurrency,
        waitTimeSeconds: t.tuning.wait_time_seconds,
        batchSize: t.tuning.batch_size,
        maxReceiveCount: t.tuning.max_receive_count,
      }).catch((err) => {
        started.delete(t.queueUrl); // allow a retry on next refresh
        logger.error(`[${label}] consumer crashed`, err);
      });
    }
  }

  await refresh();
  if (started.size === 0) throw new Error(`[${baseLabel}] no queues configured to consume`);
  setInterval(() => void refresh(), 60_000); // onboard new teams' queues live
  await new Promise<void>(() => {}); // keep the process alive
}
