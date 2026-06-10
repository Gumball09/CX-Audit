# SQS + S3 Event Setup

The pipeline uses two SQS queues, each with a dead-letter queue:

| Queue | Producer | Consumer |
|-------|----------|----------|
| `cx-transcription-queue` | S3 `ObjectCreated` events (+ manual reprocess) | transcription worker |
| `cx-audit-queue` | transcription worker | audit worker |
| `*-dlq` | redrive after 5 failed receives | manual inspection |

## 1. Provision queues + tables

```bash
npm run infra:create
```

This creates the DynamoDB tables and both queues (with DLQs, a 5-minute
visibility timeout, and `maxReceiveCount = 5`). It prints the queue URLs — paste
them into `.env.local`:

```env
SQS_TRANSCRIPTION_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<acct>/cx-transcription-queue
SQS_AUDIT_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<acct>/cx-audit-queue
```

## 2. Connect S3 → the transcription queue

`infra:create` does **not** configure the bucket notification (the bucket may be
owned by a different account/team). Do it once, either way:

### Option A — Console
1. SQS → `cx-transcription-queue` → **Access policy**: allow `s3.amazonaws.com`
   to `sqs:SendMessage` to this queue's ARN, conditioned on the source bucket
   ARN. (Policy template below.)
2. S3 → recording bucket → **Properties → Event notifications → Create**:
   - Event types: **All object create events** (`s3:ObjectCreated:*`)
   - Optional prefix: `Scaler/` (matches `S3_RECORDING_PREFIX`)
   - Optional suffix: `.mp3`
   - Destination: **SQS queue** → `cx-transcription-queue`

### Option B — CLI
```bash
aws sqs set-queue-attributes --queue-url "$SQS_TRANSCRIPTION_QUEUE_URL" \
  --attributes Policy="$(cat queue-policy.json)"

aws s3api put-bucket-notification-configuration \
  --bucket cz-scaler-support-calls \
  --notification-configuration file://s3-notification.json
```

`queue-policy.json` (allows the bucket to publish to the queue):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "s3.amazonaws.com" },
    "Action": "sqs:SendMessage",
    "Resource": "<cx-transcription-queue ARN>",
    "Condition": { "ArnLike": { "aws:SourceArn": "arn:aws:s3:::cz-scaler-support-calls" } }
  }]
}
```

`s3-notification.json`:
```json
{
  "QueueConfigurations": [{
    "QueueArn": "<cx-transcription-queue ARN>",
    "Events": ["s3:ObjectCreated:*"],
    "Filter": { "Key": { "FilterRules": [{ "Name": "suffix", "Value": ".mp3" }] } }
  }]
}
```

## 3. Run the workers

```bash
npm run worker:transcribe   # one terminal (or N processes / containers)
npm run worker:audit        # another terminal
```

## Message shapes

**Transcription queue** — either an S3 event or a manual reprocess message:
```json
{ "Records": [ { "s3": { "object": { "key": "Scaler/01_04_2024/agent-...mp3" } } } ] }
{ "recording_key": "Scaler/01_04_2024/agent-...mp3" }
```

**Audit queue** — emitted by the transcription worker:
```json
{ "audit_id": "495367-1711950009-255903", "agent_id": "495367", "transcription_key": "transcriptions/495367-1711950009-255903.txt" }
```

## Backfilling existing recordings

To process recordings that predate the event wiring, enqueue them as reprocess
messages (admin token required):
```bash
curl -X POST http://localhost:4000/api/audits/reprocess \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"recording_key":"Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3"}'
```
(`src/lib/s3.ts#listRecordingKeys` lists eligible keys if you want to script a
bulk backfill.)

## Throughput & cost knobs

- **More workers** → more parallelism (SQS splits messages across consumers).
- `SQS_BATCH_SIZE` (1–10) messages pulled per poll; `SQS_WAIT_TIME_SECONDS`
  (0–20) long-poll wait — 20 minimizes empty receives.
- Raise the visibility timeout if Whisper/GPT calls routinely exceed 5 min.
