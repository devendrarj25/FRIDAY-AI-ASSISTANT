/**
 * The catalogue's three IPC channels reach the renderer (preload, budget table, typed desktop bridge), the daily
 * version pass rides the refresh that already runs, engine installs use the governor lanes and the measured facts,
 * and the engine job path refuses and removes the way the Install Manager expects.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const budget = require_(path.join(root, "electron/ipc-budget-table.cjs"));
const engines = require_(path.join(root, "electron/engine-install.cjs"));

describe("installer catalogue wiring", () => {
  it("every channel is in the budget table (quick reads, a long update) and in the preload", () => {
    const table = budget.CHANNEL_CLASS;
    expect(table["installer:catalog"]).toBe("quick");
    expect(table["installer:refresh"]).toBe("quick");
    expect(table["installer:update"]).toBe("long-job");
    const preload = read("electron/preload.cjs");
    expect(preload).toMatch(/installerCatalog: \(\) => ipcRenderer\.invoke\("installer:catalog"\)/);
    expect(preload).toMatch(
      /refreshInstallerCatalog: \(\) => ipcRenderer\.invoke\("installer:refresh"\)/,
    );
    expect(preload).toMatch(
      /updateInstallerRow: \(request\) => ipcRenderer\.invoke\("installer:update", request\)/,
    );
  });

  it("main handles the three channels, shares the facts and the governor lanes, and adds no timer", () => {
    const main = read("electron/main.cjs");
    for (const channel of ["installer:catalog", "installer:refresh", "installer:update"]) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
    }
    expect(main).toMatch(/toolchain\.setFactsProvider\(\(\) => routingHardwareFacts\(\)\)/);
    expect(main).toMatch(
      /toolchain\.setJobRunner\(\(kind, fn, signal\) => cappedJob\(kind, fn, signal\)\)/,
    );
    // the daily pass is the catalogue refresh that already runs, not a new interval
    const refresh = main.slice(
      main.indexOf("async function runCatalogueRefresh"),
      main.indexOf("function armCatalogueSchedule"),
    );
    expect(refresh).toMatch(/getInstallerCatalog\(\)\s*\.refresh\(\{ trigger, jitterMs/);
    const block = main.slice(
      main.indexOf("let installerCatalogMemo"),
      main.indexOf('ipcMain.handle("installer:catalog"'),
    );
    expect(block).not.toMatch(/setInterval\s*\(/);
    // an update goes through the consent decision first
    const update = main.slice(
      main.indexOf('ipcMain.handle("installer:update"'),
      main.indexOf("// ---- Import & in-app build"),
    );
    expect(update.indexOf("planUpdate")).toBeGreaterThan(-1);
    expect(update.indexOf("planUpdate")).toBeLessThan(update.indexOf("runJob"));
  });

  it("the desktop bridge is typed: catalogue, refresh, update and the fit verdict", () => {
    const desktop = read("src/lib/friday/desktop.ts");
    for (const name of [
      "InstallerCatalog",
      "InstallerCatalogRow",
      "EngineFit",
      "InstallerUpdateRequest",
      "InstallerUpdateResult",
    ]) {
      expect(desktop).toMatch(new RegExp(`export type ${name} =`));
    }
    expect(desktop).toMatch(/installerCatalog\?: \(\) => Promise<InstallerCatalog>/);
    expect(desktop).toMatch(/updateInstallerRow\?: \(request: InstallerUpdateRequest\)/);
  });

  it("a refresh or a catalogue read can never start an install or update", () => {
    const main = read("electron/main.cjs");
    const catalogHandler = main.slice(
      main.indexOf('ipcMain.handle("installer:catalog"'),
      main.indexOf('ipcMain.handle("installer:update"'),
    );
    expect(catalogHandler).not.toMatch(/runJob/);
  });
});

describe("engine jobs", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-enginejob-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const events: Record<string, unknown>[] = [];
  const emit = (e: Record<string, unknown>) => void events.push(e);

  it("an engine row without a FRIDAY folder fails in words, not with a throw", async () => {
    events.length = 0;
    const out = await toolchain.runJob({ id: "llama.cpp", action: "install", root: "" }, emit);
    expect(out.ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: "Failed" });
    expect(String(events.at(-1)?.["error"])).toMatch(/folder/);
  });

  it("uninstalling an engine removes only its own folder", async () => {
    events.length = 0;
    const base = engines.engineBase(dir, engines.ENGINES["stable-diffusion.cpp"]);
    mkdirSync(path.join(base, "x-avx2"), { recursive: true });
    writeFileSync(path.join(base, "x-avx2", "sd-cli.exe"), "x");
    mkdirSync(path.join(dir, "runtime", "engines", "llama.cpp", "b1"), { recursive: true });
    const out = await toolchain.runJob(
      { id: "stable-diffusion.cpp", action: "uninstall", root: dir },
      emit,
    );
    expect(out.ok).toBe(true);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(path.join(dir, "runtime", "engines", "llama.cpp", "b1"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "Done" });
  });

  it("the engine rows are found by their own detector and report the build the marker names", async () => {
    const tool = toolchain.TOOLS.find((t: { id: string }) => t.id === "stable-diffusion.cpp");
    expect(await tool.detect({ root: dir })).toMatchObject({ installed: false });
    const base = engines.engineBase(dir, engines.ENGINES["stable-diffusion.cpp"]);
    const folder = path.join(base, "1117-avx2");
    mkdirSync(folder, { recursive: true });
    const bin = process.platform === "win32" ? "sd-cli.exe" : "sd-cli";
    writeFileSync(path.join(folder, bin), "x");
    writeFileSync(
      path.join(folder, engines.MARKER),
      JSON.stringify({ version: "1117", backend: "cpu" }),
    );
    expect(await tool.detect({ root: dir })).toMatchObject({
      installed: true,
      version: "1117",
      note: "cpu build",
    });
  });
});
