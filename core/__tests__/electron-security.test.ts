/**
 * Electron window contract. The assertions read the main-process sources and
 * the navigation policy. They do not launch Electron.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const { navigationAllowed } = require_("../../electron/navigation-policy.cjs") as {
  navigationAllowed: (url: string, devUrl?: string) => boolean;
};

function channels(source: string, api: "ipcRenderer" | "ipcMain"): string[] {
  const re =
    api === "ipcRenderer"
      ? /ipcRenderer\.(?:invoke|send|sendSync)\(\s*["']([^"']+)["']/g
      : /ipcMain\.(?:handle|on|handleOnce)\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(re)].map((match) => match[1] || "");
}

function electronSources(): string {
  const dir = path.join(ROOT, "electron");
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const name of fs.readdirSync(folder)) {
      const full = path.join(folder, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".cjs") && name !== "preload.cjs") files.push(full);
    }
  };
  walk(dir);
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

describe("app navigation", () => {
  it("allows the packaged origin and the dev origin, and refuses other hosts", () => {
    expect(navigationAllowed("friday://app/index.html", "")).toBe(true);
    expect(navigationAllowed("friday://other/index.html", "")).toBe(false);
    expect(navigationAllowed("about:blank", "")).toBe(true);
    expect(navigationAllowed("file:///C:/FRIDAY/index.html", "")).toBe(false);
    expect(navigationAllowed("https://example.com", "http://127.0.0.1:8080")).toBe(false);
    expect(navigationAllowed("http://127.0.0.1:8080/chat", "http://127.0.0.1:8080")).toBe(true);
    expect(navigationAllowed("http://127.0.0.1:9999/chat", "http://127.0.0.1:8080")).toBe(false);
    expect(navigationAllowed("not a url", "http://127.0.0.1:8080")).toBe(false);
  });
});

describe("Electron window hardening", () => {
  it("sandboxes every BrowserWindow and keeps Node out of the page", () => {
    const windows = [
      "electron/main.cjs",
      "electron/browser.cjs",
      "electron/camera.cjs",
      "electron/character/overlay.cjs",
    ];
    for (const file of windows) {
      const src = read(file);
      expect(src, file).toContain("contextIsolation: true");
      expect(src, file).toContain("nodeIntegration: false");
      expect(src, file).toContain("sandbox: true");
      expect(src, file).not.toContain("sandbox: false");
      expect(src, file).not.toContain("nodeIntegration: true");
      expect(src, file).not.toContain("contextIsolation: false");
      expect(src, file).not.toContain("webSecurity: false");
    }
    const main = read("electron/main.cjs");
    const sandboxSwitch = main.indexOf('appendSwitch("no-sandbox")');
    const selfTest = main.lastIndexOf("FRIDAY_BOOT_SELFTEST", sandboxSwitch);
    expect(sandboxSwitch).toBeGreaterThan(-1);
    expect(selfTest).toBeGreaterThan(-1);
    expect(sandboxSwitch - selfTest).toBeLessThan(400);
    expect(main).toContain('return { action: "deny" }');
    expect(main).toContain("webPreferences.nodeIntegration = false");
    expect(main).toContain("webPreferences.contextIsolation = true");
    expect(main).toContain("webPreferences.sandbox = true");
    expect(main).toContain('permission === "media"');
    expect(main).toContain("callback(false)");
    expect(read("electron/models.cjs")).toContain("safeStorage");
    expect(read("electron/renderer.cjs")).toContain("withinBundle");
    expect(read("electron/renderer.cjs")).toContain("will-navigate");
  });

  it("gives every preload channel a main-process handler", () => {
    const invoked = new Set(channels(read("electron/preload.cjs"), "ipcRenderer"));
    const handled = new Set(channels(electronSources(), "ipcMain"));
    expect(invoked.size).toBeGreaterThan(100);
    expect([...invoked].filter((channel) => !handled.has(channel))).toEqual([]);
    expect([...handled].filter((channel) => !invoked.has(channel))).toEqual([]);
  });
});
