/**
 * Main-window live wiring: conversation header, NeuralCircuit progress,
 * and Auto Mode captions stay on the real engines — no second HUD, no 1.2s fake.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { conversationEngineLabel } from "../../src/lib/friday/model-registry";
import { streamingStageProgress } from "../../src/lib/friday/use-friday-live";
import { mergeTurnExtra, turnAwarenessExtra } from "../../src/lib/friday/turn-awareness";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("conversation header names the live engine", () => {
  it("prefers the run's real label over Auto", () => {
    expect(
      conversationEngineLabel({
        routeMode: "auto",
        selected: [],
        models: [],
        liveLabel: "Llama 3.2",
      }),
    ).toBe("Llama 3.2");
    expect(
      conversationEngineLabel({
        routeMode: "auto",
        selected: [],
        models: [],
      }),
    ).toBe("Auto");
    expect(
      conversationEngineLabel({
        routeMode: "auto",
        selected: [],
        models: [],
        phase: "will",
      }),
    ).toBe("will use Auto");
    expect(
      conversationEngineLabel({
        routeMode: "auto",
        selected: [],
        models: [],
        liveLabel: "Auto → Groq · llama-3.3-70b",
        phase: "used",
      }),
    ).toBe("used Auto → Groq · llama-3.3-70b");
  });

  it("does not read models-engine routing.brain as the answering engine", () => {
    const dock = read("src/components/friday/ChatDock.tsx");
    expect(dock).toContain("conversationEngineLabel");
    expect(dock).toContain("Chat does not use the microphone. Auto mode listens.");
    expect(dock).not.toContain("modelsState.routing.brain");
    expect(dock).not.toContain("modelCatalog.find");
  });
});

describe("NeuralCircuit progress stays honest while a model streams", () => {
  it("does not treat 1.2s of execute as 100% complete", () => {
    expect(streamingStageProgress({ id: "execute", ms: 1200 })).toBeLessThan(40);
    expect(streamingStageProgress({ id: "respond", ms: 60_000 })).toBeLessThan(93);
    expect(streamingStageProgress({ id: "intent", ms: 400 })).toBe(100);
  });

  it("maps desktop stream events onto later pipeline stages", () => {
    const engine = read("src/lib/friday/brain-engine.ts");
    expect(engine).toContain("applyDesktopPhase");
    expect(engine).toContain('applyDesktopPhase(run, "stream"');
    expect(engine).toContain('applyDesktopPhase(run, "wait"');
    expect(read("src/lib/friday/use-friday-live.ts")).toContain("streamingStageProgress");
    expect(read("src/lib/friday/use-friday-live.ts")).toContain(
      "const stageProgress = stage ? streamingStageProgress(stage) : 0",
    );
  });
});

describe("typed / voice / phone extras share one builder", () => {
  it("joins blocks without inventing empty context", () => {
    expect(mergeTurnExtra("a", "", "b")).toBe("a\n\nb");
    expect(turnAwarenessExtra("hello there")).toBe("");
  });

  it("is the extra source for ChatDock, Auto Mode, and phone cognize", () => {
    expect(read("src/components/friday/ChatDock.tsx")).toContain('kind: "typed"');
    expect(read("src/lib/friday/assistant-mode.ts")).toContain('kind: "voice"');
    expect(read("src/lib/friday/brain-engine.ts")).toContain('kind: "phone"');
  });
});
