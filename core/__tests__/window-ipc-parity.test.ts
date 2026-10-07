import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

const mainSources = readdirSync(resolve(root, "electron"))
  .filter((f) => f.endsWith(".cjs"))
  .map((f) => read(`electron/${f}`))
  .join("\n");

describe("Windows window rules", () => {
  const main = read("electron/main.cjs");

  it("keeps the native Windows frame behaviour with the caption hidden", () => {
    expect(main).toMatch(/titleBarStyle:\s*"hidden"/);
    expect(main).not.toMatch(/^\s*frame:\s*false,\s*$/m);
    expect(main).toMatch(/backgroundThrottling:\s*false/);
  });

  it("restores and persists window placement", () => {
    expect(main).toContain("function readWindowState()");
    expect(main).toContain("function saveWindowState()");
    expect(main).toMatch(/getDisplayMatching/);
    expect(main).toMatch(/windowState/);
  });

  it("implements the Windows caption gestures", () => {
    expect(main).toMatch(/ipcMain\.on\("window:toggle-maximize"/);
    expect(main).toMatch(/ipcMain\.on\("window:system-menu"/);
    expect(main).toMatch(/ipcMain\.handle\("window:state"/);
  });

  it("wires the caption gestures into the unchanged title strip", () => {
    const strip = read("src/components/friday/TitleStrip.tsx");
    expect(strip).toContain("toggleMaximizeWindow");
    expect(strip).toContain("openWindowSystemMenu");
    expect(strip).toContain("onDoubleClick={onDoubleClick}");
    // The strip stays the only draggable chrome.
    expect(strip).toContain('WebkitAppRegion: "drag"');
  });
});

describe("Bridge integrity", () => {
  const preload = read("electron/preload.cjs");

  it("maps every exposed channel to a live main-process handler", () => {
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
    const sent = [...preload.matchAll(/ipcRenderer\.send\("([^"]+)"/g)].map((m) => m[1]);
    const missing: string[] = [];

    for (const channel of new Set(invoked)) {
      if (!mainSources.includes(`ipcMain.handle("${channel}"`)) missing.push(`handle ${channel}`);
    }
    for (const channel of new Set(sent)) {
      if (!mainSources.includes(`ipcMain.on("${channel}"`)) missing.push(`on ${channel}`);
    }

    expect(missing).toEqual([]);
  });

  it("exposes each channel only once so no duplicate bridge layer exists", () => {
    const keys = [...preload.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s/gm)].map((m) => m[1]);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
  });
});

describe("Renderer responsiveness", () => {
  it("guards every bridge call with a deadline and de-duplication", () => {
    const desktop = read("src/lib/friday/desktop.ts");
    expect(desktop).toContain("export function safeCall");
    expect(desktop).toContain("inFlight");
    expect(desktop).toMatch(/timed out after/);
  });

  it("warms section chunks on hover in both router entries", () => {
    expect(read("src/router.tsx")).toMatch(/defaultPreload:\s*"intent"/);
    expect(read("src/renderer/App.tsx")).toMatch(/defaultPreload:\s*"intent"/);
  });
});
