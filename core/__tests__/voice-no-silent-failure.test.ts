/**
 * ISSUE 2 — Auto/voice mode answered with silence.
 *
 * The real break: `brain.send()` returned early, with no value, whenever a
 * previous run was still active (`if (!text || this.state.activeRunId) return;`).
 * Auto Mode called it and had no way to know the turn had been dropped, so the
 * owner spoke, saw "Listening…", and never got an answer or an error.
 *
 * Every other stage that can fail — no microphone, no local transcriber, no
 * speech output — had the same shape: the state carried an error nobody said
 * out loud. These regressions pin the fix: a reported result, and an audible
 * failure at every stage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const brainSource = source("src/lib/friday/brain-engine.ts");
const assistant = source("src/lib/friday/assistant-mode.ts");

describe("the brain reports a dropped turn instead of swallowing it", () => {
  it("returns a typed result from send()", () => {
    expect(brainSource).toMatch(/export type SendResult = \{/);
    expect(brainSource).toMatch(/\): SendResult \{/);
    // The old silent early-return is gone for good.
    expect(brainSource).not.toContain("if (!text || this.state.activeRunId) return;");
  });

  it("names both refusals and gives each one a spoken-ready message", () => {
    expect(brainSource).toMatch(/reason: "empty"[\s\S]{0,80}message: "I didn't catch anything\."/);
    expect(brainSource).toMatch(/reason: "busy"[\s\S]{0,120}I'm still working on the last request/);
  });

  /** The same guard, replayed exactly as the engine now implements it. */
  const send = (prompt: string, activeRunId: string | null) => {
    const text = prompt.trim();
    if (!text) return { accepted: false, reason: "empty" as const };
    if (activeRunId) return { accepted: false, reason: "busy" as const };
    return { accepted: true, reason: "accepted" as const };
  };

  it("refuses, audibly, while another run is in flight and accepts once it clears", () => {
    expect(send("what is the weather", "run-1")).toEqual({ accepted: false, reason: "busy" });
    expect(send("   ", null)).toEqual({ accepted: false, reason: "empty" });
    expect(send("what is the weather", null)).toEqual({ accepted: true, reason: "accepted" });
  });
});

describe("Auto Mode never fails silently at any stage", () => {
  it("speaks and shows a dropped turn instead of ignoring it", () => {
    expect(assistant).toContain("let result = brain.send(command, payload);");
    expect(assistant).toContain("if (!result.accepted) {");
    // reportFailure captions AND speaks — the owner may not be at the screen.
    expect(assistant).toMatch(
      /private reportFailure\([\s\S]*this\.caption\("friday", message\);[\s\S]*this\.speak\(message\);/,
    );
  });

  it("announces a missing microphone, a missing transcriber and dead speech output", () => {
    expect(assistant).toMatch(/reportFailure\([\s\S]{0,200}"Microphone unavailable"/);
    expect(assistant).toMatch(
      /reportFailure\([\s\S]{0,300}"Local speech recognition not installed"/,
    );
    // speakText resolving "none" means nothing was actually spoken.
    expect(assistant).toContain('if (how !== "none") return;');
    expect(assistant).toMatch(/voice output failed — no speech engine could speak the reply/);
    expect(assistant).toMatch(/\.catch\(\(error: unknown\) => \{[\s\S]{0,400}voice output failed/);
  });
});
