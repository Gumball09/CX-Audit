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

/** Download a recording from the source bucket. */
export async function getRecordingBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_RECORDING_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Recording ${key} returned an empty body`);
  const buffer = await streamToBuffer(res.Body as Readable);
  logger.debug(`Downloaded recording ${key} (${buffer.length} bytes)`);
  return buffer;
}

/** Persist a transcript under transcriptions/ and return its key. */
export async function saveTranscription(transcript: string, baseName: string): Promise<string> {
  const key = `${env.S3_TRANSCRIPTION_PREFIX}${baseName}.txt`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_OUTPUT_BUCKET,
      Key: key,
      Body: transcript,
      ContentType: "text/plain; charset=utf-8",
    })
  );
  logger.info(`Saved transcription: ${key}`);
  return key;
}

/** Load a previously saved transcript. */
export async function getTranscription(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_OUTPUT_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Transcription ${key} returned an empty body`);
  return streamToString(res.Body as Readable);
}

/** Persist an audit result document under audits/ and return its key. */
export async function saveAuditDocument(doc: unknown, baseName: string): Promise<string> {
  const key = `${env.S3_AUDIT_PREFIX}${baseName}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_OUTPUT_BUCKET,
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
