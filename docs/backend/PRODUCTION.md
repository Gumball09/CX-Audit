# Production Deployment & Hardening

What's already built in, the checklist before going live, and the few decisions
that still need a human.

## Built-in hardening

| Area | What the code does |
|------|--------------------|
| **Config safety** | `validateEnv` **throws on startup in production** for fatal misconfig (missing buckets/queues, weak `JWT_SECRET`); warns in dev. |
| **HTTP security** | `helmet` security headers; CORS restricted to `CORS_ORIGIN`; JSON body capped at 1 MB. |
| **Rate limiting** | 600 req / 15 min per IP globally; 20 / 15 min on `/api/auth/*`. Set `TRUST_PROXY=1` behind a load balancer. |
| **Auth** | JWT bearer tokens; every request re-loads the user from DynamoDB so deactivation/role changes take effect immediately. |
| **Error hygiene** | Internal errors never leak `error.message` in production; responses carry an `x-request-id` that ties back to logs. |
| **Resilience** | AWS SDK `maxAttempts: 4` + OpenAI `maxRetries: 3` / 120s timeout; SQS dead-letter queues after 5 failed receives; pipeline is idempotent (conditional create on `audit_id`). |
| **Scale** | Stateless API + workers; scale by running more instances. Audits API is cursor-paginated (`?limit&cursor`) so it never silently truncates. |
| **Containers** | Multi-stage `Dockerfile` (non-root), `docker-compose.yml` for API + workers. |
| **Graceful shutdown** | API drains on SIGTERM; workers finish the in-flight batch before exiting. |

## Pre-launch checklist

- [ ] **Secrets**: `JWT_SECRET` set to a 32-byte random value; AWS creds via IAM
      role (preferred) or rotated keys; store in Secrets Manager / SSM, not files.
- [ ] `NODE_ENV=production`, `LOG_LEVEL=info` (or `warn`), `CORS_ORIGIN` = the
      real dashboard origin, `TRUST_PROXY=1` if behind ALB/CloudFront.
- [ ] DynamoDB tables created (`npm run infra:create`) with **PITR enabled** and
      on-demand billing; teams + first super_admin seeded (`npm run seed`).
- [ ] SQS queues + DLQs created; **S3 → transcription queue notification wired**
      (see [SQS_SETUP.md](SQS_SETUP.md)).
- [ ] IAM policy scoped to least privilege (below).
- [ ] Workers: ≥2 instances of each for availability.
- [ ] **Alarms**: DLQ `ApproximateNumberOfMessagesVisible > 0`; SQS queue age;
      API 5xx rate; DynamoDB throttles.
- [ ] HTTPS terminated at the load balancer; security groups locked down.
- [ ] Run `npm test` and `npm run build` in CI; build + push the image.

## Least-privilege IAM policy (workers + API)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ReadRecordings", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::cz-scaler-support-calls", "arn:aws:s3:::cz-scaler-support-calls/*"] },
    { "Sid": "WriteOutputs", "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::YOUR_OUTPUT_BUCKET/*"] },
    { "Sid": "Queues", "Effect": "Allow",
      "Action": ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"],
      "Resource": ["arn:aws:sqs:*:*:cx-transcription-queue", "arn:aws:sqs:*:*:cx-audit-queue", "arn:aws:sqs:*:*:cx-*-dlq"] },
    { "Sid": "Tables", "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan"],
      "Resource": ["arn:aws:dynamodb:*:*:table/cx_*", "arn:aws:dynamodb:*:*:table/cx_*/index/*"] }
  ]
}
```
The API doesn't need `s3:GetObject` on recordings or SQS receive; if you split
roles, give the API only DynamoDB + transcription read + `sqs:SendMessage`
(for reprocess/reaudit).

## Scaling notes

- **Throughput** = number of worker instances × messages in flight. Start more
  workers; SQS distributes automatically.
- The super_admin "all audits" view uses a DynamoDB **Scan**. Fine to thousands
  of rows; beyond that add a fixed-partition GSI (`gsi_all="ALL"` + `call_datetime`
  sort) and switch `listAudits({kind:"all"})` to query it. (Noted in
  [DYNAMODB.md](DYNAMODB.md).)
- Consider an OpenAI spend cap / budget alert; transcription is the cost driver.

## Decisions still needed before launch

These genuinely need your input — I did **not** guess them:

1. **Authentication strength.** Login is currently **email-only** (an allow-list
   check against `cx_users`). That's acceptable for an internal tool behind SSO/VPN
   but is **not** sufficient as public-facing auth. Recommended: Google Workspace
   OAuth (all users are `@scaler.com`) or put the API behind an SSO proxy / API
   gateway. The swap is isolated to `routes/auth.ts#login` — everything else
   already trusts the issued JWT. **Pick a mechanism before exposing this publicly.**
2. **Deploy target** (ECS Fargate / EKS / EC2 / Lambda-behind-SQS) — determines
   how creds are injected and how workers are run/scaled.
3. **Monitoring/alerting vendor** (CloudWatch alone vs Datadog/Sentry) — to wire
   error tracking and the alarms above.
4. **Data retention** for recordings, transcripts, and audit rows (compliance /
   PII). Customer phone numbers are stored — confirm retention + access policy.
