# RCA — silent defects in the Sarvam integration

**Date:** 2026-07-26
**Scope:** `CX-audit-backend/src/services/ai/sarvam.ts` and the transcription pipeline
**Status:** fixes implemented on `cx-audit/sarvam-provider`; pipeline still suspended (nothing has audited)

## Summary

The Sarvam provider was built from published documentation, with 70 unit tests passing, and reviewed and committed before it ever contacted the live API. The first live run surfaced three defects in about forty minutes. A follow-up run designed to test the *fix* surfaced a fourth, worse one.

None of the four were visible from the vendor's documentation. Two of them would have reached production and produced confidently wrong audit scores for real agents.

## What was wrong

| # | Defect | Failure mode | Would it have reached prod? |
|---|---|---|---|
| 1 | `upload_urls` is a map keyed by file name, not the array the OpenAPI schema shows | **Loud** — crashed on the first call | No |
| 2 | Audio at an unexpected sample rate is silently mis-decoded | **Silent** — HTTP 200, wrong content | **Yes** |
| 3 | Role-mapping parser rejected valid answers and fell back to a guess | **Silent** — degraded to a coin flip | **Yes** |
| 4 | An empty transcript was passed to the auditor and scored | **Silent** — invented scores on a real record | **Yes** |

Defect 1 is not really a problem. A vendor schema being wrong is ordinary, the code failed fast, and it cost ten minutes. If all four had been like this there would be nothing to review.

Defects 2, 3 and 4 are the incident, and they share one shape: **the provider returned success while returning something unusable, and the system had no way to tell the difference.**

### Why the silent ones matter concretely

The audit prompt instructs the model to *"Score the AGENT only — never penalise the agent for what the CUSTOMER said."* That makes attribution load-bearing:

- **Defect 3** silently downgraded attribution from a confidence-1.0 LLM answer to a greeting heuristic ("whoever spoke first is the agent"), which is close to a coin flip on calls that don't open with a clean greeting. A flipped label means the agent is scored on the customer's words.
- **Defect 2** produced phonetic nonsense ("aa yo shaan", "Ashtanga") which the auditor then scored with full confidence — a bad number attached to a conversation that never happened.
- **Defect 4** meant a blank transcript got scored. An auditor handed nothing does not object; it returns plausible criterion scores.

None of these write an error. None appear as a failed audit. They produce unfair numbers, quietly.

## Root causes

**Defect 2 was undetectable by reading.** It is not documented behaviour, it is a decode bug (or an undeclared 16 kHz assumption). A 48 kHz / 359s file returned turns ending at **1025s** — a 2.86× stretch, i.e. 48000/16000. The only possible detector is comparing the provider's output against ground truth we already had: `probeBufferDurationSec` runs on every call and its answer was used for split decisions and then discarded.

**Defect 1 came from trusting a schema, and TypeScript actively helped hide it.** `api<T>()` ends in `return (await res.json()) as T`, which validates nothing. `upload_urls` was declared `SignedUrl[]`, the runtime value was an object, and the indexing type-checked perfectly. The boundary interfaces were documentation wearing a type's clothing.

**Defect 3 survived because of how the tests were built**, and this is the sharpest finding:

1. *The buggy code was the only code not extracted.* Every pure function — `toTurns`, `renderTranscript`, `heuristicRoles`, `talkTimeBySpeaker`, `classify` — was pulled out and tested. Role-answer parsing was left inline inside `resolveRoles`, so it had no seam, so it had no test. The bug lived exactly where the code was untestable. Extraction into `extractRoleAnswer` *was* most of the fix.

2. *A test would not have helped anyway.* The fixture would have been written as `{agent_speaker_id: "0"}` — the shape the prompt requests — and it would have passed while the code stayed broken against reality. **A test whose fixture is authored from the same assumption as the implementation cannot falsify that assumption.** The 70 tests measured internal consistency; the risk was entirely at the boundary, where there was no coverage at all.

**Defect 4 was found by the fix for defect 2, and corrects part of this RCA's own first draft.** Re-running with normalisation deliberately disabled (`FFMPEG_PATH` pointed at nothing, simulating ffmpeg missing from the worker image) did *not* reproduce the stretched timeline. It returned a completed job, a well-formed document, **zero turns and an empty transcript**. So the mis-decode is not deterministic in *form* — it varies by input, and the timeline invariant written for defect 2 passed this case at ratio 0.00 while the pipeline went on to audit nothing.

**The single root cause across all four:** the only test capable of catching any of them was a live one, and it was run last instead of first.

## Fixes implemented

1. **Sample-rate normalisation** (`lib/audio.ts` → `normalizeForAsr`). Every upload is transcoded to 16 kHz mono WAV. Our CZentrix recordings are 8 kHz, below anything the vendor appears to have exercised.

2. **Timeline invariant** (`sarvam.ts` → `checkTimeline`). Diarized turns are checked against the probed duration. An over-long timeline is a hard fault with no false positives — audio cannot contain speech after it ends. A *short* timeline only warns, because a call can legitimately end in hold music or dead air.

3. **Empty-transcript rejection, in two places.** The provider refuses to return an empty transcript, and stage 2 refuses to audit one. Two layers because the second also covers the OpenAI path, pre-existing rows, and any future provider with the same manners.

4. **Terminal, not retryable.** A validation fault marks the audit `failed` with the reason and drops the SQS message rather than letting it redeliver. The fault is deterministic for a given recording, so retrying would re-submit and re-bill the same audio to get the same unusable answer. Loud, once.

5. **Attribution surfaced in the UI** (`CallAuditsView` → `SpeakerAttribution`). `speaker_roles.method` and `.confidence` were already written to every audit row and rendered *nowhere* — which is precisely how defect 3 stayed hidden. A reviewer looking at a score can now see how much to trust the labels underneath it, with a warning badge on anything heuristic or below 0.5 confidence.

6. **`npm run verify:sarvam`** — a live contract check that runs the real `transcribeCall` against real audio and asserts nine expectations against independently-known ground truth. Deliberately cheap: a 40-second clip costs about ₹0.50. Not in CI (it costs money, needs a key, and network-flakes) but it must pass before any provider or model config change ships.

## Deliberately not done

**Schema validation (zod) at the API boundary.** It is the obvious suggestion and it does not earn its keep here. It would have caught defect 1 — the one defect that was already loud and cost ten minutes — and none of the three silent ones. Tolerant readers (`signedUrlFor`, `extractRoleAnswer`) plus output invariants address the failures actually encountered.

## Honest limits of the fixes

- The timeline invariant catches the mis-decode *signature*, not gibberish generally. A wrong transcript with plausible timestamps still passes. That is what the human review loop is for, and it raises the importance of the reviewer-correction feature.
- `normalizeForAsr` falls back to the original buffer if ffmpeg fails, which was written as "degrade to a worse transcript rather than no audit." Given defect 2, that reasoning was wrong on its own terms — it silently restores the exact condition that produces garbage. It is now safe only because the validation checks downstream catch the result regardless of *why* normalisation was skipped. The lesson generalises: don't assume the upstream step worked, check the output.
- `verify:sarvam` has only ever run against clean English audio. The real question — 8 kHz, 8–23 kbps, code-mixed Hindi/English — is still open, and is the entire reason for the migration.

## The transferable lesson

Three of four defects were silent successes. For a dependency whose internals cannot be inspected, **assertions on output are the only real defence**, and the ground truth needed for them is usually already in hand — we knew the file's duration before we asked the provider anything. Unit tests over hand-authored fixtures verify that code agrees with its author, which is never where this class of risk lives.
