# Deploy — single EC2 box with Docker Compose

The simplest production-capable setup: **one EC2 instance** running the API and
both workers as containers via Docker Compose. No Terraform, no ECS. You scale by
raising in-process concurrency or running more worker containers on the box
(see [SCALING.md](SCALING.md)); when one box isn't enough, you graduate to ECS
later without touching application code.

```
                ┌──────────────────────── EC2 instance ────────────────────────┐
   S3 event ─▶ SQS ─▶                docker compose (one image)                 │
                     │   api :4000      transcribe ×N        audit ×N           │
                     └───────────────────────────────────────────────────────┘ │
                          │ uses the instance's IAM role for AWS access         │
   DynamoDB · S3 · SQS · OpenAI · Sentry  ◀────────────────────────────────────┘
```

## 1. One-time AWS setup (from your laptop or the box)

These create the AWS resources the app talks to. Run once.

```bash
cd CX-audit-backend
cp .env.local.example .env.local     # fill in values (see step 3)
npm install
npm run infra:create                 # 6 DynamoDB tables + 2 SQS queues (+ DLQs)
#   → paste the printed queue URLs into .env.local
npm run seed                         # rubrics + built-in recording pattern + super_admin
```

Then the two AWS-console wiring steps (once):
- Output bucket + CORS — [S3_SETUP.md](S3_SETUP.md).
- Recordings bucket → transcription queue notification — [SQS_SETUP.md](SQS_SETUP.md).

## 2. Provision the EC2 instance

- **Type:** `t3.small` is plenty (the workload is I/O-bound — it waits on
  OpenAI). Amazon Linux 2023 or Ubuntu 22.04.
- **IAM role (preferred over keys):** attach an instance role carrying the
  least-privilege policy in [PRODUCTION.md](PRODUCTION.md#least-privilege-iam-policy).
  Then leave `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **blank** — the AWS SDK
  picks up the role automatically. No static keys on disk.
- **Security group:** inbound `4000` only from your dashboard/ALB (or keep it
  closed and put an ALB / Caddy / nginx with HTTPS in front). Outbound 443 open
  (S3, SQS, DynamoDB, OpenAI, Sentry).

Install Docker + the compose plugin:

```bash
# Amazon Linux 2023
sudo dnf install -y docker git && sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user      # re-login after this
sudo dnf install -y docker-compose-plugin
```

## 3. Configure `.env.local` on the box

Copy your filled `.env.local` to the box (or recreate it). Production values:

```bash
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=https://your-dashboard-origin
TRUST_PROXY=1                         # if behind an ALB / reverse proxy
JWT_SECRET=<openssl rand -hex 32>

# AWS: leave keys blank to use the EC2 instance role (recommended)
AWS_REGION=ap-south-1
S3_RECORDING_BUCKET=cz-scaler-support-calls
S3_OUTPUT_BUCKET=<your-output-bucket>
SQS_TRANSCRIPTION_QUEUE_URL=<from infra:create>
SQS_AUDIT_QUEUE_URL=<from infra:create>

OPENAI_API_KEY=<the key from your manager>
# Model fallbacks; a super_admin can override these live from Dashboard → Settings.
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_AUDIT_MODEL=gpt-4o

SENTRY_DSN=<your sentry dsn>          # crashes / quota-exhaustion / DLQ alerts
SENTRY_ENVIRONMENT=production
```

## 4. Run it

```bash
git clone <repo> && cd CX-audit/CX-audit-backend
docker compose up -d --build
docker compose ps                     # api should become healthy
curl localhost:4000/api/health        # sanity check
```

Scale the (port-less) workers to drain bursts faster on this box:

```bash
docker compose up -d --scale transcribe=2 --scale audit=3
```

## 5. Operate

| Task | Command |
|------|---------|
| Logs (follow) | `docker compose logs -f audit` (or `api` / `transcribe`) |
| Restart a service | `docker compose restart audit` |
| Redeploy after a code change | `git pull && docker compose up -d --build` |
| Stop everything | `docker compose down` |
| Disk usage from old images | `docker image prune -f` |

Logs are JSON with rotation (10 MB × 5 files per container) so they won't fill
the disk. The API has a Docker **healthcheck** on `/api/health`; workers
auto-restart (`restart: unless-stopped`) and report crashes to Sentry.

## 6. When one box isn't enough

The application code is identical on ECS — see [SCALING.md](SCALING.md) for the
auto-scale-out-on-SQS-backlog path. Until then: raise `WORKER_CONCURRENCY`, or
`--scale` more worker containers, bounded by your OpenAI rate limits.

> **Auth note:** login is email-only (allow-list). Keep this box/dashboard behind
> SSO/VPN or an SSO proxy until a stronger auth mechanism is chosen — see the
> "Decisions still needed" section in [PRODUCTION.md](PRODUCTION.md).
