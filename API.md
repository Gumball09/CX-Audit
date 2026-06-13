# CX Audit — API Reference

REST API for the CX Audit platform (call-recording transcription + AI auditing).
All endpoints are mounted under **`/api`** and return JSON.

- **Base URL (local):** `http://localhost:4000/api`
- **Base URL (prod):** `https://api.audit-copilot.scaler.com/api` *(once the API subdomain is live; otherwise the ALB DNS)*
- **Source of truth:** [src/index.ts](src/index.ts) (mounting + middleware) and the files under [src/routes/](src/routes/).

---

## Authentication

Auth is **JWT bearer tokens**. Obtain a token from `POST /api/auth/login` (or `/auth/set-password` on first login), then send it on every authenticated request:

```
Authorization: Bearer <token>
```

`GET /api/health` and the `POST /api/auth/*` endpoints are the only ones that don't require a token (`/auth/me` does). Token lifetime is controlled by `JWT_EXPIRES_IN` (default `12h`).

### Roles

| Role | Scope |
|---|---|
| **`user`** | An individual agent. Sees only **their own** calls/performance. |
| **`admin`** | Manages **their own team** — its users, rubric, feedback, performance. |
| **`super_admin`** | Platform-wide — all teams, infrastructure config, patterns, model settings. |

Scope is enforced **server-side** on every route; the frontend cannot widen it.

### Rate limits
- **Global:** 600 requests / 15 min per IP (all `/api/*`).
- **Auth:** 20 requests / 15 min per IP (`/api/auth/*`) — blunts credential stuffing.

### Common error shape
```json
{ "message": "Human-readable reason" }
```
Validation errors may add an `errors` array. 500s include a `request_id` (matches `x-request-id` header) for log correlation. Standard codes used: `400` (bad input), `401` (unauthenticated), `403` (out of scope / role), `404` (not found), `409` (conflict), `429` (rate limited).

---

## Health

### `GET /api/health` · _public_
Liveness + config probe (used by the ALB target group health check).
```json
{
  "status": "ok",
  "timestamp": "2026-06-13T00:00:00.000Z",
  "s3_configured": true,
  "sqs_configured": true,
  "openai_configured": true,
  "sentry_configured": true
}
```

---

## Auth — `/api/auth`

Self-service first-login model: a user is created without a password and chooses one on first login.

### `POST /api/auth/login` · _public_
Body: `{ "email": string, "password"?: string }`
- Unknown / inactive email → `401`
- Known email, **no password set yet** → `200 { "needs_password_setup": true }` (client then calls `/set-password`)
- Known email **with** password → verifies → `200 { "token", "user" }` or `401`

### `POST /api/auth/set-password` · _public_
Body: `{ "email": string, "password": string }`
First-login only — sets the initial password for a known, active, password-less user and signs them in (`200 { "token", "user" }`). Returns `409` if a password already exists (a reset must go through an admin). Password must meet the minimum length.

### `GET /api/auth/me` · _authenticated_
Returns the currently authenticated user (`publicUser` shape — no password hash).

---

## Users — `/api/users` · _admin+_

### `GET /api/users`
List users. `admin` sees only their own team (plus themselves); `super_admin` sees everyone.

