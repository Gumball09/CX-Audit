import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { s3 } from "./aws.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { isRecordingKey } from "./filename.js";

/** Build an s3:// URL for display/storage. */
export function s3Url(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

async function streamToBuffer(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function streamToString(body: Readable): Promise<string> {
  return (await streamToBuffer(body)).toString("utf-8");
}

/** List recording object keys in the source bucket (used for backfill only). */
export async function listRecordingKeys(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: env.S3_RECORDING_BUCKET,
        Prefix: env.S3_RECORDING_PREFIX.replace(/^\//, ""),
        ContinuationToken: token,
      })
    );
    for (const item of res.Contents ?? []) {
      if (item.Key && isRecordingKey(item.Key)) keys.push(item.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  logger.debug(`Listed ${keys.length} recording keys from ${env.S3_RECORDING_BUCKET}`);
  return keys;
}

/**
 * List recording keys under a specific prefix in the source bucket, stopping at
 * `max` (so a huge prefix can't run unbounded). The given prefix is taken
 * relative to the bucket root; a leading slash is tolerated. Used by bulk-run.
 */
export async function listRecordingKeysByPrefix(prefix: string, max = 2000): Promise<string[]> {
  const keys: string[] = [];
  const norm = prefix.replace(/^\/+/, "");
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: env.S3_RECORDING_BUCKET, Prefix: norm, ContinuationToken: token })
    );
    for (const item of res.Contents ?? []) {
      if (item.Key && isRecordingKey(item.Key)) {
        keys.push(item.Key);
        if (keys.length >= max) return keys; // hit the cap — caller flags truncation
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Download a recording. `bucket` defaults to the global recording bucket. */
export async function getRecordingBuffer(key: string, bucket: string = env.S3_RECORDING_BUCKET): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Recording ${key} returned an empty body`);
  const buffer = await streamToBuffer(res.Body as Readable);
  logger.debug(`Downloaded recording ${key} (${buffer.length} bytes)`);
  return buffer;
}

/** Persist a transcript under transcriptions/. `bucket` defaults to the global output bucket. */
export async function saveTranscription(transcript: string, baseName: string, bucket: string = env.S3_OUTPUT_BUCKET): Promise<string> {
  const key = `${env.S3_TRANSCRIPTION_PREFIX}${baseName}.txt`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: transcript,
      ContentType: "text/plain; charset=utf-8",
    })
  );
  logger.info(`Saved transcription: ${key}`);
  return key;
}

/** Load a previously saved transcript. `bucket` defaults to the global output bucket. */
export async function getTranscription(key: string, bucket: string = env.S3_OUTPUT_BUCKET): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Transcription ${key} returned an empty body`);
  return streamToString(res.Body as Readable);
}

/** Persist an audit result document under audits/. `bucket` defaults to the global output bucket. */
export async function saveAuditDocument(doc: unknown, baseName: string, bucket: string = env.S3_OUTPUT_BUCKET): Promise<string> {
  const key = `${env.S3_AUDIT_PREFIX}${baseName}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(doc, null, 2),
      ContentType: "application/json",
    })
  );
  logger.info(`Saved audit document: ${key}`);
  return key;
}

export const OUTPUT_BUCKET = () => env.S3_OUTPUT_BUCKET;
export const RECORDING_BUCKET = () => env.S3_RECORDING_BUCKET;
