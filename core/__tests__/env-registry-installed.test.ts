import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "../..");

/**
 * The owner's installed FRIDAY 1.1.2.4 listed Node.js, Electron dependencies,
 * the Electron runtime, the interface bundle, and Installed FRIDAY as Missing.
 * Those are checkout paths; the installed app carries them inside app.asar.
 */
describe("environment registry inside the installed app", () => {
  it("reports the installed app's own runtime and never spawns FRIDAY.exe", () => {
    const appPath = mkdtempSync(join(tmpdir(), "friday-asar-"));
    mkdirSync(join(appPath, "dist-desktop"));
    writeFileSync(join(appPath, "dist-desktop", "index.html"), "<html></html>");
    const script = `
      const Module = require("node:module");
      const cp = require("node:child_process");
      let spawned = 0;
      for (const name of ["spawnSync", "execFileSync"]) {
        const real = cp[name];
        cp[name] = (...args) => { if (String(args[0]) === process.execPath) spawned += 1; return real(...args); };
      }
      Object.defineProperty(process.versions, "electron", { value: "43.7.7", configurable: true });
      const load = Module._load;
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return { app: { isPackaged: true, getAppPath: () => ${JSON.stringify(appPath)}, getVersion: () => "1.1.3" } };
        }
        return load.call(this, request, ...rest);
      };
      const r = require(${JSON.stringify(join(root, "scripts/env-registry.cjs"))});
      const p = r.installedProbes;
      const rows = [p.probeNode(), p.probeNodeModules(), p.probeElectron(), p.probeBrowserBundle(), p.probeInstalledApp()];
      process.stdout.write(JSON.stringify({ spawned, rows: rows.map((row) => ({ id: row.id, health: row.health, version: row.version })) }));
    `;
    const run = spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as {
      spawned: number;
      rows: { id: string; health: string; version: string | null }[];
    };
    expect(out.spawned).toBe(0);
    for (const row of out.rows) expect(row.health, row.id).toBe("ready");
    expect(out.rows.find((row) => row.id === "node")?.version).toBe(process.versions.node);
    expect(out.rows.find((row) => row.id === "installed-app")?.version).toBe("1.1.3");
  });
});

describe("environment registry runs off the window's thread", () => {
  it("the scan worker runs refresh and repair with the installed app's facts", async () => {
    const { Worker } = await import("node:worker_threads");
    const dir = mkdtempSync(join(tmpdir(), "friday-env-worker-"));
    const stub = join(dir, "registry.cjs");
    writeFileSync(
      stub,
      `module.exports = {
        refreshRegistry: () => ({ job: "refresh", packaged: JSON.parse(process.env.FRIDAY_PACKAGED_APP || "null"), resources: process.resourcesPath }),
        repairComponent: (id) => ({ job: "repair", id }),
        repairAll: () => ({ job: "repair-all" }),
      };`,
    );
    const run = (workerData: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const worker = new Worker(join(root, "electron/scan-worker.cjs"), { workerData });
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    const packaged = {
      exe: "D:/F/App/FRIDAY.exe",
      appPath: "D:/F/App/resources/app.asar",
      version: "1.1.3",
    };
    const refreshed = await run({
      job: "env-refresh",
      registryPath: stub,
      packaged,
      resourcesPath: "D:/F/App/resources",
    });
    expect(refreshed).toEqual({
      ok: true,
      result: { job: "refresh", packaged, resources: "D:/F/App/resources" },
    });
    expect(await run({ job: "env-repair", registryPath: stub, id: "node" })).toEqual({
      ok: true,
      result: { job: "repair", id: "node" },
    });
    const main = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(main).toContain('ipcMain.handle("env:refresh", () => envRegistryJob("env-refresh"));');
    expect(main).not.toMatch(
      /await Promise\.resolve\(\);\s*return envRegistry\.refreshRegistry\(\)/,
    );
  });
});
