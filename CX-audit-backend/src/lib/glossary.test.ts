import { describe, it, expect } from "vitest";
import { normalizeTerms, substitutionCount } from "./glossary.js";

/**
 * The cases below are taken from real transcripts, both the ones that must be
 * fixed and — more importantly — the ones that must be left alone. A glossary that
 * corrupts a correct transcript is worse than the problem it solves.
 */
describe("normalizeTerms", () => {
  it("fixes the company name in the greetings we actually saw", () => {
    const cases: [string, string][] = [
      ["Hi, this is Shabaz here from Eskillo.", "Hi, this is Shabaz here from Scaler."],
      ["Hi, this is Shabash here from Skillo.", "Hi, this is Shabash here from Scaler."],
      ["Hi, this is Shabaz here from SKL.", "Hi, this is Shabaz here from Scaler."],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeTerms(input).text).toBe(expected);
    }
  });

  it("fixes the support address without touching the local part", () => {
    expect(normalizeTerms("update update@skla.com.").text).toBe("update update@scaler.com.");
    expect(normalizeTerms("update@kerala.com that's it right?").text).toBe(
      "update@scaler.com that's it right?"
    );
  });

  it("leaves an already-correct mention alone", () => {
    // The same call had one correct rendering. It must survive untouched, and must
    // not be reported as a substitution.
    const r = normalizeTerms("share us and on update@scaler.com I'll be highlighting this");
    expect(r.text).toBe("share us and on update@scaler.com I'll be highlighting this");
    expect(substitutionCount(r.substitutions)).toBe(0);
  });

  it("never rewrites 'scalar', which is a real word on data-science calls", () => {
    const input = "a scalar value versus a vector, the scalar multiplication step";
    expect(normalizeTerms(input).text).toBe(input);
  });

  it("never rewrites Kerala as a place name", () => {
    const input = "I am calling from Kerala and my colleague is in Kerala too";
    expect(normalizeTerms(input).text).toBe(input);
  });

  it("only matches whole words, so it cannot corrupt a longer token", () => {
    const input = "the sklearn library and skls are unrelated";
    expect(normalizeTerms(input).text).toBe(input);
  });

  it("reports what it changed, per rule, for the audit log", () => {
    const r = normalizeTerms("from Eskillo. Mail update@skla.com or Skillo support");
    expect(r.substitutions).toEqual({ "company name": 2, "support email domain": 1 });
    expect(substitutionCount(r.substitutions)).toBe(3);
  });

  it("handles empty and unchanged input without inventing substitutions", () => {
    expect(normalizeTerms("")).toEqual({ text: "", substitutions: {} });
    expect(normalizeTerms("nothing to see here").substitutions).toEqual({});
  });

  it("does NOT attempt the error classes it cannot detect", () => {
    // Documented as a limit rather than a gap. A dropped negation and a fluent
    // hallucination both pass through untouched — no glossary can catch them, and
    // pretending otherwise would give false confidence in the transcript.
    expect(normalizeTerms("ya ya. Yes. I can't").text).toBe("ya ya. Yes. I can't");
    expect(normalizeTerms("Ready? blouse piece and walk Yeah").text).toBe(
      "Ready? blouse piece and walk Yeah"
    );
  });
});
