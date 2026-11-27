import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateLabel, type VoiceState } from "../../src/lib/friday/voice-state";
import { voiceGate } from "../../src/lib/friday/voice-audio";

// The meter's effect and ref are captured so the component can be driven without a DOM.
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  node: { style: { transform: "" } } as { style: { transform: string } },
}));
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useEffect: (fn: () => void | (() => void)) => {
      hooks.effects.push(fn);
    },
    useRef: () => ({ current: hooks.node }),
  };
});

import { LatencyChip, ModeChips, PhaseChip } from "../../src/components/friday/VoiceControlBar";
import {
  METER_STEPS,
  interimPlaceholder,
  latencyChipModel,
  meterScale,
  phaseChipModel,
  plainStateLabel,
} from "../../src/components/friday/voice-live-status-model";
import { VoiceLevelMeter } from "../../src/components/friday/VoiceLevelMeter";
import { LATENCY_BUDGET_MS } from "../../src/lib/friday/voice-engine/latency-monitor";

const ALL_STATES: VoiceState[] = [
  "OFF",
  "STARTING",
  "LISTENING",
  "SPEECH_DETECTED",
  "TRANSCRIBING",
  "WAKE_DETECTED",
  "COMMAND_LISTENING",
  "THINKING",
  "SPEAKING",
  "INTERRUPTED",
  "WAITING_CONFIRMATION",
  "PAUSED",
  "ERROR",
  "STOPPING",
];

const source = (file: string) => readFileSync(join(__dirname, "../..", file), "utf8");

describe("phase chip", () => {
  const base = { voiceState: "LISTENING" as VoiceState, pending: false };
  it("names every phase in plain words", () => {
    expect(phaseChipModel({ ...base, phase: "listening" }).label).toBe("Listening");
    expect(phaseChipModel({ ...base, phase: "hearing" }).label).toBe("Hearing you");
    expect(phaseChipModel({ ...base, phase: "thinking" }).label).toBe("Thinking");
    expect(phaseChipModel({ ...base, phase: "speaking" }).label).toBe("Speaking");
    expect(phaseChipModel({ ...base, phase: "off" }).label).toBe("Stopped");
    expect(phaseChipModel({ ...base, phase: "unavailable" }).label).toBe("Stopped");
  });
  it("a command waiting for yes or no wins over thinking and listening, never over speech or a stop", () => {
    const wait = "Waiting for yes or no";
    expect(
      phaseChipModel({ phase: "thinking", voiceState: "WAITING_CONFIRMATION", pending: false })
        .label,
    ).toBe(wait);
    expect(
      phaseChipModel({ phase: "listening", voiceState: "LISTENING", pending: true }).label,
    ).toBe(wait);
    expect(
      phaseChipModel({ phase: "hearing", voiceState: "SPEECH_DETECTED", pending: true }).label,
    ).toBe(wait);
    expect(phaseChipModel({ phase: "speaking", voiceState: "SPEAKING", pending: true }).label).toBe(
      "Speaking",
    );
    expect(
      phaseChipModel({ phase: "unavailable", voiceState: "PAUSED", pending: true }).label,
    ).toBe("Stopped");
  });
  it("renders the words, not only a colour, for the chip", () => {
    const html = renderToStaticMarkup(
      createElement(PhaseChip, { phase: "hearing", voiceState: "SPEECH_DETECTED", pending: false }),
    );
    expect(html).toContain("Hearing you");
    expect(html).toContain('data-phase="hearing"');
    expect(html).not.toMatch(/SPEECH_DETECTED(?!")/);
  });
  it("is a live region only for confirm and stopped, silent for the other phases", () => {
    const render = (phase: "hearing" | "unavailable", voiceState: "SPEECH_DETECTED" | "PAUSED") =>
      renderToStaticMarkup(createElement(PhaseChip, { phase, voiceState, pending: false }));
    expect(render("hearing", "SPEECH_DETECTED")).not.toContain("aria-live");
    expect(render("hearing", "SPEECH_DETECTED")).not.toContain('role="status"');
    const stopped = render("unavailable", "PAUSED");
    expect(stopped).toContain('data-phase="stopped"');
    expect(stopped).toContain('role="status"');
    const confirm = renderToStaticMarkup(
      createElement(PhaseChip, { phase: "hearing", voiceState: "SPEECH_DETECTED", pending: true }),
    );
    expect(confirm).toContain('data-phase="confirm"');
    expect(confirm).toContain('aria-live="polite"');
  });
  it("gives the latency chip a sentence label", () => {
    const html = renderToStaticMarkup(createElement(LatencyChip, { summary: { last: 640 } }));
    expect(html).toContain("aria-label=");
    expect(html).toContain("her first sound");
  });
});

describe("stateLabel mapping", () => {
  it("plainStateLabel never returns a raw enum or a trailing ellipsis", () => {
    for (const state of ALL_STATES) {
      const text = plainStateLabel(state);
      expect(text).not.toMatch(/[_]/);
      expect(text).not.toBe(state);
      expect(text).not.toMatch(/[….\s]$/);
      expect(stateLabel(state).startsWith(text)).toBe(true);
    }
  });
  it("the Auto screen shows the label, not the enum", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).not.toContain("voice.voiceState.toLowerCase()");
    expect(ui).toContain("plainStateLabel(voice.voiceState)");
  });
});

