/**
 * A second launch must not treat another kernel in the same folder as its own.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const readiness = require_("../../electron/readiness.cjs");
const life = require_("../../electron/app-lifecycle.cjs");
const harness = require_("../../scripts/readiness-test.cjs");

describe("kernel identity", () => {
  it("rejects a health payload from a different launch", () => {
    const health = { ok: true, data_dir: "/friday", instance_id: "launch-1" };
    expect(readiness.kernelIdentityOk(health, "launch-2")).toBe(false);
    expect(readiness.kernelIdentityOk(health, "launch-1")).toBe(true);
    expect(readiness.kernelIdentityOk({ data_dir: "/friday" }, "launch-1")).toBe(false);
  });

  it("keeps an unloaded-local chat inside the pack-continues rule", () => {
    expect(readiness.isUnloadedLocalChat("no installed local model")).toBe(true);
    expect(readiness.isUnloadedLocalChat("model not loaded in LM Studio")).toBe(true);
    expect(readiness.isUnloadedLocalChat("unavailable after scan")).toBe(true);
    expect(readiness.isUnloadedLocalChat("chat produced no answer")).toBe(false);
  });
});

describe("owned process cleanup", () => {
  it("waits until a stale owned pid is gone", async () => {
    let alive = true;
    const result = await life.waitForProcessGone(42, {
      timeoutMs: 500,
      alive: () => alive,
      kill: () => {
        alive = false;
      },
      sleep: async () => {},
    });
    expect(result.gone).toBe(true);
  });

  it("stops a kernel recorded in the owned-pid registry and leaves another runtime", () => {
    const rows = [
      { role: "kernel", command: "/usr/bin/python", pid: 7 },
      { role: "kernel", command: "ollama serve", pid: 8 },
      { role: "tray", command: "friday", pid: 9 },
    ];
    const stopped = life.processesToStop(rows).map((row: { pid: number }) => row.pid);
    expect(stopped).toContain(7);
    expect(stopped).not.toContain(8);
  });

  it("does not skip kernel cleanup on the readiness exit", () => {
    const main = readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
    const start = main.indexOf("function finishReadiness");
    const end = main.indexOf('if (process.env.FRIDAY_READINESS === "1")', start);
    const head = main.slice(start, end);
    expect(head).toContain('requestShutdown("readiness"');
    expect(head).not.toContain("setTimeout(() => life.exitNow");
    expect(main).toContain("FRIDAY_INSTANCE_ID");
  });
});

describe("restart harness", () => {
  it("prints each failing stage, the kernel pid and port, and the leak", () => {
    const line = harness.restartReportLine(
      {
        stages: [
          { name: "DATABASE", ok: false, detail: "round-trip failed" },
          { name: "CHAT", ok: false, detail: "kernel is not running" },
        ],
        kernel: { pid: 44, port: 8765 },
        leak: { ok: false, alive: [44] },
      },
      { kernel: { pid: 12, port: 8765 } },
    );
    expect(line).toContain("DATABASE: round-trip failed");
    expect(line).toContain("CHAT: kernel is not running");
    expect(line).toContain("launch 1 pid 12 port 8765");
    expect(line).toContain("launch 2 pid 44 port 8765");
    expect(line).toContain("leak 44");
  });

  it("clears only the database sidecars in a readiness root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "friday-ready-"));
    mkdirSync(path.join(root, "database"), { recursive: true });
    const db = path.join(root, "database", "friday.db");
    const wal = path.join(root, "database", "friday.db-wal");
    writeFileSync(db, "keep");
    writeFileSync(wal, "stale");
    harness.clearDatabaseSidecars(root);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(wal)).toBe(false);
  });
});
