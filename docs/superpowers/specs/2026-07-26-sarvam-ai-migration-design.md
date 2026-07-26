# PRD — Migrating CX Audit from OpenAI to Sarvam AI

**Date:** 2026-07-26
**Status:** Draft for review
**Author:** Shubh Mehrotra (with Claude)
**Scope:** `CX-audit-backend` transcription + audit pipeline, `CX-audit-dashboard` settings surface

---

## 1. Summary

CX Audit currently transcribes and scores support calls with OpenAI
(`gpt-4o-mini-transcribe` + `gpt-4o`). We are moving the pipeline to **Sarvam AI**,
an Indian-language AI platform, because our recordings are 8 kHz mono telephony
audio in mixed Hindi–English and OpenAI's models handle that input badly.

This PRD covers two phases:

- **Phase 0 — Bound the spend.** Stop transcribing calls that can never be
  audited, and turn on the per-agent daily cap that already exists in the code.
  This is where the cost saving actually comes from.
- **Phase 1 — Sarvam provider.** Sarvam becomes the pipeline, selected by a
  single constant that defaults to it. The OpenAI path stays intact and tested as
  a break-glass fallback, but is not expected to be used. This is where the
  accuracy and capability gains come from.

**The headline correction to our original assumption:** switching providers does
not by itself reduce the bill. Sarvam's audit LLM is ~36× cheaper per token, but
Sarvam's speech-to-text with diarization costs **₹45/hour of audio** versus
roughly **₹16/hour per attempt** for `gpt-4o-mini-transcribe`. The ~$100/week
overspend is caused by waste and by unbounded volume, not by OpenAI's rates.
Phase 0 fixes the cost problem; Phase 1 fixes the quality problem.

---

## 2. Background

### 2.1 What the pipeline does today

Two SQS-driven stages in `src/services/pipeline.ts`:

1. **`processTranscription`** — registers the recording, probes duration, applies
   two gates, transcribes via OpenAI, writes `transcriptions/<audit_id>.txt` to
   S3, enqueues stage 2.
2. **`processAudit`** — loads the transcript, resolves the team's rubric(s),
   scores each rubric with `gpt-4o`, writes `audits/<audit_id>.json`, updates the
   audit row and performance rollups.

All OpenAI interaction lives in `src/services/openai.ts`, imported from exactly
two places: `src/services/pipeline.ts` and `src/routes/suggestions.ts`.

Model selection is runtime-configurable through the `cx_settings` singleton
(super-admin editable, 60-second worker cache). **There is currently no settings
row in prod**, so every value falls back to the env defaults.

### 2.2 The audio we actually receive

Probed three production recordings, one per campaign (CS, RM, Escalations):

| Property | Value |
|---|---|
| Container / codec | mp3 |
| Sample rate | **8000 Hz** |
| Channels | **1 (mono)** — all three |
| Bitrate | **8–23 kbps** |
| Source | CZentrix dialer |

Two consequences:

- **Mono rules out channel-based speaker separation.** We cannot get
  agent-vs-customer for free by splitting stereo channels, so Sarvam's
  diarization tier (₹45/hr, not ₹30/hr) is required.
- **8 kbps is extreme compression, and it is why our current transcripts are
  bad.** `src/services/openai.ts` already documents the symptom: *"setting
  temperature=0 made the gpt-4o-transcribe models loop MORE on low-bitrate
  telephony audio."* The entire retry ladder in `transcribeResilient` (up to 4
  attempts, keeping the least-repetitive result) plus `collapseRepetitions`
  exists to paper over hallucinated repetition loops on exactly this input.

Sarvam documents 8 kHz telephony as a first-class supported input. This is the
strongest single argument for the migration — stronger than pricing.

> **Caveat:** three files across three campaigns is a good signal, not proof for
> every recording. Phase 1 therefore probes channel count per file at ingest and
> keeps a stereo branch available (§7.5), so a differently-configured campaign
> degrades gracefully instead of silently mis-assigning speakers.

### 2.3 Where the money actually goes

Scan of `cx_audits` in prod (7,030 rows):

| Status | Rows | Audio hours | Distinct agents |
|---|---|---|---|
| `audited` (productive) | 1,966 | 195.7 | 10 |
| `failed` (**wasted**) | 2,273 | **217.3** | 15 |
| `skipped` (free — gated before spend) | 2,788 | 19.9 | 18 |
| `transcribing` (in flight) | 3 | 0.0 | 3 |

**All 2,273 failures carry the identical error:**

```
No team mapping for agent <id>; cannot select rubric.
```

That error is raised in **stage 2** (`processAudit`, `pipeline.ts:163-166`) —
*after* the recording has already been fully transcribed and paid for. So
**53% of every transcription hour we have ever paid for was discarded.**

The root cause is that the check already runs early and does nothing.
`pipeline.ts:43-47` resolves the team in stage 1 and, when it is missing, emits
`logger.warn("No team mapping for agent ...")` — then transcribes anyway. The gate
that would have prevented the spend sits one line above it, wired as a log line
instead of a `return`.

Supporting data: `cx_users` holds 18 users but only **10** have both an
`agent_id` and a `team`, while **15** distinct agents appear in the failed rows.

