/**
 * FRIDAY · startup flow contract.
 *
 * Verifies the real orchestration rules: auto-start config, the
 * start → verify → retry → repair ladder, and that readiness can only be
 * granted when the required subsystems actually answered.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const require_ = createRequire(import.meta.url);
const startup = require_(path.join(process.cwd(), "electron/startup.cjs"));

const engines = [
  { id: "ollama", name: "Ollama", running: false, canStart: true, canStop: false, hint: null },
  {
    id: "llamacpp",
    name: "llama.cpp",
    running: false,
    canStart: false,
    canStop: false,
    hint: "start it yourself",
  },
  { id: "lmstudio", name: "LM Studio", running: true, canStart: true, canStop: true, hint: null },
];

describe("service auto-start configuration", () => {
  it("defaults to Ollama, LM Studio, and LocalAI when the workspace has no services.json", () => {
    expect(startup.AUTOSTART_DEFAULT).toEqual(["ollama", "lmstudio", "localai"]);
    expect(startup.readServiceConfig(null)).toEqual({
      autoStart: ["ollama", "lmstudio", "localai"],
      source: "default",
    });
  });

  it("respects an explicit empty list (owner disabled auto-start)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-startup-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "services.json"), JSON.stringify({ autoStart: [] }));
    expect(startup.readServiceConfig(dir).autoStart).toEqual([]);
    expect(startup.readServiceConfig(dir).source).toBe("config/services.json");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an explicit owner list even when other engines could start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-startup-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "services.json"),
      JSON.stringify({ autoStart: ["ollama"] }),
    );
    expect(startup.readServiceConfig(dir).autoStart).toEqual(["ollama"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ensureService", () => {
  it("reports a running engine without touching it", async () => {
    const result = await startup.ensureService("lmstudio", {
      engines,
      startEngine: async () => {
        throw new Error("must not start an engine that already answers");
      },
    });
    expect(result.state).toBe("running");
    expect(result.attempts).toBe(0);
  });

  it("never claims success for an engine it cannot start", async () => {
    const result = await startup.ensureService("llamacpp", {
      engines,
      startEngine: async () => ({ ok: true }),
    });
    expect(result.state).toBe("unavailable");
    expect(result.detail).toContain("start it yourself");
  });

  it("retries once and reports the repair when the second attempt verifies", async () => {
    let calls = 0;
    const result = await startup.ensureService("ollama", {
      engines,
      startEngine: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, error: "endpoint never answered" }
          : { ok: true, detail: "verified" };
      },
    });
    expect(calls).toBe(2);
    expect(result.state).toBe("repaired");
  });

  it("gives up honestly after the retry budget", async () => {
    const result = await startup.ensureService("ollama", {
      engines,
      startEngine: async () => ({ ok: false, error: "binary missing" }),
    });
    expect(result.state).toBe("unavailable");
    expect(result.detail).toBe("binary missing");
  });
});

describe("readiness", () => {
  const base = {
    workspaceRoot: "/friday",
    workspaceExists: true,
    kernelAlive: true,
    modelsAvailable: true,
    capabilityCount: 4,
    services: [],
  };

  it("is ready only when workspace and kernel are both verified", () => {
    expect(startup.evaluateReadiness(base).state).toBe("ready");
    expect(startup.evaluateReadiness({ ...base, kernelAlive: false }).ready).toBe(false);
    expect(startup.evaluateReadiness({ ...base, workspaceRoot: null }).ready).toBe(false);
    expect(startup.evaluateReadiness({ ...base, workspaceExists: false }).ready).toBe(false);
  });

  it("degrades — never blocks — when a local engine or model is missing", () => {
    const result = startup.evaluateReadiness({
      ...base,
      modelsAvailable: false,
      services: [{ id: "ollama", name: "Ollama", state: "unavailable", detail: "not installed" }],
    });
    expect(result.ready).toBe(true);
    expect(result.state).toBe("degraded");
    expect(result.warnings.length).toBe(2);
  });
});

describe("runStartupFlow", () => {
  it("runs the documented sequence and never throws on a failing probe", async () => {
    const steps: string[] = [];
    const report = await startup.runStartupFlow({
      workspaceRoot: null,
      boot: (label: string) => steps.push(label),
      listCapabilities: async () => {
        throw new Error("scan exploded");
      },
      engineStatus: async () => engines,
      startEngine: async () => ({ ok: false, error: "no binary" }),
      kernelAlive: async () => false,
      routableModels: async () => 0,
    });
    expect(steps).toEqual([
      "Scanning capabilities",
      "Loading persistent state",
      "Starting local services",
      "Verifying kernel",
      "Restoring models",
      "FRIDAY ready",
    ]);
    expect(report.ready).toBe(false);
    expect(report.blockers).toContain("no FRIDAY folder selected");
    expect(report.blockers).toContain("kernel is not responding");
  });

  it("with no services.json, starts every engine that canStart", async () => {
    const started: string[] = [];
    await startup.runStartupFlow({
      workspaceRoot: null,
      boot: () => {},
      listCapabilities: async () => ({ items: [], counts: {} }),
      engineStatus: async () => [
        { id: "ollama", name: "Ollama", running: false, canStart: true, hint: null },
        { id: "llamacpp", name: "llama.cpp", running: false, canStart: true, hint: null },
        { id: "jan", name: "Jan", running: false, canStart: false, hint: "manual" },
      ],
      startEngine: async (id: string) => {
        started.push(id);
        return { ok: true, detail: "verified" };
      },
      kernelAlive: async () => true,
      routableModels: async () => 1,
    });
    expect(started).toEqual(["ollama", "llamacpp"]);
  });

  it("honours an explicit services.json list and does not start extra canStart engines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-startup-"));
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config", "services.json"),
      JSON.stringify({ autoStart: ["ollama"] }),
    );
    const started: string[] = [];
    await startup.runStartupFlow({
      workspaceRoot: dir,
      boot: () => {},
      listCapabilities: async () => ({ items: [], counts: {} }),
      engineStatus: async () => [
        { id: "ollama", name: "Ollama", running: false, canStart: true, hint: null },
        { id: "localai", name: "LocalAI", running: false, canStart: true, hint: null },
      ],
      startEngine: async (id: string) => {
        started.push(id);
        return { ok: true, detail: "verified" };
      },
      kernelAlive: async () => true,
      routableModels: async () => 1,
    });
    expect(started).toEqual(["ollama"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
