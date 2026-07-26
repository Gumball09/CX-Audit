/**
 * One-shot provisioning for local/dev: creates the six DynamoDB tables and
 * the two SQS queues (each with a dead-letter queue). Idempotent — re-running
 * skips anything that already exists.
 *
 *   npm run infra:create
 *
 * NOTE: this does NOT wire the S3 -> SQS event notification. That is configured
 * on the bucket itself (see docs/SQS_SETUP.md, "Connect S3 to the queue").
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
  type CreateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { env } from "../src/env.js";

const region = env.AWS_REGION;
const credentials =
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
    : undefined;

const ddb = new DynamoDBClient({ region, credentials });
const sqs = new SQSClient({ region, credentials });

const PAY = "PAY_PER_REQUEST" as const;
const S = "S" as const;

const tables: CreateTableCommandInput[] = [
  {
    TableName: env.DDB_USERS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "user_id", AttributeType: S },
      { AttributeName: "email", AttributeType: S },
      { AttributeName: "agent_id", AttributeType: S },
    ],
    KeySchema: [{ AttributeName: "user_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "email-index",
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "agent-index",
        KeySchema: [{ AttributeName: "agent_id", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  {
    TableName: env.DDB_TEAMS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [{ AttributeName: "team_id", AttributeType: S }],
    KeySchema: [{ AttributeName: "team_id", KeyType: "HASH" }],
  },
  {
    TableName: env.DDB_AUDITS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "audit_id", AttributeType: S },
      { AttributeName: "agent_id", AttributeType: S },
      { AttributeName: "team", AttributeType: S },
      { AttributeName: "call_datetime", AttributeType: S },
    ],
    KeySchema: [{ AttributeName: "audit_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "agent-index",
        KeySchema: [
          { AttributeName: "agent_id", KeyType: "HASH" },
          { AttributeName: "call_datetime", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "team-index",
        KeySchema: [
          { AttributeName: "team", KeyType: "HASH" },
          { AttributeName: "call_datetime", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  {
    // Super-admin-configurable recording-filename regex patterns.
    TableName: env.DDB_PATTERNS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [{ AttributeName: "pattern_id", AttributeType: S }],
    KeySchema: [{ AttributeName: "pattern_id", KeyType: "HASH" }],
  },
  {
    // Time-bucketed performance aggregates: pk=`agent#..|team#..`, sk=`day#..` etc.
    TableName: env.DDB_PERFORMANCE_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: S },
      { AttributeName: "bucket", AttributeType: S },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "bucket", KeyType: "RANGE" },
    ],
  },
  {
    // Singleton platform settings (e.g. the OpenAI models chosen at runtime).
    TableName: env.DDB_SETTINGS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [{ AttributeName: "setting_id", AttributeType: S }],
    KeySchema: [{ AttributeName: "setting_id", KeyType: "HASH" }],
  },
  {
    // Additional per-team rubrics (team-index GSI to list by team).
    TableName: env.DDB_RUBRICS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "rubric_id", AttributeType: S },
      { AttributeName: "team_id", AttributeType: S },
    ],
    KeySchema: [{ AttributeName: "rubric_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "team-index",
        KeySchema: [{ AttributeName: "team_id", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  {
    // Human feedback on AI audits. audit-index lists feedback for a call;
    // team-index (sorted by created_at) lists a team's feedback for analysis.
    TableName: env.DDB_FEEDBACK_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "feedback_id", AttributeType: S },
      { AttributeName: "audit_id", AttributeType: S },
      { AttributeName: "team", AttributeType: S },
      { AttributeName: "created_at", AttributeType: S },
    ],
    KeySchema: [{ AttributeName: "feedback_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "audit-index",
        KeySchema: [{ AttributeName: "audit_id", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "team-index",
        KeySchema: [
          { AttributeName: "team", KeyType: "HASH" },
          { AttributeName: "created_at", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  {
    // LLM-generated rubric-improvement suggestions (team-index, newest first).
    TableName: env.DDB_SUGGESTIONS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "suggestion_id", AttributeType: S },
      { AttributeName: "team", AttributeType: S },
      { AttributeName: "created_at", AttributeType: S },
    ],
    KeySchema: [{ AttributeName: "suggestion_id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "team-index",
        KeySchema: [
          { AttributeName: "team", KeyType: "HASH" },
          { AttributeName: "created_at", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  },
  {
    // Per-role daily/monthly sign-in counters: pk=`role#<scope>`, bucket=
    // `<granularity>#<period>` (e.g. role#admin / day#2026-06-24). Mirrors the
    // performance table; each row holds login_count + a distinct-user set.
    TableName: env.DDB_LOGIN_STATS_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: S },
      { AttributeName: "bucket", AttributeType: S },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "bucket", KeyType: "RANGE" },
    ],
  },
  {
    // Per-agent, per-day audit slot counters backing the team `daily_audit_cap`.
    // Key is `<agent_id>#<YYYY-MM-DD>`; slots are claimed with a conditional
    // write so concurrent workers can't overshoot the cap. Rows self-expire via
    // the `expires_at` TTL a week after the call's date.
    TableName: env.DDB_QUOTA_TABLE,
    BillingMode: PAY,
    AttributeDefinitions: [{ AttributeName: "quota_id", AttributeType: S }],
    KeySchema: [{ AttributeName: "quota_id", KeyType: "HASH" }],
  },
];

/** Tables whose rows self-expire, mapped to their TTL attribute. */
const ttlAttributes: Record<string, string> = {
  [env.DDB_QUOTA_TABLE]: "expires_at",
};

