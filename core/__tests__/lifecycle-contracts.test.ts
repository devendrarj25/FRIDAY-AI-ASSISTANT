/**
 * Drift contracts. One owner each: exit, startup tasks, the pack pipeline,
 * the packaged launch harness, and the preload/main channel list.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function walk(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, suffix));
    else if (name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function channels(source: string, api: "ipcRenderer" | "ipcMain"): string[] {
  const re =
    api === "ipcRenderer"
      ? /ipcRenderer\.(?:invoke|send|sendSync)\(\s*["']([^"']+)["']/g
      : /ipcMain\.(?:handle|on|handleOnce)\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(re)].map((match) => match[1] || "");
}

describe("one lifecycle owner", () => {
  it("keeps quit, exit, relaunch, and owned-process kills in the lifecycle module", () => {
    const allowExit = new Set([
      path.normalize("electron/app-lifecycle.cjs"),
      path.normalize("electron/boot-selftest.cjs"),
    ]);
    const killCall = /(?:spawn(?:Sync)?|execFile(?:Sync)?)\(\s*["']taskkill["']/;
    const exitCall = /\bapp\.(?:quit|exit|relaunch)\s*\(/;
    const problems: string[] = [];
    for (const file of walk(path.join(root, "electron"), ".cjs")) {
      const rel = path.normalize(path.relative(root, file));
      const source = stripComments(fs.readFileSync(file, "utf8"));
      if (exitCall.test(source) && !allowExit.has(rel)) {
        problems.push(
          `${rel} calls app.quit, app.exit, or app.relaunch. Call electron/app-lifecycle.cjs requestShutdown, requestRestart, or exitNow instead.`,
        );
      }
      if (rel === path.normalize("electron/boot-selftest.cjs")) {
        if (/\bapp\.(?:quit|relaunch)\s*\(/.test(source)) {
          problems.push(
            `${rel} may exit through its own timer. It must not quit or relaunch. Use exitNow from app-lifecycle.cjs for every other path.`,
          );
        }
      }
      if (killCall.test(source) && rel !== path.normalize("electron/app-lifecycle.cjs")) {
        problems.push(
          `${rel} kills a process tree directly. Call killProcessTree from electron/app-lifecycle.cjs.`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it("registers startup work instead of arming it ad hoc when the app is ready", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain('require("./startup-tasks.cjs")');
    for (const id of [
      "tray",
      "model-registry",
      "startup-flow",
      "github-checks",
      "github-reconnect",
      "update-health",
      "character-autostart",
    ]) {
      expect(main, id).toContain(`id: "${id}"`);
    }
    const tasks = require_(path.join(root, "electron/startup-tasks.cjs")) as {
      createStartupRegistry: () => {
        register: (task: {
          id: string;
          phase?: string;
          readiness?: boolean;
          run: () => void;
        }) => string;
        runPhase: (phase: string, opts?: { readiness?: boolean }) => Promise<Array<{ id: string }>>;
        list: () => Array<{ id: string; readiness: boolean }>;
      };
    };
    const registry = tasks.createStartupRegistry();
    registry.register({
      id: "skipped-in-readiness",
      phase: "idle",
      readiness: false,
      run() {},
    });
    registry.register({ id: "kept", phase: "idle", run() {} });
    return registry.runPhase("idle", { readiness: true }).then((ran) => {
      expect(ran.map((row) => row.id)).toEqual(["kept"]);
    });
  });

  it("does not schedule a ready-handler timer outside the startup registry", () => {
    const main = read("electron/main.cjs");
    const marks = [...main.matchAll(/\.whenReady\(\)/g)].map((match) => match.index || 0);
    const problems: string[] = [];
    marks.forEach((start, index) => {
      const end = marks[index + 1] || main.length;
      const body = main.slice(start, end);
      if (body.includes("setTimeout") && !body.includes("startupTasks.register")) {
        problems.push(
          `electron/main.cjs whenReady at character ${start} arms a timer without startupTasks.register. Add the task to electron/startup-tasks.cjs via register().`,
        );
      }
    });
    expect(problems).toEqual([]);
  });
});

describe("one pack pipeline", () => {
  const pipeline = require_(path.join(root, "scripts/build-pipeline.cjs")) as {
    PHASES: string[];
    PHASE_COMMANDS: Record<string, string[]>;
  };

  it("uses the same phase order for CMD, Test Build, and Release", () => {
    expect(pipeline.PHASES).toEqual([
      "prepare-environment",
      "verify-versions",
      "stage-toolchain",
      "build-renderer",
      "package",
      "packaged-requires",
      "sign-hook",
      "manifest",
      "verify-artifacts",
      "verify-boot",
      "readiness",
      "packaged-self-check",
      "installer-smoke",
    ]);
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain("scripts\\build-pipeline.cjs");
    expect(cmd).toContain("--channel production --caller cmd");
    expect(cmd).toContain("FRIDAY_BUILD_CODE=%ERRORLEVEL%");
    expect(cmd).toContain("exit /b %FRIDAY_BUILD_CODE%");
    const release = read(".github/workflows/release.yml");
    const testBuild = read(".github/workflows/test-build.yml");
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --through verify-versions",
    );
    expect(release).toContain(
      "node scripts/build-pipeline.cjs --channel production --caller release --from stage-toolchain",
    );
    expect(testBuild).toContain(
      "node scripts/build-pipeline.cjs --channel test --caller test --through verify-versions",
    );
    expect(testBuild).toContain(
      "node scripts/build-pipeline.cjs --channel test --caller test --from stage-toolchain",
    );
    const source = read("scripts/build-pipeline.cjs");
    expect(source).toContain("if (!report.ok) process.exit(1)");
    const failed = source.indexOf('status: "failed"');
    const passed = source.indexOf("report.ok = true");
    expect(failed).toBeGreaterThan(-1);
    expect(passed).toBeGreaterThan(failed);
    expect(source.slice(failed, passed)).toContain("return report");
  });

  it("only names scripts that exist", () => {
    const missing: string[] = [];
    for (const [phase, commands] of Object.entries(pipeline.PHASE_COMMANDS)) {
      for (const command of commands) {
        const script = command.split(" ")[0] || "";
        if (
          !script.startsWith("scripts/") &&
          !script.endsWith(".ps1") &&
          !script.endsWith(".cjs")
        ) {
          continue;
        }
        if (!fs.existsSync(path.join(root, script))) {
          missing.push(
            `${phase} names ${script}, which is not in the tree. Add the script or remove it from PHASE_COMMANDS.`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("one packaged launch harness", () => {
  it("is the only killTree used by readiness and the boot check", () => {
    for (const rel of ["scripts/readiness-test.cjs", "scripts/verify-boot.cjs"]) {
      const source = read(rel);
      expect(source, rel).toContain('require("./packaged-launch.cjs")');
      expect(source, rel).not.toMatch(/function killTree/);
    }
    const harness = read("scripts/packaged-launch.cjs");
    expect(harness).toContain("function killTree");
    expect(harness).toContain("function leakCheck");
    expect(read("scripts/readiness-test.cjs")).toContain("launchHarness.leakCheck");
    const launch = require_(path.join(root, "scripts/packaged-launch.cjs")) as {
      leakCheck: (pids: number[]) => { ok: boolean; alive: number[] };
    };
    expect(launch.leakCheck([])).toEqual({ ok: true, alive: [] });
    expect(launch.leakCheck([process.pid]).ok).toBe(false);
  });
});

describe("preload and main channels", () => {
  it("gives every renderer channel a handler and every handler a caller", () => {
    const preload = read("electron/preload.cjs");
    const mainFiles = walk(path.join(root, "electron"), ".cjs")
      .filter((file) => path.basename(file) !== "preload.cjs")
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const invoked = [...new Set(channels(preload, "ipcRenderer"))];
    const handled = [...new Set(channels(mainFiles, "ipcMain"))];
    const missingHandler = invoked.filter((channel) => !handled.includes(channel));
    const missingCaller = handled.filter((channel) => !invoked.includes(channel));
    expect(
      missingHandler,
      "Add an ipcMain handler in electron/ for each channel, or stop calling it from electron/preload.cjs.",
    ).toEqual([]);
    expect(
      missingCaller,
      "Expose the channel from electron/preload.cjs, or remove the ipcMain handler.",
    ).toEqual([]);
  });
});
