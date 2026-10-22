import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
