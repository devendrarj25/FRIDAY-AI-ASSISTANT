/**
 * Auto picks a speech size that fits this PC and the listening language, and never a slower one than today's small.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { applySttTier } from "../../src/lib/friday/voice-session";

const require = createRequire(import.meta.url);
const voiceInstall = require("../../electron/voice-install.cjs") as {
  bootModel: (input: Record<string, unknown>) => {
    model: string;
    upgrade: string | null;
    reason: string;
  };
};
const both = { baseCached: true, smallCached: true };

describe("bootModel on Auto", () => {
  it("keeps small unless memory or the language says otherwise", () => {
    expect(voiceInstall.bootModel({ requested: "auto", ...both }).model).toBe("small");
    expect(
      voiceInstall.bootModel({ requested: "auto", ...both, ramGb: 16, language: "hi-IN" }).model,
    ).toBe("small");
    expect(
      voiceInstall.bootModel({ requested: "auto", ...both, ramGb: 0, language: "auto" }).model,
    ).toBe("small");
    // Unknown memory (0) and the old input shape are today's behaviour.
    expect(voiceInstall.bootModel({ requested: "auto" }).model).toBe("base");
  });

  it("steps down for a small PC, with the same thresholds as the tier rule, and never up past small", () => {
    const tier = (ramGb: number) =>
      voiceInstall.bootModel({ requested: "auto", ...both, ramGb }).model;
    for (const ramGb of [1, 2, 3.9, 4, 6, 7.9, 8, 12, 16, 32, 128]) {
      const wanted = applySttTier({ auto: true, ramGb, gpu: false, battery: false });
      const expected = ["medium", "large-v3"].includes(wanted) ? "small" : wanted;
      expect(tier(ramGb)).toBe(expected);
    }
  });

  it("hears plain English (US) with base, and Indian English, Hindi, Hinglish and auto with small", () => {
    const pick = (language: string) =>
      voiceInstall.bootModel({ requested: "auto", ...both, language }).model;
    expect(pick("en-US")).toBe("base");
    expect(pick("en_US")).toBe("base");
    for (const language of ["en-IN", "hi-IN", "hi-Latn", "auto", "mixed", "", "fr"]) {
      expect(pick(language)).toBe("small");
    }
  });

  it("never overrides an owner lock, and a slow load still steps down", () => {
    expect(
      voiceInstall.bootModel({ requested: "medium", ...both, ramGb: 2, language: "en-US" }).model,
    ).toBe("medium");
    expect(
      voiceInstall.bootModel({
        requested: "auto",
        ...both,
        ramGb: 16,
        failed: true,
        baseCached: true,
      }).model,
    ).toBe("base");
  });

  it("is read from the real machine and the real request, not guessed", () => {
    const source = readFileSync("electron/stt.cjs", "utf8");
    expect(source).toContain("ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10");
    expect(source).toContain("language: listeningPref");
    // A preview that names no language keeps the last named one, so the size cannot flip between two requests.
    expect(source).toMatch(/if \(pref\) listeningPref = pref\.slice\(0, 32\)/);
    expect(source).toContain("noteListeningPref(req);");
  });
});
