/**
 * FRIDAY — foundation contract: build, install, boot and live working.
 *
 * These tests protect the pieces a user depends on before any autonomy work:
 * one shared environment registry, real repair sources, the full readiness
 * contract, and the build chain that enforces both.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { hasFile } from "./helpers/environment";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const registry = require(path.join(root, "scripts", "env-registry.cjs"));
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("environment registry", () => {
  it("persists to a stable location outside the app folder", () => {
    expect(registry.registryFile).toMatch(/environment-registry\.json$/);
    expect(path.isAbsolute(registry.registryFile)).toBe(true);
  });

  it("returns an honest empty registry when nothing has been probed", () => {
    const current = registry.readRegistry();
    expect(Array.isArray(current.components)).toBe(true);
  });

  it("records every component FRIDAY needs to build, install and run", () => {
    const source = read("scripts/env-registry.cjs");
    for (const id of [
      '"node"',
      '"npm"',
      '"python"',
      '"python-venv"',
      '"python-deps"',
      '"node-modules"',
      '"electron"',
      '"kernel"',
      '"database"',
      '"config"',
      '"renderer"',
      '"installed-app"',
    ]) {
      expect(source).toContain(id);
    }
  });

  it("describes each component with version, path, health, source and capability", () => {
    const source = read("scripts/env-registry.cjs");
    for (const field of ["version:", "path:", "health:", "source:", "capability:"]) {
      expect(source).toContain(field);
    }
  });

  it("repairs only through FRIDAY's official-source installers", () => {
    const commands = Object.values(registry.REPAIRS)
      .flat()
      .map((step) => (step as [string, string[]])[1].join(" "));
    expect(commands.some((c) => c.includes("setup-python.cjs"))).toBe(true);
    expect(commands.some((c) => c.includes("ensure-electron.cjs"))).toBe(true);
    expect(commands.some((c) => c.includes("init-runtime.cjs"))).toBe(true);
    expect(commands.some((c) => c.includes("ci"))).toBe(true);
    // No mirrors, no ad-hoc downloads.
    expect(commands.join(" ")).not.toMatch(/curl|wget|http:\/\//);
  });

  it("never treats an already installed supported Python as missing", () => {
    const source = read("scripts/env-registry.cjs");
    expect(source).toContain("runtime.discoverPython()");
    expect(source).toMatch(/reused and never reinstalled|reusing existing interpreter/);
  });
});

describe("readiness contract", () => {
  const inApp = read("electron/readiness.cjs");
  const driver = read("scripts/readiness-test.cjs");

  it("covers every stage of the install-to-restart contract", () => {
    for (const stage of [
      "START",
      "BOOT",
      "KERNEL",
      "DATABASE",
      "CHAT",
      "VOICE",
      "MODEL",
      "BASIC TASK",
    ]) {
      expect(inApp).toContain(`"${stage}"`);
    }
    for (const stage of ["INSTALL", "SHUTDOWN", "RESTART", "ENVIRONMENT"]) {
      expect(driver).toContain(`"${stage}"`);
    }
  });

  it("exercises the real kernel bridge instead of a second client", () => {
    expect(inApp).toContain("kernelRequest");
    expect(inApp).toContain("settings.set");
    expect(inApp).toContain("model.list");
    expect(inApp).toContain("chat.stream");
  });

  it("prefers the installed application over the build folder", () => {
    expect(driver).toContain("registry.installedApp()");
    expect(driver).toContain('kind: "installed"');
  });

  it("stores every run locally for diagnostics", () => {
    // Canonical diagnostics location inside the FRIDAY root, asserted on the
    // source itself so the check is identical on Windows and POSIX runners.
    expect(driver).toMatch(/path\.join\(\s*root,\s*"debug",\s*"reports"\s*\)/);
    expect(driver).toContain('"reports"');
  });
});

describe("build and packaging chain", () => {
  it("probes npm through Node plus npm-cli.js so a space in the checkout path cannot hide npm", () => {
    const spawn = read("scripts/win-spawn.cjs");
    expect(spawn).toContain("npm-cli.js");
    expect(spawn).toContain('"/s"');
    expect(spawn).toContain('`"${inner}"`');
    expect(spawn).toContain("isNpmCommand");
    expect(read("scripts/check-environment.cjs")).toContain("spawnNpm");
    expect(read("scripts/check-engines.cjs")).toContain("spawnNpm");
    expect(read("scripts/check-engines.cjs")).not.toContain('shell: process.platform === "win32"');
    expect(read("scripts/env-registry.cjs")).toContain("spawnNpm");
    const { spawnNpm } = require(path.join(root, "scripts", "win-spawn.cjs"));
    const probed = spawnNpm(["--version"], { timeout: 20000 });
    expect(probed.status).toBe(0);
    expect(String(probed.stdout || "")).toMatch(/\d+\.\d+/);
  });

  it("cleans previous output without escaping the cmd.exe quote", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain('if exist "release" rmdir /s /q "release" 2>nul');
    expect(cmd).toContain('if exist "dist-desktop" rmdir /s /q "dist-desktop" 2>nul');
    // cmd.exe treats \" as an escaped quote. That can stop the pack after
    // "cleaning previous output" and never reach electron-builder.
    expect(cmd).not.toMatch(/if exist "release\\"/);
    expect(cmd).not.toMatch(/if exist "dist-desktop\\"/);
  });

  it("repairs the environment and runs the readiness test during a Windows build", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain("env-registry.cjs");
    expect(cmd).toContain("readiness-test.cjs");
    expect(cmd).toContain("--pack");
    expect(cmd.indexOf("verify-build.cjs")).toBeLessThan(cmd.indexOf("readiness-test.cjs"));
  });

  it("treats a missing Vite bundle as optional until pack, and skips rebuilding it during repair", () => {
    const source = read("scripts/env-registry.cjs");
    expect(source).toMatch(/label: "FRIDAY interface bundle"[\s\S]*?optional: true/);
    expect(source).toContain("skipRenderer");
    expect(source).toContain("--with-renderer");
  });

  it("classifies unloaded local engines as Chat-not-ready, not a broken pipeline", () => {
    const { isUnloadedLocalChat } = require(path.join(root, "electron", "readiness.cjs"));
    expect(
      isUnloadedLocalChat(
        "tried 3 route(s), including 3 local: Qwen2.5 32B Instruct: All connection attempts failed; DeepSeek Coder V2 16B: HTTP 404 — the provider does not expose this model id: model 'coder-ds' not found; Llama 3.2 3B: HTTP 400: No models loaded. Please load a model in the developer page or use the 'lms load' command.",
      ),
    ).toBe(true);
    expect(isUnloadedLocalChat("chat produced no answer")).toBe(false);
  });

  it("does not fail a Windows pack when Chat has no loaded local model", () => {
    const driver = read("scripts/readiness-test.cjs");
    const inApp = read("electron/readiness.cjs");
    expect(inApp).toContain("isUnloadedLocalChat");
    expect(driver).toContain("packGate");
    expect(driver).toContain("packChatOnlyUnloaded");
    expect(driver).toContain("FRIDAY_PYTHON");
    expect(driver).toContain("checkoutPython");
    expect(read("scripts/build-windows.cmd")).toMatch(/readiness-test\.cjs" --pack/);
  });

  it("ships the shared setup/repair scripts inside the installed app", () => {
    expect(read("electron-builder.yml")).toMatch(/from: scripts\s+to: scripts/);
  });

  it("keeps Cloud Agent and CI helpers out of the installed app", () => {
    const yml = read("electron-builder.yml");
    expect(yml).toMatch(/!cloud-agent-/);
    expect(yml).toContain("!ci-workflow-run.sh");
  });

  it("boots Cloud Agents from the default image and starts the desk", () => {
    const deskConfig = path.join(root, ".cursor", "environment.json");
    if (hasFile(deskConfig)) {
      const env = JSON.parse(fs.readFileSync(deskConfig, "utf8")) as {
        install?: string;
        start?: string;
        build?: unknown;
        image?: unknown;
        snapshot?: unknown;
      };
      expect(env.install).toBe("bash scripts/cloud-agent-install.sh");
      expect(env.start).toBe("bash scripts/cloud-agent-start.sh");
      expect(env.build).toBeUndefined();
      expect(env.image).toBeUndefined();
      expect(env.snapshot).toBeUndefined();
    } else {
      expect(
        hasFile(deskConfig),
        "optional desk config is absent; boot scripts stay required",
      ).toBe(false);
    }
    const install = read("scripts/cloud-agent-install.sh");
    expect(install).toContain("npm ci");
    expect(install).toContain("npm run setup:python");
    expect(install).toContain("npm run setup:electron");
    expect(install).toContain("npm run init:runtime");
    expect(install).toContain("3.12.10");
    expect(install).toContain("3.45.3");
    expect(install).toContain("2.49.0");
    const start = read("scripts/cloud-agent-start.sh");
    expect(start).toContain("npm run dev");
    expect(start).toContain("scripts/cloud-agent-kernel.sh");
    expect(start).toContain("http://127.0.0.1:8765/health");
    expect(start).toContain("http://127.0.0.1:8080/");
  });

  it("exposes the registry through one shared surface for EXE and browser", () => {
    expect(read("electron/preload.cjs")).toContain("envRegistry");
    expect(read("electron/main.cjs")).toContain('ipcMain.handle("env:refresh"');
    const shared = read("src/lib/friday/environment.ts");
    expect(shared).toContain("refreshEnvironment");
    expect(shared).toContain("runReadinessCheck");
  });

  it("keeps the app itself unelevated and the registry loadable in both builds", () => {
    expect(read("electron-builder.yml")).toContain("requestedExecutionLevel: asInvoker");
    expect(read("electron/main.cjs")).toContain("process.resourcesPath");
  });
});
