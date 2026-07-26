import { describe, it, expect } from "vitest";
import { __internal, extractRoleAnswer, checkTimeline } from "./sarvam.js";

const { toTurns, renderTranscript, heuristicRoles, talkTimeBySpeaker, classify } = __internal;

/** Shape of one diarized entry as Sarvam returns it. */
const entry = (speaker: string, start: number, end: number, text: string) => ({
  speaker_id: speaker,
  start_time_seconds: start,
  end_time_seconds: end,
  transcript: text,
});

const doc = (...entries: ReturnType<typeof entry>[]) => ({
  language_code: "hi-IN",
  transcript: entries.map((e) => e.transcript).join(" "),
  diarized_transcript: { entries },
});

describe("toTurns", () => {
  it("flattens diarized entries in order", () => {
    const turns = toTurns([doc(entry("0", 0, 2.5, "Namaste"), entry("1", 2.8, 5, "Haan ji"))], [0]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ speaker_id: "0", start_sec: 0, end_sec: 2.5, text: "Namaste" });
    expect(turns[1].speaker_id).toBe("1");
  });

  it("drops empty entries rather than emitting blank turns", () => {
    const turns = toTurns([doc(entry("0", 0, 1, "  "), entry("0", 1, 2, "real"))], [0]);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("real");
  });

  it("shifts later parts by their offset so a split recording stays chronological", () => {
    // A >2h recording is split and submitted as several files; each part's
    // timestamps restart at zero, so without offsets part 2 appears to happen
    // before part 1 ends.
    const turns = toTurns(
      [doc(entry("0", 0, 10, "part one")), doc(entry("1", 0, 10, "part two"))],
      [0, 7200]
    );
    expect(turns[0].start_sec).toBe(0);
    expect(turns[1].start_sec).toBe(7200);
    expect(turns[1].end_sec).toBe(7210);
  });

  it("returns nothing when the provider sent no diarization", () => {
    expect(toTurns([{ transcript: "flat", language_code: "en-IN" }], [0])).toEqual([]);
  });
});

describe("renderTranscript", () => {
  const turns = (roles: (("agent" | "customer") | null)[]) =>
    roles.map((role, i) => ({
      speaker_id: role === "agent" ? "0" : role === "customer" ? "1" : "9",
      role,
      start_sec: i,
      end_sec: i + 1,
      text: `line${i}`,
    }));

  it("labels turns by resolved role", () => {
    expect(renderTranscript(turns(["agent", "customer"]))).toBe("AGENT: line0\nCUSTOMER: line1");
  });

  it("merges consecutive turns from one speaker so it reads as speech", () => {
    // Diarization chunks a monologue into several entries; one line per chunk
    // would make the transcript look like a conversation that it isn't.
    expect(renderTranscript(turns(["agent", "agent", "customer"]))).toBe(
      "AGENT: line0 line1\nCUSTOMER: line2"
    );
  });

  it("falls back to the raw speaker id when a role could not be attributed", () => {
    expect(renderTranscript(turns([null]))).toBe("SPEAKER 9: line0");
  });

  it("returns an empty string for no turns", () => {
    expect(renderTranscript([])).toBe("");
  });
});

describe("talkTimeBySpeaker", () => {
  it("sums each speaker's floor time", () => {
    const m = talkTimeBySpeaker([
      { speaker_id: "0", role: null, start_sec: 0, end_sec: 5, text: "a" },
      { speaker_id: "1", role: null, start_sec: 5, end_sec: 7, text: "b" },
      { speaker_id: "0", role: null, start_sec: 7, end_sec: 10, text: "c" },
    ]);
    expect(m.get("0")).toBe(8);
    expect(m.get("1")).toBe(2);
  });

  it("ignores negative durations rather than subtracting time", () => {
    const m = talkTimeBySpeaker([{ speaker_id: "0", role: null, start_sec: 5, end_sec: 1, text: "x" }]);
    expect(m.get("0")).toBe(0);
  });
});

describe("heuristicRoles", () => {
  const t = (speaker: string, i: number) => ({
    speaker_id: speaker, role: null, start_sec: i, end_sec: i + 1, text: "x",
  });

  it("treats whoever greets first as the agent", () => {
    const r = heuristicRoles([t("1", 0), t("0", 1)]);
    expect(r).toMatchObject({ agent: "1", customer: "0", method: "heuristic" });
  });

  it("stays low-confidence — it is only a cross-check, not an answer", () => {
    expect(heuristicRoles([t("0", 0), t("1", 1)]).confidence).toBeLessThan(0.5);
  });

  it("reports no customer when only one speaker was detected", () => {
    const r = heuristicRoles([t("0", 0), t("0", 1)]);
    expect(r.agent).toBe("0");
    expect(r.customer).toBeNull();
  });
});

