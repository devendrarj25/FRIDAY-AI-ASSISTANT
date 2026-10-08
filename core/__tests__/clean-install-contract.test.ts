import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/**
 * Clean-install contract.
 *
 * A fresh Windows PC must be able to run `npm ci` → `npm test` →
 * `npm run build:desktop` → `npm run build:win` with one verified version set.
 * These assertions fail the build the moment the manifests drift apart.
 */
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  engines?: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/**
 * Minimal range check for the ranges this manifest actually uses
 * (`1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `*`). Deliberately dependency-free:
 * the clean-install contract must not itself rely on a transitive package.
 */
function satisfies(version: string, range: string): boolean {
  const parts = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((n) => Number(n) || 0);
  const cmp = (a: number[], b: number[]) =>
    a[0]! - b[0]! || a[1]! - b[1]! || (a[2] ?? 0) - (b[2] ?? 0);
  const spec = range.trim();
  if (!spec || spec === "*" || spec === "latest") return true;
  if (/^(https?:|file:|git|npm:|workspace:)/.test(spec)) return true;
  const m = /^([\^~>=]*)\s*v?(\d+\.\d+\.\d+[\w.-]*)$/.exec(spec);
  if (!m) return true; // complex ranges are out of scope for this contract
  const [, op, base] = m;
  const v = parts(version);
  const b = parts(base!);
  if (cmp(v, b) < 0) return false;
  if (op === "^") return b[0] === 0 ? v[0] === 0 && v[1] === b[1] : v[0] === b[0];
  if (op === "~") return v[0] === b[0] && v[1] === b[1];
  if (op === ">=") return true;
  return cmp(v, b) === 0;
}

