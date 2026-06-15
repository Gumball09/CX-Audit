import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "../env.js";

/**
 * Shared AWS client instances. Credentials fall back to the default provider
 * chain (IAM role / shared config) when explicit keys are not supplied, which
 * is the recommended setup for ECS/EC2 deployments.
 */
const credentials =
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
    : undefined;

// maxAttempts enables the SDK's built-in exponential backoff for throttling and
// transient network errors.
const common = { region: env.AWS_REGION, credentials, maxAttempts: 4 };

// `followRegionRedirects` lets this single client read a bucket that lives in a
// different region than AWS_REGION (the recordings bucket is in us-east-1 while
// the app runs in us-west-2). Without it, GetObject returns a 301
// PermanentRedirect; with it, the SDK transparently retries against the bucket's
// real region. Harmless for same-region buckets (the output bucket).
export const s3 = new S3Client({ ...common, followRegionRedirects: true });
export const sqs = new SQSClient(common);

const ddbBase = new DynamoDBClient(common);
export const ddb = DynamoDBDocumentClient.from(ddbBase, {
  marshallOptions: { removeUndefinedValues: true },
});
