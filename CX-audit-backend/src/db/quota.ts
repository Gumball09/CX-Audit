import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../lib/aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Per-agent daily audit quota.
 *
 * The team's `daily_audit_cap` limits how many of an agent's calls are audited
 * on any one day. Counting rows and then acting on the count is not safe here:
 * with WORKER_CONCURRENCY across several transcribe tasks, dozens of messages
 * for the same agent can read the same count and all pass. At a cap of 3 that
 * overshoot is a large fraction of the budget.
 *
 * So a slot is *claimed* with a single conditional write instead. DynamoDB
 * evaluates the condition and the increment atomically, so concurrent claims
 * serialize and only `cap` of them can ever succeed.
 *
 * Claims are keyed on `audit_id` as well as counted, which makes a redelivered
 * SQS message reuse the slot it already holds rather than consume a second one.
 */

const TABLE = env.DDB_QUOTA_TABLE;
const RETENTION_DAYS = 7;
/** Bounded retries for the "raced, but still under cap" case. */
const MAX_ATTEMPTS = 3;

export interface SlotResult {
  /** True when this audit may proceed (freshly claimed, or already held). */
  granted: boolean;
  /** Slots used for this agent/day, for logging. */
  used: number;
}

interface QuotaItem {
  quota_id: string;
  used?: number;
  audit_ids?: Set<string>;
  expires_at?: number;
}

const quotaId = (agentId: string, day: string) => `${agentId}#${day}`;

/** Epoch seconds at which the counter may be reaped (DynamoDB TTL). */
function expiryFor(day: string): number {
  const base = Date.parse(`${day}T00:00:00.000Z`);
  const from = Number.isNaN(base) ? Date.now() : base;
  return Math.floor(from / 1000) + RETENTION_DAYS * 24 * 60 * 60;
}

async function readQuota(agentId: string, day: string): Promise<QuotaItem | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { quota_id: quotaId(agentId, day) }, ConsistentRead: true })
  );
  return res.Item as QuotaItem | undefined;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

/**
 * Claim one of `cap` daily slots for `agentId` on `day`.
 *
 * Returns `granted: false` only when the cap is genuinely reached. Re-claiming
 * with an `auditId` that already holds a slot returns `granted: true` without
 * consuming another — so SQS redelivery of the same recording is free.
 *
 * Callers MUST release the slot (see `releaseDailySlot`) if the work the slot
 * was claimed for does not complete, or a permanently failing recording will
 * hold one of the agent's slots for the rest of the day.
 */
export async function reserveDailySlot(
  agentId: string,
  day: string,
  cap: number,
  auditId: string
): Promise<SlotResult> {
  if (cap <= 0) return { granted: true, used: 0 }; // 0/unset = unlimited

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { quota_id: quotaId(agentId, day) },
          // ADD creates-or-increments the counter and unions the id into the set.
          UpdateExpression: "ADD #used :one, audit_ids :thisId SET expires_at = :exp",
          // Claim only while under cap, and only if this audit does not already
          // hold a slot (that case is handled as an idempotent replay below).
          ConditionExpression:
            "(attribute_not_exists(#used) OR #used < :cap) AND " +
            "(attribute_not_exists(audit_ids) OR NOT contains(audit_ids, :auditId))",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":cap": cap,
            ":thisId": new Set([auditId]),
            ":auditId": auditId,
            ":exp": expiryFor(day),
          },
          ReturnValues: "UPDATED_NEW",
        })
      );
      return { granted: true, used: Number(res.Attributes?.used ?? 1) };
    } catch (err) {
      if (!isConditionFailure(err)) throw err;

      // The condition can fail for two very different reasons — tell them apart.
      const current = await readQuota(agentId, day);
      const used = current?.used ?? 0;

      if (current?.audit_ids?.has(auditId)) {
        // This recording already holds a slot: a redelivery, not a new call.
        return { granted: true, used };
      }
      if (used >= cap) return { granted: false, used };

      // Raced with another claim but still under cap — try again.
      logger.debug(`Quota claim raced for ${agentId} on ${day} (${used}/${cap}); retry ${attempt}/${MAX_ATTEMPTS}`);
    }
  }

  // Contention never settled. Fail closed: skipping a call that was probably
  // under cap is cheaper and more predictable than overshooting the budget.
  logger.warn(`Quota claim for ${agentId} on ${day} did not settle in ${MAX_ATTEMPTS} attempts; treating as capped`);
  return { granted: false, used: cap };
}

/**
 * Return a previously claimed slot. Safe to call when no slot is held (the
 * condition simply fails and we move on), so it can be used unconditionally on
 * the failure path.
 */
export async function releaseDailySlot(agentId: string, day: string, auditId: string): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { quota_id: quotaId(agentId, day) },
        UpdateExpression: "ADD #used :minusOne DELETE audit_ids :thisId",
        ConditionExpression: "contains(audit_ids, :auditId) AND #used > :zero",
        ExpressionAttributeNames: { "#used": "used" },
        ExpressionAttributeValues: {
          ":minusOne": -1,
          ":zero": 0,
          ":thisId": new Set([auditId]),
          ":auditId": auditId,
        },
      })
    );
    logger.debug(`Released daily audit slot for ${agentId} on ${day} (${auditId})`);
  } catch (err) {
    if (isConditionFailure(err)) return; // nothing held — nothing to release
    // Never let bookkeeping mask the original failure the caller is handling.
    logger.warn(`Could not release daily audit slot for ${agentId} on ${day} (${auditId})`, err);
  }
}
