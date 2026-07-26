import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gate behaviour for pipeline stage 1.
 *
 * The gates exist to stop spend *before* it happens, so what matters in every
 * case below is not just the resulting status — it is whether `transcribeAudio`
 * was called at all.
 */

const m = vi.hoisted(() => ({
  resolveRecordingMeta: vi.fn(),
  getUserByAgentId: vi.fn(),
  getTeam: vi.fn(),
  createAuditIfAbsent: vi.fn(),
  getAudit: vi.fn(),
  updateAudit: vi.fn(),
  setStatus: vi.fn(),
  reserveDailySlot: vi.fn(),
  releaseDailySlot: vi.fn(),
  getRecordingBuffer: vi.fn(),
  saveTranscription: vi.fn(),
  probeBufferDurationSec: vi.fn(),
  transcribeAudio: vi.fn(),
  sendMessage: vi.fn(),
  getModelSettingsCached: vi.fn(),
  resolveTeamInfra: vi.fn(),
}));

vi.mock("../lib/filename.js", () => ({
  resolveRecordingMeta: m.resolveRecordingMeta,
  buildAuditId: () => AUDIT_ID,
}));
vi.mock("../lib/s3.js", () => ({
  getRecordingBuffer: m.getRecordingBuffer,
  saveTranscription: m.saveTranscription,
  getTranscription: vi.fn(),
  saveAuditDocument: vi.fn(),
  s3Url: () => "s3://bucket/key",
}));
vi.mock("../lib/sqs.js", () => ({ sendMessage: m.sendMessage }));
vi.mock("../lib/audio.js", () => ({ probeBufferDurationSec: m.probeBufferDurationSec }));
vi.mock("./openai.js", () => ({ transcribeAudio: m.transcribeAudio, auditTranscript: vi.fn() }));
vi.mock("../db/users.js", () => ({ getUserByAgentId: m.getUserByAgentId }));
vi.mock("../db/teams.js", () => ({ getTeam: m.getTeam }));
vi.mock("../db/audits.js", () => ({
  createAuditIfAbsent: m.createAuditIfAbsent,
  getAudit: m.getAudit,
  updateAudit: m.updateAudit,
  setStatus: m.setStatus,
}));
vi.mock("../db/quota.js", () => ({
  reserveDailySlot: m.reserveDailySlot,
  releaseDailySlot: m.releaseDailySlot,
}));
vi.mock("../db/rubrics.js", () => ({ listRubricsByTeam: vi.fn() }));
vi.mock("../db/performance.js", () => ({ recordAuditPerformance: vi.fn() }));
vi.mock("../db/settings.js", () => ({ getModelSettingsCached: m.getModelSettingsCached }));
vi.mock("./teamInfra.js", () => ({ resolveTeamInfra: m.resolveTeamInfra }));

const { processTranscription } = await import("./pipeline.js");

const AUDIT_ID = "460015-1781072881-378068";
const AGENT = "460015";
const KEY = "cz-scaler-support-calls/Scaler/2026_07_20/agent-460015-x.mp3";

/** The last patch handed to updateAudit. */
const lastPatch = () => m.updateAudit.mock.calls.at(-1)?.[1];

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());

  m.resolveRecordingMeta.mockResolvedValue({
    agent_id: AGENT,
    session_id: "1781072881",
    campaign: "Scaler",
    customer_number: "8770192840",
    call_datetime: "2026-07-20T11:58:02.000Z",
    file_name: "agent-460015-x.mp3",
  });
  m.resolveTeamInfra.mockResolvedValue({
    recording_bucket: "recordings",
    output_bucket: "output",
    audit_queue_url: "https://sqs/audit",
  });
  m.createAuditIfAbsent.mockResolvedValue(true);
  m.getRecordingBuffer.mockResolvedValue(Buffer.from("audio"));
  m.probeBufferDurationSec.mockResolvedValue(900); // 15 min — comfortably auditable
  m.getModelSettingsCached.mockResolvedValue({
    transcription_model: "gpt-4o-mini-transcribe",
    audit_model: "gpt-4o",
    min_audit_duration_sec: 600,
  });
  m.getUserByAgentId.mockResolvedValue({ agent_id: AGENT, team: "CS" });
  m.getTeam.mockResolvedValue({ team_id: "CS", daily_audit_cap: 3 });
  m.reserveDailySlot.mockResolvedValue({ granted: true, used: 1 });
  m.transcribeAudio.mockResolvedValue("AGENT: hi\nCUSTOMER: hello");
  m.saveTranscription.mockResolvedValue("transcriptions/x.txt");
});

