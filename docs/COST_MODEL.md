# Cost model — where the money actually goes

Measured 2026-07-26 against four real CS recordings (8 kHz mono, 8 kbps, 3–6 min)
and the real CS rubric, on Sarvam. Numbers here are observed, not estimated, except
where flagged.

## Per-call cost, measured

### Published Sarvam rates (as of 2026-07-26)

| Item | Rate |
|---|---|
| Speech to Text | **₹30 / audio hour** |
| Speech to Text **with diarization** | **₹45 / audio hour** |
| sarvam-105b input | ₹4 / 1M tokens |
| sarvam-105b cached input | ₹2.5 / 1M tokens |
| sarvam-105b output | ₹16 / 1M tokens |
| Free credits on signup | ₹100 |

Billing is per second of audio, rounded up per request. We need diarization — it is
what separates agent from customer, and the audit prompt scores the agent only — so
**₹45/hr is our rate**, not ₹30.

Note on cached input: Sarvam publishes a cached-input rate, but the API does not
report cached tokens (`prompt_tokens_details` came back `null` across three
identical 1,259-token prompts, with no latency trend). So we cannot verify or rely
on it. Do not design around it.

### Measured per call

| Component | Measured | Cost |
|---|---|---|
| Batch STT with diarization | 356s of audio | **₹4.46** |
| Role-mapping chat call | ~500 in + ~100 out | ₹0.004 |
| Audit chat call, per rubric | 1,259 in + ~300 out | **₹0.010** |

**Audio duration is ~99.7% of the cost of auditing a call. Tokens are ~0.3%.**

The audit chat call costs roughly **one paisa**. STT for the same recording is
~450× that. Any effort spent shaving tokens is effort spent on a rounding error.

## Cost range by call length

At ₹45/hr with diarization, plus ~₹0.015 for the two chat calls:

| Call length | Per call |
|---|---|
| 1 min | ₹0.77 |
| 3 min | ₹2.27 |
| 5 min | ₹3.77 |
| 6 min | ₹4.52 |
| 10 min | ₹7.52 |
| 15 min | ₹11.27 |

### Monthly, on actual production data

Not modelled from assumed headcount. Computed from `cx_audits` (6,779 calls with
durations across 16 days in June 2026) and `cx_users`, simulating the cap of 3
calls per agent per day against the real per-agent, per-day call pattern.

**Scale: 10 auditable agents** — 6 RM, 3 CS, 1 Escalations. The other 8 rows in
`cx_users` are admins and super-admins, who are never audited.

| `min_audit_duration_sec` | calls/day audited | avg length | ₹/day | **₹/22-day month** |
|---|---|---|---|---|
| 0 | 15.4 | 211s | 41 | **893** |
| 60 | 15.4 | 415s | 80 | **1,756** |
| 120 | 15.4 | 488s | 94 | **2,062** |
| 300 | 15.3 | 657s | 126 | **2,769** |
| 600 (current default) | 12.6 | 987s | 156 | **3,425** |
| 900 | 7.9 | 1371s | 135 | 2,968 |

**₹900–₹3,400/month, about $11–$41.** Against a stated budget of $350–400 that is
roughly 10× of headroom. At this scale cost is not the binding constraint — the
daily cap already made it small.

### Raising the duration threshold costs MORE, not less

This is counter-intuitive and worth stating plainly, because the opposite was
assumed for a long time. Between 0 and 300 seconds the **cap binds** at ~15 calls a
day regardless of the threshold. So the threshold does not change how many calls are
audited — it only changes *which three* per agent get picked, and a higher threshold
forces the selection toward longer, more expensive calls. Moving 300s → 600s
increases spend by ~24% while auditing *fewer* calls.

Set `min_audit_duration_sec` on whether a call is long enough to be worth reviewing.
It is not a cost lever, and the ₹893 row is not a target — a 30-second call has
nothing to assess.

### Where the money was actually going

The fundamentals were never expensive. The waste was:

- **8 agents generating calls with no `cx_users` mapping** — `320`, `4877`,
  `444096`, `460010`, `496622`, `496624`, `499948`, `499988` — making up **46% of
  all calls and 225 of 433 audio-hours**. No team means no rubric, so every one of
  those was transcribed and could never be audited. The `no_team` gate now rejects
  them before any provider call.
- **2,273 of 7,030 audit rows sit at `failed`** (32%), almost certainly the same
  calls reaching stage 2 and dying there after transcription was already paid for.
- No per-agent cap was enforced at the time.

