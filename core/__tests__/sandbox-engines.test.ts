import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const engines = require("../../electron/sandbox-engines.cjs");

// Real, platform-correct locations: the same isolation contract has to hold on
// a Windows CI runner and on a POSIX developer machine.
const projectDir = path.join(os.tmpdir(), "friday-engine-project");

describe("sandbox isolation engines", () => {
  it("publishes a catalog with install sources for every non-builtin engine", () => {
    const catalog = engines.catalog();
    expect(catalog.length).toBeGreaterThanOrEqual(8);
    for (const engine of catalog) {
      expect(engine.id).toBeTruthy();
      expect(engine.isolation).toBeTruthy();
      if (!engine.builtin) expect((engine.install ?? []).length).toBeGreaterThan(0);
    }
  });

  it("wraps a command for the plain process engine unchanged", () => {
    const wrapped = engines.wrap("process", { command: "node -v", dir: projectDir });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.line).toBe("node -v");
  });

  it("falls back to the process engine for an unknown id", () => {
    const wrapped = engines.wrap("does-not-exist", { command: "echo hi", dir: projectDir });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.line).toContain("echo hi");
  });

  it("isolates container runs inside the project folder", () => {
    const wrapped = engines.wrap("docker", {
      command: "npm test",
      dir: projectDir,
      network: false,
    });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.isolated).toBe(true);
    expect(wrapped.line).toContain("docker run");
    expect(wrapped.line).toContain(projectDir);
    expect(wrapped.line).toContain("npm test");
  });

  it("keeps host PATH runtimes visible inside a bwrap wrap", () => {
    const wrapped = engines.wrap("bwrap", { command: "node -v", dir: projectDir, network: false });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.isolated).toBe(true);
    expect(wrapped.line).toContain("bwrap");
    expect(wrapped.line).toContain(projectDir);
    expect(wrapped.line).toContain("node -v");
  });
});

describe("windows feature installs request elevation for that command only", () => {
  it("flags WSL and Windows Sandbox as needing a UAC prompt, and nothing else", () => {
    const shapes = engines.ENGINES.map(
      (engine: { id: string; install?: { elevate?: boolean }[] }) => ({
        id: engine.id,
        elevated: (engine.install ?? []).some((source) => source.elevate),
      }),
    );
    const elevated = shapes
      .filter((s: { elevated: boolean }) => s.elevated)
      .map((s: { id: string }) => s.id);
    expect(elevated.sort()).toEqual(["windows-sandbox", "wsl"]);
    // winget-based engines keep their untouched, unelevated path.
    for (const id of ["docker", "podman", "sandboxie", "qemu", "deno", "venv", "process"]) {
      expect(elevated).not.toContain(id);
    }
  });

  it("reports a clear, honest status when the UAC prompt is declined", () => {
    expect(engines.DECLINED_MESSAGE).toMatch(/Admin permission declined/i);
    expect(engines.DECLINED_MESSAGE).toMatch(/Windows Features/i);
  });
});

describe("windows edition parsing (Home cannot run Windows Sandbox)", () => {
  it("treats EditionID Core* and ProductName Home as Home", () => {
    const home = engines.parseWindowsEdition({
      editionId: "Core",
      productName: "Windows 11 Home",
    });
    expect(home.home).toBe(true);
    expect(home.windowsSandboxEligible).toBe(false);
    expect(engines.isWindowsHome(home)).toBe(true);
    expect(engines.windowsSandboxSupported(home, "win32")).toBe(false);
  });

  it("allows Professional / Enterprise / Education SKUs", () => {
    const pro = engines.parseWindowsEdition({
      editionId: "Professional",
      productName: "Windows 11 Pro",
    });
    expect(pro.home).toBe(false);
    expect(pro.windowsSandboxEligible).toBe(true);
    expect(engines.windowsSandboxSupported(pro, "win32")).toBe(true);
  });

  it("fails closed when the SKU cannot be read on Windows", () => {
    const unknown = engines.parseWindowsEdition({ editionId: "", productName: "" });
    expect(unknown.windowsSandboxEligible).toBe(false);
    expect(engines.windowsSandboxSupported(unknown, "win32")).toBe(false);
  });
});

