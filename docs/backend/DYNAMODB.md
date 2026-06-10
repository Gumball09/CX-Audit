# DynamoDB Data Model

Three tables. All keys are strings; billing is on-demand (`PAY_PER_REQUEST`).
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
| `criteria` | L | `[{ name, weight, description }]`; weights sum to 100 |
| `system_prompt` | S | base instruction for the LLM auditor |
| `flag_threshold` | N | overall score below this ⇒ flagged (default 70) |
| `critical_criterion_threshold` | N | any criterion below this ⇒ flagged (default 60) |
| `updated_at` / `updated_by` | S | |

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
