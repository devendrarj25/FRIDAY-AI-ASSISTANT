import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import {
  beginVoiceTurn,
  markTurnStage,
  resetVoiceTurns,
  turnTraceLine,
  voiceTurn,
  whereItStopped,
} from "../../src/lib/friday/voice-turn-trace";
import { spokenRouteError } from "../../src/lib/friday/voice-session";

describe("voice turn trace", () => {
  beforeEach(() => resetVoiceTurns());

  it("walks heard to spoken with a time on each stage", () => {
    beginVoiceTurn(1000);
    markTurnStage("heard", true, "", "4 words", 1000);
    markTurnStage("routed", true, "", "auto", 1010);
    markTurnStage("model", true, "", "local llama", 1500);
    markTurnStage("reply", true, "", "22 chars", 1600);
    markTurnStage("spoken", true, "", "sapi", 1900);
    expect(whereItStopped(voiceTurn())).toBeNull();
    expect(turnTraceLine(voiceTurn())).toBe(
      "heard ✓ +0ms (4 words) → routed ✓ +10ms (auto) → model ✓ +500ms (local llama) → reply ✓ +600ms (22 chars) → spoken ✓ +900ms (sapi)",
    );
  });

  it("names the stage where a transcript died and keeps its first reason", () => {
    beginVoiceTurn(0);
    markTurnStage("heard", true, "", "", 0);
    markTurnStage("routed", true, "", "", 5);
    markTurnStage("model", false, "NO_FREE_MODEL_AVAILABLE", "", 40);
    markTurnStage("model", true, "", "", 90);
    expect(whereItStopped(voiceTurn())).toEqual({
      stage: "model",
      reason: "NO_FREE_MODEL_AVAILABLE",
    });
    markTurnStage("spoken", false, "Speak replies is turned off in Voice settings", "", 100);
    expect(turnTraceLine(voiceTurn())).toContain("spoken ✗");
  });

  it("is wired at every stage of the live Auto path", () => {
    const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");
    for (const stage of ["heard", "routed", "model", "reply", "spoken"]) {
      expect(mode).toMatch(new RegExp(`markTurnStage\\(\\s*"${stage}"`));
    }
  });
});

describe("the true reason when every model is blocked", () => {
  it("speaks the first line of the failure, not the generic sentence", () => {
    const reason = "Paid-only is on, but paid AI access is off — no model can answer.";
    const text = [
      reason,
      "",
      "Want me to help you connect a model in Models, or start a local one with Ollama?",
    ].join("\n");
    expect(spokenRouteError(text)).toBe(reason);
    expect(
      spokenRouteError(
        "I can't answer that one on my own — it needs a connected AI model.\n\nWant me to help you connect a model in Models",
      ),
    ).toBe("No model is reachable. Connect one in Models, or start a local engine.");
  });

  it("leads the chat error with the reason from the router", () => {
    const router = createRequire(import.meta.url)("../../electron/model-router.cjs") as {
      blockedSummary: (input: Record<string, unknown>) => string;
    };
    const blocked = router.blockedSummary;
    expect(
      blocked({
        detail:
          "NO_FREE_MODEL_AVAILABLE: no verified free local or cloud model could answer. Paid and unknown-cost models stay blocked while usage is Free only.",
      }),
    ).toMatch(/^no verified free local or cloud model could answer/);
    expect(
      blocked({
        detail: "FRIDAY couldn't connect to an available AI model.",
        failures: [{ label: "Groq Llama", category: "invalid_key" }],
      }),
    ).toBe("I tried one model and none answered: Groq Llama API key rejected.");
    expect(blocked({ detail: "", offline: true })).toBe(
      "I am offline and no local model is running.",
    );
    const main = readFileSync("electron/main.cjs", "utf8");
    expect(main).toContain("honestHandoff(detail, reason)");
    expect(main).not.toMatch(
      /function honestHandoff\(detail\) \{\s*return \[\s*"I can't answer that one on my own/,
    );
  });
});