Duration distribution across 6,779 rows with a probed duration:
`min=0s, p50=88s, p90=608s, max=3405s`. Half of all calls are under 90 seconds,
so the 600-second gate is doing real work — but only for mapped agents.

> **Caveat on absolute dollars:** this table appears to have been wiped at least
> once, so treat the **53% ratio** as reliable and the derived dollar figures as a
> floor rather than a full account of the ~$100/week.

### 2.4 The cost control we built and never switched on

`daily_audit_cap` — max calls audited per agent per day — is **fully
implemented**: `types.ts:91`, create/patch in `routes/teams.ts:78,122`, the gate
at `pipeline.ts:100-120`, and a dashboard input at
`AuditPromptsView.tsx:196`. It is enforced *before* transcription, so a capped
call costs nothing.

It is **unset on all three teams** (`Escalations`, `CS`, `RM`), meaning unlimited.

**Critical interaction:** the cap check is nested inside `if (team)` at
`pipeline.ts:100`. An unmapped agent has `team === null`, so it **skips the cap
entirely**, transcribes without limit, and then fails in stage 2. The cap cannot
bound our spend until the no-team gate from §2.3 exists. Phase 0 is a
prerequisite for the cap working, not an independent nice-to-have.

---

## 3. Goals

**Sarvam becomes the pipeline. OpenAI becomes a break-glass fallback.**

1. **Sarvam is the default and only path in normal operation.** A single
   constant selects the provider; flipping it back to OpenAI is an emergency
   escape hatch, not a routine choice. The OpenAI code stays working and tested,
   but nobody is expected to use it.
2. **The cap flow is correct and matches what the admin tool promises.** When an
   admin types `3` into "Calls audited per member / day", exactly 3 calls per
   agent per day get audited — no bypass, no silent "unlimited", no overshoot.
3. Transcribe mixed Hindi–English calls faithfully, in Roman script, so any
   reviewer can read them.
4. Attribute every transcript turn to **agent** or **customer**.
5. Keep total AI spend inside the ~$350–400/month budget, predictably.

## 4. Non-goals