describe("no_team gate", () => {
  it("skips an unmapped agent without transcribing it", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined); // no mapping
    await processTranscription(KEY, null); // null = global queue, so no queue team either

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ status: "skipped", skip_reason: "no_team" });
  });

  it("runs before the cap gate, so unmapped calls never consume a slot", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined);
    await processTranscription(KEY, null);

    // This ordering is the whole point: the cap is keyed on the team, so a
    // team-less call would otherwise bypass it and transcribe without limit.
    expect(m.reserveDailySlot).not.toHaveBeenCalled();
  });

  it("still records the probed duration, so skipped audio stays measurable", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined);
    await processTranscription(KEY, null);

    expect(lastPatch()).toMatchObject({ duration_sec: 900 });
  });

  it("uses the queue's team when the agent has no mapping", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined);
    await processTranscription(KEY, "RM"); // team-owned queue supplies the team

    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

describe("duration gate", () => {
  it("skips a short call before transcription and before the cap", async () => {
    m.probeBufferDurationSec.mockResolvedValue(88); // the median call

    await processTranscription(KEY, null);

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expect(m.reserveDailySlot).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ status: "skipped", skip_reason: "too_short" });
  });

  it("fails open when the duration cannot be probed", async () => {
    m.probeBufferDurationSec.mockResolvedValue(0);
    await processTranscription(KEY, null);
    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

describe("daily cap gate", () => {
  it("skips once the agent's slots are gone", async () => {
    m.reserveDailySlot.mockResolvedValue({ granted: false, used: 3 });

    await processTranscription(KEY, null);

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expect(lastPatch()).toMatchObject({ status: "skipped", skip_reason: "daily_cap" });
  });

  it("claims the slot against the call's date, not today", async () => {
    await processTranscription(KEY, null);
    expect(m.reserveDailySlot).toHaveBeenCalledWith(AGENT, "2026-07-20", 3, AUDIT_ID);
  });

  it("does not reserve at all when the team is uncapped", async () => {
    m.getTeam.mockResolvedValue({ team_id: "CS", daily_audit_cap: 0 });
    await processTranscription(KEY, null);

    expect(m.reserveDailySlot).not.toHaveBeenCalled();
    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

describe("slot release", () => {
  it("hands the slot back when transcription fails", async () => {
    m.transcribeAudio.mockRejectedValue(new Error("Sarvam job failed"));

    await expect(processTranscription(KEY, null)).rejects.toThrow("Sarvam job failed");
    expect(m.releaseDailySlot).toHaveBeenCalledWith(AGENT, "2026-07-20", AUDIT_ID);
  });

  it("keeps the slot on success", async () => {
    await processTranscription(KEY, null);
    expect(m.releaseDailySlot).not.toHaveBeenCalled();
    expect(m.sendMessage).toHaveBeenCalledTimes(1); // handed off to the audit stage
  });

  it("does not release a slot it never claimed", async () => {
    m.getTeam.mockResolvedValue({ team_id: "CS", daily_audit_cap: 0 }); // uncapped
    m.transcribeAudio.mockRejectedValue(new Error("boom"));

    await expect(processTranscription(KEY, null)).rejects.toThrow("boom");
    expect(m.releaseDailySlot).not.toHaveBeenCalled();
  });
});
