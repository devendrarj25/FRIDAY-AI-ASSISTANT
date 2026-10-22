import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AutoMode } from "../../src/components/friday/AutoMode";
import { AutonomyDial } from "../../src/components/friday/AutonomyDial";
import { CaptionRow, VoiceTranscript } from "../../src/components/friday/VoiceTranscript";
import type { Caption } from "../../src/lib/friday/assistant-mode";

// A static render always reads the server snapshot (Compact). To render the
// other levels the saved level is forced here; everything else is real.
const forced = vi.hoisted(() => ({ level: null as 1 | 2 | 3 | null }));
vi.mock("../../src/lib/friday/chat-level", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/friday/chat-level")>();
  return { ...real, useVoiceLevel: () => forced.level ?? real.useVoiceLevel() };
});

const source = (file: string) => readFileSync(join(__dirname, "../..", file), "utf8");

/**
 * Owner request 2026-10-22: diagnostics and the pipeline open from buttons on
 * the Live captions strip without disturbing the captions; the Auto Mode bar
 * is grouped with icons; the FRIDAY graphic is unchanged.
 */
describe("Auto Mode layout", () => {
  const html = renderToStaticMarkup(createElement(AutoMode));

  it("puts diagnostics and pipeline toggles on the captions strip, closed by default", () => {
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?diagnostics · /);
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?pipeline · \d+/);
    // Closed: no panel and no diagnostics rows render (nothing runs while closed).
    expect(html).not.toContain('aria-label="Voice diagnostics"');
    expect(html).not.toContain('aria-label="Voice pipeline"');
  });

  it("keeps the captions in their own scroller next to the panel slot", () => {
    const ui = source("src/components/friday/AutoMode.tsx");
    expect(ui).toContain('className="flex min-h-0 flex-1 flex-col md:flex-row"');
    expect(ui).toContain("min-h-0 flex-1 select-text space-y-1 overflow-y-auto px-3 py-1.5");
    expect(ui).toContain('{panel === "diagnostics" ? (');
    expect(ui).not.toContain("<details");
    expect(source("src/components/friday/VoiceDiagnostics.tsx")).not.toContain("<details");
  });

  it("groups the HUD with icons and keeps the FRIDAY graphic untouched", () => {
    for (const label of [
      "Pause listening",
      "Reset microphone",
      "Voice flow",
      "Ask every time",
      "Balanced",
      "Full autonomy",
      "Stop everything",
    ]) {
      expect(html, label).toMatch(new RegExp(`<svg[^>]*>.*?</svg>${label}`));
    }
    expect(html).toMatch(/role="group" aria-label="Autonomy"/);
    expect(source("src/components/friday/AutoMode.tsx")).toContain(
      "<NeuralCircuit large onSelectNode={selectCircuitNode} />",
    );
  });

  it("is not selectable chrome, while captions and panels stay selectable", () => {
    expect(html).toContain('<div class="flex h-full min-h-0 select-none flex-col gap-2">');
    expect(html).toContain("select-text");
  });

  it("keeps the full autonomy buttons for Flow Studio", () => {
    const full = renderToStaticMarkup(createElement(AutonomyDial));
    expect(full).not.toContain('aria-label="Autonomy"');
    expect(full).toContain("Stop everything");
  });
});

