# CX Audit — Architecture

An event-driven pipeline that audits CX call recordings. A recording landing in
S3 is automatically transcribed and scored against the owning team's rubric; the
dashboard reads results scoped to the viewer's role.

## End-to-end flow

```
                         (1) ObjectCreated event
 ┌──────────────────┐    ───────────────────────►   ┌───────────────────────────┐
 │ Recording bucket │                                │  cx-transcription-queue   │
 │  (S3, read-only) │                                │        (SQS)              │
 └──────────────────┘                                └─────────────┬─────────────┘
                                                                    │ long-poll
                                                                    ▼
                                                      ┌───────────────────────────┐
                                                      │   Transcription worker     │
                                                      │  (npm run worker:transcribe)│
                                                      │  parse filename → dedup     │
                                                      │  → Whisper → save .txt      │
                                                      └─────────────┬──────────────┘
                                          transcriptions/<id>.txt   │ enqueue
                          ┌───────────────────────────┐  ◄──────────┤
                          │      Output bucket (S3)    │             ▼
                          │  transcriptions/ , audits/ │  ┌───────────────────────────┐
                          └───────────────────────────┘  │      cx-audit-queue (SQS)  │
                                          ▲               └─────────────┬─────────────┘
                          audits/<id>.json│                             │ long-poll
                                          │                             ▼
                                          │               ┌───────────────────────────┐
                                          └───────────────│        Audit worker        │
                                                          │   (npm run worker:audit)   │
                                                          │  agent→team→rubric → GPT    │
                                                          │  → save .json → update row  │
                                                          └─────────────┬──────────────┘
                                                                        │
                                            ┌───────────────────────────▼─────────────┐
                                            │            DynamoDB (cx_audits)          │
                                            │  one row per call, status + result links │
                                            └───────────────────────────┬─────────────┘
                                                                         │ scoped reads
 ┌──────────────┐   login (JWT)   ┌─────────────────────┐               ▼
 │  Dashboard   │ ◄─────────────► │   API (Express)      │  GET /api/audits (all|team|own)
 │  (frontend)  │   scoped data   │  auth · users · teams│
 └──────────────┘                 │  · audits            │
                                   └─────────────────────┘
```

## Components

| Component | Entrypoint | Responsibility |
|-----------|-----------|----------------|
| **API server** | `src/index.ts` (`npm run dev`) | Auth, RBAC, serve scoped audits, manage users + team rubrics. |
| **Transcription worker** | `src/workers/transcribe.worker.ts` (`npm run worker:transcribe`) | Stage 1: download recording → Whisper → store transcript → enqueue audit. |
| **Audit worker** | `src/workers/audit.worker.ts` (`npm run worker:audit`) | Stage 2: resolve team rubric → GPT audit → store result → finalize row. |
| **Pipeline** | `src/services/pipeline.ts` | Stage logic shared by workers + reprocess/reaudit endpoints. |

Workers are plain long-running Node consumers (long-poll loop in
`src/lib/sqs.ts`). Run as many copies as you need — SQS distributes messages, so
horizontal scaling is "start more workers."

## Why two queues

Transcription (Whisper, I/O + audio bound) and auditing (GPT, token bound) have
different rates, costs, and failure modes. Splitting them lets you scale and
retry each independently, and a rubric change can re-run **only** the audit
stage (`POST /api/audits/:id/reaudit`) without re-transcribing.

## Idempotency & dedup

The Audits table PK is `audit_id = <agent_id>-<session_id>`, derived from the
filename. Stage 1 does a conditional create (`attribute_not_exists`), so a
recording that is redelivered (S3 retry, replayed event, manual reprocess) maps
to the same row and is not double-processed. Stage 2 skips rows already in
`audited` status. Failures stay in SQS and, after `maxReceiveCount` attempts,
move to the per-queue dead-letter queue.

## Resilience

- **Visibility timeout** 5 min covers a slow Whisper/GPT call before redelivery.
- **DLQs** capture poison messages for inspection instead of infinite retry.
- **Status field** (`queued → transcribing → transcribed → auditing → audited`,
  or `failed`) makes stuck/failed calls queryable and replayable.
- **Stub mode**: with no `OPENAI_API_KEY`, transcription + audit return
  deterministic fakes so the whole pipeline can be exercised without spend.

## Recording filename contract

```
Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3
                  agent-<agentId>-<sessTs>-<sessSeq>-<campaign>-<YYYY>_<MM>_<DD>_<HH>_<MM>_<SS>-<customer>.<ext>
```

| Field | Example | Source |
|-------|---------|--------|
| agent_id | `495367` | filename |
| session_id | `1711950009-255903` | filename |
| campaign | `Scaler` | filename |
| call_datetime | `2024-04-01T11:10:09Z` | filename |
| customer_number | `916353969873` | filename |
| team | `CS` | **DynamoDB**: agent_id → user record → team |

See `src/lib/filename.ts` for the parser.
