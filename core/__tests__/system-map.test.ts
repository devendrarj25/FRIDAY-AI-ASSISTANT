import { describe, expect, it } from "vitest";
import { buildSystemMap, type SystemMapInput } from "../../src/lib/friday/system-map";
import { areasFor, planFor } from "../../src/lib/friday/self/dev-pipeline";

const input = (over: Partial<SystemMapInput> = {}): SystemMapInput =>
  ({
    desktop: true,
    platform: "win32",
    version: "1.1.0",
    build: "2026.01.01",
    at: 1_000,
    env: {
      version: 1,
      updatedAt: 1_000,
      platform: "win32",
      ready: false,
      blocking: ["python"],
      components: [
        {
          id: "python",
          label: "Python runtime",
          kind: "runtime",
          version: null,
          path: null,
          health: "missing",
          source: null,
          capability: [],
          detail: "not installed",
          minimum: "3.12",
          repairable: true,
          checkedAt: 900,
          readySince: null,
        },
        {
          id: "node",
          label: "Node.js",
          kind: "runtime",
          version: "22.0.0",
          path: "C:/node",
          health: "ready",
          source: null,
          capability: [],
          detail: "ok",
          minimum: "20",
          repairable: false,
          checkedAt: 900,
          readySince: 800,
        },
      ],
    },
    doctor: {
      checks: [{ id: "db", label: "Database", group: "core", status: "Ready", detail: "open" }],
      log: [],
      scanning: false,
      mode: "idle",
      repairing: [],
      lastScanAt: 950,
      durationMs: 10,
      rollbacks: [],
      desktop: true,
    },
    models: {
      active: ["qwen"],
      installed: { qwen: "7b" },
      runtimes: { qwen: { state: "Running" } },
      providerState: {
        ollama: {
          id: "ollama",
          detected: true,
          online: true,
          endpoint: "http://localhost:11434",
          apiKey: null,
          models: 3,
          latencyMs: 12,
          error: null,
          checkedAt: 900,
        },
      },
      lastScanAt: 900,
    },
    ops: {
      skills: [
        { name: "research", category: "web", status: "Ready", level: "Basic", lastUsed: "now" },
      ],
      tools: [{ name: "fs.read", summary: "Read a file", risk: "safe", enabled: true }],
    },
    memory: { items: [], counts: { permanent: 2 }, lastWriteAt: 950 },
    governance: { items: [], pending: [], lastChangeAt: 0 },
    ledger: { tasks: [{ status: "failed" }], approvals: [] },
    self: { index: { at: 900, totals: { files: 10, edges: 20, broken: 0 } }, impacts: [] },
    ...over,
  }) as unknown as SystemMapInput;

describe("system map", () => {
  it("folds every engine snapshot into one registry", () => {
    const map = buildSystemMap(input());
    const ids = map.entries.map((e) => e.id);
    expect(ids).toContain("runtime/app");
    expect(ids).toContain("environment/python");
    expect(ids).toContain("services/db");
    expect(ids).toContain("models/qwen");
    expect(ids).toContain("models/provider/ollama");
    expect(ids).toContain("skills/research");
    expect(ids).toContain("tools/fs.read");
    expect(ids).toContain("development/index");
    expect(ids).toContain("development/source-health");
    expect(ids).toContain("governance/queue");
  });

  it("reports missing components as real problems", () => {
    const map = buildSystemMap(input());
    expect(map.health.ok).toBe(false);
    expect(map.health.errors.some((e) => e.includes("Python"))).toBe(true);
  });

  it("never invents entries when nothing is known", () => {
    const map = buildSystemMap(
      input({
        env: {
          version: 1,
          updatedAt: null,
          platform: "browser",
          ready: false,
          blocking: [],
          components: [],
        },
        models: {
          active: [],
          installed: {},
          runtimes: {},
          providerState: {},
          lastScanAt: null,
        } as never,
        ops: { skills: [], tools: [] } as never,
        doctor: { ...input().doctor, checks: [] },
      }),
    );
    expect(map.entries.some((e) => e.group === "models")).toBe(false);
    expect(map.entries.some((e) => e.group === "environment")).toBe(false);
  });

  it("counts group readiness without duplicating entries", () => {
    const map = buildSystemMap(input());
    const unique = new Set(map.entries.map((e) => e.id));
    expect(unique.size).toBe(map.entries.length);
    const env = map.groups.find((g) => g.group === "environment");
    expect(env).toEqual({ group: "environment", total: 2, idle: 0, ready: 1, problems: 1 });
  });

  it("treats a never-configured provider as idle, not as a problem", () => {
    const map = buildSystemMap(
      input({
        models: {
          active: [] as string[],
          installed: {},
          runtimes: {},
          providerState: {
            openai: {
              id: "openai",
              detected: false,
              online: false,
              endpoint: "https://api.openai.com/v1",
              apiKey: null,
              models: 0,
              latencyMs: null,
              error: null,
              checkedAt: 900,
            },
          },
          lastScanAt: 900,
        } as unknown as SystemMapInput["models"],
      }),
    );
    const entry = map.entries.find((e) => e.id === "models/provider/openai");
    expect(entry?.status).toBe("idle");
    const group = map.groups.find((g) => g.group === "models");
    expect(group?.problems).toBe(0);
    expect(group?.idle).toBe(1);
    expect(map.health.errors.join(" ")).not.toMatch(/openai/i);
  });

  it("folds source health from the self snapshot so status surfaces automatically", () => {
    const map = buildSystemMap(
      input({
        self: {
          index: { at: 900, totals: { files: 10, edges: 20, broken: 0 } },
          impacts: [],
          sourceHealth: {
            at: 950,
            inspected: true,
            problemCount: 1,
            detail: "AUDIT.md records 44 prettier errors",
            failing: ["source:audit:lint"],
          },
        },
      } as unknown as Partial<SystemMapInput>),
    );
    const entry = map.entries.find((item) => item.id === "development/source-health");
    expect(entry?.status).toBe("degraded");
    expect(entry?.detail).toMatch(/prettier/i);
    expect(map.health.warnings.join(" ")).toMatch(/Source health/i);
  });
});

describe("self-development planning", () => {
  it("maps a natural-language request to the areas it touches", () => {
    expect(areasFor("make the voice reply faster")).toContain("voice");
    expect(areasFor("improve model routing for coding")).toContain("models");
    expect(areasFor("fix prettier lint errors in my source")).toContain("source");
    expect(areasFor("something entirely unrelated")).toEqual(["general"]);
  });

  it("always plans backup, impact scan and approval before applying", () => {
    const plan = planFor("improve memory recall", ["memory"], ["memory/permanent · ready"]);
    expect(plan.join(" ")).toMatch(/backup/i);
    expect(plan.join(" ")).toMatch(/impact scan/i);
    expect(plan.join(" ")).toMatch(/approval/i);
  });
});
