import { describe, it, expect } from "vitest";
import { parseRecordingMeta, buildAuditId, isRecordingKey } from "./filename.js";

const KEY =
  "Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3";

describe("parseRecordingMeta", () => {
  it("parses the Scaler dialer filename", () => {
    const meta = parseRecordingMeta(KEY);
    expect(meta).not.toBeNull();
    expect(meta!).toMatchObject({
      agent_id: "495367",
      session_id: "1711950009-255903",
      campaign: "Scaler",
      customer_number: "916353969873",
      extension: "mp3",
      call_datetime: "2024-04-01T11:10:09.000Z",
      file_name: "agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3",
    });
  });

  it("returns null for non-matching keys", () => {
    expect(parseRecordingMeta("Scaler/notes.txt")).toBeNull();
    expect(parseRecordingMeta("random.mp3")).toBeNull();
  });

  it("builds a deterministic audit id", () => {
    expect(buildAuditId(parseRecordingMeta(KEY)!)).toBe("495367-1711950009-255903");
  });

  it("recognizes recording keys", () => {
    expect(isRecordingKey(KEY)).toBe(true);
    expect(isRecordingKey("foo/bar.json")).toBe(false);
  });
});