describe("extractRoleAnswer", () => {
  it("reads the flat shape we ask for", () => {
    expect(
      extractRoleAnswer({ agent_speaker_id: "0", customer_speaker_id: "1", confidence: 0.9 })
    ).toEqual({ agent: "0", customer: "1", confidence: 0.9 });
  });

  it("reads the nested shape sarvam-105b actually returns", () => {
    // Observed live: the model ignores the requested key names and answers with
    // {agent:{id,confidence,evidence}}. Rejecting that threw away a correct,
    // confidence-1.0 answer and fell back to a weak greeting heuristic.
    expect(
      extractRoleAnswer({
        agent: { id: 0, confidence: 1.0, evidence: "Thank you for calling…" },
        customer: { id: 1, confidence: 1.0, evidence: "I bought a coat…" },
      })
    ).toEqual({ agent: "0", customer: "1", confidence: 1 });
  });

  it("coerces numeric ids to strings so they match diarization ids", () => {
    expect(extractRoleAnswer({ agent_speaker_id: 0, customer_speaker_id: 1 }).agent).toBe("0");
  });

  it("accepts the *_id spelling and bare scalars", () => {
    expect(extractRoleAnswer({ agent_id: "2", customer_id: "3" }).agent).toBe("2");
    expect(extractRoleAnswer({ agent: "0", customer: "1" }).customer).toBe("1");
  });

  it("clamps confidence into 0..1 and defaults it to 0", () => {
    expect(extractRoleAnswer({ agent: "0", confidence: 7 }).confidence).toBe(1);
    expect(extractRoleAnswer({ agent: "0", confidence: -3 }).confidence).toBe(0);
    expect(extractRoleAnswer({ agent: "0" }).confidence).toBe(0);
  });

  it("returns nulls for junk rather than inventing an answer", () => {
    expect(extractRoleAnswer(null)).toEqual({ agent: null, customer: null, confidence: 0 });
    expect(extractRoleAnswer({ something_else: true }).agent).toBeNull();
  });
});

describe("checkTimeline", () => {
  const turn = (start: number, end: number) => ({
    speaker_id: "0", role: null as null, start_sec: start, end_sec: end, text: "x",
  });

  it("faults on the real mis-decode we hit: 1025s of turns on a 359s file", () => {
    // The exact defect. A 48 kHz mp3 came back stretched by 48000/16000 with a
    // transcript of phonetic nonsense, and HTTP 200. Audio cannot contain speech
    // after it ends, so this is the one signal that catches it every time.
    const r = checkTimeline([turn(184, 1025)], 359);
    expect(r.fault).toContain("1025s");
    expect(r.fault).toContain("2.86x"); // 1025/359 — i.e. the 48000/16000 stretch
    expect(r.fault).toContain("must not be audited");
  });

  it("passes a normal transcript that ends just about when the audio does", () => {
    expect(checkTimeline([turn(0, 12), turn(12, 357)], 359)).toEqual({ fault: null, warning: null });
  });

  it("tolerates a small overhang from frame padding and rounding", () => {
    // Ends 1.5s past a 60s file — encoder padding, not a decode error.
    expect(checkTimeline([turn(0, 61.5)], 60).fault).toBeNull();
  });

  it("warns but does not fault when the timeline is short", () => {
    // A call that ends with minutes of hold music is legitimate, so this can only
    // ever be a hint — faulting here would block real audits.
    const r = checkTimeline([turn(0, 100)], 600);
    expect(r.fault).toBeNull();
    expect(r.warning).toContain("silent tail");
  });

  it("stays silent when the duration probe failed — it will not guess", () => {
    expect(checkTimeline([turn(0, 9999)], 0)).toEqual({ fault: null, warning: null });
  });

  it("stays silent with no turns, which is a separate handled case", () => {
    expect(checkTimeline([], 359)).toEqual({ fault: null, warning: null });
  });
});

describe("classify", () => {
  it("treats 403 as a non-retryable config error and says why", () => {
    const e = classify(403, "forbidden");
    expect(e.retryable).toBe(false);
    // Sarvam uses 403 where most APIs use 401 — worth spelling out in the message.
    expect(e.message).toContain("403, not 401");
  });

  it("treats 429 and 5xx as retryable", () => {
    expect(classify(429, "slow down").retryable).toBe(true);
    expect(classify(503, "overloaded").retryable).toBe(true);
  });

  it("treats other 4xx as non-retryable", () => {
    expect(classify(422, "bad params").retryable).toBe(false);
  });
});
