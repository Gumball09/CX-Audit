import { describe, it, expect } from "vitest";
import { parseCap, DEFAULT_DAILY_AUDIT_CAP } from "./teams.js";

/**
 * `daily_audit_cap` is a spend control, so the important cases here are the
 * invalid ones: anything that quietly becomes "unlimited" is an open-ended bill.
 */
describe("parseCap", () => {
  it("accepts non-negative integers", () => {
    expect(parseCap(3)).toBe(3);
    expect(parseCap("5")).toBe(5);
    expect(parseCap(0)).toBe(0); // an explicit, deliberate "unlimited"
  });

  it("floors fractional input rather than rejecting it", () => {
    expect(parseCap(3.7)).toBe(3);
  });

  it("treats absent input as 'leave unchanged', not as a value", () => {
    expect(parseCap(undefined)).toBeUndefined();
    expect(parseCap(null)).toBeUndefined();
    expect(parseCap("")).toBeUndefined();
  });

  it("rejects garbage instead of failing open to unlimited", () => {
    // Each of these used to coerce to `undefined`, which the caller then read as
    // "no cap" — a typo silently uncapped the team.
    expect(parseCap("abc")).toBe("invalid");
    expect(parseCap(-1)).toBe("invalid");
    expect(parseCap(NaN)).toBe("invalid");
    expect(parseCap(Infinity)).toBe("invalid");
    expect(parseCap({})).toBe("invalid");
  });

  it("defaults new teams to a real cap", () => {
    expect(DEFAULT_DAILY_AUDIT_CAP).toBe(3);
    expect(parseCap(undefined) ?? DEFAULT_DAILY_AUDIT_CAP).toBe(3);
  });
});
