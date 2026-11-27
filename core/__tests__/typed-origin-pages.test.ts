import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** Every `brain.send(` call in a file, with its argument text up to the matching close paren. */
function sendCalls(src: string): string[] {
  const calls: string[] = [];
  let at = src.indexOf("brain.send(");
  while (at >= 0) {
    let depth = 0;
    let end = at + "brain.send".length;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(at, end + 1));
    at = src.indexOf("brain.send(", end);
  }
  return calls;
}

const TYPED_PAGES = [
  "src/lib/friday/hub-chat.ts",
  "src/lib/friday/import-chat.ts",
  "src/routes/browser.tsx",
  "src/routes/sandbox.tsx",
  "src/routes/tasks.tsx",
  "src/routes/terminal.tsx",
];

describe("typed pages pass promptOrigin typed", () => {
  for (const file of TYPED_PAGES) {
    it(`${file}: every brain.send names promptOrigin typed`, () => {
      const calls = sendCalls(read(file));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).toContain('promptOrigin: "typed"');
    });
  }

  it("voice callers keep the voice origin", () => {
    const src = read("src/lib/friday/assistant-mode.ts");
    expect(src).toContain("...VOICE_SEND");
    for (const call of sendCalls(src)) expect(call).not.toContain('promptOrigin: "typed"');
  });
});

describe("one shared panel button class", () => {
  it("lives in ui.tsx with the standard focus ring and is imported, not redefined", () => {
    expect(read("src/components/friday/ui.tsx")).toMatch(/export const PANEL_BUTTON =/);
    const bar = read("src/components/friday/VoiceControlBar.tsx");
    expect(bar).not.toMatch(/const PANEL_BUTTON =/);
    expect(bar).toMatch(/PANEL_BUTTON[^;]*from "@\/components\/friday\/ui"|PANEL_BUTTON,/);
    const ui = read("src/components/friday/ui.tsx");
    const def = ui.slice(ui.indexOf("export const PANEL_BUTTON ="));
    expect(def.slice(0, def.indexOf(";"))).toContain("focus-visible:ring-ring");
    expect(def.slice(0, def.indexOf(";"))).not.toContain("ring-primary/60");
  });
});
