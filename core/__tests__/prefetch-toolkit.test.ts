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
  it("names only tools the Install Manager can install, and has no size cap", () => {
    const ids = new Set(toolchain.TOOLS.map((tool: { id: string }) => tool.id));
    expect(manifest.maxPrefetchBytes).toBeUndefined();
    for (const entry of [...manifest.prefetch, ...manifest.onDemand]) {
      expect(ids.has(entry.id), entry.id).toBe(true);
    }
    for (const entry of manifest.prefetch) expect(entry.why, entry.id).toBeTruthy();
    // A row name in the Install Manager list that differs from the tool id is declared, not guessed.
    expect(manifest.prefetch.find((row: { id: string }) => row.id === "uv (Python)")?.catalog).toBe(
      "uv",
    );
  });

  it("installs the heavy tools FRIDAY's features need before the build, whatever their size", () => {
    const wanted = new Set(manifest.prefetch.map((row: { id: string }) => row.id));
    for (const id of [
      "Docker Desktop",
      "WSL 2",
      "Sandbox runner (Windows Sandbox)",
      "CUDA Toolkit",
      "Git",
      "CMake",
      "Go",
      "Rust",
      "OpenJDK (Temurin)",
      "ripgrep",
      "FFmpeg",
    ]) {
      expect(wanted.has(id), id).toBe(true);
    }
    const order = manifest.prefetch.map((row: { id: string }) => row.id);
    expect(order.indexOf("WSL 2")).toBeLessThan(order.indexOf("Docker Desktop"));
  });

  it("marks the administrator tools and gates CUDA on an NVIDIA GPU", () => {
    const by = Object.fromEntries(manifest.prefetch.map((row: { id: string }) => [row.id, row]));
    for (const id of [
      "Docker Desktop",
      "WSL 2",
      "Sandbox runner (Windows Sandbox)",
      "CUDA Toolkit",
    ]) {
      expect(by[id].elevated, id).toBe(true);
    }
    expect(by["CUDA Toolkit"].requires).toBe("nvidia-gpu");
  });

  it("leaves only models and the runners a model needs for later, by kind", () => {
    const prefetched = new Set(manifest.prefetch.map((row: { id: string }) => row.id));
    for (const entry of manifest.onDemand) {
      expect(prefetched.has(entry.id), entry.id).toBe(false);
      expect(entry.reason, entry.id).toBeTruthy();
    }
    for (const id of ["Hugging Face runner", "PyTorch (CUDA)", "vLLM"]) {
      expect(
        manifest.onDemand.some((row: { id: string }) => row.id === id),
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
  const get = (rows: Row[], id: string) => rows.find((row) => row.id === id);

  it("installs what is missing, updates what is older, and keeps what is current", () => {
    const rows = toolkit.toolkitPlan({ detected, latest }) as Row[];
    expect(get(rows, "ripgrep")).toMatchObject({ action: "update", from: "14.1.0", to: "15.1.0" });
    expect(get(rows, "jq (JSON)")).toMatchObject({ action: "keep", version: "1.7.1" });
    expect(get(rows, "Ninja")?.action).toBe("install");
    expect(get(rows, "Docker Desktop")?.action).toBe("install");
  });

  it("only reports an update when updates are switched off, and never claims one it cannot see", () => {
    const rows = toolkit.toolkitPlan({ detected, latest, update: false }) as Row[];
    expect(get(rows, "ripgrep")?.action).toBe("outdated");
    const unknown = toolkit.toolkitPlan({ detected, latest: {} }) as Row[];
    expect(get(unknown, "ripgrep")?.action).toBe("keep");
  });

  it("installs CUDA only on a PC whose NVIDIA driver answers", () => {
    const none = toolkit.toolkitPlan({ detected: {} }) as Row[];
    expect(get(none, "CUDA Toolkit")?.action).toBe("skip");
    const gpu = toolkit.toolkitPlan({
      detected: { "NVIDIA Driver": { installed: true, version: "560.1" } },
    }) as Row[];
    expect(get(gpu, "CUDA Toolkit")?.action).toBe("install");
  });

  it("skips only the administrator tools for a quick build, and keeps ones already installed", () => {
    const quick = toolkit.toolkitPlan({
      detected: { "Docker Desktop": { installed: true, version: "4.0" } },
      elevated: false,
    }) as Row[];
    expect(get(quick, "WSL 2")?.action).toBe("skip");
    expect(get(quick, "Docker Desktop")?.action).toBe("keep");
    expect(get(quick, "Git")?.action).toBe("install");
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

  it("installs every missing tool with progress, warns before an administrator one, and names what is left for later", async () => {
    const stub = fakeToolchain({});
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: (l: string) => lines.push(l),
    });
    const ids = stub.jobs.map((job) => job.id);
    expect(ids).toContain("Docker Desktop");
    expect(ids).toContain("Sandbox runner (Windows Sandbox)");
    expect(ids).not.toContain("CUDA Toolkit");
    expect(stub.jobs.every((job) => job.action === "install")).toBe(true);
    expect(rows.find((row: { id: string }) => row.id === "aria2")).toMatchObject({ ok: false });
    const text = lines.join("\n");
    expect(text).toContain("Docker Desktop needs administrator rights");
    expect(text).toContain("CUDA Toolkit skipped: no NVIDIA GPU driver");
    expect(text).toContain("not installed; FRIDAY offers it in the Install Manager");
    expect(text).toContain("no size limit");
    expect(text).toContain("Models section");
    expect(text).toContain("Hugging Face runner");
  });

  it("reports a pending restart without stopping the build", async () => {
    const stub = fakeToolchain({});
    const real = stub.runJob;
    stub.runJob = async (job, emit) => {
      const out = await real(job, emit);
      return job.id === "WSL 2" ? { ...out, restartRequired: true } : out;
    };
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: (l: string) => lines.push(l),
    });
    expect(rows.find((row: { id: string }) => row.id === "WSL 2")).toMatchObject({
      restartRequired: true,
    });
    expect(lines.join("\n")).toContain("WSL 2 asks for a Windows restart");
    expect(stub.jobs.map((job) => job.id)).toContain("Docker Desktop");
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
    const tried = rows.filter((row: { skipped?: boolean }) => !row.skipped);
    expect(tried.length).toBeGreaterThan(10);
    expect(tried.every((row: { ok: boolean }) => row.ok === false)).toBe(true);
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

describe("toolkit install time limit", () => {
  it("defaults to 30 minutes, 45 for administrator tools, and honours the environment", () => {
    expect(toolkit.jobLimitMs({}, false)).toBe(30 * 60_000);
    expect(toolkit.jobLimitMs({}, true)).toBe(45 * 60_000);
    expect(toolkit.jobLimitMs({ FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN: "2" }, false)).toBe(120_000);
    expect(toolkit.jobLimitMs({ FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN: "x" }, false)).toBe(
      30 * 60_000,
    );
  });

  it("cancels and moves on when an install never answers", async () => {
    const cancelled: string[] = [];
    const stub = {
      detectTools: async () => ({ tools: [] }),
      wingetUpgrades: async () => ({}),
      toolById: (id: string) => ({ id }),
      latestFor: async () => null,
      cancelJob: (job: { id: string }) => cancelled.push(job.id),
      runJob: () => new Promise(() => {}),
    };
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      platform: "win32",
      env: { CI: "", GITHUB_ACTIONS: "", FRIDAY_PREFETCH_TOOLKIT_TIMEOUT_MIN: "0.0005" },
      toolchain: stub,
      progressLine: () => "",
      log: (l: string) => lines.push(l),
    });
    expect(cancelled).toContain("ripgrep");
    expect(rows.find((row: { id: string }) => row.id === "ripgrep")).toMatchObject({ ok: false });
    expect(lines.join("\n")).toContain("no answer after");
  }, 60_000);
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

describe("toolkit scan", () => {
  it("asks the scan for the toolkit's own tools and the NVIDIA driver only", async () => {
    let asked: string[] = [];
    const stub = {
      detectTools: async (opts: { only?: string[] }) => {
        asked = opts.only ?? [];
        return { tools: [] };
      },
      wingetUpgrades: async () => ({}),
      toolById: (id: string) => ({ id }),
      latestFor: async () => null,
      runJob: async () => ({ ok: true }),
    };
    await toolkit.prefetchToolkit("C:/friday", {
      platform: "win32",
      env: { CI: "", GITHUB_ACTIONS: "" },
      toolchain: stub,
      progressLine: () => "",
      log: () => {},
    });
    expect(asked).toContain("NVIDIA Driver");
    expect(asked).toContain("Docker Desktop");
    expect(asked.length).toBe(manifest.prefetch.length + 1);
  });

  it("probes a subset in the real scan without touching the full-scan cache", async () => {
    const out = await toolchain.detectTools({ force: true, root: "", only: ["Git", "ripgrep"] });
    expect(out.tools.map((tool: { id: string }) => tool.id).sort()).toEqual(["Git", "ripgrep"]);
    expect(toolchain.lastDetected().tools ?? []).not.toHaveLength(2);
  }, 60_000);
});

describe("toolkit in every command", () => {
  it("gives each tool a probe, so doctor can tell whether it is there", () => {
    for (const entry of manifest.prefetch) {
      const probe = entry.probe;
      expect(probe, entry.id).toBeTruthy();
      expect(Boolean(probe.file) !== Boolean(probe.cmd?.length), entry.id).toBe(true);
      if (probe.cmd) expect(Array.isArray(probe.args), entry.id).toBe(true);
    }
  });

  it("is reported by npm run doctor as warnings and installed by npm run setup:toolkit", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["setup:toolkit"]).toBe("node scripts/prefetch-toolkit.cjs");
    expect(pkg.scripts["doctor"]).toContain("scripts/check-environment.cjs");
    const check = readFileSync(path.join(root, "scripts/check-environment.cjs"), "utf8");
    expect(check).toContain('group: "agent-toolkit"');
    expect(check).toContain("required: false");
    expect(check).toContain("npm run setup:toolkit");
    // --fix repairs Electron and Python only, so a build never asks for an administrator prompt twice.
    expect(check).not.toMatch(/--fix[^\n]*prefetch-toolkit/);
  });
});
