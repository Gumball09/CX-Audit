import { describe, it, expect } from "vitest";
import { resolveSettings } from "./settings.js";

/**
 * Model ids are not portable between providers, so the settings row and the active
 * provider have to agree. The dangerous case is the one that exists in production
 * right now: a row written before `ai_provider` was a field, holding OpenAI model
 * ids and saying nothing about which provider they belong to.
 */
describe("resolveSettings", () => {
  it("discards OpenAI model ids from a pre-migration row when Sarvam is active", () => {
    // The live prod row: no ai_provider, OpenAI models. Keeping `gpt-4o` here would
    // send an OpenAI model name to api.sarvam.ai and fail every single audit.
    const s = resolveSettings(
      {
        transcription_model: "gpt-4o-mini-transcribe",
        audit_model: "gpt-4o",
        min_audit_duration_sec: 600,
      },
      "sarvam"
    );
    expect(s.ai_provider).toBe("sarvam");
    expect(s.audit_model).toBe("sarvam-105b");
    expect(s.transcription_model).toBe("saaras:v3");
    // Unrelated settings on the same row must survive untouched.
    expect(s.min_audit_duration_sec).toBe(600);
  });

  it("keeps the stored models when the row predates the field but OpenAI is still active", () => {
    const s = resolveSettings(
      { transcription_model: "gpt-4o-transcribe", audit_model: "gpt-4.1" },
      "openai"
    );
    expect(s.audit_model).toBe("gpt-4.1");
    expect(s.transcription_model).toBe("gpt-4o-transcribe");
  });

  it("honours stored models once the row declares its provider", () => {
    // A deliberate admin choice — e.g. the cheaper Sarvam model — must not be
    // silently reset back to the default on every read.
    const s = resolveSettings(
      { ai_provider: "sarvam", transcription_model: "saaras:v2.5", audit_model: "sarvam-30b" },
      "sarvam"
    );
    expect(s.audit_model).toBe("sarvam-30b");
    expect(s.transcription_model).toBe("saaras:v2.5");
  });

  it("falls back entirely for a missing row", () => {
    const s = resolveSettings(undefined, "sarvam");
    expect(s.ai_provider).toBe("sarvam");
    expect(s.audit_model).toBe("sarvam-105b");
  });

  it("ignores a junk provider value rather than trusting it", () => {
    const s = resolveSettings({ ai_provider: "gemini" as never, audit_model: "gpt-4o" }, "sarvam");
    expect(s.ai_provider).toBe("sarvam");
    expect(s.audit_model).toBe("sarvam-105b");
  });
});