describe("Auto Mode levels: Compact, Expanded, Transcript", () => {
  const ui = source("src/components/friday/AutoMode.tsx");
  const renderAt = (level: 1 | 2 | 3) => {
    forced.level = level;
    try {
      return renderToStaticMarkup(createElement(AutoMode));
    } finally {
      forced.level = null;
    }
  };
  afterEach(() => {
    forced.level = null;
  });

  it("renders the large graphic at Compact and Expanded and none at Transcript", () => {
    for (const level of [1, 2] as const) {
      const html = renderAt(level);
      expect(html, `level ${level}`).toContain("neural-circuit relative isolate");
      expect(html).toContain("Live captions");
    }
    const transcript = renderAt(3);
    expect(transcript).not.toContain("neural-circuit");
    expect(transcript).not.toContain('<svg viewBox="0 0 100 100"');
    expect(ui.match(/<NeuralCircuit large onSelectNode=\{selectCircuitNode\} \/>/g)).toHaveLength(
      1,
    );
    expect(ui).toContain("{full ? (");
  });

  it("keeps the mic chip and Stop everything visible at every level", () => {
    for (const level of [1, 2, 3] as const) {
      const html = renderAt(level);
      expect(html, `level ${level}`).toMatch(
        /role="status" aria-live="polite" aria-label="Microphone (off|listening|paused|error): /,
      );
      expect(html).toContain("voice-mic-chip");
      expect(html).toMatch(/<svg[^>]*>.*?<\/svg>Stop everything/);
      expect(html).toContain('aria-label="Stop everything"');
      // The chip is never a "More" item.
      expect(html).not.toMatch(/More voice tools[\s\S]*voice-mic-chip/);
    }
    expect(ui).toContain("voice-mic-chip");
    expect(source("src/styles.css")).not.toMatch(/\.voice-mic-chip[^{]*\{[^}]*display:\s*none/);
  });

  it("keeps every HUD label right after its icon at every level", () => {
    for (const level of [1, 2, 3] as const) {
      const html = renderAt(level);
      for (const label of [
        "Pause listening",
        "Reset microphone",
        "Voice flow",
        "Voice settings",
        "Ask every time",
        "Balanced",
        "Full autonomy",
        "Stop everything",
      ]) {
        expect(html, `${label} at ${level}`).toMatch(new RegExp(`<svg[^>]*>.*?</svg>${label}`));
      }
      expect(html).toMatch(/role="group" aria-label="Listen"/);
      expect(html).toMatch(/role="group" aria-label="Safety"/);
      expect(html).toMatch(/role="group" aria-label="Tools"/);
      expect(html).toContain('<div class="flex h-full min-h-0 select-none flex-col gap-2">');
      expect(html).toContain("select-text");
    }
    const transcript = renderAt(3);
    expect(transcript).toMatch(/<svg[^>]*>.*?<\/svg>Mute voice/);
    expect(transcript).toMatch(/<svg[^>]*>.*?<\/svg>Diagnostics/);
    expect(transcript).toMatch(/<svg[^>]*>.*?<\/svg>Pipeline/);
    expect(transcript).toMatch(/role="group" aria-label="Speak"/);
  });

  it("shows the size switch on the captions strip, and on the bar at Transcript", () => {
    for (const level of [1, 2, 3] as const) {
      const html = renderAt(level);
      expect(html).toContain('role="radiogroup" aria-label="Voice window size"');
      expect(html.match(/role="radio"/g)).toHaveLength(3);
      const label = { 1: "Compact", 2: "Expanded", 3: "Transcript" }[level];
      expect(html).toContain(`aria-checked="true" aria-label="${label} (Alt+${level})"`);
    }
    expect(renderAt(1)).toContain("h-[5.6rem]");
    expect(renderAt(2)).toContain("h-[42vh]");
    expect(renderAt(3)).toContain("voice-glass min-h-0 flex-1");
    expect(ui).toContain("duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]");
    expect(ui).toContain('streaming && "transition-none"');
  });

  it("renders closed panels as nothing at every level", () => {
    for (const level of [1, 2, 3] as const) {
      const html = renderAt(level);
      expect(html).not.toContain('aria-label="Voice diagnostics"');
      expect(html).not.toContain('aria-label="Voice pipeline"');
      expect(html).not.toContain("Jump to latest");
    }
  });

  it("derives the level from the saved choice without touching voice logic", () => {
    expect(ui).toContain("voiceDisplayLevel(saved, voice.expanded)");
    expect(ui).toContain("if (next !== 3) assistantMode.setExpanded(next === 2);");
    // Alt+1/2/3 stays inside the window, never in a field, never global.
    expect(ui).toContain("if (isTypingTarget(event.target)) return;");
    expect(ui).toContain("levelForKey(event)");
    for (const file of [
      "src/components/friday/AutoMode.tsx",
      "src/components/friday/VoiceControlBar.tsx",
      "src/components/friday/VoiceTranscript.tsx",
    ]) {
      const text = source(file);
      expect(text).not.toContain('addEventListener("keydown"');
      expect(text).not.toContain("globalShortcut");
      expect(text).not.toContain("setInterval");
    }
    // Same hold-to-talk handlers as before.
    expect(ui).toContain("onPointerDown={() => assistantMode.holdToTalk(true)}");
    expect(ui).toContain("onPointerUp={() => assistantMode.holdToTalk(false)}");
    expect(ui).toContain("onPointerLeave={() => assistantMode.holdToTalk(false)}");
    expect(ui).toContain('search: { section: "voice" }');
  });

  it("pins the voice cursor, label and glass rules", () => {
    const css = source("src/styles.css");
    expect(css).toContain("html,\nbody,\n#root {\n  cursor: default;\n}");
    expect(css).toContain(
      ".friday-voice button:disabled {\n  pointer-events: auto;\n  cursor: not-allowed;\n}",
    );
    expect(css).toContain(
      ".friday-voice .voice-level-switch button,\n.friday-voice .voice-btn {\n  cursor: pointer;\n}",
    );
    expect(css).toContain(".friday-voice .voice-captions,\n.friday-voice aside {\n  cursor: text;");
    expect(css).toContain(".friday-voice .neural-circuit {\n  cursor: default;");
    expect(css).toContain("@container voice-bar (max-width: 48rem)");
    expect(css).toContain("content: attr(data-label);");
    expect(css).toContain("html.no-glow .voice-glass,");
    // The label text is hidden by size, never removed; only the hover pill
    // of the clipped autonomy dial is switched off.
    expect(css).not.toMatch(/\.voice-btn\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.voice-btn\s*\{[^}]*font-size:\s*0/);
  });
});

describe("Voice transcript rows", () => {
  const cap = (
    id: string,
    who: Caption["who"],
    text: string,
    extra: Partial<Caption> = {},
  ): Caption => ({
    id,
    who,
    text,
    at: 0,
    ...extra,
  });

  it("keeps today's one-line caption at Compact and Expanded", () => {
    const html = renderToStaticMarkup(
      createElement(CaptionRow, {
        caption: cap("a", "user", "what time is it", {
          tag: "addressed",
          language: "en",
          confidence: 0.91,
        }),
        layout: "line",
        showTime: false,
      }),
    );
    expect(html).toContain('<div class="flex gap-2 text-sm">');
    expect(html).toContain(">you</span>");
    expect(html).toContain("addressed · en · 0.91");
    expect(html).not.toContain("Copy this line");
  });

  it("lays out Transcript as you right, FRIDAY left, with copy, interim and the card", () => {
    const captions = Array.from({ length: 500 }, (_, i) =>
      cap(`c${i}`, i % 2 ? "friday" : "user", `line ${i}`),
    );
    const html = renderToStaticMarkup(
      createElement(VoiceTranscript, {
        captions,
        interim: "still talking",
        display: { kind: "text", text: "shown inline" },
        pending: { command: "delete the folder", reason: "destructive", at: 0 },
        layout: "bubble",
        showTime: false,
      }),
    );
    expect(html).toContain("mx-auto w-full max-w-[48rem] space-y-2");
    expect(html.match(/aria-label="Copy this line"/g)).toHaveLength(500);
    expect(html).toContain("group flex justify-end");
    expect(html).toContain("group flex justify-start");
    expect(html).toContain('italic text-foreground/70">still talking');
    expect(html).toContain("shown inline");
    expect(html).toContain("YES · run it");
    expect(html).toContain("NO · cancel");
  });

  it("shows times only when the timestamps preference is on", () => {
    const row = (showTime: boolean) =>
      renderToStaticMarkup(
        createElement(CaptionRow, {
          caption: cap("b", "friday", "It is ten."),
          layout: "bubble",
          showTime,
        }),
      );
    expect(row(false)).not.toContain("normal-case text-muted-foreground");
    expect(row(true)).toContain("normal-case text-muted-foreground");
  });
});
