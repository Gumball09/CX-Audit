# ⚠️ Superseded

Dedup is no longer done via daily `audit_log.jsonl` files. Each call now has a
single **DynamoDB row** in `cx_audits` keyed by `audit_id = <agent_id>-<session_id>`;
the transcription worker creates it with a conditional write, so a recording is
processed exactly once even if its S3 event is redelivered. Failed messages go
to a dead-letter queue.

See [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md)
("Idempotency & dedup") and
[backend/DYNAMODB.md](backend/DYNAMODB.md).
