import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HudButton } from "../../src/components/friday/VoiceControlBar";
import { Mic } from "lucide-react";

const source = (file: string) => readFileSync(join(__dirname, "../..", file), "utf8");

describe("HUD buttons (S9)", () => {
  it("a stable label carries aria-pressed", () => {
    const html = renderToStaticMarkup(
      createElement(HudButton, { icon: Mic, label: "Diagnostics", active: true }),
    );
    expect(html).toContain('aria-pressed="true"');
  });

  it("a flipping label never carries aria-pressed", () => {
    const html = renderToStaticMarkup(
      createElement(HudButton, { icon: Mic, label: "Resume listening", active: true, flips: true }),
    );
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('aria-label="Resume listening"');
  });

  it("extends the hit area to 32 px without changing the 24 px look", () => {
    const html = renderToStaticMarkup(createElement(HudButton, { icon: Mic, label: "Reset" }));
    expect(html).toContain("h-6");
    expect(html).toContain("before:-inset-y-1");
  });
});

describe("Auto Mode controls (S8, S9, S10)", () => {
  const ui = source("src/components/friday/AutoMode.tsx");

  it("pause, mute, hands-free and push-to-talk flip their label, so none is aria-pressed", () => {
    const flips = ui.match(/\n\s+flips\n/g) ?? [];
    expect(flips.length).toBeGreaterThanOrEqual(4);
  });

  it("the hands-free label reads the stored wake word", () => {
    expect(ui).toContain("prefs.voice.wakeWord");
    expect(ui).toContain("say “${wakeWord} …”");
    expect(ui).toContain("say your wake word …");
    expect(ui).not.toContain('"say “FRIDAY …”"');
  });

  it("mute says it also stops the microphone, in both mute buttons", () => {
    expect(ui.match(/Mute: stops her voice and the microphone/g)?.length).toBe(2);
    expect(ui).not.toContain('"Mute FRIDAY"');
  });

  it("the caption-strip mute has a stable name with aria-pressed", () => {
    expect(ui).toContain('stableLabel="Mute voice and microphone"');
    expect(ui).toContain("pressed={voice.muted}");
  });

  it("the mic chip has a muted state", () => {
    expect(ui).toMatch(/if \(voice\.muted\) return "muted"/);
    expect(ui).toContain('voice.muted ? "muted · " : ""');
  });

  it("push-to-talk follows its store and a timed-out hold, with no timer while off", () => {
    expect(ui).toContain("subscribePtt");
    expect(ui).toContain("const talkHeld = usePttActive()");
    expect(ui).not.toContain("assistantMode.pushToTalkActive()");
    expect(ui).toMatch(/if \(!on\) return undefined;/);
  });

  it("fault and status lines go through the plain-words map", () => {
    expect(ui).toContain("plainFaultLine(voice.error, faultLang, faultContext(voice))");
    expect(ui).toContain("plainFaultLine(voice.status, faultLang, faultContext(voice))");
  });
});

describe("Voice settings pickers (S11)", () => {
  const pickers = source("src/components/friday/settings/VoiceAudioPickers.tsx");
  it("shows Permission needed with a Retry when the microphone was never allowed", () => {
    expect(pickers).toContain('micIssue?.kind === "permission"');
    expect(pickers).toContain("Retry");
  });
  it("a failed enumerate is an error with Retry, not an empty list", () => {
    expect(pickers).toContain("listed.enumerated");
  });
});

describe("Watch steady row (S5)", () => {
  it("is fed by the real gate, not fixed numbers", () => {
    const doc = source("src/lib/friday/voice-doctor.ts");
    expect(doc).not.toContain("frames: 10, sameEnergy: 0, handles: 1, crashes: 0");
    expect(doc).toContain("voiceGate.liveTracks()");
    expect(doc).toContain("voiceGate.lastCaptureFailure()");
  });
});
