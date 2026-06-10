# Scaling the workers

"More workers when busy, back to baseline when idle" happens at two independent
layers. They compose — use both in production.

```
                 burst of N recordings
                          │
                  ┌───────▼────────┐
                  │   SQS queue    │  ← absorbs the burst; never "fails", just queues
                  └───────┬────────┘
        ┌─────────────────┼───────────────────┐
        ▼                 ▼                    ▼
   worker task 1     worker task 2   ...  worker task M     ← LAYER 2: # of tasks autoscales
   ├ slot 1 ┐        ├ slot 1 ┐
   ├ slot 2 ┤ ≤C     ├ slot 2 ┤ ≤C  ...                     ← LAYER 1: C parallel jobs per task
   └ slot C ┘        └ slot C ┘
```

## Layer 1 — adaptive concurrency *inside* a worker (built, portable)

Each worker process runs `WORKER_CONCURRENCY` (default 5) independent loops.
A loop only does work when a message is waiting; when the queue is empty every
loop sits on a cheap 20s long-poll and CPU drops to ~0. The instant a burst
arrives it ramps straight back to `WORKER_CONCURRENCY` in-flight jobs. Because
transcription/auditing are I/O-bound (waiting on OpenAI), one small process can
hold many concurrent calls.

- **Tune:** raise `WORKER_CONCURRENCY` to drain bursts faster from a single box.
- **Ceiling:** your **OpenAI rate limits** (RPM/TPM), not CPU. Set concurrency
  so peak in-flight calls stay under your account limits.
- Works identically on a laptop, one EC2 box, or a Fargate task. No infra needed.

This alone handles your "40 at once" case on a single machine: the 40 queue up
and are processed `WORKER_CONCURRENCY` at a time, fast, without failing.

## Layer 2 — more worker containers / instances

### Current setup — single EC2 box with Docker Compose *(what we deploy)*
One EC2 instance runs the API + both workers as containers. You scale **on the
box** in two ways, both relying entirely on Layer 1:
- raise `WORKER_CONCURRENCY`, and/or
- run more worker containers: `docker compose up -d --scale transcribe=2 --scale audit=3`.

Cheapest to operate; "scale down" just means idle CPU. Fine until a single box
can't keep up. Full setup: **[DEPLOY.md](DEPLOY.md)**.

### When you outgrow one box — autoscale on SQS backlog (ECS, later)
When one box's concurrency isn't enough, scale the **count** of worker tasks on
**SQS backlog**. The standard signal is *backlog per task*:

```
backlogPerTask = ApproximateNumberOfMessagesVisible / runningTaskCount
```

Scale out when it exceeds a target (e.g. 10), scale in when it falls — a
CloudWatch target-tracking policy on an ECS service per worker type
(`min=1, max=20, target=10`). **The application code is identical** — moving from
the single box to ECS is purely an infra change, no code rewrite.

## Related limits to respect

- **OpenAI RPM/TPM** — the true throughput ceiling. Add a budget/limit alert.
- **SQS visibility timeout** (currently 300s) must exceed your slowest single
  Whisper/GPT call, or the message redelivers and double-processes (dedup guards
  against persisting twice, but it wastes an API call). Raise it or add a
  `ChangeMessageVisibility` heartbeat for very long calls.
- **Whisper 25 MB/request** — long recordings must be chunked before transcription.
