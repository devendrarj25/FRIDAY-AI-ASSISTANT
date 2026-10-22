import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AutoMode } from "../../src/components/friday/AutoMode";
import { AutonomyDial } from "../../src/components/friday/AutonomyDial";

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
