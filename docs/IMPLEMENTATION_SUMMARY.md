# ⚠️ Superseded

This document described the original **daily-scan / single-request** design,
which has been replaced by an event-driven SQS + workers pipeline backed by
DynamoDB.

See instead:

- [README.md](README.md) — project overview
- [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md) — end-to-end design
- [backend/DYNAMODB.md](backend/DYNAMODB.md) — data model
- [backend/SQS_SETUP.md](backend/SQS_SETUP.md) — queues + S3 events
- [backend/RBAC.md](backend/RBAC.md) — access control
