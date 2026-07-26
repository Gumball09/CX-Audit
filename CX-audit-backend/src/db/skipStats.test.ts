import { describe, it, expect, vi, beforeEach } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/aws.js", () => ({ ddb: { send } }));

const { recordSkip, getSkipStats } = await import("./skipStats.js");

const DAY = "2026-07-20";

beforeEach(() => send.mockReset());

describe("recordSkip", () => {
  it("increments the count and the seconds for the reason given", async () => {
    send.mockResolvedValueOnce({});

    await recordSkip("too_short", DAY, 88);

    const cmd = send.mock.calls[0][0];
    expect(cmd.input.Key).toEqual({ quota_id: `skips#${DAY}` });
    expect(cmd.input.ExpressionAttributeNames).toEqual({
      "#count": "too_short_count",
      "#sec": "too_short_sec",
    });
    expect(cmd.input.ExpressionAttributeValues[":one"]).toBe(1);
    expect(cmd.input.ExpressionAttributeValues[":seconds"]).toBe(88);
  });

  it("keeps one item per day regardless of how many calls are skipped", async () => {
    send.mockResolvedValue({});

    await recordSkip("too_short", DAY, 30);
    await recordSkip("daily_cap", DAY, 900);
    await recordSkip("no_team", DAY, 120);

    const keys = send.mock.calls.map(([c]: any) => c.input.Key.quota_id);
    expect(new Set(keys).size).toBe(1);
  });

  it("rounds and floors odd durations to zero rather than writing garbage", async () => {
    send.mockResolvedValue({});

    await recordSkip("no_team", DAY, -5);
    await recordSkip("no_team", DAY, NaN);
    await recordSkip("no_team", DAY, 12.6);

    const secs = send.mock.calls.map(([c]: any) => c.input.ExpressionAttributeValues[":seconds"]);
    expect(secs).toEqual([0, 0, 13]);
  });

  it("outlives the 7-day quota rows so trends stay readable", async () => {
    send.mockResolvedValueOnce({});
    await recordSkip("too_short", DAY, 10);

    const exp = send.mock.calls[0][0].input.ExpressionAttributeValues[":exp"];
    expect(exp).toBe(Date.parse(`${DAY}T00:00:00.000Z`) / 1000 + 90 * 86400);
  });

  it("never throws — a bookkeeping failure must not fail the pipeline", async () => {
    // This runs on the path where we successfully AVOIDED a cost. Throwing here
    // would turn a saving into a retry and, eventually, a DLQ message.
    send.mockRejectedValueOnce(new Error("table missing"));
    await expect(recordSkip("too_short", DAY, 88)).resolves.toBeUndefined();
  });
});

describe("getSkipStats", () => {
  it("reads a day's tallies", async () => {
    send.mockResolvedValueOnce({
      Item: { quota_id: `skips#${DAY}`, too_short_count: 12, too_short_sec: 900, no_team_count: 3 },
    });

    expect(await getSkipStats(DAY)).toEqual({
      day: DAY,
      too_short_count: 12,
      too_short_sec: 900,
      daily_cap_count: 0,
      daily_cap_sec: 0,
      no_team_count: 3,
      no_team_sec: 0, // absent counters read as zero
    });
  });

  it("returns zeroes for a day with no skips", async () => {
    send.mockResolvedValueOnce({});
    const stats = await getSkipStats(DAY);
    expect(stats.too_short_count).toBe(0);
    expect(stats.daily_cap_count).toBe(0);
  });

  it("degrades to zeroes instead of throwing when the read fails", async () => {
    send.mockRejectedValueOnce(new Error("throttled"));
    await expect(getSkipStats(DAY)).resolves.toMatchObject({ day: DAY, too_short_count: 0 });
  });
});
