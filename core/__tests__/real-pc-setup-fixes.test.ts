/**
 * Fixes from the owner's own Windows PC log (npm run setup, build:win, doctor):
 * Windows Sandbox on Home counted as a failed install, winget "no upgrade" shown as
 * "updated", Rust reported installed without a compiler, and tools that setup had
 * just installed reported missing by Doctor because the console kept its old PATH.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
// Git on Windows checks files out with CRLF; the checks below match across lines.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const winPath = require_(path.join(root, "scripts/win-path.cjs"));
const { toolkitPlan, prefetchToolkit } = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));

describe("the console PATH is refreshed from the registry", () => {
  it("keeps the session entries first and adds the registry ones once", () => {
    expect(winPath.mergePaths("C:\\a;C:\\b\\", "c:\\B;C:\\c;;C:\\a\\")).toBe("C:\\a;C:\\b;C:\\c");
  });

  it("adds a directory winget wrote to the registry and reports the change", () => {
    const env: Record<string, string> = { Path: "C:\\old" };
    const changed = winPath.refreshWindowsPath(env, () => "C:\\Users\\x\\WinGet\\Links", "win32");
    expect(changed).toBe(true);
    expect(env["Path"]).toBe("C:\\old;C:\\Users\\x\\WinGet\\Links");
    expect(winPath.refreshWindowsPath(env, () => "C:\\old", "win32")).toBe(false);
  });

  it("does nothing off Windows or when the registry cannot be read", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    expect(winPath.refreshWindowsPath(env, () => "C:\\x", "linux")).toBe(false);
    expect(winPath.refreshWindowsPath(env, () => "", "win32")).toBe(false);
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("runs before Doctor, the environment check and the toolchain script look for a tool", () => {
    expect(read("scripts/check-environment.cjs")).toContain("refreshWindowsPath()");
    expect(read("scripts/doctor.cjs")).toContain("refreshWindowsPath()");
    const setup = read("scripts/setup-windows.ps1");
    expect(setup.indexOf("Refresh-Path\n  Write-Step 'Preparing")).toBeGreaterThan(-1);
    // The session PATH is merged, not replaced.
    expect(setup).toContain('(("$env:Path;$machine;$user") -split');
  });
});

describe("Windows Sandbox on a Home edition", () => {
  const toolchain = read("electron/toolchain.cjs");

  it("carries the unsupported flag from the detector into the scan row", () => {
    expect(toolchain).toContain("...(found.unsupported ? { unsupported: true } : {})");
  });

  it("is skipped by the toolkit plan, not tried and failed", () => {
    const plan = toolkitPlan({
      detected: {
        "Sandbox runner (Windows Sandbox)": {
          installed: false,
          unsupported: true,
          manual: "not available on this Windows edition (Microsoft Windows 11 Home)",
        },
      },
      entries: [
        { id: "Sandbox runner (Windows Sandbox)", why: "x", approxBytes: 1, elevated: true },
      ],
    });
    expect(plan[0].action).toBe("skip");
    expect(plan[0].note).toContain("Windows 11 Home");
  });
});

describe("winget results are reported as they are", () => {
  it("names the winget exit codes and flags an update that changed nothing", () => {
    const toolchain = read("electron/toolchain.cjs");
    expect(toolchain).toContain("const WINGET_NO_UPGRADE = 2316632107");
    expect(toolchain).toContain("const WINGET_NOT_MANAGED = 2316632084");
    expect(toolchain).toContain("upToDate: true");
    expect(toolchain).toContain("outsideWinget: true");
  });

  it("does not print 'updated' when winget had nothing newer", async () => {
    const lines: string[] = [];
    const rows = await prefetchToolkit("C:\\friday", {
      env: { FRIDAY_PREFETCH: "1" },
      platform: "win32",
      log: (line: string) => lines.push(line),
      progressLine: () => "",
      toolchain: {
        detectTools: async () => ({
          tools: [
            { id: "yq (YAML)", installed: true, version: "4.53.6" },
            { id: "Git LFS", installed: true, version: "3.7.1" },
          ],
        }),
        wingetUpgrades: async () => ({}),
        toolById: (id: string) => ({ id }),
        latestFor: async (tool: { id: string }) => (tool.id === "yq (YAML)" ? "4.54.1" : "3.8.1"),
        runJob: async (job: { id: string }) =>
          job.id === "yq (YAML)"
            ? { ok: true, code: 2316632107, upToDate: true }
            : { ok: true, code: 2316632084, outsideWinget: true },
      },
    });
    const text = lines.join("\n");
    expect(rows.every((row: { ok: boolean }) => row.ok)).toBe(true);
    expect(text).toContain(
      "yq (YAML) 4.53.6 is the newest version winget offers; 4.54.1 is not in winget yet",
    );
    expect(text).toContain("Git LFS 3.7.1 was not installed by winget; left as it is");
    expect(text).not.toContain("yq (YAML) updated");
    expect(text).not.toContain("Git LFS updated");
  });
});

describe("Rust counts as installed only when rustc runs", () => {
  const toolchain = read("electron/toolchain.cjs");

  it("needs the compiler and adds the stable toolchain after winget installs rustup", () => {
    const rust = toolchain.slice(toolchain.indexOf('T("Rust"'), toolchain.indexOf('T("Go"'));
    expect(rust).toContain("requireCommand: true");
    expect(rust).toContain('postInstall: "rustup-stable"');
    expect(rust).toContain('".cargo"');
    expect(toolchain).toContain('["default", "stable"]');
    expect(toolchain).toContain('["update", "stable"]');
    // The winget package list is not proof for such a tool (it listed rustup's own version).
    expect(toolchain).toContain("!bin && !tool.requireCommand ? wingetPackage");
  });
});

describe("Rust is found wherever winget left it", () => {
  const toolchain = require_(path.join(root, "electron/toolchain.cjs"));

  it("looks in winget's link and package folders and in cargo's own folder", () => {
    const list = toolchain.rustupInitCandidates({
      env: { LOCALAPPDATA: "C:\\L", CARGO_HOME: "C:\\cargo" },
      home: "C:\\U",
      readdir: () => ["Rustlang.Rustup_Microsoft.Winget.Source_8wekyb3d8bbwe", "Other.Tool_x"],
    });
    expect(list.some((file: string) => /WinGet.Links.rustup-init\.exe$/.test(file))).toBe(true);
    expect(
      list.some((file: string) => /Packages.Rustlang\.Rustup_.*rustup-init\.exe$/.test(file)),
    ).toBe(true);
    expect(list.some((file: string) => /Other\.Tool/.test(file))).toBe(false);
    expect(list.at(-1)).toMatch(/cargo.bin.rustup-init\.exe$/);
  });

  it("finishes a rustup that is already here in place, with nothing to download", () => {
    const source = read("electron/toolchain.cjs");
    expect(source).toContain("const tryExisting = async () => {");
    expect(source).toContain("rustup is already on this PC — using it, nothing to download");
    // It goes first, so an update is `rustup update stable` and not a second installer download.
    expect(source).toMatch(/for \(const step of \[\s*tryExisting,/);
  });

  it("uses the launcher it finds when it is not on PATH", () => {
    const source = read("electron/toolchain.cjs");
    expect(source).toContain("rustupInitCandidates().find((file) => fs.existsSync(file))");
  });
});

describe("an update comes from the vendor when winget is behind", () => {
  const inventory = require_(path.join(root, "electron/install-inventory.cjs"));

  it("sees Git's fourth number and Go's patch release as newer", () => {
    expect(inventory.newer("2.56.0.windows.4", "2.56.0.windows.3")).toBe(true);
    expect(inventory.newer("1.27.3", "1.27.0")).toBe(true);
    expect(inventory.newer("1.27.0", "1.27.0")).toBe(false);
    expect(inventory.newer("4.54.1", "4.54.1")).toBe(false);
  });

  it("goes on to the official installer after winget's 'nothing newer', and keeps the old copy if it fails", () => {
    const source = read("electron/toolchain.cjs");
    expect(source).toContain(
      'if (action === "update" && last.upToDate && vendorFeeds.hasFeed(tool.id))',
    );
    expect(source).toContain("inventory.newer(feed.version, last.probe.version)");
    expect(source).toContain("keptCurrent = finished");
    expect(source).toContain("vendorUpdateFailed");
    // A downloaded .msi asks for administrator rights once, the way winget does.
    expect(source).toContain("/^msiexec(\\.exe)?$/i.test(String(cmd[0]))");
  });

  it("reports an update the official installer could not finish as kept, not as a failure", async () => {
    const lines: string[] = [];
    const rows = await prefetchToolkit("C:\\friday", {
      env: { FRIDAY_PREFETCH: "1" },
      platform: "win32",
      log: (line: string) => lines.push(line),
      progressLine: () => "",
      toolchain: {
        detectTools: async () => ({
          tools: [
            { id: "Go", installed: true, version: "1.27.0" },
            { id: "CUDA Toolkit", installed: true, version: "" },
            { id: "NVIDIA Driver", installed: true, version: "570" },
          ],
        }),
        wingetUpgrades: async () => ({}),
        toolById: (id: string) => ({ id }),
        latestFor: async () => "1.27.3",
        runJob: async () => ({
          ok: true,
          code: 2316632107,
          upToDate: true,
          vendorUpdateFailed: "vendor installer (exit 1603)",
        }),
      },
    });
    const text = lines.join("\n");
    expect(rows.find((row: { id: string }) => row.id === "Go")).toMatchObject({ ok: true });
    expect(text).toContain(
      "Go 1.27.0 stays installed; 1.27.3 is out but its official installer did not finish",
    );
    expect(text).toContain("CUDA Toolkit already installed; not downloaded again");
    expect(text).not.toContain("installed already installed");
  });
});