Mapping those 8 agents takes the auditable population from 10 to 18 and roughly
doubles spend, to ~₹1,600–₹6,200/month — still well inside budget, and it is the
change that actually improves coverage. Today ~15 of ~230 auditable calls per day
are audited, about 7%.

### Versus OpenAI

`gpt-4o-mini-transcribe` is about ₹15 per audio hour. Sarvam with diarization is
₹45 — **roughly 3× more per hour** (2× without diarization, which we can't use).
The migration buys accuracy on Indian speech and speaker separation. It does not
save money, and no amount of tuning will change that.

## What this means for adding rubric `guidance`

Fully specifying all five CS criteria adds roughly 400–500 prompt tokens, taking
the audit call from ~1,259 to ~1,700 tokens: about **₹0.002 per call** — two tenths
of a paisa — against ₹4.46 of transcription for the same call.

Set against that, guidance made scoring reproducible where nothing else did —
criteria with guidance scored identically across three runs, criteria without kept
swinging (Escalation Handling 80/0/0 → 100/100/100). **Write the guidance as long as
it needs to be.** Terse guidance to save tokens would trade the thing that fixed
score reliability for two tenths of a paisa.

## Prompt caching

Tested three identical 1,259-token prompts back to back. Sarvam returned
`prompt_tokens: 1259` every time and `prompt_tokens_details: null`, with no latency
trend (2.7s / 3.8s / 3.2s). **There is no evidence Sarvam supports prompt caching,
and nothing reported that we could bill against.** Do not build anything that
assumes it.

The OpenAI path is different: OpenAI applies automatic prefix caching to prompts
over ~1,024 tokens. Our prompt is already shaped for it — the stable part (team
preamble → criteria → guidance) precedes the variable transcript, so the cacheable
prefix grows as guidance grows. Worth not breaking if anyone reorders
`auditTranscript`.

## The levers that actually move the bill

In descending order of effect, measured against production data rather than assumed.

1. **Daily audit cap** — 3 calls per agent per day (per-team, admin-set). This is
   the lever, and it is already doing the work: it makes spend a function of
   headcount (10 auditable agents) rather than call volume (~424 calls/day), which
   is what brings the bill to ₹900–₹3,400/month. Enforced with an atomic
   reservation keyed on `audit_id`, so redeliveries reuse a slot.
2. **The `no_team` gate.** 46% of all calls and 225 of 433 audio-hours came from 8
   agents with no `cx_users` mapping, which could never be audited because no team
   means no rubric. Now gated before any spend. Keep `cx_users` mapped — every
   unmapped agent is either wasted spend or a missing audit.
3. **`min_audit_duration_sec`** (Settings, super_admin). Previously described here
   as the largest lever, which the data disproves — see the section above. Because
   the cap binds first, raising this threshold *increases* spend while auditing
   fewer calls. Treat it as a relevance control, not a cost control.
4. **`stt_job_id` resume.** An SQS redelivery resumes the existing Sarvam job
   instead of submitting a second paid one.
5. **Duration and team gates run before the audit row is created**, so a rejected
   call costs one S3 download and a local `ffprobe` — no provider call at all.

## Token work worth doing

Only one item, and it is small:

- **Ask for shorter explanations.** `criteria_scores[].explanation` is truncated to
  600 characters after the fact, so any tokens generated beyond that are paid for
  and discarded. Asking for two sentences per criterion trims completion tokens
  with no loss.

## Token work deliberately not done

- **Consolidating multi-rubric scoring into one call.** `processAudit` makes one
  chat call per active rubric, each resending the full transcript, so N rubrics
  means N× the prompt tokens. At ₹0.01 per call even four rubrics come to ₹0.04
  against ₹4.46 of STT. Merging them risks one rubric's criteria bleeding into
  another's scores and makes a single failure lose every rubric's result. Not worth
  it for pennies.
- **Reordering the prompt to share a transcript prefix across rubric calls.** Would
  only pay off under a caching scheme we have no evidence exists, and trades
  against keeping instructions near the end where the model follows them best.
- **Lowering `max_tokens`.** It is a ceiling, not a charge. Lowering it risks
  truncating JSON mid-answer, which is a real failure mode on this model because
  reasoning tokens count against the same budget.

## If cost becomes a real problem

The only large lever left is not sending some audio to a diarizing model at all.
Sarvam's non-diarized STT is cheaper, but attribution is what makes the score
meaningful — the audit prompt scores the agent only — so this would mean choosing
which calls get a trustworthy score. Tighten the duration gate and the daily cap
first; both are already built and neither costs any accuracy.
