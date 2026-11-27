/**
 * The Brain settings read FRIDAY Core through one read-only channel, `brain:core-status`. The payload carries the
 * variant, her name and three flags, never the launch key, the port or the endpoint. The channel is in the preload
 * allowlist and the IPC budget table, and the panel shows loading, error with Retry and offline states.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const main = read("electron/main.cjs");
const preload = read("electron/preload.cjs");
const brain = read("src/components/friday/settings/BrainSettings.tsx");
const table = require_(path.join(root, "electron/ipc-budget-table.cjs")) as {
  CHANNEL_CLASS: Record<string, string>;
};

type Status = Record<string, unknown>;
const build = new Function(
  `${main.slice(main.indexOf("// CORE-STATUS-BEGIN"), main.indexOf("// CORE-STATUS-END"))}; return buildCoreStatus;`,
)() as (input: { endpoint: Status | null; plan: Status | null }) => Status;

describe("brain:core-status payload", () => {
  const endpoint = {
    baseUrl: "http://127.0.0.1:53211/v1",
    apiKey: "sk-launch-secret",
    port: 53211,
    variant: "default",
    fridayName: "Friday Core",
  };

  it("running Core: variant and flags only, no key, port or URL", () => {
    const out = build({ endpoint, plan: null });
    expect(Object.keys(out).sort()).toEqual(
      ["fridayName", "installed", "ready", "running", "variant"].sort(),
    );
    expect(out).toMatchObject({ variant: "default", installed: true, running: true, ready: true });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/sk-launch-secret|53211|127\.0\.0\.1|http/);
  });

  it("installed but down, and not installed", () => {
    expect(build({ endpoint: null, plan: { ok: true, variant: "lite", fridayName: "F" } })).toEqual(
      {
        variant: "lite",
        fridayName: "F",
        installed: true,
        running: false,
        ready: false,
      },
    );
    expect(build({ endpoint: null, plan: { ok: false, reason: "x" } })).toEqual({
      variant: "",
      fridayName: "",
      installed: false,
      running: false,
      ready: false,
    });
  });

  it("the handler only returns that payload", () => {
    const at = main.indexOf('ipcMain.handle("brain:core-status"');
    const handler = main.slice(at, main.indexOf("ipcMain.handle", at + 10));
    expect(handler).toContain("return buildCoreStatus({ endpoint, plan });");
  });
});

describe("brain:core-status wiring", () => {
  it("is in the preload allowlist and the budget table as a quick call", () => {
    expect(preload).toContain('brainCoreStatus: () => ipcRenderer.invoke("brain:core-status")');
    expect(table.CHANNEL_CLASS["brain:core-status"]).toBe("quick");
  });

  it("the panel shows loading, error with Retry and offline, on the shared poller", () => {
    expect(brain).toContain('useLivePoll(\n    "brain.core-status"');
    expect(brain).toContain("Reading Core status");
    expect(brain).toContain("could not be read");
    expect(brain).toContain("Retry");
    expect(brain).toContain("Offline:");
    expect(brain).toContain("[on, desktop, refresh]");
    expect(brain).not.toMatch(/setInterval/);
  });
});
