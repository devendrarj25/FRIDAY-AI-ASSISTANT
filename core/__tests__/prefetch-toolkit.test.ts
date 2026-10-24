/**
 * Build-time agent toolkit: portable command-line tools land in the FRIDAY
 * folder before the EXE is built, through the Install Manager's own job. No
 * network and no installs here: the toolchain is a stand-in.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolkit = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));
const manifest = require_(path.join(root, "config/agent-toolkit.json"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const pipeline = require_(path.join(root, "scripts/build-pipeline.cjs"));

type Row = { id: string; action: string; from?: string; to?: string; version?: string };

describe("agent toolkit manifest", () => {
  it("names only tools the Install Manager can install, and keeps every prefetch under 2 GB", () => {
    const ids = new Set(toolchain.TOOLS.map((tool: { id: string }) => tool.id));
    expect(manifest.maxPrefetchBytes).toBe(2_000_000_000);
    for (const entry of [...manifest.prefetch, ...manifest.deferred]) {
      expect(ids.has(entry.id), entry.id).toBe(true);
    }
    const total = manifest.prefetch.reduce(
      (sum: number, row: { approxBytes: number }) => sum + row.approxBytes,
      0,
    );
    expect(total).toBeLessThan(manifest.maxPrefetchBytes);
    for (const entry of manifest.prefetch) {
      expect(entry.approxBytes, entry.id).toBeLessThan(manifest.maxPrefetchBytes);
      expect(entry.why, entry.id).toBeTruthy();
    }
  });

  it("never prefetches a tool that needs an administrator, a restart or more than 2 GB", () => {
    const prefetched = new Set(manifest.prefetch.map((row: { id: string }) => row.id));
    for (const entry of manifest.deferred) {
      expect(prefetched.has(entry.id), entry.id).toBe(false);
      expect(entry.reason, entry.id).toBeTruthy();
    }
    for (const id of ["Docker Desktop", "WSL 2", "Hugging Face runner", "CUDA Toolkit"]) {
      expect(
        manifest.deferred.some((row: { id: string }) => row.id === id),
        id,
      ).toBe(true);
    }
  });

  it("gives the portable fallbacks a vendor feed so a missing winget does not stop an install", () => {
    for (const id of ["ripgrep", "uv (Python)", "CMake", "Ninja"]) {
      expect(vendor.hasFeed(id), id).toBe(true);
    }
  });
});

describe("toolkit plan", () => {
  const detected = {
    ripgrep: { installed: true, version: "14.1.0" },
    "jq (JSON)": { installed: true, version: "1.7.1" },
    Ninja: { installed: false },
  };
  const latest = { ripgrep: "15.1.0", "jq (JSON)": "1.7.1" };

  it("installs what is missing, updates what is older, and keeps what is current", () => {
    const rows = toolkit.toolkitPlan({ detected, latest }) as Row[];
    const get = (id: string) => rows.find((row) => row.id === id);
    expect(get("ripgrep")).toMatchObject({ action: "update", from: "14.1.0", to: "15.1.0" });
    expect(get("jq (JSON)")).toMatchObject({ action: "keep", version: "1.7.1" });
    expect(get("Ninja")?.action).toBe("install");
    expect(get("yq (YAML)")?.action).toBe("install");
  });

  it("only reports an update when updates are switched off, and never claims one it cannot see", () => {
    const rows = toolkit.toolkitPlan({ detected, latest, update: false }) as Row[];
    expect(rows.find((row) => row.id === "ripgrep")?.action).toBe("outdated");
    const unknown = toolkit.toolkitPlan({ detected, latest: {} }) as Row[];
    expect(unknown.find((row) => row.id === "ripgrep")?.action).toBe("keep");
  });

  it("defers anything at or above the cap", () => {
    const rows = toolkit.toolkitPlan({ detected: {}, latest: {}, cap: 5_000_000 }) as Row[];
    expect(rows.find((row) => row.id === "uv (Python)")?.action).toBe("defer");
    expect(rows.find((row) => row.id === "Ninja")?.action).toBe("install");
  });

  it("compares dotted versions without being fooled by text", () => {
    expect(toolkit.newer("v15.1.0", "14.1.0")).toBe(true);
    expect(toolkit.newer("1.10", "1.9")).toBe(true);
    expect(toolkit.newer("1.7.1", "1.7.1")).toBe(false);
    expect(toolkit.newer("", "1.0")).toBe(false);
    expect(toolkit.newer("unknown", "1.0")).toBe(false);
  });
});

describe("toolkit run", () => {
  const win = { platform: "win32", env: { CI: "", GITHUB_ACTIONS: "" } };

  function fakeToolchain(installed: Record<string, string>, latest: Record<string, string> = {}) {
    const jobs: { id: string; action: string; root: string }[] = [];
    return {
      jobs,
      detectTools: async () => ({
        tools: Object.entries(installed).map(([id, version]) => ({ id, installed: true, version })),
      }),
      wingetUpgrades: async () => ({}),
      toolById: (id: string) => ({ id }),
      latestFor: async (tool: { id: string }) => latest[tool.id] ?? null,
      runJob: async (
        job: { id: string; action: string; root: string },
        emit: (e: unknown) => void,
      ) => {
        jobs.push(job);
        emit({ id: job.id, phase: "Running", line: "downloading" });
        emit({ id: job.id, progress: 100 });
        return { ok: job.id !== "aria2" };
      },
    };
  }

  const progressLine = (id: string, event: { progress: number }) => `${id} ${event.progress}%`;

  it("does not download what is already installed and updates what is outdated", async () => {
    const all = Object.fromEntries(
      manifest.prefetch.map((row: { id: string }) => [row.id, "1.0.0"]),
    );
    const stub = fakeToolchain(all, { ripgrep: "2.0.0" });
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: (l: string) => lines.push(l),
    });
    expect(stub.jobs).toEqual([{ id: "ripgrep", action: "update", root: "C:/friday" }]);
    expect(rows.filter((row: { downloaded: boolean }) => row.downloaded)).toHaveLength(1);
    expect(lines.join("\n")).toContain("already installed; not downloaded again");
    expect(lines.join("\n")).toContain("updating ripgrep 1.0.0 -> 2.0.0");
    expect(lines.join("\n")).toContain("ripgrep 100%");
  });

  it("installs the missing tools with progress, survives a failed one, and names what stays in the Install Manager", async () => {
    const stub = fakeToolchain({});
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: (l: string) => lines.push(l),
    });
    expect(stub.jobs).toHaveLength(manifest.prefetch.length);
    expect(stub.jobs.every((job) => job.action === "install")).toBe(true);
    expect(rows.find((row: { id: string }) => row.id === "aria2")).toMatchObject({ ok: false });
    const text = lines.join("\n");
    expect(text).toContain("not installed; FRIDAY offers it in the Install Manager");
    expect(text).toContain("left for the Install Manager inside FRIDAY");
    expect(text).toContain("Docker Desktop");
    expect(text).toContain("limit 2.0 GB");
  });

  it("never lets a throwing install stop the build", async () => {
    const stub = fakeToolchain({});
    stub.runJob = async () => {
      throw new Error("winget exploded");
    };
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: () => {},
    });
    expect(rows.every((row: { ok: boolean }) => row.ok === false)).toBe(true);
  });

  it("skips offline, off Windows, on hosted CI and when switched off", async () => {
    expect(toolkit.skipReason({ FRIDAY_OFFLINE: "1" }, "win32")).toContain("offline");
    expect(toolkit.skipReason({}, "linux")).toContain("Windows");
    expect(toolkit.skipReason({ CI: "true" }, "win32")).toContain("CI");
    expect(toolkit.skipReason({ CI: "true", FRIDAY_PREFETCH: "1" }, "win32")).toBe("");
    expect(toolkit.skipReason({ FRIDAY_PREFETCH_TOOLKIT: "0" }, "win32")).toContain("turned off");
    expect(toolkit.skipReason({ FRIDAY_PREFETCH: "0" }, "win32")).toContain("turned off");
    const stub = fakeToolchain({});
    expect(
      await toolkit.prefetchToolkit("C:/friday", {
        env: { FRIDAY_OFFLINE: "1" },
        platform: "win32",
        toolchain: stub,
        log: () => {},
      }),
    ).toEqual([]);
    expect(stub.jobs).toHaveLength(0);
  });
});

describe("toolkit is part of the one build recipe", () => {
  it("runs inside prepare-environment, after the Python setup and before the runtime init", () => {
    const commands: string[] = pipeline.PHASE_COMMANDS["prepare-environment"];
    const at = commands.indexOf("scripts/prefetch-toolkit.cjs");
    expect(at).toBeGreaterThan(commands.indexOf("scripts/setup-python.cjs"));
    expect(at).toBeLessThan(commands.indexOf("scripts/init-runtime.cjs"));
    expect(pipeline.PHASES).not.toContain("prefetch-toolkit");
    const source = readFileSync(path.join(root, "scripts/build-pipeline.cjs"), "utf8");
    expect(source).toContain('runNode("scripts/prefetch-toolkit.cjs", [], root)');
  });

  it("is also run by the Windows setup script, which never fails on it", () => {
    const setup = readFileSync(path.join(root, "scripts/setup-windows.ps1"), "utf8");
    expect(setup).toContain("scripts\\prefetch-toolkit.cjs");
    expect(setup).toMatch(/prefetch-toolkit\.cjs\s*\n\s*if \(\$LASTEXITCODE -ne 0\) \{ Write-Host/);
  });
});