async function createTables() {
  for (const table of tables) {
    try {
      await ddb.send(new CreateTableCommand(table));
      console.log(`✓ created table ${table.TableName}`);
    } catch (err: any) {
      if (err.name === "ResourceInUseException") console.log(`• table ${table.TableName} already exists`);
      else throw err;
    }
  }
  await enableTtls();
}

/** Turn on TTL for tables that self-expire. Idempotent and safe to re-run. */
async function enableTtls() {
  for (const [tableName, attributeName] of Object.entries(ttlAttributes)) {
    try {
      const current = await ddb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
      const status = current.TimeToLiveDescription?.TimeToLiveStatus;
      if (status === "ENABLED" || status === "ENABLING") {
        console.log(`• TTL already enabled on ${tableName}`);
        continue;
      }
      await ddb.send(
        new UpdateTimeToLiveCommand({
          TableName: tableName,
          TimeToLiveSpecification: { Enabled: true, AttributeName: attributeName },
        })
      );
      console.log(`✓ enabled TTL on ${tableName} (${attributeName})`);
    } catch (err: any) {
      // A brand-new table can still be CREATING; TTL can be enabled later.
      console.log(`! could not enable TTL on ${tableName}: ${err.name ?? err.message}. Re-run once the table is ACTIVE.`);
    }
  }
}

/**
 * Returns the queue URL and whether we just created it. The flag matters: an
 * existing queue's attributes are left alone (see `createQueues`).
 */
async function ensureQueue(name: string): Promise<{ url: string; created: boolean }> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (QueueUrl) {
      console.log(`• queue ${name} already exists`);
      return { url: QueueUrl, created: false };
    }
  } catch {
    /* not found — create below */
  }
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  console.log(`✓ created queue ${name}`);
  return { url: QueueUrl!, created: true };
}

async function queueArn(url: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] })
  );
  return Attributes!.QueueArn!;
}

async function createQueues() {
  for (const base of ["cx-transcription-queue", "cx-audit-queue"]) {
    const dlq = await ensureQueue(`${base}-dlq`);
    const dlqArn = await queueArn(dlq.url);
    const main = await ensureQueue(base);

    // Only stamp attributes onto a queue we just created. Re-running this script
    // used to overwrite them unconditionally, which silently reverted tuning
    // done in the live environment — prod's transcription queue had been raised
    // to VisibilityTimeout 900 for long recordings, and a re-run would have
    // knocked it back to 300 with no warning.
    if (main.created) {
      await sqs.send(
        new SetQueueAttributesCommand({
          QueueUrl: main.url,
          Attributes: {
            VisibilityTimeout: "900", // long enough for a slow transcription
            RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT }),
          },
        })
      );
    } else {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: main.url, AttributeNames: ["VisibilityTimeout", "RedrivePolicy"] })
      );
      console.log(
        `  • left ${base} attributes untouched (VisibilityTimeout=${Attributes?.VisibilityTimeout}` +
          `${Attributes?.RedrivePolicy ? "" : ", NO redrive policy — set one manually"})`
      );
    }
    console.log(`  → ${base} URL: ${main.url}`);
  }
}

async function main() {
  console.log(`Provisioning CX Audit infra in ${region}...\n`);
  await createTables();
  console.log("");
  await createQueues();
  console.log("\nDone. Copy the printed queue URLs into .env.local, then run `npm run seed`.");
}

main().catch((err) => {
  console.error("Infra provisioning failed:", err);
  process.exit(1);
});
