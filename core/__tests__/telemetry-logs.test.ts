import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const telemetry = require("../../electron/telemetry.cjs") as {
  init: (send: (channel: string, payload: unknown) => void) => void;
  recordLog: (level: string, source: string, message: string) => { id: string; level: string };
  recordIpc: (entry: { channel: string; ok: boolean; ms: number }) => {
    id?: string;
    channel: string;
  };
  snapshot: () => {
    logs: Array<{ message: string }>;
    ipc: Array<{ channel: string }>;
    file?: string | null;
  };
  hydrateFromText: (text: string) => number;
  hydrate: () => { ok: boolean; loaded: number };
  clearLogs: () => { ok: boolean };
  parseLogLine: (line: string) => { level: string; source: string; message: string } | null;
  formatLogLine: (entry: { at: number; level: string; source: string; message: string }) => string;
  listFiles: () => { ok: boolean; files: Array<{ rel: string }>; error?: string };
  readLogFile: (rel: string) => { ok: boolean; error?: string };
  ipc: { clear: () => void };
  LIMIT: number;
};
const paths = require("../../electron/friday-paths.cjs") as {
  setRoot: (root: string | null) => void;
  root: () => string | null;
};

describe("telemetry log ring", () => {
  const previous = paths.root();

  beforeEach(() => {
    paths.setRoot(null);
    telemetry.clearLogs();
    telemetry.ipc.clear();
    telemetry.init(() => {});
  });

  afterEach(() => {
    telemetry.clearLogs();
    telemetry.init(() => {});
    paths.setRoot(previous);
  });

  it("parses modern and legacy main.log lines", () => {
    const modern = telemetry.parseLogLine("[2026-09-08T12:00:00.000Z] [error] kernel boom");
    expect(modern).toMatchObject({ level: "error", source: "kernel", message: "boom" });
    const legacy = telemetry.parseLogLine("[2026-09-08T12:00:00.000Z] boot ok");
    expect(legacy).toMatchObject({ source: "main", message: "boot ok" });
  });

  it("hydrates the ring from disk text and caps it", () => {
    telemetry.clearLogs();
    const lines = Array.from({ length: 320 }, (_, i) =>
      telemetry.formatLogLine({
        at: Date.parse("2026-09-08T12:00:00.000Z") + i,
        level: "info",
        source: "main",
        message: `line-${i}`,
      }),
    );
    const loaded = telemetry.hydrateFromText(lines.join("\n"));
    expect(loaded).toBe(telemetry.LIMIT);
    expect(telemetry.snapshot().logs.at(-1)?.message).toBe("line-319");
  });

  it("emits live entries into the same ring snapshot", () => {
    telemetry.clearLogs();
    const emitted: unknown[] = [];
    telemetry.init?.((channel: string, payload: unknown) => {
      if (channel === "telemetry:log") emitted.push(payload);
    });
    const entry = telemetry.recordLog("warn", "plugin", "loaded");
    expect(entry.level).toBe("warn");
    expect(telemetry.snapshot().logs.map((row) => row.message)).toContain("loaded");
    expect(emitted).toHaveLength(1);
  });

  it("emits IPC rows into the same live ring", () => {
    const emitted: unknown[] = [];
    telemetry.init((channel: string, payload: unknown) => {
      if (channel === "telemetry:ipc") emitted.push(payload);
    });
    const row = telemetry.recordIpc({ channel: "telemetry:snapshot", ok: true, ms: 2 });
    expect(row.id).toMatch(/^ipc-/);
    expect(emitted).toHaveLength(1);
    expect(telemetry.snapshot().ipc.map((item) => item.channel)).toContain("telemetry:snapshot");
  });

  it("hydrates from disk, lists files, and clearLogs leaves the file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-logs-"));
    paths.setRoot(root);
    const dir = path.join(root, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "main.log");
    fs.writeFileSync(
      file,
      [
        "[2026-09-08T12:00:00.000Z] boot ok",
        "[2026-09-08T12:00:01.000Z] [error] kernel boom",
        "",
      ].join("\n"),
      "utf8",
    );
    const loaded = telemetry.hydrate();
    expect(loaded.ok).toBe(true);
    expect(loaded.loaded).toBe(2);
    expect(telemetry.snapshot().logs.map((row) => row.message)).toEqual(["boot ok", "boom"]);
    expect(telemetry.listFiles().files.some((item) => item.rel === "main.log")).toBe(true);
    expect(telemetry.readLogFile("main.log").ok).toBe(true);
    expect(telemetry.clearLogs().ok).toBe(true);
    expect(telemetry.snapshot().logs).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toMatch(/boot ok/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a path that leaves the logs folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-logs-"));
    paths.setRoot(root);
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    expect(telemetry.readLogFile("../config/secrets.json").ok).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