- Removing or deprecating the OpenAI code path.
- Real-time / streaming transcription (we audit recordings after the fact).
- Text-to-speech, voice agents, or document digitization.
- Word-level timestamps (Sarvam's Batch API provides chunk-level only).
- Re-transcribing the existing corpus. Historic transcripts stay as they are;
  the existing Bulk Run feature can reprocess a chosen subset if wanted.
- Multi-file batching (20 recordings per Sarvam job). Deliberately deferred —
  see §7.4.
- Per-team provider selection. `AI_PROVIDER` is a single global constant.
- A dashboard provider selector. Switching providers is a deploy-time decision,
  deliberately not an admin-facing knob (§7.2).

---

## 5. Phase 0 — Bound the spend

Ships first, independently deployable, no Sarvam dependency. Its purpose is both
to stop the waste and to establish a clean cost baseline — we cannot honestly
measure Sarvam's cost impact while half the bill is garbage.

### 5.1 Gate unmappable calls before transcription

In `processTranscription`, promote the existing team-resolution warning into a
gate placed alongside the other two gates — after the duration probe, before
`transcribeAudio`:

```ts
if (!team) {
  await updateAudit(auditId, {
    status: "skipped",
    skip_reason: "no_team",
    duration_sec: durationSec > 0 ? Math.round(durationSec) : undefined,
  });
  logger.info(`Skipping ${auditId} — no team mapping for agent ${meta.agent_id}`);
  return;
}
```

- Add `"no_team"` to the `skip_reason` union, which is declared **twice** and must
  be updated in both places: `CX-audit-backend/src/types.ts:208` and
  `CX-audit-dashboard/src/lib/cx-data.ts:171` (currently
  `"too_short" | "daily_cap"`). The dashboard renders the reason, so missing the
  second one produces an unlabelled skip in the UI.
- `skipped` is already re-processable (`pipeline.ts:71`), so once an agent gets
  mapped, a reprocess picks the call up. Nothing is lost — only deferred.
- Stage 2's existing failure branch stays as a backstop for rows that raced the
  gate.

### 5.2 Backfill agent → team mappings

At least 5 agents are calling without a `cx_users` mapping. Produce the list of
unmapped `agent_id`s from `cx_audits`, get them assigned to teams, and write
them into `cx_users`. Recurring hygiene: surface "unmapped agents seen in the
last 7 days" in the dashboard so this cannot silently rot again.

### 5.3 Make the per-agent daily cap actually hold

The admin tool is already built and unambiguous: `AuditPromptsView.tsx:191`
reads **"Calls audited per member / day"**, with helper text *"Max calls audited
per agent each day for this team. 0 = unlimited. Extras are skipped before
transcription."* The counting path is efficient too — a day-scoped `Query` on the
`agent-index` GSI (`agent_id` HASH + `call_datetime` RANGE), not a table scan.

So the tool is right and the storage is right. **The enforcement is what does not
match the promise.** Four defects, in severity order:

**(a) The cap is bypassed entirely for unmapped agents.** The check sits inside
`if (team)` at `pipeline.ts:100`. `team === null` means no cap at all — unlimited
transcription, then guaranteed stage-2 failure. This is the same root cause as
§2.3, and it is why the cap has never bounded anything. Fixed by ordering the
§5.1 `no_team` gate **before** the cap gate, after which the `if (team)` wrapper
is removed so the cap is unconditional.

**(b) An invalid cap silently means unlimited.** `sanitizeCap`
(`routes/teams.ts:16-20`) returns `undefined` for any non-numeric input, and
`undefined` is treated as unlimited. So a typo in the admin field fails **open**
— the worst possible direction for a spend control. Change it to reject with a
400 so the admin sees the error instead of an uncapped team.

**(c) New teams default to unlimited.** `routes/teams.ts:78` calls
`sanitizeCap(b.daily_audit_cap)` with no fallback. Default to `3` so a newly
created team cannot silently run uncapped.

**(d) The cap overshoots under concurrency.** The code documents this as
best-effort: the count is read, then acted on, with no atomicity. With
`WORKER_CONCURRENCY = 5` across up to 10 transcribe tasks, up to ~50 messages are
in flight, so several calls from the same agent on the same day can clear the
check simultaneously. At a cap of 3 an overshoot of 2–3 calls is a 60–100% error
— tolerable at a cap of 100, not at 3.

Fix with an **atomic reservation** rather than a read-then-check. Keep a counter
item per `(agent_id, date)` and claim a slot with a single conditional
`UpdateItem`:

```
UpdateExpression:      SET audited_count = if_not_exists(audited_count, :zero) + :one
ConditionExpression:   attribute_not_exists(audited_count) OR audited_count < :cap
```

A `ConditionalCheckFailedException` means the cap is reached — skip with
`skip_reason: "daily_cap"`, exactly as today. This makes the admin's `3` mean 3.
The counter is claimed *before* transcription, so a reserved-but-failed call must
release its slot (decrement) on failure, or the reservation must be keyed on
`audit_id` so a retry of the same recording is idempotent rather than consuming a
second slot.

**Then set `daily_audit_cap = 3` on all three teams** (`Escalations`, `CS`, `RM`),
which are currently unset. That part is pure admin action, available today.

### 5.4 Cap semantics — decided

- **Period:** per agent, per **calendar day**, using the *call's* date
  (`call_datetime`), not the processing date. Backfills therefore count against
  the day the call happened, which is what makes historical reprocessing safe.
- **Ownership:** the cap comes from the team row resolved as
  `queueTeamId ?? agentUser?.team`. An agent who changes teams mid-day is subject
  to whichever team's cap applies to each call. Acceptable; documented rather
  than solved.
- **Interaction with the duration gate:** the duration gate runs first, so short
  calls are skipped without consuming cap slots. The cap therefore counts only
  audit-worthy calls, which is the intended behaviour.
- **Ordering of all gates after this change:** duration → `no_team` → cap
  reservation → transcribe.

### 5.5 Reduce retry amplification

`TRANSCRIPTION_MAX_RETRIES` defaults to 3 (so up to 4 attempts per recording).
On 8 kbps audio this multiplies both productive and wasted spend. Actions:

- Instrument it: count retries per recording and emit the rate. The warning at
  `openai.ts:82-86` already fires on every loop retry, so the historic rate is
  recoverable from logs. **This number decides whether Phase 1 saves or costs
  money** (§6), so it must be measured before Phase 1 deploys.
- Consider lowering the default to 1 retry on the OpenAI path once the rate is
  known.

### 5.6 Phase 0 acceptance criteria

- Zero new `failed` rows with the `No team mapping` error.
- A `skipped` / `no_team` count that matches the previous failure volume.
- `daily_audit_cap = 3` live on all three teams.
- A measured average transcription-attempts-per-recording figure recorded in
  this document.

---

## 6. Cost model

Assumes ₹88 = $1. Sarvam rates are from Sarvam's published pricing page. The
OpenAI audio rate is from memory of OpenAI's published per-minute pricing and
**must be checked against an actual invoice before sign-off.**

| Service | Rate |
|---|---|
| Sarvam STT (`saaras:v3`) | ₹30 / hour of audio |
| Sarvam STT **+ diarization** | **₹45 / hour** ← our path |
| Sarvam `sarvam-105b` | ₹4 in / ₹2.5 cached / ₹16 out per 1M tokens |
| Sarvam `sarvam-30b` | ₹2.5 in / ₹1.5 cached / ₹10 out per 1M tokens |
| Sarvam text translate | ₹20 / 10K characters |
| Sarvam language ID | ₹3.5 / 10K characters |
| OpenAI `gpt-4o-mini-transcribe` | ~₹16 / hour, **per attempt** |
| OpenAI `gpt-4o` | ~₹220 in / ₹880 out per 1M tokens |

### 6.1 Per-call comparison

A qualifying call (≥600 s) averages **0.28 hours** (16.8 min), derived from the
696 rows at or above the gate totalling 195.0 hours. Assume 2 rubrics scored.

| Scenario | Transcription | Audit | **Total** |
|---|---|---|---|
| OpenAI, 1 attempt | ₹4.5 | ₹3.8 | **₹8.3** |
| OpenAI, 3 attempts | ₹13.4 | ₹3.8 | **₹17.2** |
| Sarvam, diarized | ₹12.6 | ₹0.10 | **₹12.7** |

So Sarvam lands **between** OpenAI's best and worst case. If our real retry
average is ≈3 attempts, Sarvam is cheaper *and* better. If most calls transcribe
cleanly on the first try, Sarvam costs ~1.5× more. Hence §5.5.

### 6.2 Bounded monthly spend after Phase 0

```
monthly_cost = agents × cap × working_days × avg_qualifying_hours × rate
```

With `cap = 3`, 22 working days, and a 0.28 h average qualifying call. Agent
count is **assumed to be 18 after the §5.2 backfill** — today only 10 are mapped,
while 15 distinct agents appear in the failed rows and `cx_users` holds 18 people
in total. Substitute the real post-backfill number once it is known; the figure
scales linearly with it.

- **Ceiling volume:** 1,188 calls ≈ 333 audio-hours / month
- **Sarvam:** 333 × ₹45 ≈ ₹15,000 ≈ **$170 / month**
- **OpenAI (1 attempt):** ≈ $61 / month; **(3 attempts):** ≈ $182 / month

Both sit inside the $350–400 budget. This is a genuine ceiling, not an estimate:
the 600-second duration gate means most agents will not produce 3 qualifying
calls a day, so real spend should land well below it.

**Conclusion: the cap is what solves the budget problem. Sarvam is what solves
the quality problem.** They are independent, and the PRD should be sold that way.

---

## 7. Phase 1 — Sarvam provider

### 7.1 Provider abstraction

```
src/services/ai/
  types.ts     — TranscriptionResult, AuditResult, SuggestionOutput, provider interface
  openai.ts    — today's implementation, moved verbatim
  sarvam.ts    — new
  index.ts     — resolves the provider from settings and dispatches
```

`index.ts` re-exports `transcribeCall`, `auditTranscript`,
`suggestRubricImprovements` with unchanged signatures, so only two import sites
change: `pipeline.ts:12` and `routes/suggestions.ts:16`.

Each provider module owns its own client construction, stub-mode behaviour, and
error classification. Neither imports the other.

### 7.2 The toggle — a constant, not a runtime setting

Per goal 1, the provider is a **build-time constant in `src/env.ts`**, alongside
the other configuration constants. Sarvam is the default. There is deliberately
**no provider selector in the dashboard** — switching back to OpenAI is a
break-glass action, not a knob for admins to explore.

| Constant | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | **`"sarvam"`** | `"sarvam"` \| `"openai"` |
| `SARVAM_API_KEY` | — | SSM SecureString, injected into all three task definitions |
| `SARVAM_STT_MODEL` | `"saaras:v3"` | Sarvam ASR model |
| `SARVAM_STT_MODE` | `"translit"` | `transcribe`/`translate`/`verbatim`/`translit`/`codemix` |
| `SARVAM_LANGUAGE_CODE` | `"unknown"` | BCP-47, or `unknown` to auto-detect |
| `SARVAM_DIARIZATION` | `true` | Speaker separation (the ₹45/hr tier) |
| `SARVAM_NUM_SPEAKERS` | `2` | `0` = auto-detect |
| `SARVAM_AUDIT_MODEL` | `"sarvam-105b"` | Chat model for scoring |

Anything invalid in `AI_PROVIDER` must **fail startup**, not silently fall back —
a typo that quietly reverts the whole pipeline to OpenAI is exactly the failure we
are trying to design out. `validateEnv("worker")` requires a key for the selected
provider only, and keeps the existing stub-mode fallback when none is present.

The existing `cx_settings` row keeps its current job — tuning `min_audit_duration_sec`
and the model ids of **whichever provider is active** — so super-admin model
tuning keeps working without a provider selector. `OPENAI_TRANSCRIPTION_MODEL` /
`OPENAI_AUDIT_MODEL` remain the OpenAI-path defaults, unchanged.

Dashboard: `SettingsView.tsx` displays the active provider **read-only**, and its
model-suggestion lists in `cx-data.ts` become provider-aware
(`SARVAM_TRANSCRIPTION_MODES`, `SARVAM_AUDIT_MODELS` beside the existing OpenAI
lists). Copy that hardcodes "OpenAI" becomes provider-neutral:
`SettingsView.tsx:9,60` and `BulkRunView.tsx:17,85,154` ("re-incurs OpenAI cost").

**Accepted trade-off:** because this is a constant, flipping back to OpenAI means
updating the three ECS task definitions and forcing a new deployment — minutes,
during an incident, not a 60-second settings flip. That is the cost of goal 1's
simplicity, and it is the right call given OpenAI is meant to be unused. If a
no-deploy rollback later proves necessary, the escape hatch is a single optional
`ai_provider` override read from the existing settings row, defaulting to the
constant — roughly ten lines, deliberately not built now.

**Rollout consequence:** unlike the earlier draft, deploying Phase 1 **does**
change behaviour immediately, because the default is Sarvam. The validation gate
in §9 therefore has to run *before* the production deploy — see §10.

### 7.3 Stage 2 — auditing (the straightforward half)

Sarvam's chat API is **OpenAI-wire-compatible**: `POST
https://api.sarvam.ai/v1/chat/completions`, and it accepts
`Authorization: Bearer <key>` in addition to Sarvam's native
`api-subscription-key` header. We therefore reuse the existing `openai` npm SDK
with `baseURL` and `apiKey` swapped, and `auditTranscript` /
`suggestRubricImprovements` collapse into one implementation parameterised by
(client, model).

Two mandatory deltas from the current call shape:

- **`max_tokens: 2000`** (up from 900) and **`reasoning_effort: null`**.
  `sarvam-105b` has reasoning **on by default**, and reasoning tokens count
  against `max_tokens` — our current 900 would truncate the JSON mid-response.
  Sarvam's own call-analytics cookbook calls this out explicitly.
- Error mapping: Sarvam returns **403** for an invalid key (not 401), and 429 for
  both quota exhaustion and rate limiting.

**Correction after live testing — `json_schema` is unusable on `sarvam-105b`.**
The docs advertise strict structured outputs, but in practice the model emits the
schema's own key names as values and then pads newlines until it hits
`max_tokens` (`finish_reason: "length"`, unparseable). `response_format:
{ type: "json_object" }` returns clean JSON and is what we use. So the
regex-salvage parsing at `openai.ts:340-352` **stays** — it is load-bearing, not
legacy.

Worse, `reasoning_effort: null` turns out to be mandatory rather than an
optimisation: without it the response comes back with **empty `content`** and the
entire answer stranded in a `reasoning_content` field, because reasoning tokens
are spent before any content is emitted.

Overall score computation stays where it is — computed locally from rubric weights
in `weightedOverall`, never trusted from the model.

Context budget: `sarvam-105b` has a 128K window, `sarvam-30b` 64K. Our longest
call is 3,405 s (~57 min ≈ 9K tokens), so a full transcript plus rubric fits
comfortably. No chunking needed.

### 7.4 Stage 1 — transcription (the hard half)

**Sarvam's synchronous STT endpoint caps at 30 seconds of audio.** Our audit
floor is 600 s. The Batch job API is therefore mandatory, and it is
asynchronous:

| Step | Call |
|---|---|
| 1. Init | `POST /speech-to-text/job/v1` with `job_parameters` |
| 2. Get upload URLs | `POST /speech-to-text/job/v1/upload-files` → presigned URLs |
| 3. Upload | `PUT` the audio buffer to the presigned URL |
| 4. Start | `POST /speech-to-text/job/v1/start` |
| 5. Poll | `GET /speech-to-text/job/v1/{job_id}/status` |
| 6. Download | `POST /speech-to-text/job/v1/download-files` with `{job_id, files: ["0.json"]}` |

Because step 3 uses **presigned URLs**, the worker can upload the S3 buffer
directly — no temp files on disk, unlike the SDK's file-path-oriented helpers.
Limits: 2 hours per file, 20 files per job, up to 20 speakers.

**Chosen integration: poll inline inside the existing transcribe worker.** This
keeps the queue topology, worker model, and SQS-backlog autoscaling completely
unchanged — `processTranscription` still returns only when the transcript is
stored. Three mitigations make it safe:

1. **Persist `sarvam_job_id` on the audit row immediately after step 4.** On SQS
   redelivery, resume polling the existing job instead of submitting a new one.
   Without this, a redelivery double-bills the recording.
2. **Heartbeat the message visibility** via `ChangeMessageVisibility` while
   polling, so a slow job does not get redelivered mid-flight.
3. **Raise the queue visibility timeout.** Note a discrepancy to resolve:
   `scripts/create-infra.ts:248` provisions `VisibilityTimeout: 300`, while
   `ARCHITECTURE.md` documents 900 for the transcription queue. Verify the live
   value before rollout.

Poll with a 5-second interval and a ceiling generous enough for a 57-minute
recording; on timeout, leave the row `transcribing` with its `sarvam_job_id` so a
later reprocess can resume rather than re-pay.

*Deferred (documented, not built):* **webhook callbacks**
(`callback: {url, auth_token}`, validated via the `X-SARVAM-JOB-CALLBACK-TOKEN`
header) would free the worker slot entirely. They need a public HTTPS endpoint,
which `ARCHITECTURE.md` still marks *planned* for the API. Revisit once HTTPS is
live. Note that the webhook body is a **status notification, not the transcript** —
the download step is still required.

**Machinery retired on the Sarvam path:** the `transcribeResilient` retry ladder
and `transcribeChunked` / `splitAudioOnSilence` fallback. Sarvam accepts 2-hour
files natively and is telephony-tuned, so neither has a job. `collapseRepetitions`
stays as a free string-level safety net. `splitAudioOnSilence` remains available
for the >2 h edge case only, submitting parts as multiple files in one job. All of
this stays fully intact on the OpenAI path.

### 7.5 Diarization and speaker-role mapping

Sarvam returns, per file:

```json
{
  "request_id": "...",
  "transcript": "full text...",
  "timestamps": { "chunks": [...], "start_time_seconds": [...], "end_time_seconds": [...] },
  "diarized_transcript": {
    "entries": [
      { "transcript": "...", "start_time_seconds": 0.01,
        "end_time_seconds": 2.5, "speaker_id": "0" }
    ]
  },
  "language_code": "en-IN"
}
```

`speaker_id` is stable across the whole recording. Mapping id → role, in
descending order of trust:

1. **Channel** — deterministic, but unavailable: our audio is mono (§2.2). The
   code still probes channel count per file and takes this path when it finds
   genuine stereo, so a differently-configured campaign is handled correctly and
   skips the diarization surcharge.
2. **LLM role-mapping (our actual path).** One `sarvam-105b` call with a strict
   `json_schema` returning
   `{ agent_speaker_id, customer_speaker_id, confidence, evidence }`. Costs
   ≈₹0.05 per call — negligible. This is the approach in Sarvam's own
   call-analytics cookbook, which resolves roles from the transcript reliably.
3. **Heuristic cross-check.** Greeting position (the agent almost always opens)
   and talk-time share. Used only to flag disagreement with a low-confidence LLM
   result, never to override a high-confidence one.

`confidence` is persisted so reviewers can see when attribution was uncertain,
and so we can measure attribution accuracy during validation.

Diarization is configured with `with_diarization: true` and `num_speakers: 2`.
Sarvam's guidance is that a known speaker count gives more consistent results
than auto-detection, and 2 is correct for our calls; `sarvam_num_speakers: 0`
falls back to auto for transfer/conference calls.

### 7.6 Transcript artifact — backwards compatible

`transcriptions/<audit_id>.txt` **keeps existing** and stays the audit input,
now rendered as speaker-labelled lines:

```
AGENT: Hello, Scaler se baat kar raha hoon, kaise help kar sakta hoon?
CUSTOMER: Haan bhai, mera course access nahi ho raha hai.
```

So the dashboard viewer (`CallAuditsView.tsx:392`), `getTranscription`, and the
re-audit flow keep working with **zero changes**.

A **new sibling** `transcriptions/<audit_id>.json` holds the structured form:
turns with `speaker_id`, resolved `role`, start/end seconds and text, plus
`language_code` and per-speaker talk-time totals. New reader features use it when
present and degrade gracefully when absent (every pre-migration audit).

New `AuditRecord` fields, all optional:

| Field | Purpose |
|---|---|
| `ai_provider` | Which provider produced this audit |
| `sarvam_job_id` | Batch job id, for resume-not-resubmit idempotency |
| `transcript_json_key` | S3 key of the structured transcript |
| `speaker_roles` | `{ agent, customer, confidence, method }` |
| `talk_time_sec` | `{ agent, customer }` |
| `detected_language` | Sarvam's returned `language_code` |

### 7.7 Error handling

| Condition | Behaviour |
|---|---|
| 403 invalid key | Fail fast, report critical to Sentry — config error, not transient |
| 429 quota / rate limit | Exponential backoff, then let SQS redeliver; alert on repeats |
| 500 / 503 | Retry with backoff; DLQ after `SQS_MAX_RECEIVE_COUNT` (5) |
| Job state `Failed` | Mark the row `failed` with Sarvam's `error_message` |
| Per-file failure inside a successful job | Read `job_details[].state`; fail only that audit |
| Poll timeout | Leave `transcribing` with `sarvam_job_id` retained; resume on reprocess |
| Missing `diarized_transcript` | Fall back to the flat `transcript`, `speaker_roles = null`, still audit — a transcript without attribution beats no audit |
| No `SARVAM_API_KEY` | Deterministic diarized stub, mirroring today's `isStubMode` |

Sarvam rate limits are account-wide by plan tier (Starter 60/min, Pro 200/min,
Business 1,000/min). With `WORKER_CONCURRENCY = 5` across up to 10 transcribe
tasks plus 10 audit tasks, we must confirm our plan tier supports the peak or
bound concurrency accordingly. **Open question — see §11.**

---

## 8. Capabilities this unlocks

### In scope for Phase 1

1. **Faithful Hinglish in Roman script** — `mode: "translit"`, readable by every
   reviewer regardless of Devanagari literacy.
2. **Agent vs customer on every turn.**
3. **The agent's turns isolated in the audit prompt.** Today the model scores the
   agent against a transcript that also contains everything the *customer* said,
   so agents can be penalised for the customer's words. This is likely the single
   largest audit-quality gain in the migration.
4. **Per-speaker talk-time and talk:listen ratio** — free from diarization
   timestamps, a CX metric we cannot compute at all today.
5. **Timestamped turns** — the transcript viewer can jump to that moment in the
   recording, and criterion explanations can cite a timestamp instead of a vague
   paraphrase.
6. **Automatic language detection per call** — which languages each agent
   actually handles, straight from `language_code`.
7. **Rubric criteria that were previously impossible:** interruption / talk-over
   counts, dead-air and hold gaps, longest monologue, and greeting/closing script
   compliance checked against *the agent's own turns*.

### Documented for later

- ~~`json_schema` strict structured outputs replacing regex JSON salvage.~~
  **Ruled out** — broken on `sarvam-105b` (§7.3). Revisit only if Sarvam fixes it.
- Two-tier routing: `sarvam-30b` for the bulk pass, `sarvam-105b` for flagged
  calls only.
- Cheap enough to afford per-criterion evidence quotes, call summaries, and
  agent-level coaching digests.
- On-demand English translation for leadership reporting via the text translate
  API (₹20/10K chars) — **not** a second STT pass.
- Bulbul TTS to read coaching feedback back to agents in their own language.
- Indian data residency / sovereignty, if that becomes a compliance requirement.
- Multi-file batching (20 per job) as a throughput optimisation, paired with the
  existing Bulk Run feature.

---

## 9. Testing strategy

**Unit (pure, no network):**

- Provider resolution from the `AI_PROVIDER` constant, including that an invalid
  value fails startup rather than falling back silently (§7.2).
- **Cap enforcement**, as its own test group, since it is goal 2:
  - gate ordering — duration → `no_team` → cap reservation → transcribe;
  - a mapped agent at cap 3 gets exactly 3 audited and the 4th `skipped`
    with `daily_cap`;
  - an **unmapped** agent is skipped with `no_team` and never reaches the cap
    or transcription;
  - concurrent claims for the same `(agent, day)` cannot exceed the cap
    (the §5.3(d) conditional update);
  - a retry of the same `audit_id` reuses its reservation instead of consuming a
    second slot;
  - a terminal failure releases the reserved slot;
  - an invalid cap value is rejected with 400 instead of becoming unlimited;
  - a new team is created with a cap of 3, not unlimited.
- Diarized-JSON → speaker-labelled text renderer, including the
  missing-`diarized_transcript` fallback.
- Role resolver precedence: channel → LLM → heuristic cross-check, plus
  low-confidence flagging.
- Talk-time aggregation from entry timestamps.
- Sarvam error classification (403 vs 429 vs 5xx vs job-level failure).
- Cost estimator, so the §6 model stays honest as rates change.

Follows the existing pattern in `src/lib/filename.test.ts` and
`src/services/rbac.test.ts`.

**Integration:** a Sarvam stub mode mirroring `isStubMode`, returning a
deterministic diarized payload so the whole pipeline runs end-to-end with no key
and no spend. Plus an idempotency test: a redelivered SQS message with a stored
`sarvam_job_id` must resume, never resubmit.

**Live validation (the go/no-go gate):** push a fixed sample of ~30 real
recordings — spanning all three campaigns, a range of durations, and known
Hinglish-heavy calls — through both providers via the existing Bulk Run, then
compare:

| Dimension | How |
|---|---|
| Transcript quality | Side-by-side human read; count hallucinated loops on each |
| Hinglish fidelity | Reviewer rates whether regional speech survived |
| Role attribution | Manual check of agent/customer on all 30; record accuracy |
| Score stability | Do rubric scores move, and is the movement defensible? |
| Actual cost | Sarvam dashboard vs OpenAI invoice for the same 30 calls |
| Latency | Batch job turnaround vs today's synchronous call |

---

## 10. Rollout

Because `AI_PROVIDER` defaults to Sarvam (§7.2), the production deploy *is* the
cutover. Validation therefore has to happen before it, not after — the order below
matters.

1. **Phase 0 ships and settles.** Measure the weekly spend for one to two weeks
   to establish a clean baseline. Record the retry rate from §5.5. Set
   `daily_audit_cap = 3` on all three teams.
2. **Phase 1 built and validated outside prod.** Run the §9 comparison from a
   local or staging worker with `AI_PROVIDER=sarvam` against the 30-call sample,
   writing to a scratch output prefix. Production keeps running on OpenAI
   throughout, untouched.
3. **Go/no-go on the §9 evidence.** Transcript quality, Hinglish fidelity, role
   attribution accuracy, score movement, real cost, and batch latency. A failure
   here means Phase 1 does not deploy — and Phase 0 has still delivered the cost
   win independently.
4. **Deploy Phase 1 to prod.** All three ECS services with
   `AI_PROVIDER=sarvam` and `SARVAM_API_KEY` in SSM. This is the cutover.
5. **Watch closely for the first week.** Sentry for job failures, DLQ depth,
   `speaker_roles.confidence` distribution, and spend against the §6.2 ceiling on
   the Sarvam dashboard.
6. **Rollback, if needed.** Set `AI_PROVIDER=openai` in the three task
   definitions and force a new deployment. Minutes, not seconds — see the
   trade-off note in §7.2.

---

## 11. Risks and open questions

| # | Item | Handling |
|---|---|---|
| 1 | **OpenAI audio pricing quoted from memory.** The whole §6 comparison rests on ~₹16/hr. | Verify against a real invoice before sign-off. Blocks the cost claim, not the build. |
| 2 | **Retry rate unknown.** Decides whether Phase 1 saves or costs money. | Measure in Phase 0 (§5.5) before flipping. |
| 3 | **Sarvam plan tier vs our concurrency.** Up to 20 worker tasks × 5 concurrency could exceed a Starter/Pro rate limit. | Confirm tier; bound `WORKER_CONCURRENCY` or upgrade before cutover. |
| 4 | **Batch latency is unmeasured.** Docs say "minutes"; the SDK default timeout is 600 s. If jobs routinely exceed the queue visibility timeout, the inline-poll design gets uncomfortable and webhooks become urgent. | Measure during validation; the `sarvam_job_id` resume path is the safety net. |
| 5 | **Role attribution is inferred, not deterministic** (mono audio). | Persist `confidence`; measure accuracy on 30 calls during validation; set a floor below which the audit records "attribution uncertain". |
| 6 | **Diarization quality on 8 kbps audio is unproven** — Sarvam's telephony tuning is documented but not verified on *our* audio. | This is exactly what the validation gate exists to answer. If it fails, Phase 0 has still delivered the cost win and we stay on OpenAI. |
| 7 | **Only 3 recordings were probed for channel count.** | Per-file channel probe at ingest with automatic fallback (§7.5). |
| 8 | **Queue visibility timeout discrepancy** — 300 in `create-infra.ts` vs 900 in `ARCHITECTURE.md`. | Verify the live value; reconcile the docs either way. |
| 9 | **`saarika:v2.5` is being deprecated** in favour of `saaras:v3` with `mode`. | We target `saaras:v3` from day one. |
| 10 | **Sarvam is a smaller vendor than OpenAI.** Concentration risk on availability and roadmap. | The OpenAI path stays intact and tested. Rollback is a task-definition change plus redeploy (§7.2), so it costs minutes rather than seconds — accepted per goal 1. |
| 11 | **The deploy is the cutover** (`AI_PROVIDER` defaults to Sarvam), so a bad deploy switches the whole pipeline at once. | Validation moves *before* the prod deploy (§10 steps 2–3). No partial/canary rollout is available with a single global constant. |
| 12 | **The atomic cap reservation adds a failure mode:** a slot claimed then not used (transcription crash) permanently consumes an agent's daily quota. | Key the reservation on `audit_id` so a retry is idempotent, and release the slot on terminal failure. Both are §5.3(d) requirements and need explicit tests. |

---

## 12. Appendix — verified Sarvam API facts

Gathered from `docs.sarvam.ai` on 2026-07-26 (append `.md` to any docs URL for
clean markdown; `llms.txt` indexes the corpus).

- **Base URL:** `https://api.sarvam.ai`
- **Auth:** `api-subscription-key` header. Chat additionally accepts
  `Authorization: Bearer`. Auth failures return **403**, not 401.
- **SDK:** `sarvamai` on npm (v1.1.7) and PyPI. The JS client exposes
  `speechToTextJob.createJob / uploadFiles / start / waitUntilComplete /
  getFileResults / downloadOutputs`.
- **STT transports:** REST (≤30 s, no diarization), WebSocket (streaming, no
  diarization), **Batch** (≤2 h/file, 20 files/job, diarization + chunk-level
  timestamps). Word-level timestamps are not available on any transport.
- **STT modes** (`saaras:v3`): `transcribe`, `translate`, `verbatim`, `translit`,
  `codemix`.
- **Language:** BCP-47 codes (`hi-IN`, `en-IN`, …) or `unknown` to auto-detect.
  Sarvam recommends specifying when known, for accuracy and speed.
- **Diarization:** `with_diarization: true`, optional `num_speakers`; supports up
  to 20 speakers; ids are stable across the recording.
- **Chat models:** `sarvam-105b` (128K context), `sarvam-30b` (64K).
  `sarvam-m` is deprecated. `response_format` accepts `json_object` (works) and
  `json_schema` (**advertised but broken** — see §7.3). Reasoning is on by default
  on 105b and its tokens are consumed *before* any content, so
  `reasoning_effort: null` is required or `content` comes back empty.

### Verified live on 2026-07-26 (personal key, Sarvam's public sample call)

- **Batch turnaround: ~13 seconds** for a 6-minute recording, end to end
  (init → upload → start → poll → download). This largely retires risk #4 — the
  inline-poll design has plenty of headroom against a 900s visibility timeout.
- **Diarization is good:** 45 clean turns on a 2-speaker call, sensible talk-time
  split (239s agent / 62s customer of 359s).
- **`upload_urls` / `download_urls` are objects keyed by file name**, not the
  arrays the published OpenAPI schema shows. Code tolerates both.
- **Uploads go to Azure Blob SAS URLs** and require an `x-ms-blob-type: BlockBlob`
  header; a bare PUT returns 400.
- **Sample rate must be normalised.** A 48 kHz mp3 came back with timestamps
  running to 1025s on a 359s file (a ~2.85x stretch, i.e. 48000/16000) and a
  transcript of confident phonetic nonsense — **with no error**. The same audio at
  16 kHz transcribed perfectly. Every upload is therefore transcoded to 16 kHz
  mono WAV first (`normalizeForAsr`). Our recordings are 8 kHz, below anything
  tested here, so this guard matters for them too.
- **Rate limits:** Starter 60/min, Pro 200/min, Business 1,000/min, Enterprise
  custom. New accounts get ₹100 of free credits.
- **Batch webhooks:** `callback: {url, auth_token}`; Sarvam sends the token in
  `X-SARVAM-JOB-CALLBACK-TOKEN`; the endpoint must return 200 within 30 s; the
  payload is job status only, so results still require the download call.
- **Reference cookbook:** *Call Analytics Pipeline* — batch STT with diarization,
  speaker-wise transcript parsing, and LLM call analysis. Very close to our use
  case and worth following closely.