describe("mode chips", () => {
  it("shows Hands-free and Dictating only while on, and nothing otherwise", () => {
    expect(
      renderToStaticMarkup(createElement(ModeChips, { handsFree: false, dictating: false })),
    ).toBe("");
    const both = renderToStaticMarkup(
      createElement(ModeChips, { handsFree: true, dictating: true }),
    );
    expect(both).toContain("Hands-free");
    expect(both).toContain("Dictating");
    const only = renderToStaticMarkup(
      createElement(ModeChips, { handsFree: false, dictating: true }),
    );
    expect(only).toContain("Dictating");
    expect(only).not.toContain("Hands-free");
  });
  it("the chips are state only: no button, no handler", () => {
    const html = renderToStaticMarkup(
      createElement(ModeChips, { handsFree: true, dictating: true }),
    );
    expect(html).not.toContain("<button");
  });
});

describe("last-turn latency chip", () => {
  it("draws nothing before a turn was measured", () => {
    expect(latencyChipModel(null)).toBeNull();
    expect(latencyChipModel(undefined)).toBeNull();
    expect(latencyChipModel({ last: Number.NaN })).toBeNull();
    expect(renderToStaticMarkup(createElement(LatencyChip, { summary: null }))).toBe("");
  });
  it("reads the last turn and flags only a turn over the budget", () => {
    expect(latencyChipModel({ last: 640.4 })).toEqual({
      label: "Last turn 640 ms",
      overBudget: false,
    });
    expect(latencyChipModel({ last: LATENCY_BUDGET_MS })?.overBudget).toBe(false);
    expect(latencyChipModel({ last: LATENCY_BUDGET_MS + 1 })?.overBudget).toBe(true);
    const html = renderToStaticMarkup(createElement(LatencyChip, { summary: { last: 1200 } }));
    expect(html).toContain("Last turn 1200 ms");
  });
});

describe("interim placeholder", () => {
  it("keeps the real words, and fills the gap only while speech is picked up", () => {
    expect(interimPlaceholder("open the", "SPEECH_DETECTED")).toBe("open the");
    expect(interimPlaceholder("", "SPEECH_DETECTED")).toBe("listening…");
    expect(interimPlaceholder("  ", "TRANSCRIBING")).toBe("transcribing…");
    for (const state of ["LISTENING", "THINKING", "SPEAKING", "PAUSED", "OFF"] as VoiceState[])
      expect(interimPlaceholder("", state)).toBe("");
  });
});

