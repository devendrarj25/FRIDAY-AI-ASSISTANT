import { describe, expect, it } from "vitest";
import { plainFaultLine } from "../../src/lib/friday/mic-session";

describe("mic fault text is anchored to the microphone class", () => {
  it("does not call a missing speech or wake model a missing microphone", () => {
    for (const raw of ["Speech model not found in models folder", "Wake model not found"]) {
      expect(plainFaultLine(raw, "en")).toBe(raw);
    }
  });

  it("still maps the real no-microphone phrases", () => {
    for (const raw of ["no-microphone", "No microphone found", "NotFoundError", "no audio input"]) {
      expect(plainFaultLine(raw, "en")).toMatch(/Plug one in/);
    }
  });

  it("does not turn a worker crash into a busy microphone", () => {
    const raw = "voice: stt crashed in use by worker";
    expect(plainFaultLine(raw, "en")).toBe(raw);
  });

  it("takes the class from the mic state first", () => {
    expect(plainFaultLine("Speech model not found", "en", { micState: "no-microphone" })).toMatch(
      /Plug one in/,
    );
    expect(plainFaultLine("something odd", "en", { micState: "permission-denied" })).toMatch(
      /blocked/,
    );
    expect(plainFaultLine("no-microphone", "en", { micState: "available" })).toMatch(/Plug one in/);
  });

  it("says Reopening now only while a heal runs", () => {
    const raw = "No audio frames arrived.";
    expect(plainFaultLine(raw, "en")).not.toMatch(/Reopening/);
    expect(plainFaultLine(raw, "en", { healing: true })).toMatch(/Reopening now/);
    expect(plainFaultLine(raw, "hinglish", { healing: true })).toMatch(/Dobara khol rahi hoon/);
    expect(plainFaultLine(raw, "hi", { healing: false })).not.toMatch(/दोबारा खोल/);
  });
});
