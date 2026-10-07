/**
 * Main-window layout: Auto Mode HUD/stats and Manual ChatDock toolbars
 * must wrap instead of overlaying the live graphic or each other.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Auto Mode HUD is a reserved row, not an overlay", () => {
  const ui = source("src/components/friday/AutoMode.tsx");
  const circuit = source("src/components/friday/NeuralCircuit.tsx");

  it("keeps voice badges and session stats in flex rows, not absolute overlays", () => {
    expect(ui).toContain("flex min-h-0 flex-1 flex-col overflow-hidden");
    expect(ui).not.toContain("absolute left-3 top-3");
    expect(ui).not.toContain("absolute inset-x-3 bottom-3");
    expect(ui).toContain("flex max-w-full shrink-0 flex-wrap items-center gap-1.5 px-3 pt-3");
    expect(ui).toContain("flex shrink-0 flex-col gap-2 px-3 pb-3");
  });

  it("reuses the HudPanel toolbar wrap on the caption bar", () => {
    expect(ui).toContain(
      "flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-primary/15 px-3 py-1",
    );
  });

  it("parks WORKING/IDLE on the HUD row in Auto Mode so it cannot cover Verification", () => {
    expect(ui).toContain('{working ? "WORKING" : "IDLE"}');
    expect(circuit).toContain("{large ? null : (");
    expect(circuit).toContain("absolute right-3 top-3");
  });
});

describe("Manual ChatDock toolbars wrap at the window minimum", () => {
  const dock = source("src/components/friday/ChatDock.tsx");

  it("wraps the conversation header and composer actions like HudPanel", () => {
    expect(dock).toContain(
      "flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-primary/10 px-3 py-1.5",
    );
    expect(dock).toContain("flex min-w-0 flex-wrap items-center justify-between gap-2");
    expect(dock).toContain("flex min-w-0 flex-wrap items-center justify-end gap-1");
    expect(dock).toContain("flex min-w-0 flex-wrap items-center gap-1");
  });
});

describe("Manual + Auto status stays on live stores", () => {
  it("does not open a chat microphone; Auto mode retries when faster-whisper appears", () => {
    const dock = source("src/components/friday/ChatDock.tsx");
    expect(dock).toContain("Chat does not use the microphone. Auto mode listens.");
    expect(dock).not.toContain("DesktopDictation");
    const assistant = source("src/lib/friday/assistant-mode.ts");
    expect(assistant).toContain('installed["faster-whisper"]');
    expect(assistant).toContain("this.startRecognition()");
  });

  it("Auto Mode still reads the assistant, brain and live stores", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).toContain("useAssistantMode()");
    expect(ui).toContain("useBrain()");
    expect(ui).toContain("useFridayLive()");
  });

  it("does not offer hands-free or awake while a voice error is showing", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).toContain("voice.handsFree && !voice.error");
    expect(ui).toContain("voice.awake && !voice.error");
  });
});
