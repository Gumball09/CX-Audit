import { describe, it, expect, vi, beforeEach } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/aws.js", () => ({ ddb: { send } }));

const { reserveDailySlot, releaseDailySlot } = await import("./quota.js");

/** The error DynamoDB raises when a ConditionExpression evaluates false. */
function conditionFailure(): Error {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

const isUpdate = (cmd: any) => cmd?.input?.UpdateExpression !== undefined;
const isGet = (cmd: any) => !isUpdate(cmd);

const AGENT = "460015";
const DAY = "2026-07-20";
const AUDIT = "460015-1781072881-378068";

beforeEach(() => send.mockReset());

describe("reserveDailySlot", () => {
  it("grants without touching DynamoDB when the cap is unlimited", async () => {
    const res = await reserveDailySlot(AGENT, DAY, 0, AUDIT);
    expect(res).toEqual({ granted: true, used: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("claims a slot and reports the new count", async () => {
    send.mockResolvedValueOnce({ Attributes: { used: 1 } });

    const res = await reserveDailySlot(AGENT, DAY, 3, AUDIT);

    expect(res).toEqual({ granted: true, used: 1 });
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.TableName).toBeDefined();
    expect(cmd.input.Key).toEqual({ quota_id: `${AGENT}#${DAY}` });
    // Both the cap check and the duplicate-claim check must be in one condition,
    // or the increment stops being atomic.
    expect(cmd.input.ConditionExpression).toContain("#used < :cap");
    expect(cmd.input.ConditionExpression).toContain("NOT contains(audit_ids, :auditId)");
    expect(cmd.input.ExpressionAttributeValues[":cap"]).toBe(3);
    expect(cmd.input.ExpressionAttributeValues[":exp"]).toBeGreaterThan(0);
  });

  it("sets a TTL a week past the call's date, not a week past now", async () => {
    send.mockResolvedValueOnce({ Attributes: { used: 1 } });
    await reserveDailySlot(AGENT, "2026-07-20", 3, AUDIT);

    const exp = send.mock.calls[0][0].input.ExpressionAttributeValues[":exp"];
    expect(exp).toBe(Date.parse("2026-07-20T00:00:00.000Z") / 1000 + 7 * 86400);
  });

  it("is idempotent: a redelivery of the same audit reuses its slot", async () => {
    send
      .mockRejectedValueOnce(conditionFailure())
      .mockResolvedValueOnce({ Item: { used: 3, audit_ids: new Set([AUDIT, "other-1", "other-2"]) } });

    const res = await reserveDailySlot(AGENT, DAY, 3, AUDIT);

    // Already at the cap, but this audit is one of the holders — it proceeds.
    expect(res).toEqual({ granted: true, used: 3 });
    expect(send.mock.calls.filter(([c]) => isUpdate(c))).toHaveLength(1); // no second increment
  });

  it("refuses once the cap is reached by other calls", async () => {
    send
      .mockRejectedValueOnce(conditionFailure())
      .mockResolvedValueOnce({ Item: { used: 3, audit_ids: new Set(["a", "b", "c"]) } });

    expect(await reserveDailySlot(AGENT, DAY, 3, AUDIT)).toEqual({ granted: false, used: 3 });
  });

  it("retries when it raced another claim but is still under cap", async () => {
    send
      .mockRejectedValueOnce(conditionFailure())
      .mockResolvedValueOnce({ Item: { used: 1, audit_ids: new Set(["a"]) } }) // under cap, not ours
      .mockResolvedValueOnce({ Attributes: { used: 2 } }); // retry claims it

    expect(await reserveDailySlot(AGENT, DAY, 3, AUDIT)).toEqual({ granted: true, used: 2 });
    expect(send.mock.calls.filter(([c]) => isUpdate(c))).toHaveLength(2);
  });

  it("fails closed when contention never settles", async () => {
    // Always contended, always under cap — must not spin forever, and must not
    // grant. Overshooting the budget is worse than skipping one call.
    send.mockImplementation((cmd: any) =>
      isGet(cmd)
        ? Promise.resolve({ Item: { used: 1, audit_ids: new Set(["a"]) } })
        : Promise.reject(conditionFailure())
    );

    expect(await reserveDailySlot(AGENT, DAY, 3, AUDIT)).toEqual({ granted: false, used: 3 });
    expect(send.mock.calls.filter(([c]) => isUpdate(c))).toHaveLength(3);
  });

  it("propagates non-condition errors instead of silently granting", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }));
    await expect(reserveDailySlot(AGENT, DAY, 3, AUDIT)).rejects.toThrow("throttled");
  });

  it("treats a missing counter as zero used", async () => {
    send
      .mockRejectedValueOnce(conditionFailure())
      .mockResolvedValueOnce({}) // no Item at all
      .mockResolvedValueOnce({ Attributes: { used: 1 } });

    expect(await reserveDailySlot(AGENT, DAY, 3, AUDIT)).toEqual({ granted: true, used: 1 });
  });
});

describe("releaseDailySlot", () => {
  it("decrements and removes the audit id, guarded so it can't go negative", async () => {
    send.mockResolvedValueOnce({});

    await releaseDailySlot(AGENT, DAY, AUDIT);

    const cmd = send.mock.calls[0][0];
    expect(cmd.input.UpdateExpression).toContain("DELETE audit_ids");
    expect(cmd.input.ExpressionAttributeValues[":minusOne"]).toBe(-1);
    expect(cmd.input.ConditionExpression).toContain("contains(audit_ids, :auditId)");
    expect(cmd.input.ConditionExpression).toContain("#used > :zero");
  });

  it("is a no-op when no slot is held", async () => {
    send.mockRejectedValueOnce(conditionFailure());
    await expect(releaseDailySlot(AGENT, DAY, AUDIT)).resolves.toBeUndefined();
  });

  it("swallows unexpected errors so it never masks the original failure", async () => {
    // It runs on the error path of a failed transcription; throwing here would
    // replace the real error with a bookkeeping one.
    send.mockRejectedValueOnce(new Error("network down"));
    await expect(releaseDailySlot(AGENT, DAY, AUDIT)).resolves.toBeUndefined();
  });
});
