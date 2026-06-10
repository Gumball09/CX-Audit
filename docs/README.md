# CX Audit

Internal platform for Scaler's CX team that **automatically audits recorded
support/sales calls**. A recording uploaded to S3 is transcribed and scored
against the owning team's quality rubric by AI, then surfaced in a dashboard
where reviewers see results scoped to their role.

```
recording in S3 ─▶ SQS ─▶ transcription worker (Whisper) ─▶ SQS ─▶ audit worker (GPT) ─▶ DynamoDB ─▶ dashboard
```

## Repository

| Folder | What it is |
|--------|-----------|
| [../CX-audit-backend/](../CX-audit-backend/) | Event-driven API + workers (TypeScript, Express, AWS, OpenAI). **Start here.** |
| [../CX-audit-dashboard/](../CX-audit-dashboard/) | React 19 + TanStack Start dashboard (login, call audits, user & rubric admin). |

> All project documentation lives in this `docs/` folder. Backend setup docs are
> under [`backend/`](backend/).

## Architecture at a glance

- **Event-driven, two-stage pipeline.** S3 `ObjectCreated` → transcription queue
  → transcription workers → audit queue → audit workers. Each stage scales and
  retries independently; failures land in dead-letter queues.
- **DynamoDB** for state: `cx_users` (identity + RBAC + agent→team mapping),
  `cx_teams` (per-team rubrics), `cx_audits` (one row per call with S3 links to
  the recording, transcript, and audit JSON).
- **S3 layout:** recordings in the source bucket; outputs under
  `transcriptions/` and `audits/` in the output bucket.
- **RBAC:** `super_admin` (org-wide) → `admin` (one team) → `user` (own calls).
- **Team-based auditing:** the call's agent_id (parsed from the filename) maps to
  a team in DynamoDB, which selects that team's rubric for scoring.

Full detail lives in the backend docs:

- [Backend README](backend/README.md)
- [Architecture](backend/ARCHITECTURE.md)
- [DynamoDB data model](backend/DYNAMODB.md)
- [S3 buckets + CORS](backend/S3_SETUP.md)
- [SQS + S3 event setup](backend/SQS_SETUP.md)
- [RBAC](backend/RBAC.md)
- [Production checklist + IAM](backend/PRODUCTION.md)

## Getting started

```bash
# Backend (Node 20+)
cd CX-audit-backend
npm install
cp .env.local.example .env.local      # fill in AWS + OpenAI values
npm run infra:create                  # create tables + queues
npm run seed                          # seed rubrics + super_admin
npm run dev                           # API
npm run worker:transcribe             # in another terminal
npm run worker:audit                  # in another terminal

# Dashboard
cd ../CX-audit-dashboard
npm install
npm run dev
```

See each subproject's README for details.
