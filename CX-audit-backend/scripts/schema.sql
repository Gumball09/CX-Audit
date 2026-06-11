-- ===========================================================================
-- CX Audit — Postgres / Supabase schema
-- Run this in the Supabase SQL editor (or `npm run db:migrate`). Idempotent.
-- Mirrors the 6 former DynamoDB tables; JSONB holds the nested arrays.
-- ===========================================================================

-- 1. Users — identity + agent_id→team mapping
CREATE TABLE IF NOT EXISTS cx_users (
  user_id     text PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL,
  team        text,
  agent_id    text,
  status      text NOT NULL DEFAULT 'active',
  created_at  text NOT NULL,
  created_by  text,
  updated_at  text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cx_users_email_idx ON cx_users (email);
CREATE INDEX IF NOT EXISTS cx_users_agent_idx ON cx_users (agent_id);

-- 2. Teams — one rubric per team
CREATE TABLE IF NOT EXISTS cx_teams (
  team_id                       text PRIMARY KEY,
  name                          text NOT NULL,
  description                   text NOT NULL DEFAULT '',
  criteria                      jsonb NOT NULL DEFAULT '[]'::jsonb,
  system_prompt                 text NOT NULL DEFAULT '',
  scale_max                     integer,
  flag_threshold                integer NOT NULL DEFAULT 70,
  critical_criterion_threshold  integer NOT NULL DEFAULT 60,
  updated_at                    text NOT NULL,
  updated_by                    text
);

-- 3. Audits — one row per call through the pipeline
CREATE TABLE IF NOT EXISTS cx_audits (
  audit_id              text PRIMARY KEY,
  recording_key         text NOT NULL,
  recording_url         text,
  agent_id              text NOT NULL,
  session_id            text,
  campaign              text,
  customer_number       text,
  call_datetime         text,
  team                  text,
  status                text NOT NULL,
  error                 text,
  transcription_key     text,
  transcription_url     text,
  audit_key             text,
  audit_url             text,
  score                 integer,
  flagged               boolean,
  flag_reason           text,
  criteria_scores       jsonb,
  performance_recorded  boolean NOT NULL DEFAULT false,
  created_at            text NOT NULL,
  transcribed_at        text,
  audited_at            text,
  updated_at            text NOT NULL
);
CREATE INDEX IF NOT EXISTS cx_audits_agent_idx ON cx_audits (agent_id, call_datetime DESC);
CREATE INDEX IF NOT EXISTS cx_audits_team_idx  ON cx_audits (team, call_datetime DESC);
CREATE INDEX IF NOT EXISTS cx_audits_dt_idx    ON cx_audits (call_datetime DESC);

-- 4. Recording patterns — super_admin-configurable filename regexes
CREATE TABLE IF NOT EXISTS cx_recording_patterns (
  pattern_id   text PRIMARY KEY,
  label        text NOT NULL,
  regex        text NOT NULL,
  flags        text NOT NULL DEFAULT 'i',
  priority     integer NOT NULL DEFAULT 1,
  active       boolean NOT NULL DEFAULT true,
  match_count  bigint NOT NULL DEFAULT 0,
  is_builtin   boolean NOT NULL DEFAULT false,
  created_by   text,
  created_at   text NOT NULL,
  updated_at   text NOT NULL
);
CREATE INDEX IF NOT EXISTS cx_patterns_active_idx ON cx_recording_patterns (active, priority);

-- 5. Performance — time-bucketed aggregates (pk = agent#/team#, bucket = day#/month#/year#)
CREATE TABLE IF NOT EXISTS cx_performance (
  pk             text NOT NULL,
  bucket         text NOT NULL,
  scope_type     text NOT NULL,
  scope_id       text NOT NULL,
  granularity    text NOT NULL,
  period         text NOT NULL,
  call_count     bigint NOT NULL DEFAULT 0,
  score_sum      bigint NOT NULL DEFAULT 0,
  flagged_count  bigint NOT NULL DEFAULT 0,
  updated_at     text NOT NULL,
  PRIMARY KEY (pk, bucket)
);

-- 6. Settings — singleton platform config (OpenAI models)
CREATE TABLE IF NOT EXISTS cx_settings (
  setting_id           text PRIMARY KEY,
  transcription_model  text,
  audit_model          text,
  updated_at           text,
  updated_by           text
);