describe("sandbox engine ranking (one function)", () => {
  const ids = (opts: Record<string, unknown>) =>
    engines.rankEngines(opts).map((e: { id: string }) => e.id);

  it("orders Windows command engines docker > wsl > sandboxie > podman > venv > process", () => {
    const ranked = ids({
      platform: "win32",
      edition: { editionId: "Professional", windowsSandboxEligible: true, home: false },
      forCommands: true,
    });
    expect(ranked).not.toContain("windows-sandbox");
    expect(ranked).not.toContain("qemu");
    expect(ranked.indexOf("docker")).toBeLessThan(ranked.indexOf("wsl"));
    expect(ranked.indexOf("wsl")).toBeLessThan(ranked.indexOf("sandboxie"));
    expect(ranked.indexOf("sandboxie")).toBeLessThan(ranked.indexOf("podman"));
    expect(ranked.indexOf("podman")).toBeLessThan(ranked.indexOf("venv"));
    expect(ranked.indexOf("venv")).toBeLessThan(ranked.indexOf("process"));
  });

  it("excludes windows-sandbox entirely on Windows Home, including launch ranking", () => {
    const home = {
      editionId: "Core",
      productName: "Windows 11 Home",
      home: true,
      windowsSandboxEligible: false,
    };
    expect(ids({ platform: "win32", edition: home, forCommands: true })).not.toContain(
      "windows-sandbox",
    );
    expect(ids({ platform: "win32", edition: home, forCommands: false })).not.toContain(
      "windows-sandbox",
    );
  });

  it("keeps windows-sandbox first on Pro when ranking launch engines", () => {
    const ranked = ids({
      platform: "win32",
      edition: { editionId: "Professional", windowsSandboxEligible: true, home: false },
      forCommands: false,
    });
    expect(ranked[0]).toBe("windows-sandbox");
  });

  it("orders Linux command engines by isolation and omits Windows-only ids", () => {
    const ranked = ids({ platform: "linux", edition: null, forCommands: true });
    expect(ranked).not.toContain("windows-sandbox");
    expect(ranked).not.toContain("wsl");
    expect(ranked).not.toContain("sandboxie");
    expect(ranked.indexOf("docker")).toBeLessThan(ranked.indexOf("firejail"));
    expect(ranked.indexOf("firejail")).toBeLessThan(ranked.indexOf("podman"));
    expect(ranked.indexOf("podman")).toBeLessThan(ranked.indexOf("bwrap"));
    expect(ranked.indexOf("bwrap")).toBeLessThan(ranked.indexOf("venv"));
    expect(ranked.indexOf("venv")).toBeLessThan(ranked.indexOf("process"));
  });
});

