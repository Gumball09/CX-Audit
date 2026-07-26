# Cost model — where the money actually goes

Measured 2026-07-26 against four real CS recordings (8 kHz mono, 8 kbps, 3–6 min)
and the real CS rubric, on Sarvam. Numbers here are observed, not estimated, except
where flagged.

## Per-call cost, measured

| Component | Measured | Cost |
|---|---|---|
| Batch STT with diarization | 356s of audio | **₹4.46** (₹45/hr) |
| Role-mapping chat call | ~500 prompt tokens | negligible |
| Audit chat call, per rubric | 1,259 prompt + ~300 completion | **~₹0.08** * |

\* We do not have a published sarvam-105b token rate. The figure assumes a
generous ₹50 per million tokens. The conclusion below does not depend on it: for
the audit call to cost as much as the STT for the same recording, the rate would
have to be about **₹2,885 per million tokens** — roughly 50× any plausible price
for a model this size. The ratio is lopsided enough that a large pricing error
does not change the decision.

**Audio duration is ~98% of the cost of auditing a call. Tokens are ~2%.**

## What this means for adding rubric `guidance`

Fully specifying all five CS criteria adds roughly 400–500 prompt tokens, taking
the audit call from ~1,259 to ~1,700 tokens: about **₹0.02 per call**, against
₹4.46 of transcription for the same call.

Set against that, guidance made scoring reproducible where nothing else did —
criteria with guidance scored identically across three runs, criteria without kept
swinging (Escalation Handling 80/0/0 → 100/100/100). **Write the guidance as long as
it needs to be.** Terse guidance to save tokens would trade the thing that fixed
score reliability for two paise.

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

In descending order of effect. The first is worth more than everything else here
combined.

1. **`min_audit_duration_sec`** (Settings, super_admin). The p50 call is 88
   seconds; the default is 600. Every second of every audited call is billed at
   ₹45/hr, so this single threshold decides most of the spend. Set it
   deliberately — it is currently the difference between auditing ~10% and ~100%
   of call volume.
2. **Daily audit cap** — 3 calls per agent per day (per-team, admin-set). Bounds
   total spend regardless of call volume. Already enforced with an atomic
   reservation, keyed on `audit_id` so redeliveries reuse a slot.
3. **The `no_team` gate.** Previously 53% of all transcription hours went to calls
   from unmapped agents that could never be audited, and the cap did not apply to
   them. Now gated before any spend. Keep `cx_users` mapped — every unmapped agent
   is either wasted spend or a missing audit.
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
  means N× the prompt tokens. At ₹0.08 per call even four rubrics come to ₹0.32
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
