# Making Code Changes — What Needs an AWS Change vs a Redeploy

This explains how code changes reach production, and **when a change requires touching
AWS** (vs. when a plain rebuild-and-redeploy is enough).

> TL;DR — **The backend does NOT auto-deploy.** The GitHub repo and the ECS backend are
> decoupled; pushing to GitHub changes nothing in AWS until you rebuild the Docker image,
> push it to ECR, and force a new ECS deployment. The **frontend (Amplify) is the
> opposite** — it rebuilds itself on every push to the connected branch.

---

## How deploys work today

| | Backend (ECS on EC2 + ECR) | Frontend (AWS Amplify) |
|---|---|---|
| Auto-deploys on `git push`? | **No** | **Yes** (once the repo is connected) |
| What triggers a deploy | You manually: rebuild → push to ECR → force new ECS deployment | A commit to the connected branch |
| CI/CD pipeline wired? | None | Amplify's built-in build |

### Image layout (verified)
All three backend services run from **one shared image** and differ only by the command
in each task definition:

```
678047317409.dkr.ecr.us-west-2.amazonaws.com/cx-audit-backend:latest
   ├─ cx-api         (HTTP API)
   ├─ cx-transcribe  (transcription worker)
   └─ cx-audit       (audit worker)
```

- Region: **us-west-2**, Account B: **678047317409**, Cluster: **cx-audit**
- Image tag is **`:latest`** (mutable) — one build covers all three services.
- Images are **arm64** (must match the t4g / Graviton instances, or you get `exec format error`).

---

## The common case: a pure code change

A new feature, bug fix, new route, or prompt tweak that introduces **no new dependency**
needs **no AWS structure change** — just ship a new image:

```bash
cd "/path/to/CX Audit/CX-audit-backend"

# 1. Log in to ECR
aws ecr get-login-password --region us-west-2 --profile cx-prod \
  | docker login --username AWS --password-stdin 678047317409.dkr.ecr.us-west-2.amazonaws.com

# 2. Build (arm64 — must match the Graviton instances)
docker build --platform linux/arm64 \
  -t 678047317409.dkr.ecr.us-west-2.amazonaws.com/cx-audit-backend:latest .

# 3. Push
docker push 678047317409.dkr.ecr.us-west-2.amazonaws.com/cx-audit-backend:latest

# 4. Tell each service to pull the new :latest and roll
for svc in cx-api cx-transcribe cx-audit; do
  aws ecs update-service --cluster cx-audit --service "$svc" \
    --force-new-deployment --region us-west-2 --profile cx-prod
done
```

**Why step 4 is required:** because the tag stays `:latest`, the task-definition string
doesn't change, so ECS won't notice a new image on its own. `--force-new-deployment` makes
it re-pull. It performs a **rolling deploy** (starts new tasks, drains old) → no downtime.

---

## When you DO need to touch AWS

If a change introduces a **new dependency**, that dependency must be created in AWS and
granted to the task role — the code alone can't conjure it.

| Change | AWS action needed |
|---|---|
| New / changed **env var or secret** | New **task definition revision** with the env var (or an SSM Parameter Store SecureString + access on the **execution role**), then update the service to that revision |
| New **DynamoDB table / SQS queue / S3 bucket / prefix** | Create the resource **and** add it to the **task role** IAM policy (`cx-audit-task-role`) |
| New **external permission** (call another AWS API, cross-account access, KMS decrypt) | Update the **task role** policy (and any cross-account bucket/queue policy) |
| Change **container port / health check / CPU / memory** | New task definition revision (+ ALB target group / health check if the port or path changed) |
| Change **scaling behavior** (min/max tasks, thresholds) | Update the service Auto-scaling policies / CloudWatch alarms |
| Change **networking** (VPC, subnets, security groups, network mode) | Update the service / task def / SG |
| New **inbound route or domain** | ALB listener rule / ACM cert / Route 53 record |
| **Pure code** (no new resource, no new config) | **Nothing** — just the rebuild + redeploy above |

### Rule of thumb
- **Behavior-only change** → rebuild + redeploy. No infra.
- **Change that needs a new table, queue, bucket, secret, env var, permission, port, or
  domain** → create/grant it in AWS too, *then* rebuild + redeploy.

---

## Roles reference (for IAM changes)

- **Task role** — `arn:aws:iam::678047317409:role/cx-audit-task-role` — what the *running
  app* can do (read/write S3, SQS, DynamoDB, etc.). Add permissions here when the app needs
  to touch a new resource. Shared by all three services.
- **Execution role** — `arn:aws:iam::678047317409:role/cx-audit-ecs-execution` — what ECS
  uses to *start* the task (pull from ECR, read SSM secrets, write logs). Add SSM
  parameter access here when you add a new secret.

---

## Recommendations

- **Tag images with the git SHA** (`:latest` *and* `:<sha>`) instead of only `:latest`.
  Then a task-def revision pins an exact build, rollbacks are trivial, and you avoid the
  "which `latest` is actually running?" ambiguity.
- Consider a **`scripts/deploy.sh`** that runs all four steps (with git-SHA tagging) so a
  redeploy is one command.
- For secrets, prefer **SSM Parameter Store SecureString** referenced from the task def
  over plaintext env vars.
