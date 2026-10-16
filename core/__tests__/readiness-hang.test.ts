import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const trace = require_(path.join(root, "electron/readiness-trace.cjs")) as {
  BUDGETS: Record<string, number>;
  backgroundWorkAllowed: () => boolean;
  createReadinessTrace: (deps?: {
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => number;
    clear?: (id: number) => void;
    append?: (row: { milestone: string }) => void;
  }) => {
    trace: (milestone: string, extra?: Record<string, unknown>) => { milestone: string } | null;
    onExpire: (fn: (info: { stage: string; error: string; detail: string }) => void) => void;
    stop: () => void;
    reset: (at?: number) => void;
  };
};
const hang = require_(path.join(root, "scripts/readiness-hang.cjs")) as {
  hangLine: (events: Array<{ milestone: string; ms: number }>) => string;
  noReportVerdict: (result: { stages?: unknown[]; error?: string; noReport?: boolean }) => boolean;
  readProgress: (file: string) => Array<{ milestone: string }>;
};

describe("readiness progress trace", () => {
  it("appends a milestone and fails that milestone when its budget expires", () => {
    const rows: Array<{ milestone: string; ms: number }> = [];
    const held: { scheduled: { fn: () => void; ms: number } | null } = { scheduled: null };
    const seen: number[] = [];
    const clock = { at: 5_000 };
    const writer = trace.createReadinessTrace({
      now: () => clock.at,
      schedule: (fn, ms) => {
        held.scheduled = { fn, ms };
        seen.push(ms);
        return 1;
      },
      clear: () => {
        held.scheduled = null;
      },
      append: (row) => rows.push(row as { milestone: string; ms: number }),
    });
    const previous = process.env["FRIDAY_READINESS"];
    process.env["FRIDAY_READINESS"] = "1";
    try {
      writer.reset(1_000);
      clock.at = 4_000;
      const row = writer.trace("window-created");
      expect(row?.milestone).toBe("window-created");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ms).toBe(3_000);
      expect(held.scheduled?.ms).toBe(trace.BUDGETS["window-created"]);
      const failed: { stage: string; error: string } = { stage: "", error: "" };
      writer.onExpire((info) => {
        failed.stage = info.stage;
        failed.error = info.error;
      });
      held.scheduled?.fn();
      expect(failed.stage).toBe("BOOT");
      expect(failed.error).toBe("hung after window-created");
      writer.reset(0);
      clock.at = 0;
      seen.length = 0;
      writer.trace("kernel-spawn");
      writer.trace("did-finish-load");
      expect(seen).toEqual([trace.BUDGETS["kernel-spawn"]]);
    } finally {
      writer.stop();
      if (previous === undefined) delete process.env["FRIDAY_READINESS"];
      else process.env["FRIDAY_READINESS"] = previous;
    }
  });

  it("does not write or arm a timer on a normal launch", () => {
    const previous = process.env["FRIDAY_READINESS"];
    delete process.env["FRIDAY_READINESS"];
    let armed = false;
    const writer = trace.createReadinessTrace({
      schedule: () => {
        armed = true;
        return 1;
      },
      append: () => {
        throw new Error("normal launch must not write the readiness trace");
      },
    });
    try {
      expect(writer.trace("process-start")).toBeNull();
      expect(armed).toBe(false);
      expect(trace.backgroundWorkAllowed()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["FRIDAY_READINESS"];
      else process.env["FRIDAY_READINESS"] = previous;
    }
  });

  it("schedules no background discovery while readiness mode is on", () => {
    const previous = process.env["FRIDAY_READINESS"];
    process.env["FRIDAY_READINESS"] = "1";
    try {
      expect(trace.backgroundWorkAllowed()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["FRIDAY_READINESS"];
      else process.env["FRIDAY_READINESS"] = previous;
    }
    const main = read("electron/main.cjs");
    expect(main).toContain("readinessTrace.backgroundWorkAllowed()");
    expect(main).not.toContain("process.stdout.write = sink");
    const gated = main.slice(main.indexOf("if (readinessTrace.backgroundWorkAllowed())"));
    for (const name of [
      "tray.init",
      "startModelRegistryRefresh",
      "detectProviders",
      "detectHardware",
      "detectComponents",
      "runStartup",
    ]) {
      expect(gated).toContain(name);
    }
    const python = read("electron/python.cjs");
    const readinessCandidates = python.slice(
      python.indexOf('if (process.env.FRIDAY_READINESS === "1")'),
      python.indexOf("A FRIDAY-managed environment"),
    );
    expect(readinessCandidates).not.toContain("materialiseBundledRuntime");
    expect(readinessCandidates).not.toContain("windowsInstalledPythons");
  });

  it("does not resolve userData before the app is ready", () => {
    const main = read("electron/main.cjs");
    const startup = main.slice(0, main.indexOf("// ---- Lifecycle"));
    expect(startup).not.toContain('setFallbackRoot(app.getPath("userData"))');
    expect(main).toContain('setFallbackRoot(app.getPath("userData"))');
    expect(main.indexOf('trace("before-subsystems")')).toBeLessThan(
      main.indexOf('trace("load:voice")'),
    );
    expect(main.indexOf('trace("load:voice")')).toBeLessThan(
      main.indexOf('trace("after-requires")'),
    );
    const bootstrap = main.slice(
      main.indexOf("const bootstrapSettingsFile"),
      main.indexOf("const workspaceSettingsFile"),
    );
    expect(bootstrap.indexOf("!app.isReady()")).toBeGreaterThan(-1);
    expect(bootstrap.indexOf("!app.isReady()")).toBeLessThan(bootstrap.indexOf("getPath"));
    expect(main.indexOf('traceLoad("connectors")')).toBeGreaterThan(
      main.indexOf('trace("before-subsystems")'),
    );
    expect(main.indexOf('traceLoad("connectors")')).toBeLessThan(
      main.indexOf('require("./connectors.cjs")'),
    );
    expect(main.indexOf('trace("load:voice")')).toBeLessThan(
      main.indexOf('traceLoad("voiceprint")'),
    );
    const voice = read("electron/voiceprint.cjs");
    expect(voice.slice(0, voice.indexOf("function userDataDir"))).not.toContain("getPath");
    expect(voice).toContain("!app.isReady()");
    const engines = read("electron/sandbox-engines.cjs");
    expect(engines).toContain("!app.isReady()");
    expect(engines).not.toMatch(/^loadRestartPending\(\);/m);
    expect(trace.BUDGETS["before-subsystems"]).toBeGreaterThanOrEqual(120_000);
  });

  it("does not read desktop exports that wait for ready while the subsystem modules load", () => {
    const Module = require_("module") as {
      prototype: { require: (id: string) => unknown };
    };
    const touched: string[] = [];
    const forbidden = new Set(["safeStorage", "desktopCapturer", "Tray", "nativeImage"]);
    const electron = new Proxy(
      {
        app: {
          isReady: () => false,
          isPackaged: false,
          getAppPath: () => root,
          getPath: () => {
            throw new Error("getPath before ready");
          },
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string" && forbidden.has(prop)) touched.push(prop);
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const original = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === "electron") return electron;
      return original.apply(this, [id]);
    };
    const names = [
      "electron/lazy-electron.cjs",
      "electron/watcher.cjs",
      "electron/updater.cjs",
      "electron/providers.cjs",
      "electron/provider-registry.cjs",
      "electron/hardware.cjs",
      "electron/system-monitor.cjs",
      "electron/service-health.cjs",
      "electron/importer.cjs",
      "electron/builder-run.cjs",
      "electron/import-factory.cjs",
      "electron/sandbox.cjs",
      "electron/capabilities.cjs",
      "electron/capability-verify.cjs",
      "electron/skill-pack.cjs",
      "electron/tool-pack.cjs",
      "electron/agent-pack.cjs",
      "electron/module-pack.cjs",
      "electron/workflow-pack.cjs",
      "electron/tools.cjs",
      "electron/modules.cjs",
      "electron/connectors.cjs",
      "electron/mcp-server.cjs",
      "electron/mcp-launch.cjs",
      "electron/mcp-paths.cjs",
      "electron/startup.cjs",
      "electron/browser.cjs",
      "electron/browser-live.cjs",
      "electron/screen-vision.cjs",
      "electron/diagram-ocr.cjs",
      "electron/camera.cjs",
      "electron/skills.cjs",
      "electron/agents.cjs",
      "electron/character/runtime.cjs",
      "electron/character/index.cjs",
      "electron/renderer.cjs",
      "electron/self-maintenance.cjs",
      "electron/finetune.cjs",
      "electron/source-access.cjs",
      "electron/plugins.cjs",
      "electron/telemetry.cjs",
      "electron/credentials.cjs",
      "electron/models.cjs",
      "electron/model-download.cjs",
      "electron/python.cjs",
      "electron/tray.cjs",
      "electron/startup-tasks.cjs",
      "electron/startup-trace.cjs",
      "electron/neural-voice.cjs",
      "electron/audio-duck.cjs",
      "electron/meeting-watch.cjs",
      "electron/voiceprint.cjs",
      "electron/stt.cjs",
      "electron/wake-engine.cjs",
      "electron/voice-verify.cjs",
      "electron/remote-access.cjs",
      "electron/library.cjs",
      "electron/project-workspaces.cjs",
      "electron/readiness.cjs",
      "electron/storage-manager.cjs",
      "electron/build-channel.cjs",
    ];
    const previous = process.env["FRIDAY_READINESS"];
    process.env["FRIDAY_READINESS"] = "1";
    try {
      for (const name of names) delete require_.cache[path.join(root, name)];
      for (const name of names) require_(path.join(root, name));
      expect(touched).toEqual([]);
      const rows: Array<{ milestone: string }> = [];
      const seen: number[] = [];
      const writer = trace.createReadinessTrace({
        schedule: (_fn, ms) => {
          seen.push(ms);
          return 1;
        },
        clear: () => {},
        append: (row) => rows.push(row),
      });
      writer.trace("load:connectors");
      expect(rows[0]?.milestone).toBe("load:connectors");
      expect(seen[0]).toBe(180_000);
      writer.stop();
    } finally {
      Module.prototype.require = original;
      for (const name of names) delete require_.cache[path.join(root, name)];
      if (previous === undefined) delete process.env["FRIDAY_READINESS"];
      else process.env["FRIDAY_READINESS"] = previous;
    }
  });
});

describe("readiness hang report", () => {
  it("names the last milestone and does not treat a missing report as an exit code", () => {
    const line = hang.hangLine([
      { milestone: "process-start", ms: 0 },
      { milestone: "app-ready", ms: 1200 },
      { milestone: "window-created", ms: 47000 },
    ]);
    expect(line).toBe(
      "hung after window-created (47s); last events: process-start, app-ready, window-created",
    );
    expect(
      hang.noReportVerdict({
        stages: [],
        error: "FRIDAY did not finish within 5 minutes",
      }),
    ).toBe(true);
    expect(
      hang.noReportVerdict({
        stages: [{ name: "CHAT" }],
        error: "inference failed",
      }),
    ).toBe(false);
    const driver = read("scripts/readiness-test.cjs");
    expect(driver).toContain("not evaluated: first run produced no report");
    expect(driver).toContain('add("RESTART", false, "not evaluated")');
    expect(driver).toContain("300000");
    expect(driver).toContain("did not finish within 5 minutes");
    expect(driver).toContain("first.exitCode === expected");
    expect(driver).toContain("--friday-python=");
    expect(driver).toContain("readiness-progress.jsonl");
    expect(driver).not.toContain("exit code undefined");
  });

  it("reads the jsonl the child appends", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-readiness-"));
    const file = path.join(dir, "readiness-progress.jsonl");
    try {
      fs.writeFileSync(
        file,
        `${JSON.stringify({ milestone: "process-start", ms: 0 })}\n${JSON.stringify({ milestone: "app-ready", ms: 10 })}\n`,
      );
      expect(hang.readProgress(file).map((row) => row.milestone)).toEqual([
        "process-start",
        "app-ready",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