### `POST /api/users`
Create a user. Body: `{ email, name, role, team?, agent_id? }`.
- `super_admin` can create any role/team; `admin` is bounded by `canManageUser` (own team, can't escalate).
- New users have **no password** (set on first login). `201` with the created user, `409` if the email exists.

### `PATCH /api/users/:id`
Update `{ name?, role?, team?, agent_id?, status? }` within permission bounds.
- `admin` **cannot** change `role` or `team` (super_admin only).

### `DELETE /api/users/:id`
Remove a user. Cannot delete yourself; cannot delete the **last** `super_admin`. RBAC-enforced.

---

## Teams — `/api/teams`

A team carries its **primary rubric** (criteria, system prompt, thresholds) and optional per-team **infra** (buckets/queues/tuning).

### `GET /api/teams` · _any authenticated_
List all teams.

### `GET /api/teams/:id` · _any authenticated_
A single team. `404` if not found.

### `POST /api/teams` · _super_admin_
Create a team. Body: `{ team_id, name, description?, criteria?, system_prompt?, scale_max?, flag_threshold?, critical_criterion_threshold?, infra? }`.
- `team_id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$` (URL-safe slug; it's the DB key).
- `409` if the team exists; `criteria` validated if provided.

### `PATCH /api/teams/:id` · _admin (own team) / super_admin_
Edit a team.
- **Rubric fields** (criteria, prompt, thresholds): admin (own team) or super_admin.
- **`infra` and `active`**: `super_admin` only.

---

## Audits — `/api/audits` · _authenticated, scope-enforced_

Scope: `super_admin` = all, `admin` = own team, `user` = own calls.

### `GET /api/audits`
Paginated list of audits visible to the caller.
Query: `?team=CS` *(super_admin only)* `&flagged=true&from=<ISO>&to=<ISO>&limit=200&cursor=<opaque>`
Returns: `{ "items": AuditRecord[], "nextCursor"?: string }`

### `GET /api/audits/:id`
A single audit (scope enforced — `403 Out of scope` otherwise).

### `GET /api/audits/:id/transcript`
The full transcript text for an audit: `{ "audit_id", "transcript" }`. `404` if no transcript yet.

### `POST /api/audits/reprocess` · _admin+_
Re-ingest a recording through the **full pipeline** (transcribe → audit). Body: `{ "recording_key": string }`.
Routes to the owning team's transcription queue (resolved from the recording), else the global queue. Idempotent (already-audited calls are skipped). Returns `{ "ok": true, "queued": "<key>" }`. **Use this to backfill old recordings.**

### `POST /api/audits/:id/reaudit` · _admin+_
Re-run **only the audit stage** on an already-transcribed call (e.g. after a rubric change). Resets status to `transcribed` and re-enqueues to the audit queue. `400` if there's no transcript. Returns `{ "ok": true, "queued": "<audit_id>" }`.

---

## Performance — `/api/performance` · _authenticated, scope-enforced_

Score/volume time series rolled up into headline numbers + delta vs the previous period.

### `GET /api/performance/me`
The caller's **own** performance. Scope chosen by role:
- `user` → their own **agent** series (personal performance).
- `admin` / `super_admin` → their own **team** series (falls back to agent series if no team).

Query: `?granularity=day|month|year` (default `month`).
Returns: `{ "scope": {type,id} | null, "granularity", "series": [...], "summary": {...} }`.

### `GET /api/performance`
Scoped series for a specific agent or team (RBAC-enforced via `authorizeScope`).
Query: `?scope=agent|team&id=<id>&granularity=day|month|year&from&to` (`scope` + `id` required).
- `super_admin`: any scope. `admin`: own team or an agent within it. `user`: only their own `agent_id` → anything else `403`.

---

## Settings — `/api/settings`

Singleton platform settings — the OpenAI models the pipeline uses. These **override** the `OPENAI_*_MODEL` env fallbacks and propagate to workers within ~60s (settings cache).

### `GET /api/settings` · _admin+_
Current settings: `{ transcription_model, audit_model, updated_at, updated_by, ... }`.

### `PATCH /api/settings` · _super_admin_
Body: `{ "transcription_model"?: string, "audit_model"?: string }` (provide at least one).
Model id must be a non-empty, whitespace-free token ≤100 chars. No redeploy needed.

---

## Recording Patterns — `/api/patterns` · _super_admin_

Regex patterns that extract `agent_id` (and other fields) from recording filenames/keys. Each pattern must include a named capture group `(?<agent_id>...)`.

### `GET /api/patterns`
List all patterns (by priority).

### `POST /api/patterns/test`
Dry-run a pattern before saving. Body: `{ regex, flags?, sample }`.
Returns `{ "matched": boolean, "groups": {...} | null }`.

### `POST /api/patterns`
Create a pattern. Body: `{ label, regex, flags?, priority?, active? }`. New patterns default to the **end** of the priority order. `201` with the pattern.

### `PATCH /api/patterns/:id`
Edit `{ label?, regex?, flags?, priority?, active? }` (regex re-validated if changed).

### `DELETE /api/patterns/:id`
Delete a pattern. The **built-in default** pattern cannot be deleted (deactivate it instead → `400`).

---

## Rubrics — `/api/rubrics` · _admin+_

**Additional** rubrics for a team (the primary rubric lives on the team row). Scope: admin (own team) / super_admin.

### `GET /api/rubrics?team=<id>`
List a team's additional rubrics. `team` query param required.

### `POST /api/rubrics`
Create. Body: `{ team_id, name, criteria, description?, system_prompt?, scale_max?, flag_threshold?, critical_criterion_threshold?, active? }`. `criteria` validated. `201` with the rubric.

### `PATCH /api/rubrics/:id`
Edit any rubric field (criteria re-validated if present).

### `DELETE /api/rubrics/:id`
Delete an additional rubric.

---

## Feedback — `/api/feedback` · _admin+_

A reviewer's correction of an AI audit. The AI verdict is snapshotted at submission so the divergence signal survives a later re-audit. Scoped to the audit/team's team.

### `GET /api/feedback`
List feedback. Provide **one** of:
- `?audit=<id>` — feedback for a single call, or
- `?team=<id>` — all feedback for a team.

### `POST /api/feedback`
Submit a correction. Body:
```json
{
  "audit_id": "string (required)",
  "rubric_id": "string (default 'primary')",
  "disposition": "agree | disagree | partial (default disagree)",
  "comment": "string (required unless disposition='agree')",
  "human_score": 0,
  "human_flagged": false,
  "criteria_corrections": [{ "name": "...", "ai_score": 0, "human_score": 0, "note": "..." }]
}
```
`201` with the stored feedback.

### `DELETE /api/feedback/:id`
Delete feedback — **author or super_admin** only.

---

## Suggestions — `/api/suggestions` · _admin+_

AI-generated rubric-improvement suggestions, derived from comparing AI scores against reviewer feedback. Scoped to the team.

### `GET /api/suggestions?team=<id>`
List a team's suggestions. `team` query param required.

### `POST /api/suggestions/generate`
Analyze a team's feedback for one rubric and produce a fresh suggestion. Body: `{ "team": string, "rubric_id"?: string (default "primary") }`.
Requires existing feedback for that rubric (`400` otherwise). Uses the configured audit model. `201` with the suggestion (summary, suggested system prompt, criteria changes).

### `PATCH /api/suggestions/:id`
Set status. Body: `{ "status": "open | applied | dismissed" }`.

### `DELETE /api/suggestions/:id`
Delete a suggestion.

---

## Endpoint summary

| Method | Path | Min role | Notes |
|---|---|---|---|
| GET | `/api/health` | public | liveness probe |
| POST | `/api/auth/login` | public | login / detect first-login |
| POST | `/api/auth/set-password` | public | first-login password set |
| GET | `/api/auth/me` | authenticated | current user |
| GET | `/api/users` | admin | own team for admin |
| POST | `/api/users` | admin | create user/admin |
| PATCH | `/api/users/:id` | admin | role/team = super_admin only |
| DELETE | `/api/users/:id` | admin | protects last super_admin |
| GET | `/api/teams` | authenticated | list |
| GET | `/api/teams/:id` | authenticated | one |
| POST | `/api/teams` | super_admin | create |
| PATCH | `/api/teams/:id` | admin | infra/active = super_admin only |
| GET | `/api/audits` | authenticated | scoped, paginated |
| GET | `/api/audits/:id` | authenticated | scoped |
| GET | `/api/audits/:id/transcript` | authenticated | scoped |
| POST | `/api/audits/reprocess` | admin | full re-ingest / backfill |
| POST | `/api/audits/:id/reaudit` | admin | re-run audit stage only |
| GET | `/api/performance/me` | authenticated | personal (user) / team (admin+) |
| GET | `/api/performance` | authenticated | scoped by `authorizeScope` |
| GET | `/api/settings` | admin | view models |
| PATCH | `/api/settings` | super_admin | change models (~60s propagation) |
| GET | `/api/patterns` | super_admin | list |
| POST | `/api/patterns/test` | super_admin | dry-run |
| POST | `/api/patterns` | super_admin | create |
| PATCH | `/api/patterns/:id` | super_admin | edit |
| DELETE | `/api/patterns/:id` | super_admin | built-in protected |
| GET | `/api/rubrics` | admin | `?team=` required |
| POST | `/api/rubrics` | admin | own team |
| PATCH | `/api/rubrics/:id` | admin | edit |
| DELETE | `/api/rubrics/:id` | admin | delete |
| GET | `/api/feedback` | admin | `?audit=` or `?team=` |
| POST | `/api/feedback` | admin | submit correction |
| DELETE | `/api/feedback/:id` | admin | author or super_admin |
| GET | `/api/suggestions` | admin | `?team=` required |
| POST | `/api/suggestions/generate` | admin | needs feedback |
| PATCH | `/api/suggestions/:id` | admin | set status |
| DELETE | `/api/suggestions/:id` | admin | delete |
