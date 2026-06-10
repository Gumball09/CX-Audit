# CX Audit Backend

Event-driven backend that transcribes and audits CX call recordings, with
role-based access for the dashboard. TypeScript + Express + AWS (S3, SQS,
DynamoDB) + OpenAI (Whisper + GPT).

> **New here?** Read [docs/ARCHITECTURE.md](ARCHITECTURE.md) first — it has
> the end-to-end diagram and the design rationale.

## What it does

1. A recording lands in the S3 recording bucket → S3 fires an event to the
   **transcription queue**.
2. The **transcription worker** parses the filename, registers the call in
   DynamoDB (deduped), runs Whisper, stores the transcript in
   `s3://<output>/transcriptions/`, and enqueues the **audit queue**.
3. The **audit worker** resolves the agent's team → that team's rubric, scores
   the call with GPT, stores the result in `s3://<output>/audits/`, and
   finalizes the DynamoDB row.
4. The **API** serves audits to the dashboard, scoped by the viewer's role
   (super_admin = all, admin = team, user = own).

## Project layout

```
src/
  index.ts                 # API server (auth + users + teams + audits)
  env.ts                   # env loading + validation
  types.ts                 # shared domain types
  validation.ts            # rubric / email validation
  logger.ts
  lib/
    aws.ts                 # shared S3 / SQS / DynamoDB clients
    filename.ts            # recording-key parser (the Scaler format)
    s3.ts                  # download recording, save transcript/audit
    sqs.ts                 # send + long-poll consumer loop
  db/
    users.ts  teams.ts  audits.ts   # DynamoDB repositories
  services/
    openai.ts              # transcribe + audit (with stub mode)
    auth.ts                # JWT sign/verify + middleware
    rbac.ts                # permission matrix
    pipeline.ts            # stage 1 + stage 2 logic (shared by workers)
  routes/
    auth.ts  users.ts  teams.ts  audits.ts
  workers/
    transcribe.worker.ts   # consumes transcription queue
    audit.worker.ts        # consumes audit queue
scripts/
  create-infra.ts          # create DynamoDB tables + SQS queues
  seed.ts                  # seed team rubrics + initial super_admin
```

> All documentation lives in the repo-level `docs/` folder (this file is
> `docs/backend/README.md`). The setup docs referenced below are its siblings.

## Setup docs

| Topic | Doc |
|-------|-----|
| End-to-end design | [docs/ARCHITECTURE.md](ARCHITECTURE.md) |
| DynamoDB tables + data model | [docs/DYNAMODB.md](DYNAMODB.md) |
| S3 buckets, layout, **CORS** | [docs/S3_SETUP.md](S3_SETUP.md) |
| SQS queues, DLQs, **S3 event wiring** | [docs/SQS_SETUP.md](SQS_SETUP.md) |
| Roles & permissions | [docs/RBAC.md](RBAC.md) |
| Production checklist + IAM | [docs/PRODUCTION.md](PRODUCTION.md) |

## Setup

Requires **Node 20+**.

```bash
cd CX-audit-backend
npm install
cp .env.local.example .env.local      # then fill in the values
```

Fill in `.env.local` (every variable is documented in `.env.local.example`).
At minimum you need AWS credentials, `S3_RECORDING_BUCKET`, `S3_OUTPUT_BUCKET`,
and (for real audits) `OPENAI_API_KEY`. Leaving the OpenAI key blank runs the
pipeline in **stub mode**.

Then provision and seed:

```bash
npm run infra:create   # create DynamoDB tables + SQS queues, prints queue URLs
#   → paste the queue URLs into .env.local
npm run seed           # seed the 4 team rubrics + initial super_admin
```

Then the two one-time AWS wiring steps:
- Create/configure the output bucket + CORS — [docs/S3_SETUP.md](S3_SETUP.md).
- Wire the recordings bucket → transcription queue — [docs/SQS_SETUP.md](SQS_SETUP.md).

## Running

```bash
npm run dev                # API server  → http://localhost:4000
npm run worker:transcribe  # transcription worker (run 1+)
npm run worker:audit       # audit worker (run 1+)
```

Production: `npm run build` then `npm start`, `npm run start:worker:transcribe`,
`npm run start:worker:audit` (use PM2/systemd/containers; run multiple worker
instances to scale).

## API

All routes are under `/api`. Everything except `/health` and `/auth/login`
requires `Authorization: Bearer <token>`.

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/health` | public | liveness + which integrations are configured |
| POST | `/auth/login` | public | `{ email }` → `{ token, user }` |
| GET | `/auth/me` | any | current user |
| GET | `/audits` | any | audits in scope; filters `?team&flagged&from&to` |
| GET | `/audits/:id` | scoped | single audit row |
| GET | `/audits/:id/transcript` | scoped | full transcript text |
| POST | `/audits/reprocess` | admin+ | `{ recording_key }` → re-ingest |
| POST | `/audits/:id/reaudit` | admin+ | re-run audit stage only |
| GET | `/users` | admin+ | list users (admin sees own team) |
| POST | `/users` | admin+ | create user/admin (per RBAC) |
| PATCH | `/users/:id` | admin+ | update (role/team = super_admin only) |
| DELETE | `/users/:id` | admin+ | delete (protects last super_admin) |
| GET | `/teams` | any | list team rubrics |
| GET | `/teams/:id` | any | one team rubric |
| PATCH | `/teams/:id` | admin (own) / super_admin | edit rubric (weights must sum to 100) |

See [docs/RBAC.md](RBAC.md) for the full permission matrix.

## Quick local smoke test (stub mode, no OpenAI spend)

```bash
# 1. login as the seeded super_admin
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"shubh.mehrotra@scaler.com"}' | jq -r .token)

# 2. backfill one recording through the pipeline
curl -s localhost:4000/api/audits/reprocess -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"recording_key":"Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3"}'

# 3. (workers running) — list audits
curl -s localhost:4000/api/audits -H "authorization: Bearer $TOKEN" | jq
```

## Tests

```bash
npm test          # vitest run (filename parser + RBAC matrix)
```

## Production

Hardening (helmet, rate limiting, prod fail-fast config, retries, DLQs,
pagination, non-root Docker image) is already wired. The launch checklist, the
least-privilege IAM policy, scaling notes, and the **decisions still needed**
(auth strength, deploy target, monitoring, data retention) live in
**[docs/PRODUCTION.md](PRODUCTION.md)**.

```bash
docker compose up --build          # API + transcribe + audit from one image
docker compose up --scale audit=3  # scale a worker
```