describe("auto-select + fallback + cache", () => {
  const home = {
    editionId: "Core",
    productName: "Windows 11 Home",
    home: true,
    windowsSandboxEligible: false,
  };
  const cacheFile = () =>
    path.join(os.tmpdir(), `friday-engine-cache-${Date.now()}-${Math.random()}.json`);

  afterEach(() => {
    engines.clearSelectionCache();
  });

  it("never probes or installs windows-sandbox on Windows Home", async () => {
    const probed: string[] = [];
    const installed: string[] = [];
    const result = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: true,
      skipCache: true,
      probe: (engine: { id: string }) => {
        probed.push(engine.id);
        return {
          ready: engine.id === "process",
          installed: engine.id === "process",
          detail: `${engine.id} fake`,
        };
      },
      installEngine: async (id: string) => {
        installed.push(id);
        return { ok: false, error: `${id} install refused in test` };
      },
    });
    expect(probed).not.toContain("windows-sandbox");
    expect(installed).not.toContain("windows-sandbox");
    expect(result.isolated).toBe(false);
    expect(result.warning).toMatch(/No OS isolation engine is available/i);
    expect(result.warning).toMatch(/docker:/);
    expect(result.id).toMatch(/^(venv|process)$/);
  });

  it("selects the first isolated engine whose existing probe succeeds", async () => {
    const result = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: false,
      skipCache: true,
      probe: (engine: { id: string }) => ({
        ready: engine.id === "sandboxie" || engine.id === "process",
        installed: engine.id === "sandboxie" || engine.id === "process",
        detail: `${engine.id} ready`,
      }),
    });
    expect(result.id).toBe("sandboxie");
    expect(result.isolated).toBe(true);
    expect(result.source).toBe("probe");
    expect(result.warning).toBeNull();
  });

  it("walks to the next engine when install fails, and only trusts a passing re-probe", async () => {
    const installed: string[] = [];
    const result = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: true,
      skipCache: true,
      probe: (engine: { id: string }) => ({
        ready: engine.id === "sandboxie" && installed.includes("sandboxie"),
        installed: installed.includes(engine.id),
        detail: installed.includes(engine.id) ? `${engine.id} ready` : `${engine.id} missing`,
      }),
      installEngine: async (id: string) => {
        installed.push(id);
        if (id === "docker" || id === "wsl") return { ok: false, error: `${id} failed on purpose` };
        if (id === "sandboxie") return { ok: true };
        return { ok: false, error: `${id} skipped` };
      },
    });
    expect(installed[0]).toBe("docker");
    expect(installed).toContain("wsl");
    expect(installed).toContain("sandboxie");
    expect(result.id).toBe("sandboxie");
    expect(result.source).toBe("install");
    expect(result.isolated).toBe(true);
    expect(
      result.attempts.some((a: { id: string; error?: string }) => a.id === "docker" && a.error),
    ).toBe(true);
  });

  it("does not claim success when install returns ok but the re-probe fails", async () => {
    const result = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: true,
      skipCache: true,
      probe: (engine: { id: string }) => ({
        ready: engine.id === "process",
        installed: engine.id === "process",
        detail: engine.id === "process" ? "built in" : "still missing",
      }),
      installEngine: async (id: string) => ({ ok: true, engine: { id } }),
    });
    expect(result.isolated).toBe(false);
    expect(
      result.attempts.some((a: { error?: string }) => /re-probe failed/i.test(a.error || "")),
    ).toBe(true);
  });

  it("reuses a cached isolated engine only while its own probe still succeeds", async () => {
    const file = cacheFile();
    fs.writeFileSync(
      file,
      JSON.stringify({ id: "docker", platform: "win32", isolated: true, at: Date.now() }),
      "utf8",
    );
    const probed: string[] = [];
    const hit = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: false,
      cacheFile: file,
      probe: (engine: { id: string }) => {
        probed.push(engine.id);
        return { ready: engine.id === "docker", installed: true, detail: "docker ok" };
      },
    });
    expect(hit.id).toBe("docker");
    expect(hit.cached).toBe(true);
    expect(probed).toEqual(["docker"]);

    const stale = await engines.selectBestEngine({
      platform: "win32",
      edition: home,
      allowInstall: false,
      cacheFile: file,
      probe: (engine: { id: string }) => ({
        ready: engine.id === "process",
        installed: engine.id === "process",
        detail: engine.id === "docker" ? "docker died" : "fallback",
      }),
    });
    expect(stale.id).not.toBe("docker");
    expect(stale.cached).toBe(false);
    expect(stale.isolated).toBe(false);
    try {
      fs.unlinkSync(file);
    } catch {
      /* tmp */
    }
  });

  it("marks process wrap as not OS-isolated", () => {
    const wrapped = engines.wrap("process", { command: "node -v", dir: projectDir });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.isolated).toBe(false);
    expect(engines.wrap("docker", { command: "node -v", dir: projectDir }).isolated).toBe(true);
  });

  it("does not treat Windows container mode as able to run Linux images", () => {
    expect(engines.containerOsBlocksLinuxImages("windows")).toBe(true);
    expect(engines.containerOsBlocksLinuxImages("windows/amd64")).toBe(true);
    expect(engines.containerOsBlocksLinuxImages('"windows"')).toBe(true);
    expect(engines.containerOsBlocksLinuxImages(" linux ")).toBe(false);
    expect(engines.containerOsBlocksLinuxImages("")).toBe(false);
    expect(engines.engineForCommand("venv")).toBe("process");
    expect(engines.engineForCommand("venv", { python: true })).toBe("venv");
    expect(engines.engineForCommand("docker")).toBe("docker");
    expect(engines.engineForCommand("")).toBe("process");
    const utf16 = Buffer.from("Windows Subsystem\n", "utf16le");
    expect(engines.decodeOutput(utf16)).toBe("Windows Subsystem\n");
    expect(engines.decodeOutput(Buffer.from("plain"))).toBe("plain");
    const wsl = engines.ENGINES.find((engine: { id: string }) => engine.id === "wsl");
    expect(wsl.ready.args.join(" ")).toContain("echo");
    expect(wsl.probe.args).toContain("--status");
  });
});