describe("node toolchain version set", () => {
  it("declares the supported Node.js and npm range", () => {
    expect(pkg.engines?.["node"]).toBe(">=22.19.0");
    expect(pkg.engines?.["npm"]).toBe(">=10.9.0");
  });

  it("keeps the Node floor at or above undici's engine requirement", () => {
    const undici = JSON.parse(read("node_modules/undici/package.json")) as {
      engines?: { node?: string };
    };
    const ours = pkg.engines?.["node"] ?? "";
    const theirs = undici.engines?.node ?? "";
    expect(ours.startsWith(">=")).toBe(true);
    expect(theirs.startsWith(">=")).toBe(true);
    const oursMin = ours.replace(/[^0-9.]/g, "");
    const theirsMin = theirs.replace(/[^0-9.]/g, "");
    expect(satisfies(oursMin, `>=${theirsMin}`)).toBe(true);
  });

  it("uses the same Node.js and npm policy in Setup and Doctor", () => {
    const versions = JSON.parse(read("config/toolchain-versions.json")) as Record<string, string>;
    expect(pkg.engines?.["node"]).toBe(`>=${versions["nodeMinimum"]}`);
    expect(pkg.engines?.["npm"]).toBe(`>=${versions["npmMinimum"]}`);
    expect(read("scripts/check-environment.cjs")).toContain("nodeMinimum");
    expect(read("scripts/setup-windows.ps1")).toContain("nodeMinimum");
  });

  it("pins the build-critical toolchain to exact versions", () => {
    for (const name of ["electron-builder", "typescript", "vite", "vitest"]) {
      const version = pkg.devDependencies[name];
      expect(version, `${name} must be pinned`).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(pkg.devDependencies["electron"]).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it("never declares a package in both dependency sets", () => {
    const duplicates = Object.keys(pkg.dependencies).filter((n) => n in pkg.devDependencies);
    expect(duplicates).toEqual([]);
  });

  it("resolves every declared dependency in the lockfile (npm ci contract)", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const rootEntry = lock.packages[""] as unknown as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    const locked = { ...(rootEntry?.dependencies ?? {}), ...(rootEntry?.devDependencies ?? {}) };
    const drift: string[] = [];

    for (const [name, range] of Object.entries(declared)) {
      // 1. The lockfile's own manifest copy must repeat the exact range —
      //    this is precisely what `npm ci` compares and refuses to guess.
      if (locked[name] !== range) {
        drift.push(`${name}: package.json "${range}" vs lock manifest "${locked[name]}"`);
        continue;
      }
      // 2. A resolved tree entry must exist and satisfy that range.
      const installed = lock.packages[`node_modules/${name}`]?.version;
      if (!installed) {
        drift.push(`${name}: no resolved entry in the lockfile tree`);
        continue;
      }
      if (!satisfies(installed, range)) {
        drift.push(`${name}: locked ${installed} does not satisfy "${range}"`);
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps the lockfile in step with the pinned toolchain", () => {
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };
    for (const name of ["electron", "electron-builder", "typescript", "vite", "vitest"]) {
      if (name === "electron") {
        expect(lock.packages[`node_modules/${name}`]?.version).toMatch(/^\d+\.\d+\.\d+/);
      } else {
        expect(lock.packages[`node_modules/${name}`]?.version).toBe(pkg.devDependencies[name]);
      }
    }
  });

  it("never blocks npm install on an Electron binary download", () => {
    expect(pkg.scripts["postinstall"]).toBeUndefined();
    expect(pkg.scripts["setup:electron"]).toContain("ensure-electron.cjs");
    expect(pkg.scripts["doctor"]).not.toContain("ensure-electron");
  });

  it("allows Electron's trusted package installer during npm ci", () => {
    expect(read(".npmrc")).toContain("ignore-scripts=false");
    expect(read("node_modules/electron/install.js")).toContain("downloadArtifact");
  });

  it("provisions and resolves an isolated Python runtime for installed builds", () => {
    expect(read("installer/build/installer.nsh")).toContain("runtime\\.venv");
    expect(read("installer/build/repair-runtime.ps1")).toContain("kernel\\requirements.txt");
    expect(read("electron/python.cjs")).toContain(
      'path.dirname(process.execPath), "runtime", ".venv"',
    );
  });

  it("never aborts Setup over Python so the uninstaller is always registered", () => {
    const nsh = read("installer/build/installer.nsh");
    const install = nsh.slice(
      nsh.indexOf("!macro customInstall"),
      nsh.indexOf("!macro customUnInstall"),
    );
    expect(install).not.toMatch(/^\s*Abort\s*$/m);
    expect(install).toContain("PythonSetupPending");
  });

  it("supports idempotent reinstall repair without elevated user-state mismatch", () => {
    const builder = read("electron-builder.yml");
    const installer = read("installer/build/installer.nsh");
    const repair = read("installer/build/repair-runtime.ps1");
    expect(builder).toContain("perMachine: false");
    expect(installer).toContain("repair-runtime.ps1");
    expect(repair).toContain("if (Test-Runtime)");
    expect(repair).toContain("Finish 'ready' 0");
    expect(repair).toContain("function Install-CapabilityExtras");
    expect(repair).toContain("Remove-Item -LiteralPath $venvDir");
    expect(repair).toContain("--only-binary=:all:");
    expect(repair).toContain("import fastapi,uvicorn,httpx,pydantic,yaml");
    expect(repair).toContain("sqlite3.connect(':memory:')");
    expect(installer).toContain("!macro customInit");
    // Silent installs and upgrades never see the folder page: customInit must
    // establish the same one-root layout on its own.
    expect(installer).toContain('StrCpy $FridayRoot "$PROFILE\\FRIDAY"');
    expect(installer).toContain('StrCpy $INSTDIR "$FridayRoot\\App"');
  });

  it("isolates TEST install metadata and exercises real installer lifecycle in both workflows", () => {
    const installer = read("installer/build/installer.nsh");
    const testWorkflow = read(".github/workflows/test-build.yml");
    const releaseWorkflow = read(".github/workflows/release.yml");
    const prWorkflow = read(".github/workflows/pr-validation.yml");
    expect(installer).toContain('"${PRODUCT_NAME}" == "FRIDAY Test"');
    expect(installer).toContain('HKCU "Software\\FRIDAY Test" "InstallPath"');
    expect(testWorkflow).toContain("windows-installer-smoke.ps1");
    expect(releaseWorkflow).toContain("windows-installer-smoke.ps1");
    expect(prWorkflow).toContain("windows-installer-smoke.ps1");
    expect(prWorkflow).toContain("npm run lint");
  });

  it("uses the workspace selected by Setup after reinstall or repair", () => {
    const main = read("electron/main.cjs");
    const resolver = main.slice(
      main.indexOf("async function resolveWorkspaceRoot"),
      main.indexOf("function getWorkspaceRoot"),
    );
    expect(resolver.indexOf("readRegistryWorkspace()")).toBeLessThan(
      resolver.indexOf("readSettings().workspaceRoot"),
    );
    // Fresh Setup writes only the registry pointer. The window must not exist
    // until that pointer is applied, or the renderer asks for a folder while
    // the real root is still being resolved.
    const ready = main.slice(main.indexOf("app\n  .whenReady()"));
    const resolveAt = ready.indexOf("await resolveWorkspaceRoot()");
    const windowAt = ready.indexOf("createWindow()");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(windowAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(windowAt);
  });

  it("closes only the installed FRIDAY process tree before lifecycle changes", () => {
    const installer = read("installer/build/installer.nsh");
    const closer = read("installer/build/close-friday.ps1");
    expect(installer).toContain("customCheckAppRunning");
    expect(installer).toContain("close-friday.ps1");
    expect(closer).toContain("ExecutablePath");
    expect(closer).toContain("FRIDAY.exe");
    expect(closer).toContain("'/T'");
    expect(closer).toContain("FileShare]::None");
  });

  it("keeps every uninstaller symbol inside the BUILD_UNINSTALLER pass", () => {
    const nsh = read("installer/build/installer.nsh");
    const guard = nsh.indexOf("!ifdef BUILD_UNINSTALLER");
    expect(guard).toBeGreaterThan(0);
    // NSIS warning 6020 (fatal for electron-builder) fires when "un." code is
    // visible in the pass that packs, rather than writes, the uninstaller.
    const beforeGuard = nsh.slice(0, guard);
    expect(beforeGuard).not.toMatch(/^\s*Function\s+un\./m);
    expect(beforeGuard).not.toMatch(/UninstPage\s+custom/);
    expect(nsh.trimEnd().endsWith("!endif")).toBe(true);
    // The uninstall data decision still exists, and still defaults to keeping.
    expect(nsh).toContain("Delete all FRIDAY data too");
    expect(nsh).toContain("${NSD_SetState} $FridayUnDeleteData ${BST_UNCHECKED}");
    expect(nsh).toContain('StrCpy $FridayUnMode "keep"');
  });

  it("keeps the uninstall decision in dedicated variables, never scratch registers", () => {
    const nsh = read("installer/build/installer.nsh");
    const unInstall = nsh.slice(
      nsh.indexOf("!macro customUnInstall"),
      nsh.indexOf("; The uninstall welcome page"),
    );
    // $R6/$R7 are reused by electron-builder's own uninstaller code between the
    // welcome page and customUnInstall — that is what made "keep" delete data.
    expect(unInstall).not.toMatch(/\$R[0-9]/);
    expect(unInstall).toContain("$FridayUnMode");
    expect(unInstall).toContain("$FridayUnRoot");
  });

  it("keeps the data folder untouched unless delete was explicitly confirmed", () => {
    const nsh = read("installer/build/installer.nsh");
    const keepBranch = nsh.slice(
      nsh.indexOf("Keeping the FRIDAY data folder and its pointer"),
      nsh.indexOf("; Application-only leftovers"),
    );
    expect(keepBranch).not.toContain('RMDir /r "$FridayUnRoot');
    expect(keepBranch).not.toContain('DeleteRegValue HKCU "Software\\FRIDAY" "WorkspacePath"');
    // Only the confirmed delete path may remove the root.
    expect(nsh).toContain('StrCpy $FridayUnMode "delete"');
    expect(nsh).toContain('RMDir /r "$FridayUnRoot"');
  });

  it("leaves nothing of FRIDAY behind when delete-all is confirmed", () => {
    const nsh = read("installer/build/installer.nsh");
    for (const target of [
      'RMDir /r "$APPDATA\\FRIDAY"',
      'RMDir /r "$LOCALAPPDATA\\FRIDAY"',
      'RMDir /r "$LOCALAPPDATA\\Programs\\FRIDAY"',
      'RMDir /r "$LOCALAPPDATA\\friday-cache"',
      'RMDir /r "$LOCALAPPDATA\\friday-updater"',
      'DeleteRegKey HKCU "Software\\FRIDAY"',
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "FRIDAY"',
    ]) {
      expect(nsh, `${target} must be removed by a delete-all uninstall`).toContain(target);
    }
    // The program folder itself is swept after the uninstaller process exits.
    expect(nsh).toContain("Remove-Item -LiteralPath");
    expect(nsh).toContain("Start-Sleep -Seconds 6");
  });

  it("asks for one root folder and derives the program folder from it", () => {
    const nsh = read("installer/build/installer.nsh");
    const builder = read("electron-builder.yml");
    // Exactly one folder question: the stock directory page is off, FRIDAY's
    // own page is the single place a location is chosen.
    expect(builder).toContain("allowToChangeInstallationDirectory: false");
    expect(nsh).toContain("Where should FRIDAY live?");
    expect(nsh).toContain('WriteRegStr HKCU "Software\\FRIDAY" "WorkspacePath" "$FridayRoot"');
    expect(nsh).toContain('StrCpy $INSTDIR "$FridayRoot\\App"');
    // Existing installs store the database as friday.sqlite3 (legacy friday.db still counts).
    expect(nsh).toContain("$FridayRoot\\database\\friday.sqlite3");
    expect(nsh).toContain("$FridayRoot\\database\\friday.db");
    expect(nsh).toContain("${OrIf} ${FileExists}");
    // No second, independent data-folder prompt survives anywhere.
    expect(nsh).not.toContain("$FridayDataDir");
  });

  // NSIS treats "variable declared but never referenced" (warning 6001) as a
  // fatal error under electron-builder. The uninstall decision variables are
  // only ever referenced by un. code, so declaring them in the installer pass
  // broke every NSIS build. They must stay inside the uninstaller pass.
  it("declares the uninstall decision variables only in the uninstaller pass", () => {
    const nsh = read("installer/build/installer.nsh");
    const declaration = nsh.indexOf("Var FridayUnMode");
    expect(declaration).toBeGreaterThan(-1);
    const before = nsh.slice(0, declaration);
    const guard = before.lastIndexOf("!ifdef BUILD_UNINSTALLER");
    expect(guard).toBeGreaterThan(before.lastIndexOf("!endif"));
    const after = nsh.slice(declaration);
    expect(after.indexOf("!endif")).toBeLessThan(after.indexOf("!macro customUnInit"));
  });

  it("exposes the environment check used before a fresh build", () => {
    expect(pkg.scripts["check:env"]).toContain("check-environment.cjs");
  });

  it("exposes one idempotent Windows setup and final doctor", () => {
    expect(pkg.scripts["setup"]).toContain("setup-windows.ps1");
    expect(pkg.scripts["doctor"]).toContain("init-runtime.cjs");
    expect(pkg.scripts["doctor"]).toContain("check-environment.cjs");
    expect(pkg.scripts["doctor"]).toContain("verify-deps.cjs");
  });
});

describe("python requirement set", () => {
  const kernelReq = read("kernel/requirements.txt");

  it("keeps one canonical requirement list with compatibility floors", () => {
    expect(read("requirements.txt")).toContain("-r kernel/requirements.txt");
    expect(read("requirements.txt")).toContain("-r kernel/requirements-capabilities.txt");
    const pins = kernelReq
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(pins.length).toBeGreaterThan(0);
    // Floors, not exact pins: newer compatible releases must be accepted.
    for (const pin of pins) expect(pin, `${pin} must declare a minimum with >=`).toContain(">=");
    expect(kernelReq).not.toMatch(/^pydantic-core/m);
  });

  it("covers every package the kernel imports at startup", () => {
    for (const name of ["fastapi", "uvicorn", "httpx", "pydantic", "PyYAML"]) {
      expect(kernelReq).toMatch(new RegExp(`^${name}(\\[[^\\]]+\\])?>=`, "m"));
    }
  });

  it("declares the existing voice runtime floors without making numpy or chroma required", () => {
    expect(kernelReq).toMatch(/^faster-whisper>=/m);
    expect(kernelReq).toMatch(/^edge-tts>=/m);
    const pins = kernelReq
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(pins.some((pin) => pin.startsWith("numpy"))).toBe(false);
    expect(pins.some((pin) => pin.startsWith("chromadb"))).toBe(false);
    expect(pins.some((pin) => pin.startsWith("bleak"))).toBe(false);
    expect(pins.some((pin) => pin.startsWith("zeroconf"))).toBe(false);
  });

  it("declares capability extras in a second floors file the kernel already imports", () => {
    const caps = read("kernel/requirements-capabilities.txt");
    for (const name of [
      "numpy",
      "chromadb",
      "bleak",
      "zeroconf",
      "onnxruntime",
      "pymupdf",
      "Pillow",
      "pytesseract",
      "mss",
      "PyAutoGUI",
      "pywin32",
    ]) {
      expect(caps).toMatch(new RegExp(`^${name}>=`, "m"));
    }
    const capPins = caps
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    for (const pin of capPins) expect(pin, `${pin} must declare a minimum with >=`).toContain(">=");
    expect(caps).toContain('sys_platform == "win32"');
    expect(caps).toContain("Voice-stack rule");
    expect(caps).toContain("phonemizer");
    expect(caps).toContain("espeak-ng");
    expect(caps).toContain("faster-whisper");
    expect(caps).not.toMatch(/^torch/m);
    expect(caps).not.toMatch(/^piper-tts/m);
    expect(caps).not.toMatch(/^kokoro-onnx/m);
    expect(caps).not.toMatch(/^sherpa-onnx/m);
    expect(caps).not.toMatch(/^silero-vad/m);
    expect(caps).not.toMatch(/^vosk/m);
    expect(caps).not.toMatch(/^vllm/m);
  });

  it("installs Python packages from official PyPI wheels without a Rust toolchain", () => {
    const setup = read("scripts/setup-python.cjs");
    expect(setup).toContain("--only-binary=:all:");
    expect(setup).toContain("preferBinaryFirst");
    expect(setup).toContain("https://pypi.org/simple");
    expect(setup).not.toContain("cargo");
    expect(setup).toContain("targetVenvPython");
    expect(setup).toContain("restoreCheckoutCollisions");
    expect(setup).toContain("resolveKernelSource");
    expect(setup).toContain("faster_whisper");
    expect(setup).toContain("edge_tts");
    expect(setup).toContain("--load-probe");
    expect(setup).toContain("requirements-capabilities.txt");
    expect(setup).toContain("timeout: 120000");
  });
});

describe("multi-fallback installation", () => {
  it("gives Electron three official installation methods", () => {
    const guard = read("scripts/ensure-electron.cjs");
    expect(guard).toContain("Electron's official npm installer");
    expect(guard).toContain("official GitHub release archive");
    expect(guard).toContain("@electron/get");
    expect(guard).toContain("method failed:");
  });

  it("gives every Windows prerequisite an official fallback download", () => {
    const setup = read("scripts/setup-windows.ps1");
    for (const marker of [
      "https://nodejs.org/dist/index.json",
      "https://nodejs.org/dist/v",
      "https://www.python.org/ftp/python/",
      "git-for-windows/git",
      "PowerShell/PowerShell",
      "npm@latest",
      "curl.exe",
      "UB-Mannheim/tesseract",
      "aka.ms/vs/17/release/vc_redist.x64.exe",
      "registry.npmjs.org",
    ]) {
      expect(setup).toContain(marker);
    }
    expect(setup).toContain("method failed:");
    // Security must never be weakened to make a download succeed.
    expect(setup).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback/);
  });

  it("keeps powershell.exe scripts 7-bit ASCII so Windows PowerShell 5.1 can parse them", () => {
    // npm run setup launches `powershell.exe` (5.1), which reads -File as the
    // system ANSI code page unless a BOM is present. A UTF-8 em-dash (bytes
    // E2 80 94) becomes a stray quote in CP1252 and aborts the whole script
    // at parse time with Unexpected token '$(', before any download runs.
    const files = [
      "scripts/setup-windows.ps1",
      "scripts/sign-windows.ps1",
      "installer/build/install-python.ps1",
      "installer/build/repair-runtime.ps1",
      "scripts/windows-installer-smoke.ps1",
      "installer/build/close-friday.ps1",
    ];
    for (const file of files) {
      const buf = readFileSync(path.join(root, file));
      const high = [...buf].filter((b) => b > 127);
      expect(high, `${file} must be ASCII for powershell.exe`).toEqual([]);
    }
  });

  it("bootstraps pip from more than one official get-pip host", () => {
    const setup = read("scripts/setup-python.cjs");
    expect(setup).toContain("bootstrap.pypa.io/get-pip.py");
    expect(setup).toContain("pypa/get-pip");
    expect(setup).toContain("--retries");
    const repair = read("installer/build/repair-runtime.ps1");
    expect(repair).toContain("bootstrap.pypa.io/get-pip.py");
    expect(repair).toContain("pypa/get-pip");
    expect(repair).toContain("function Install-Pip");
  });

  it("retries npm ci inside the Windows pack script", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain("npm cache verify");
    expect(cmd).toContain("registry.npmjs.org");
  });

  it("installs CPython with python.org plus winget 3.13 and 3.12", () => {
    const runtime = read("scripts/python-runtime.cjs");
    expect(runtime).toContain("Python.Python.3.13");
    expect(runtime).toContain("Python.Python.3.12");
    expect(runtime).toContain("curl.exe");
    const helper = read("installer/build/install-python.ps1");
    expect(helper).toContain("curl.exe");
    expect(helper).toContain("Python.Python.3.13");
    expect(helper).toContain("function Install-WingetPython");
  });
});

describe("paths are portable", () => {
  it("uses no hardcoded drive or user paths in build and runtime scripts", () => {
    const files = [
      "scripts/build-windows.cmd",
      "scripts/setup-python.cjs",
      "scripts/check-environment.cjs",
      "scripts/ensure-electron.cjs",
      "electron-builder.yml",
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, `${file} must not hardcode a drive path`).not.toMatch(
        /[A-Z]:\\(?!Windows)[A-Za-z]/,
      );
      expect(source, `${file} must not hardcode a user profile`).not.toMatch(/Users\\[A-Za-z]/);
    }
  });
});

describe("environment check is actionable", () => {
  const script = read("scripts/check-environment.cjs");

  it("checks every pinned kernel package individually", () => {
    expect(script).toContain("kernel");
    expect(script).toContain("Python package: ");
    expect(script).toContain("importlib.metadata");
  });

  it("verifies the SQLite module the FRIDAY database needs", () => {
    expect(script).toContain("import sqlite3");
  });

  it("offers an idempotent automatic repair", () => {
    expect(script).toContain("--fix");
    expect(pkg.scripts["check:env:fix"]).toContain("--fix");
  });

  it("never ends on a generic failure line", () => {
    expect(script).not.toContain("required component(s) missing. Install them and re-run");
    expect(script).toContain("installed:");
    expect(script).toContain("required:");
    expect(script).toContain("source:");
  });

  it("is wired into the Windows build script", () => {
    const cmd = read("scripts/build-windows.cmd");
    expect(cmd).toContain('setup-python.cjs"');
    expect(cmd).toContain('init-runtime.cjs"');
    expect(cmd).toContain('check-environment.cjs" --fix');
  });

  it("probes and fills the same live venv the running app launches", () => {
    const pythonRuntime = read("scripts/python-runtime.cjs");
    const init = read("scripts/init-runtime.cjs");
    const env = read("scripts/check-environment.cjs");
    expect(pythonRuntime).toContain("friday-root.cjs");
    expect(pythonRuntime).toContain("targetVenvPython");
    expect(pythonRuntime).toContain("VOICE_PACKAGES");
    expect(pythonRuntime).toContain("faster-whisper");
    expect(pythonRuntime).toContain("edge-tts");
    expect(pythonRuntime).toContain("CAPABILITY_PACKAGES");
    expect(init).toContain("resolveVenvPython");
    expect(init).toContain("installBundledModel");
    expect(init).toContain("restoreCheckoutCollisions");
    expect(init).toContain("resolveKernelSource");
    expect(env).toContain("resolveVenvPython");
    expect(env).toContain("VOICE_PACKAGES");
    expect(env).toContain("CAPABILITY_PACKAGES");
    expect(env).toContain("requirements-capabilities.txt");
    expect(env).toContain("required: capability ? false : !voice || win");
    expect(read("installer/build/repair-runtime.ps1")).toContain("requirements-capabilities.txt");
    expect(read("installer/build/repair-runtime.ps1")).toContain(
      "function Install-CapabilityExtras",
    );
    expect(read("scripts/verify-build.cjs")).toContain("requirements-capabilities.txt");
    expect(read("scripts/setup-windows.ps1")).toContain("Gyan.FFmpeg");
    expect(read("scripts/setup-windows.ps1")).toContain("UB-Mannheim.TesseractOCR");
    expect(read("scripts/setup-windows.ps1")).toContain("Test-TesseractPresent");
  });
});

describe("uninstall data contract", () => {
  const nsh = read("installer/build/installer.nsh");
  const flow = read("electron/dev-workflow.cjs");

  it("keeps the data folder when the delete checkbox is not ticked", () => {
    // The only unconditional root deletion must sit inside the delete branch.
    const deleteBranch = nsh.slice(
      nsh.indexOf('${If} $FridayUnMode == "delete"'),
      nsh.indexOf('${Else}\n      DetailPrint "Keeping the FRIDAY data folder'),
    );
    expect(deleteBranch).toContain('RMDir /r "$FridayUnRoot"');
    expect(nsh.match(/RMDir \/r "\$FridayUnRoot"/g) || []).toHaveLength(1);
    expect(nsh).toContain('DeleteRegValue HKCU "Software\\FRIDAY" "InstallPath"');
  });

  it("rescues a data folder that lives inside the program folder before it is wiped", () => {
    expect(nsh).toContain("LAST-LINE DATA GUARD");
    expect(nsh).toContain('Rename "$FridayUnRoot" "$4"');
    expect(nsh).toContain('WriteRegStr HKCU "Software\\FRIDAY" "WorkspacePath" "$4"');
  });

  it("removes every trace only in delete mode", () => {
    expect(nsh).toContain('DeleteRegKey HKCU "Software\\FRIDAY"');
    expect(nsh).toContain("Remove-Item -LiteralPath");
  });

  it("cuts self-development branches from the fetched remote tip", () => {
    expect(flow).toContain('await git(["fetch", "--prune", remote, base], cwd)');
    expect(flow).toContain("const resolved = await resolveBase(cwd, base);");
    expect(flow).toContain('["checkout", "-b", branch, start]');
  });
});

describe("INSTALL.md owner command map", () => {
  it("names every Windows CMD pack and repair script that package.json exposes", () => {
    const install = read("INSTALL.md");
    const named = [
      "setup",
      "setup:python",
      "setup:electron",
      "init:runtime",
      "check:env",
      "check:env:fix",
      "doctor",
      "verify:env",
      "repair:env",
      "verify:boot",
      "verify:install",
      "build:win",
      "build:win:dir",
      "desktop:start",
      "desktop:dev",
      "clean:cache",
      "sign:win",
      "validate:local",
    ];
    for (const name of named) {
      expect(pkg.scripts[name], name).toBeTruthy();
      expect(install, name).toContain(`npm run ${name}`);
    }
    expect(install).toContain("scripts\\build-windows.cmd");
    expect(install).toContain("scripts\\install-python-deps.cmd");
    expect(install).toContain("git clone https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git");
    const releaseVersion = require(
      path.join(root, "scripts/release-engine.cjs"),
    ).readCanonicalIdentity({
      root,
    }).releaseVersion;
    expect(install).toContain(`release\\FRIDAY-Setup-${releaseVersion}.exe`);
  });
});
