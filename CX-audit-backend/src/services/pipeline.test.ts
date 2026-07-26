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
  recordSkip: vi.fn(),
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
vi.mock("../db/skipStats.js", () => ({ recordSkip: m.recordSkip }));
vi.mock("../db/rubrics.js", () => ({ listRubricsByTeam: vi.fn() }));
vi.mock("../db/performance.js", () => ({ recordAuditPerformance: vi.fn() }));
vi.mock("../db/settings.js", () => ({ getModelSettingsCached: m.getModelSettingsCached }));
vi.mock("./teamInfra.js", () => ({ resolveTeamInfra: m.resolveTeamInfra }));

const { processTranscription } = await import("./pipeline.js");

const AUDIT_ID = "460015-1781072881-378068";
const AGENT = "460015";
const KEY = "cz-scaler-support-calls/Scaler/2026_07_20/agent-460015-x.mp3";

/**
 * A skipped call must leave no trace in cx_audits — that is the whole point of
 * the gates running before the row is created.
 */
function expectNoRowWritten() {
  expect(m.createAuditIfAbsent).not.toHaveBeenCalled();
  expect(m.updateAudit).not.toHaveBeenCalled();
  expect(m.setStatus).not.toHaveBeenCalled();
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.getAudit.mockResolvedValue(undefined); // no prior row by default

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
  it("skips an unmapped agent without transcribing it, and writes no row", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined); // no mapping
    await processTranscription(KEY, null); // null = global queue, so no queue team either

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expectNoRowWritten();
    expect(m.recordSkip).toHaveBeenCalledWith("no_team", "2026-07-20", 900);
  });

  it("runs before the cap gate, so unmapped calls never consume a slot", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined);
    await processTranscription(KEY, null);

    // This ordering is the whole point: the cap is keyed on the team, so a
    // team-less call would otherwise bypass it and transcribe without limit.
    expect(m.reserveDailySlot).not.toHaveBeenCalled();
  });

  it("uses the queue's team when the agent has no mapping", async () => {
    m.getUserByAgentId.mockResolvedValue(undefined);
    await processTranscription(KEY, "RM"); // team-owned queue supplies the team

    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

describe("duration gate", () => {
  it("skips a short call before transcription, before the cap, and writes no row", async () => {
    m.probeBufferDurationSec.mockResolvedValue(88); // the median call

    await processTranscription(KEY, null);

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expect(m.reserveDailySlot).not.toHaveBeenCalled();
    expectNoRowWritten();
    // Seconds are tallied, not just the count — audio duration is what gets billed.
    expect(m.recordSkip).toHaveBeenCalledWith("too_short", "2026-07-20", 88);
  });

  it("fails open when the duration cannot be probed", async () => {
    m.probeBufferDurationSec.mockResolvedValue(0);
    await processTranscription(KEY, null);
    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});

describe("daily cap gate", () => {
  it("skips once the agent's slots are gone, and writes no row", async () => {
    m.reserveDailySlot.mockResolvedValue({ granted: false, used: 3 });

    await processTranscription(KEY, null);

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expectNoRowWritten();
    expect(m.recordSkip).toHaveBeenCalledWith("daily_cap", "2026-07-20", 900);
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

describe("row creation", () => {
  it("creates the row only once the call is committed to transcription", async () => {
    await processTranscription(KEY, null);

    expect(m.createAuditIfAbsent).toHaveBeenCalledTimes(1);
    const row = m.createAuditIfAbsent.mock.calls[0][0];
    expect(row).toMatchObject({
      audit_id: AUDIT_ID,
      agent_id: AGENT,
      team: "CS",
      status: "transcribing", // never persisted as "queued" then skipped
      duration_sec: 900,
    });
  });

  it("does not re-download a recording that is already processed", async () => {
    m.getAudit.mockResolvedValue({ audit_id: AUDIT_ID, status: "audited" });

    await processTranscription(KEY, null);

    expect(m.getRecordingBuffer).not.toHaveBeenCalled();
    expect(m.transcribeAudio).not.toHaveBeenCalled();
    expect(m.recordSkip).not.toHaveBeenCalled(); // not a gate skip — already done
  });

  it("re-processes a previously failed row", async () => {
    m.getAudit.mockResolvedValue({ audit_id: AUDIT_ID, status: "failed" });
    m.createAuditIfAbsent.mockResolvedValue(false); // row already exists

    await processTranscription(KEY, null);

    expect(m.setStatus).toHaveBeenCalledWith(AUDIT_ID, "transcribing");
    expect(m.transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it("backs off when another worker won the race, without transcribing twice", async () => {
    m.createAuditIfAbsent.mockResolvedValue(false);
    m.getAudit
      .mockResolvedValueOnce(undefined) // the early idempotency read saw nothing
      .mockResolvedValueOnce({ audit_id: AUDIT_ID, status: "transcribing" }); // winner claimed it

    await processTranscription(KEY, null);

    expect(m.transcribeAudio).not.toHaveBeenCalled();
    // Reservations are keyed on audit_id, so both workers hold the SAME slot.
    // Releasing here would pull it out from under the worker that is using it.
    expect(m.releaseDailySlot).not.toHaveBeenCalled();
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
