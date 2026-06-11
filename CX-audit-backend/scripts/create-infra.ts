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
];

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
}

async function ensureQueue(name: string): Promise<string> {
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (QueueUrl) {
      console.log(`• queue ${name} already exists`);
      return QueueUrl;
    }
  } catch {
    /* not found — create below */
  }
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name }));
  console.log(`✓ created queue ${name}`);
  return QueueUrl!;
}

async function queueArn(url: string): Promise<string> {
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["QueueArn"] })
  );
  return Attributes!.QueueArn!;
}

async function createQueues() {
  for (const base of ["cx-transcription-queue", "cx-audit-queue"]) {
    const dlqUrl = await ensureQueue(`${base}-dlq`);
    const dlqArn = await queueArn(dlqUrl);
    const mainUrl = await ensureQueue(base);
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: mainUrl,
        Attributes: {
          VisibilityTimeout: "300", // 5 min — long enough for a Whisper/GPT call
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT }),
        },
      })
    );
    console.log(`  → ${base} URL: ${mainUrl}`);
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