describe("level meter", () => {
  afterEach(() => {
    hooks.effects.length = 0;
    hooks.node.style.transform = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("scales the level into 0..1 and steps it under reduced motion", () => {
    expect(meterScale(0, false)).toBe(0);
    expect(meterScale(Number.NaN, false)).toBe(0);
    expect(meterScale(-1, false)).toBe(0);
    expect(meterScale(5, false)).toBe(1);
    const mid = meterScale(0.04, false);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    for (const level of [0.001, 0.01, 0.04, 0.2, 0.9]) {
      const stepped = meterScale(level, true) * METER_STEPS;
      expect(Number.isInteger(Math.round(stepped * 1e6) / 1e6)).toBe(true);
    }
  });

  it("is decorative: hidden from assistive tech, with no text", () => {
    hooks.effects.length = 0;
    const html = renderToStaticMarkup(createElement(VoiceLevelMeter, { active: true }));
    expect(html).toContain("aria-hidden");
    expect(html.replace(/<[^>]*>/g, "")).toBe("");
  });

  it("paints through the ref from the gate's notifications and lets go on cleanup", () => {
    let listener: ((s: { level: number }) => void) | null = null;
    const off = vi.fn();
    const subscribe = vi.spyOn(voiceGate, "subscribe").mockImplementation((fn) => {
      listener = fn as unknown as (s: { level: number }) => void;
      return off;
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    renderToStaticMarkup(createElement(VoiceLevelMeter, { active: true }));
    expect(hooks.effects).toHaveLength(1);
    const cleanup = hooks.effects[0]?.();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(listener).not.toBeNull();
    (listener as unknown as (s: { level: number }) => void)({ level: 0.04 });
    expect(hooks.node.style.transform).toBe(`scaleX(${meterScale(0.04, false)})`);
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(off).toHaveBeenCalledTimes(1);
    expect(hooks.node.style.transform).toBe("scaleX(0)");
  });

  it("does not listen to the gate while inactive", () => {
    const subscribe = vi.spyOn(voiceGate, "subscribe");
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    renderToStaticMarkup(createElement(VoiceLevelMeter, { active: false }));
    expect(hooks.effects[0]?.()).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
    expect(hooks.node.style.transform).toBe("scaleX(0)");
  });

  it("honours prefers-reduced-motion at paint time", () => {
    let listener: ((s: { level: number }) => void) | null = null;
    vi.spyOn(voiceGate, "subscribe").mockImplementation((fn) => {
      listener = fn as unknown as (s: { level: number }) => void;
      return () => true;
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    renderToStaticMarkup(createElement(VoiceLevelMeter, { active: true }));
    hooks.effects[0]?.();
    (listener as unknown as (s: { level: number }) => void)({ level: 0.04 });
    expect(hooks.node.style.transform).toBe(`scaleX(${meterScale(0.04, true)})`);
  });

  it("adds no timer and no per-frame React state", () => {
    const meter = source("src/components/friday/VoiceLevelMeter.tsx");
    expect(meter).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|useState/);
    expect(meter).toContain("voiceGate.subscribe");
    expect(meter).toContain("motion-safe:transition-transform");
  });
});

describe("Auto screen wiring", () => {
  const ui = source("src/components/friday/AutoMode.tsx");
  it("mounts the phase chip, meter, mode and latency chips from the live state", () => {
    expect(ui).toContain("<PhaseChip");
    expect(ui).toContain("phase={voice.phase}");
    expect(ui).toContain(
      "<VoiceLevelMeter active={voice.listening && !voice.muted && !voice.paused}",
    );
    expect(ui).toContain("<ModeChips handsFree={voice.handsFree} dictating={voice.dictating}");
    expect(ui).toContain('voiceLatency.summary("budget.firstSound")');
  });
  it("passes the empty-state inputs to the transcript", () => {
    for (const prop of ["wakeWord=", "handsFree=", "muted=", "paused=", "error="])
      expect(ui).toContain(`                  ${prop}`);
  });
  it("renders the new chips in a static render without opening anything", async () => {
    const { AutoMode } = await import("../../src/components/friday/AutoMode");
    const html = renderToStaticMarkup(createElement(AutoMode));
    expect(html).toContain("voice-phase-chip");
    expect(html).toContain('data-voice-meter="');
    expect(html).toContain("voice-mic-chip");
  });
});
