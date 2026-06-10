# ⚠️ Moved

S3 setup is now documented in two places:

- **Buckets, object layout, and CORS** → [backend/S3_SETUP.md](backend/S3_SETUP.md)
- **Bucket → SQS event notification** (what drives the pipeline) → [backend/SQS_SETUP.md](backend/SQS_SETUP.md)

S3 layout in brief:

```
Recording bucket (read-only source)
  Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3

Output bucket (read-write)
  transcriptions/<agent_id>-<session_id>.txt
  audits/<agent_id>-<session_id>.json
```
