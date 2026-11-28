/**
 * Build-time agent toolkit: portable command-line tools land in the FRIDAY
 * folder before the EXE is built, through the Install Manager's own job. No
 * network and no installs here: the toolchain is a stand-in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolkit = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));
const manifest = require_(path.join(root, "config/agent-toolkit.json"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const pipeline = require_(path.join(root, "scripts/build-pipeline.cjs"));

type Row = {
  id: string;
  action: string;
  from?: string;
  to?: string;
  version?: string;
  note?: string;
};

describe("agent toolkit manifest", () => {
  it("names only tools the Install Manager can install, and has no size cap", () => {
    // The shipped extension rows (config/install-extensions.json) are part of the catalog.
    toolchain.syncExtensions("");
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

  it("keeps the CUDA Toolkit optional: nothing runs nvcc, speech uses pip's CUDA 12 libraries", () => {
    const row = manifest.prefetch.find((r: { id: string }) => r.id === "CUDA Toolkit");
    expect(row.optional).toBe(true);
    expect(row.optionalReason).toContain("nvcc");
    expect(row.optionalReason).toContain("Install Manager");
    // No other tool is optional by accident.
    const others = manifest.prefetch.filter(
      (r: { id: string; optional?: boolean }) => r.optional && r.id !== "CUDA Toolkit",
    );
    expect(others).toEqual([]);
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
    // The driver alone no longer installs a 3.5 GB toolkit: the row stays, skipped, with the reason.
    expect(get(gpu, "CUDA Toolkit")).toMatchObject({ action: "skip" });
    expect(get(gpu, "CUDA Toolkit")?.note).toContain("optional, not installed by default");
    expect(get(gpu, "CUDA Toolkit")?.note).toContain("nvcc");
    // Opted in on purpose (FRIDAY_PREFETCH_TOOLKIT_OPTIONAL=1) it installs, and still only with the driver.
    const driver = { "NVIDIA Driver": { installed: true, version: "560.1" } };
    expect(
      get(toolkit.toolkitPlan({ detected: driver, optional: true }) as Row[], "CUDA Toolkit")
        ?.action,
    ).toBe("install");
    expect(
      get(toolkit.toolkitPlan({ detected: {}, optional: true }) as Row[], "CUDA Toolkit")?.action,
    ).toBe("skip");
  });

  it("keeps and updates an optional tool that is already installed", () => {
    const rows = toolkit.toolkitPlan({
      detected: { "CUDA Toolkit": { installed: true, version: "12.6" } },
      latest: { "CUDA Toolkit": "13.0" },
    }) as Row[];
    expect(get(rows, "CUDA Toolkit")).toMatchObject({ action: "update", from: "12.6", to: "13.0" });
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
  // A fresh in-memory ledger per test, so no run writes under a C:/friday folder on this machine.
  let win = {
    platform: "win32",
    env: { CI: "", GITHUB_ACTIONS: "" },
    ledger: toolkit.memoryLedger(),
  };
  beforeEach(() => {
    win = {
      platform: "win32",
      env: { CI: "", GITHUB_ACTIONS: "" },
      ledger: toolkit.memoryLedger(),
    };
  });

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
      manifest.prefetch.map((row: { id: string }) => [
        row.id,
        row.id === ".NET SDK" ? "10.0.100" : "1.0.0",
      ]),
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
    expect(text).toContain("aria2 was not installed");
    // A tool that could not be installed is named with the way forward (strict mode fails the step on it; by default it is a notice).
    const report = toolkit.failureReport(rows).join("\n");
    expect(report).toContain("ACTION REQUIRED");
    expect(report).toContain("aria2");
    expect(report).toContain("npm run setup:toolkit");
    expect(text).toContain("no size limit");
    expect(text).toContain("Models section");
    expect(text).toContain("Hugging Face runner");
  });

  it("does not install the optional CUDA Toolkit on a PC with an NVIDIA driver, and shows the row as skipped with the reason", async () => {
    const stub = fakeToolchain({ "NVIDIA Driver": "560.1" });
    const lines: string[] = [];
    const rows = await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: stub,
      progressLine,
      log: (l: string) => lines.push(l),
    });
    expect(stub.jobs.map((job) => job.id)).not.toContain("CUDA Toolkit");
    expect(rows.find((row: { id: string }) => row.id === "CUDA Toolkit")).toMatchObject({
      ok: true,
      skipped: true,
      downloaded: false,
    });
    const text = lines.join("\n");
    expect(text).toContain("CUDA Toolkit skipped: optional, not installed by default");
    expect(text).toContain("Install Manager");
  });

  // The JSON of `prefetch-models.cjs --plan --json` for a PC with an NVIDIA card (what the CUDA Toolkit gate reads).
  const gpuPlan = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    required: [{ id: "cuda-libs", kind: "runtime-pack", action: "install" }],
    skipped: [],
    pc: {
      gpu: { name: "RTX 3060", vramGb: 12, computeCap: 8.6, driver: "560.1" },
      cudaDriver: true,
      diskFreeGb: 400,
      ...over,
    },
    ...extra,
  });

  it("installs the CUDA Toolkit when the owner opts in with FRIDAY_PREFETCH_TOOLKIT_OPTIONAL=1 and this PC's plan lets it in", async () => {
    const stub = fakeToolchain({ "NVIDIA Driver": "560.1" });
    await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      env: { ...win.env, FRIDAY_PREFETCH_TOOLKIT_OPTIONAL: "1" },
      toolchain: stub,
      progressLine,
      plan: gpuPlan(),
      log: () => {},
    });
    expect(stub.jobs.map((job) => job.id)).toContain("CUDA Toolkit");
  });

  it("keeps the opted-in CUDA Toolkit waiting when the plan refuses: no CUDA 12 driver, a low compute capability, no disk, or no plan", async () => {
    const refused: Array<[string, unknown, RegExp]> = [
      ["no CUDA 12 driver", gpuPlan({ cudaDriver: false }), /does not report CUDA 12/],
      [
        "low compute capability",
        gpuPlan(
          {},
          { skipped: [{ id: "cuda-libs", reason: "compute capability 6.1 is below 7.5" }] },
        ),
        /compute capability 6\.1/,
      ],
      ["no disk", gpuPlan({ diskFreeGb: 4 }), /not enough free disk space/],
      ["no card in the plan", gpuPlan({ gpu: null }), /no NVIDIA graphics card/],
      [
        "waiting line",
        gpuPlan({}, { required: [{ id: "cuda-libs", action: "defer" }] }),
        /better moment/,
      ],
      ["no plan", null, /plan could not be read/],
    ];
    for (const [label, plan, why] of refused) {
      const stub = fakeToolchain({ "NVIDIA Driver": "560.1" });
      const lines: string[] = [];
      const rows = await toolkit.prefetchToolkit("C:/friday", {
        ...win,
        env: { ...win.env, FRIDAY_PREFETCH_TOOLKIT_OPTIONAL: "1" },
        toolchain: stub,
        progressLine,
        plan,
        log: (l: string) => lines.push(l),
      });
      expect(
        stub.jobs.map((job) => job.id),
        label,
      ).not.toContain("CUDA Toolkit");
      expect(
        rows.find((row: { id: string }) => row.id === "CUDA Toolkit"),
        label,
      ).toMatchObject({
        ok: true,
        skipped: true,
      });
      expect(lines.join("\n"), label).toMatch(why);
    }
  });

  it("the CUDA Toolkit gate is pure and reads the plan of this PC, never the driver alone", () => {
    const entry = { approxBytes: 3 * 1024 ** 3 };
    expect(toolkit.cudaToolkitGate(gpuPlan(), entry)).toEqual({ ok: true, reason: "" });
    expect(toolkit.cudaToolkitGate(gpuPlan({ diskFreeGb: null }), entry).ok).toBe(true);
    expect(toolkit.cudaToolkitGate(gpuPlan({ diskFreeGb: 4 }), entry).ok).toBe(false);
    expect(toolkit.cudaToolkitGate(null, entry).ok).toBe(false);
    expect(toolkit.cudaToolkitGate({}, entry).ok).toBe(false);
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
    expect(lines.join("\n")).toContain("WSL 2 asks for a restart");
    // A restart asked for is a notice, not a failure: the later tools are still installed.
    expect(lines.join("\n")).toContain("RESTART WINDOWS once to finish: WSL 2");
    expect(stub.jobs.map((job) => job.id)).toContain("Docker Desktop");
  });

  it("turns a throwing install into a failed row and a notice-only step, never an uncaught crash", async () => {
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
    expect(toolkit.failureReport(rows).length).toBeGreaterThan(tried.length);
    // A tool that did not install is a notice: the step exits 0 unless the owner opts in to strict mode.
    expect(toolkit.strict({})).toBe(false);
    expect(toolkit.strict({ FRIDAY_PREFETCH_TOOLKIT_STRICT: "0" })).toBe(false);
    expect(toolkit.strict({ FRIDAY_PREFETCH_TOOLKIT_STRICT: "1" })).toBe(true);
    expect(toolkit.strict({ FRIDAY_SETUP_STRICT: "1" })).toBe(true);
  });

  it("records every tool that did not install as one notice, clears it when the tool verifies, and says so in one line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-toolnotice-"));
    try {
      const lines: string[] = [];
      const rows = [
        { id: "aria2", ok: false, error: "winget exploded" },
        { id: "Git", ok: true, downloaded: false },
      ];
      const recorded = toolkit.recordToolNotices(rows, {
        root: dir,
        log: (l: string) => lines.push(l),
      });
      expect(recorded.map((entry: { id: string }) => entry.id)).toEqual(["tool:aria2"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("NOTICE");
      expect(lines[0]).toContain("Not a stop");
      const file = JSON.parse(
        readFileSync(path.join(dir, "runtime", "setup-notices.json"), "utf8"),
      );
      expect(file.notices[0]).toMatchObject({
        id: "tool:aria2",
        kind: "tool",
        installManagerId: "aria2",
        repair: "npm run setup:toolkit",
      });
      toolkit.recordToolNotices([{ id: "aria2", ok: true, downloaded: true }], {
        root: dir,
        log: () => {},
      });
      const after = JSON.parse(
        readFileSync(path.join(dir, "runtime", "setup-notices.json"), "utf8"),
      );
      expect(after.notices).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves with exit 0 on a failed tool by default, and with exit 1 only in strict mode (source)", () => {
    const src = readFileSync(path.join(root, "scripts/prefetch-toolkit.cjs"), "utf8");
    expect(src).toContain("leave(lines.length && strict() ? 1 : 0)");
    expect(src).toContain("recordToolNotices(rows, { root: picked.root })");
    expect(src).toContain("if (strict()) for (const line of lines) console.error(line)");
  });

  it("tries a newer release once: a shadowed or finished update is not downloaded on the next run", async () => {
    const all = Object.fromEntries(
      manifest.prefetch.map((row: { id: string }) => [
        row.id,
        row.id === ".NET SDK" ? "10.0.100" : "1.0.0",
      ]),
    );
    const stub = fakeToolchain(all, { CMake: "2.0.0" });
    const lines: string[] = [];
    const run = () =>
      toolkit.prefetchToolkit("C:/friday", {
        ...win,
        toolchain: stub,
        progressLine,
        log: (l: string) => lines.push(l),
      });
    await run();
    expect(stub.jobs.map((job) => job.id)).toEqual(["CMake"]);
    // The scan still sees 1.0.0 afterwards: the older copy is first on PATH.
    expect(lines.join("\n")).toContain(
      "CMake 2.0.0 is installed, but 1.0.0 is found first on PATH",
    );
    lines.length = 0;
    await run();
    await run();
    expect(stub.jobs.map((job) => job.id)).toEqual(["CMake"]);
    expect(lines.join("\n")).toContain("CMake 1.0.0 works; 2.0.0 was tried before");
    // A still newer release is a new attempt.
    const next = fakeToolchain(all, { CMake: "3.0.0" });
    await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      toolchain: next,
      progressLine,
      log: () => {},
    });
    expect(next.jobs.map((job) => job.id)).toEqual(["CMake"]);
  });

  it("looks for no update at all when updates are off (Doctor and the build), and installs what is missing", async () => {
    const all = Object.fromEntries(
      manifest.prefetch.map((row: { id: string }) => [
        row.id,
        row.id === ".NET SDK" ? "10.0.100" : "1.0.0",
      ]),
    );
    delete all["Pandoc"];
    let asked = 0;
    const stub = fakeToolchain(all, { CMake: "2.0.0", Pandoc: "9.0.0" });
    stub.wingetUpgrades = async () => {
      asked += 1;
      return {};
    };
    await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      env: { ...win.env, FRIDAY_PREFETCH_TOOLKIT_UPDATE: "0" },
      toolchain: stub,
      progressLine,
      log: () => {},
    });
    expect(asked).toBe(0);
    expect(stub.jobs).toEqual([{ id: "Pandoc", action: "install", root: "C:/friday" }]);
    const build = readFileSync(path.join(root, "scripts/build-pipeline.cjs"), "utf8");
    expect(build).toContain('"scripts/prefetch-toolkit.cjs", ["--no-update"]');
    const check = readFileSync(path.join(root, "scripts/check-environment.cjs"), "utf8");
    expect(check).toMatch(/prefetch-toolkit\.cjs"\), "--no-update"\]/);
    const setup = readFileSync(path.join(root, "scripts/setup-windows.ps1"), "utf8");
    expect(setup).toContain("node.exe scripts\\prefetch-toolkit.cjs");
    expect(setup).not.toMatch(/prefetch-toolkit\.cjs --no-update/);
  });

  it("decides an update's outcome from what the next scan sees, and retries a failure after a day", () => {
    expect(toolkit.updateOutcome({ ok: true }, "2.0.0", "2.0.0")).toBe("installed");
    expect(toolkit.updateOutcome({ ok: true }, "2.0.0", "1.0.0")).toBe("shadowed");
    expect(toolkit.updateOutcome({ ok: true, upToDate: true }, "2.0.0", "1.0.0")).toBe("current");
    expect(toolkit.updateOutcome({ ok: true, vendorUpdateFailed: "x" }, "2.0.0", "1.0.0")).toBe(
      "failed",
    );
    expect(toolkit.updateOutcome({ ok: false }, "2.0.0", "1.0.0")).toBe("failed");
    const at = 1_000_000;
    const ledger = {
      A: { to: "2.0.0", outcome: "failed", at },
      B: { to: "2.0.0", outcome: "shadowed", at },
    };
    expect(toolkit.alreadyTried(ledger, "A", "2.0.0", at + 3_600_000)).toBeTruthy();
    expect(toolkit.alreadyTried(ledger, "A", "2.0.0", at + 25 * 3_600_000)).toBeNull();
    expect(toolkit.alreadyTried(ledger, "B", "2.0.0", at + 90 * 24 * 3_600_000)).toBeTruthy();
    expect(toolkit.alreadyTried(ledger, "B", "2.1.0", at)).toBeNull();
  });

  it("drops installer spinner frames and progress bars from the log", () => {
    const { tidyChunk } = require_(path.join(root, "electron/installer-output.cjs"));
    const chunk =
      "  -\r  \\\r  |\r  /\r  ██████▒▒▒▒  12.0 MB / 40.0 MB\r  ████████▒▒  32.0 MB / 40.0 MB\r\n" +
      "Successfully installed\r\nSuccessfully installed\r\n  100%\r\n";
    expect(tidyChunk(chunk)).toEqual(["Successfully installed"]);
    expect(tidyChunk("\x1b[1m\x1b[32mFound CMake [Kitware.CMake] Version 4.2.0\x1b[0m")).toEqual([
      "Found CMake [Kitware.CMake] Version 4.2.0",
    ]);
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
    expect(source).toContain('runNode("scripts/prefetch-toolkit.cjs", ["--no-update"], root)');
  });

  it("is also run by the Windows setup script, which notes an incomplete toolkit and stops only when strict", () => {
    const setup = readFileSync(path.join(root, "scripts/setup-windows.ps1"), "utf8");
    expect(setup).toContain("scripts\\prefetch-toolkit.cjs");
    expect(setup).toMatch(
      /prefetch-toolkit\.cjs\s*\r?\n\s*if \(\$LASTEXITCODE -ne 0\) \{ Stop-OrNotice /,
    );
    expect(setup).not.toMatch(
      /prefetch-toolkit\.cjs\s*\r?\n\s*if \(\$LASTEXITCODE -ne 0\) \{ Write-Host/,
    );
    // Stop-OrNotice is the stop: it throws when the strict switch is on and only prints a notice otherwise.
    const stopOrNotice = setup.match(/^function Stop-OrNotice\b[\s\S]*?^}\r?$/m)?.[0] ?? "";
    expect(stopOrNotice).toMatch(/if \(\$script:SetupStrict\) \{ throw /);
    expect(stopOrNotice).toContain("Write-Notice");
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

  it("is required where the setup installs it, repaired by npm run doctor and installed by npm run setup:toolkit", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["setup:toolkit"]).toBe("node scripts/prefetch-toolkit.cjs");
    expect(pkg.scripts["doctor"]).toBe("node scripts/doctor.cjs");
    const check = readFileSync(path.join(root, "scripts/check-environment.cjs"), "utf8");
    expect(check).toContain('group: "agent-toolkit"');
    // Required exactly where the setup would install it (not hosted CI, not offline, not switched off).
    expect(check).toContain("const toolsRequired");
    expect(check).toContain("prefetch-toolkit.cjs");
    expect(check).toContain("required: mustHave && !notApplicable");
    // --fix installs what is missing: the toolchain, Electron, Python, the models and the toolkit.
    expect(check).toContain("setup-windows.ps1");
    expect(check).toContain('"-ToolchainOnly"');
    expect(check).toContain('"prefetch-toolkit.cjs"');
    expect(check).toContain("npm run doctor");
  });
});

describe("a newer managed copy is used first", () => {
  const managedPath = require_(path.join(root, "electron/managed-path.cjs"));

  const entry = {
    probe: { cmd: ["pandoc.exe", "pandoc"], args: ["--version"], dirs: ["%PF%/Pandoc"] },
  };
  /** A PC with some folders holding a tool, each answering its own version. */
  const pc = (versions: Record<string, string>, pathDirs: string[]) => {
    const calls: string[] = [];
    const env: Record<string, string | undefined> = {
      PATH: pathDirs.join(path.delimiter),
      PF: "/prog",
    };
    return {
      calls,
      env,
      deps: {
        env,
        exists: (exe: string) => Object.keys(versions).some((dir) => exe.startsWith(dir)),
        run: (exe: string) => {
          const dir = Object.keys(versions).find((d) => exe.startsWith(d)) as string;
          return `pandoc ${versions[dir]}\nFeatures: +server`;
        },
        installedBin: () => null,
        managedPath: {
          preferManaged: (_r: string, dir: string) => (calls.push(dir), true),
          withFirstPath: managedPath.withFirstPath,
        },
      },
    };
  };

  it("puts the newest copy first when an older one is found first on PATH (two system copies)", () => {
    const user = path.join("/home", "u", "Pandoc");
    const machine = path.join("/prog", "Pandoc");
    const { deps, env, calls } = pc({ [user]: "3.12.1", [machine]: "3.13" }, [user, "/usr/bin"]);
    const best = toolkit.preferNewestCopy("/friday", entry, null, deps);
    expect(best).toMatchObject({ dir: machine, version: "3.13" });
    expect(calls).toEqual([machine]);
    expect(env["PATH"]?.split(path.delimiter)[0]).toBe(machine);
  });

  it("does nothing when the copy found first already is the newest, or there is only one copy", () => {
    const a = path.join("/a", "Pandoc");
    const b = path.join("/b", "Pandoc");
    const same = pc({ [a]: "3.13", [b]: "3.12.1" }, [a, b]);
    expect(toolkit.preferNewestCopy("/friday", entry, null, same.deps)).toBeNull();
    expect(same.calls).toEqual([]);
    const one = pc({ [a]: "3.13" }, [a]);
    expect(toolkit.preferNewestCopy("/friday", entry, null, one.deps)).toBeNull();
  });

  it("counts the managed copy under runtime as a candidate and survives a failing probe", () => {
    const system = path.join("/prog", "CMake", "bin");
    const managedDir = path.join("/friday", "runtime", "cmake", "bin");
    const cmake = { probe: { cmd: ["cmake.exe", "cmake"], args: ["--version"], dirs: [] } };
    const { deps, env } = pc({ [system]: "4.4.4", [managedDir]: "4.4.5" }, [system]);
    (deps as { installedBin: unknown }).installedBin = () => ({
      bin: path.join(managedDir, "cmake.exe"),
      version: "4.4.5",
    });
    (deps as { run: unknown }).run = (exe: string) => {
      if (exe.startsWith(managedDir)) return "cmake version 4.4.5";
      return "cmake version 4.4.4";
    };
    const best = toolkit.preferNewestCopy("/friday", cmake, { id: "CMake" }, deps);
    expect(best).toMatchObject({ dir: managedDir, version: "4.4.5" });
    expect(env["PATH"]?.split(path.delimiter)[0]).toBe(managedDir);
    const broken = pc({ [system]: "4.4.4" }, [system]);
    (broken.deps as { run: unknown }).run = () => {
      throw new Error("does not run");
    };
    expect(toolkit.preferNewestCopy("/friday", cmake, null, broken.deps)).toBeNull();
    expect(toolkit.preferNewestCopy("/friday", undefined, null, {})).toBeNull();
  });

  it("keeps the recorded front folders first on every later apply, and lists nothing twice", () => {
    expect(managedPath.withFirstPath("C:\\a;C:\\b;C:\\c", ["C:\\B", "C:\\x"], ";")).toBe(
      "C:\\B;C:\\x;C:\\a;C:\\c",
    );
    const dir = mkdtempSync(path.join(tmpdir(), "friday-first-"));
    try {
      const bin = path.join(dir, "runtime", "cmake", "bin");
      mkdirSync(bin, { recursive: true });
      expect(managedPath.preferManaged(dir, bin)).toBe(true);
      expect(managedPath.readFirst(dir)).toEqual([bin]);
      const env = { PATH: ["/usr/bin", "/opt/cmake/bin"].join(path.delimiter) };
      managedPath.applyManagedPath(dir, [], env);
      expect(env.PATH.split(path.delimiter)[0]).toBe(bin);
      // The list the kernel reads keeps the front folders after a later apply rewrites it.
      expect(managedPath.readFirst(dir)).toEqual([bin]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the toolkit log of a real setup run", () => {
  const win = { platform: "win32", env: { CI: "", GITHUB_ACTIONS: "" } };
  const installer = require_(path.join(root, "electron/installer-output.cjs"));

  it("prints one line per ten percent of an installer download, not one per chunk", async () => {
    const lines: string[] = [];
    const stub = {
      detectTools: async () => ({ tools: [] }),
      wingetUpgrades: async () => ({}),
      toolById: (id: string) => ({ id }),
      latestFor: async () => null,
      runJob: async (_job: unknown, emit: (e: unknown) => void) => {
        for (let p = 0; p <= 100; p += 1)
          emit({
            id: "Git",
            phase: "Downloading",
            percent: p,
            line: `Downloading Git ${p}%`,
            speedMbps: 8.4,
          });
        return { ok: true };
      },
    };
    await toolkit.prefetchToolkit("C:/friday", {
      ...win,
      ledger: toolkit.memoryLedger(),
      toolchain: stub,
      progressLine: () => "",
      log: (l: string) => lines.push(l),
    });
    const git = lines.filter((l) => /^\[friday\] Git +downloading \d+%/.test(l));
    expect(git.length).toBeGreaterThanOrEqual(9);
    expect(git.length).toBeLessThanOrEqual(11);
    expect(git[0]).toContain("MB/s");
    expect(lines.some((l) => /Downloading Git \d+%/.test(l))).toBe(false);
  });

  it("drops winget's boilerplate and the echo of the command that was run", () => {
    for (const line of [
      "No available upgrade found.",
      "No newer package versions are available from the configured sources.",
      "This application is licensed to you by its owner.",
      "Microsoft is not responsible for, nor does it grant any licenses to, third-party packages.",
      "[winget] winget upgrade --id Git.Git --silent --accept-package-agreements",
      "[vendor installer] powershell -NoProfile -ExecutionPolicy Bypass -Command $ErrorActionPreference='Stop'",
    ])
      expect(installer.tidyLine(line), line).toBe("");
    for (const line of [
      "Found PowerShell [Microsoft.PowerShell] Version 7.6.10.0",
      "Successfully verified installer hash",
      "Starting package install...",
      "Successfully installed",
    ])
      expect(installer.tidyLine(line), line).toBe(line);
  });

  it("shows the version number alone and names winget's well-known exit code in words", () => {
    expect(toolkit.shortVersion("9.0.2-full_build-www.gyan.dev")).toBe("9.0.2");
    expect(toolkit.shortVersion("2.56.0.windows.4")).toBe("2.56.0");
    expect(toolkit.shortVersion("")).toBe("");
    expect(toolchain.exitCodeText(2316632107)).toBe("winget: no newer version is available");
    expect(toolchain.exitCodeText(0x8a15002b)).toContain("no newer version");
    expect(toolchain.exitCodeText(5)).toBe("exit code 5");
  });

  it("raises no administrator prompt for an archive unpacked into FRIDAY's own folder", () => {
    const source = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(source).toMatch(/\["msi", "exe"\]\.includes\(String\(feed\.kind/);
  });
});

describe("toolkit log lines say what happens", () => {
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it("says nothing to fetch when every tool is here, instead of `0 to fetch (1 MB at most)`", () => {
    const src = read("scripts/prefetch-toolkit.cjs");
    expect(src).toContain("`[friday] agent toolkit: ${plan.length} tools, nothing to fetch`");
    expect(src).toMatch(
      /total\.length\s+\? `\[friday\] agent toolkit: \$\{plan\.length\} tools, \$\{total\.length\} to fetch/,
    );
  });

  it("unpacks an archive and places a .phar instead of claiming to run it", () => {
    const src = read("electron/toolchain.cjs");
    expect(src).toContain("/\\.(zip|7z|gz|tgz|tar)$/i.test(file)");
    expect(src).toContain('"unpacking"');
    expect(src).toContain('"placing"');
    expect(src).toContain("line: `${verb} ${path.basename(file)}`");
    expect(src).not.toContain("line: `running ${path.basename(file)}`");
  });
});
