# DynamoDB Data Model

Six tables. All keys are strings; billing is on-demand (`PAY_PER_REQUEST`).
Create them with `npm run infra:create` (definitions live in
`scripts/create-infra.ts`).

## Why a single Users table (not three role tables)

`super_admin`, `admin`, and `user` share the same shape and are queried
together constantly (login by email, list users, resolve an agent's team).
Splitting them into three tables would mean fan-out reads and cross-table
consistency for every one of those operations. Instead we keep one `cx_users`
table with a `role` attribute and let the API enforce RBAC. This is the standard
DynamoDB approach and keeps the access patterns single-query.

---

## 1. `cx_users`

The identity table. A row is both a dashboard login **and** (for call agents)
the `agent_id → team` mapping the audit worker needs.

| Attribute | Type | Notes |
|-----------|------|-------|
| `user_id` (**PK**) | S | `USR-<random>` |
| `email` | S | unique login identity (lowercased) |
| `name` | S | |
| `role` | S | `super_admin` \| `admin` \| `user` |
| `team` | S | `CS` \| `RM` \| `OORP` \| `Escalations`; null for org-wide super_admins |
| `agent_id` | S | dialer id, e.g. `495367`; null for non-agent staff |
| `status` | S | `active` \| `inactive` |
| `created_at` / `updated_at` / `created_by` | S | audit trail |

**GSIs**
- `email-index` — PK `email`. Login (`POST /api/auth/login`).
- `agent-index` — PK `agent_id`. Team resolution during auditing (point 7).

Access patterns: get by id (auth middleware), by email (login), by agent_id
(audit worker), scan (list users — small table).

---

## 2. `cx_teams`

One row per team holding that team's audit rubric. Editable by the team's admin
or any super_admin.

| Attribute | Type | Notes |
|-----------|------|-------|
| `team_id` (**PK**) | S | `CS` \| `RM` \| `OORP` \| `Escalations` |
| `name`, `description` | S | |
| `criteria` | L | `[{ name, weight?, description, guidance?, critical_threshold? }]` |
| `system_prompt` | S | base instruction for the LLM auditor |
| `scale_max` | N | max score per criterion (default 100) |
| `flag_threshold` | N | overall score below this ⇒ flagged (default 70) |
| `critical_criterion_threshold` | N | any criterion below this ⇒ flagged (default 60) |
| `updated_at` / `updated_by` | S | |

**Flexible rubric (not a fixed template):** `weight` is *relative* and
normalized at scoring time (`src/validation.ts → normalizeWeights`), so admins
are not forced to make weights sum to 100 — `1/2/3`, `10/20/70`, or no weights
(equal) all work. `critical_threshold` optionally overrides the rubric-wide
critical threshold for a single criterion, `guidance` carries free-form extra
instruction/examples, and `scale_max` lets the team score on a non-0–100 scale.

---

## 3. `cx_audits`

One row per call, tracking it through the pipeline and pointing at the S3
artifacts. Heavy data (full transcript, full audit JSON) lives in S3, not here.

| Attribute | Type | Notes |
|-----------|------|-------|
| `audit_id` (**PK**) | S | `<agent_id>-<session_id>` — deterministic ⇒ dedup |
| `recording_key` / `recording_url` | S | source object in the recording bucket |
| `agent_id`, `session_id`, `campaign`, `customer_number` | S | parsed from filename |
| `call_datetime` | S | ISO; GSI sort key |
| `team` | S | resolved from agent record |
| `status` | S | `queued`→`transcribing`→`transcribed`→`auditing`→`audited` \| `failed` |
| `error` | S | populated on failure |
| `transcription_key` / `transcription_url` | S | `transcriptions/<id>.txt` |
| `audit_key` / `audit_url` | S | `audits/<id>.json` |
| `score`, `flagged`, `flag_reason` | N/BOOL/S | result summary |
| `criteria_scores` | L | per-criterion scores |
| `performance_recorded` | BOOL | set once the score is folded into the performance aggregates (dedup guard) |
| `created_at` / `transcribed_at` / `audited_at` / `updated_at` | S | timeline |

**GSIs** (both sorted by `call_datetime`, newest first)
- `agent-index` — PK `agent_id`. **user** scope (own calls).
- `team-index` — PK `team`. **admin** scope (team calls).

**super_admin** scope (all calls) uses a `Scan`. At larger volumes, swap the
scan for a fixed-partition GSI (e.g. `gsi_all = "ALL"` + `call_datetime` sort)
to paginate efficiently.

---

## RBAC ↔ scope mapping

| Role | Audit query | Index |
|------|-------------|-------|
| `super_admin` | `scanAll()` | (table scan) |
| `admin` | `queryByTeam(user.team)` | `team-index` |
| `user` | `queryByAgent(user.agent_id)` | `agent-index` |

See `src/db/audits.ts`.

---

## 4. `cx_recording_patterns`

Super-admin-configurable regexes for parsing recording filenames, so the
pipeline survives a change in the dialer's naming convention without a code
deploy. See `src/db/patterns.ts` + `src/lib/filename.ts`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `pattern_id` (**PK**) | S | `PAT-<random>`; the seeded default is `PAT-builtin` |
| `label` | S | human-friendly name |
| `regex` | S | regex source using **named capture groups** (`agent_id` required) |
| `flags` | S | regex flags (default `i`) |
| `priority` | N | lower = tried earlier; the active default has the lowest |
| `active` | BOOL | inactive patterns are skipped |
| `match_count` | N | how many recordings this pattern has parsed |
| `is_builtin` | BOOL | the seeded Scaler-format default (cannot be deleted) |
| `created_by` / `created_at` / `updated_at` | S | audit trail |

**How matching works.** The worker loads active patterns (cached 60s — it's on
the hot path), tries them in `priority` order, and the first whose named groups
yield a valid recording wins; that pattern's `match_count` is incremented.
Recognized group names: `agent_id` (required), `session_id` | `session_ts` +
`session_seq`, `campaign`, `customer_number`, `call_datetime` | (`year`,
`month`, `day`, `hour`, `minute`, `second`), `ext`.

**Auto-promotion.** On each cache refresh, if the most-matched pattern is not the
current default, the two swap `priority` — so as a new dialer format overtakes
the old one in usage, it automatically becomes the default checked first.

---

## 5. `cx_performance`

Time-bucketed performance aggregates powering the dashboard graphs. One row per
(scope, granularity, period). See `src/db/performance.ts`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `pk` (**PK**) | S | `agent#<agent_id>` or `team#<team>` |
| `bucket` (**SK**) | S | `day#YYYY-MM-DD` \| `month#YYYY-MM` \| `year#YYYY` |
| `scope_type` / `scope_id` | S | `agent` \| `team`, and the id |
| `granularity` / `period` | S | denormalized for convenience |
| `call_count` | N | atomic `ADD` counter |
| `score_sum` | N | atomic `ADD`; avg = `score_sum / call_count` (computed on read) |
| `flagged_count` | N | atomic `ADD` counter |
| `updated_at` | S | |

Written once per audit (guarded by `cx_audits.performance_recorded`) for the
agent **and** their team across all three granularities. Queried by
`pk = :pk AND bucket BETWEEN :lo AND :hi` for a date-ranged series, newest last.
A manual re-audit deliberately does **not** re-aggregate (it's a correction
tool), so counts stay stable.

---

## 6. `cx_settings`

A single-row table holding runtime platform settings a super_admin edits from
the dashboard (no redeploy). Today: the OpenAI models. See `src/db/settings.ts`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `setting_id` (**PK**) | S | always `"global"` (singleton) |
| `transcription_model` | S | Whisper model id; falls back to `OPENAI_TRANSCRIPTION_MODEL` |
| `audit_model` | S | GPT model id; falls back to `OPENAI_AUDIT_MODEL` |
| `updated_at` / `updated_by` | S | audit trail |

Workers read this through a 60s cache (`getModelSettingsCached`), so a model
change takes effect within ~60s. The `OPENAI_*_MODEL` env vars are the fallback
when no row exists or the table is briefly unavailable.
