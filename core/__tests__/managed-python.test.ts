import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { createRequire } from "node:module";

const repo = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const python = require_(join(repo, "electron/python.cjs"));
const project = require_(join(repo, "electron/project.cjs"));
const extract = require_(join(repo, "electron/document-extract.cjs"));

const WIN32 = { path: path.win32, win32: true as const };
const HOST_WIN = process.platform === "win32";
const WIN_RUNTIME = "D:\\FRIDAY\\runtime\\.venv\\Scripts\\python.exe";
const WIN_LEGACY = "D:\\FRIDAY\\.venv\\Scripts\\python.exe";

function venvInterpreter(parentDir: string): string {
  return HOST_WIN
    ? join(parentDir, ".venv", "Scripts", "python.exe")
    : join(parentDir, ".venv", "bin", "python");
}

function plantUnixVenv(parentDir: string): string {
  const exe = venvInterpreter(parentDir);
  mkdirSync(path.dirname(exe), { recursive: true });
  if (HOST_WIN) {
    writeFileSync(exe, "");
    return exe;
  }
  writeFileSync(exe, "#!/bin/sh\nexit 0\n");
  chmodSync(exe, 0o755);
  return exe;
}

type DatabaseResult = {
  ok: boolean;
  integrity?: string;
  tables?: string[];
  log: string[];
};

function withoutFridayPython<T>(fn: () => T): T {
  const prev = process.env["FRIDAY_PYTHON"];
  delete process.env["FRIDAY_PYTHON"];
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["FRIDAY_PYTHON"];
    else process.env["FRIDAY_PYTHON"] = prev;
  }
}

async function withoutFridayPythonAsync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["FRIDAY_PYTHON"];
  delete process.env["FRIDAY_PYTHON"];
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["FRIDAY_PYTHON"];
    else process.env["FRIDAY_PYTHON"] = prev;
  }
}

describe("Windows interpreter probes", () => {
  it("does not spawn the Windows Store python alias", () => {
    expect(
      python.isWindowsStoreAlias(
        "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
      ),
    ).toBe(true);
    expect(
      python.skipUnusableInterpreter(
        "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
      ),
    ).toBe(true);
    expect(python.isWindowsStoreAlias("C:\\Python312\\python.exe")).toBe(false);
  });
});

describe("managed Python path helpers (path.win32)", () => {
  it("returns <root>/runtime/.venv/Scripts/python.exe for a Windows FRIDAY folder", () => {
    expect(python.runtimeVenvPython("D:\\FRIDAY", WIN32)).toBe(WIN_RUNTIME);
    expect(python.venvPython("D:\\FRIDAY", WIN32)).toBe(WIN_LEGACY);
  });

  it("prefers runtime/.venv when both interpreters exist", () => {
    const picked = python.resolveManagedPython("D:\\FRIDAY", {
      ...WIN32,
      existsSync: (file: string) => file === WIN_RUNTIME || file === WIN_LEGACY,
    });
    expect(picked.exe).toBe(WIN_RUNTIME);
    expect(picked.source).toBe("runtime");
    expect(picked.tried).toEqual([WIN_RUNTIME]);
  });

  it("falls back to legacy <root>/.venv when runtime is missing", () => {
    const picked = python.resolveManagedPython("D:\\FRIDAY", {
      ...WIN32,
      existsSync: (file: string) => file === WIN_LEGACY,
    });
    expect(picked.exe).toBe(WIN_LEGACY);
    expect(picked.source).toBe("legacy");
    expect(picked.tried).toEqual([WIN_RUNTIME, WIN_LEGACY]);
    expect(picked.reason).toContain(WIN_RUNTIME);
  });

  it("returns null and lists both paths when neither interpreter exists", () => {
    const picked = python.resolveManagedPython("D:\\FRIDAY", {
      ...WIN32,
      existsSync: () => false,
    });
    expect(picked.exe).toBeNull();
    expect(picked.source).toBeNull();
    expect(picked.tried).toEqual([WIN_RUNTIME, WIN_LEGACY]);
    expect(picked.reason).toContain(WIN_RUNTIME);
    expect(picked.reason).toContain(WIN_LEGACY);
  });
});

describe("ensureDatabase interpreter (mocked FRIDAY root)", () => {
  it("resolveDatabasePython prefers workspace runtime over workspace legacy", () => {
    const fridayRoot = mkdtempSync(join(tmpdir(), "friday-venv-pref-"));
    try {
      const runtimePy = plantUnixVenv(join(fridayRoot, "runtime"));
      plantUnixVenv(fridayRoot);
      const picked = withoutFridayPython(() =>
        project.resolveDatabasePython({ root: fridayRoot, install: repo }),
      );
      expect(picked.exe).toBe(runtimePy);
      expect(picked.source).toBe("workspace:runtime");
      expect(picked.tried[0]).toBe(venvInterpreter(join(fridayRoot, "runtime")));
    } finally {
      rmSync(fridayRoot, { recursive: true, force: true });
    }
  });

  it("resolveDatabasePython uses workspace legacy .venv when runtime is absent", () => {
    const fridayRoot = mkdtempSync(join(tmpdir(), "friday-venv-legacy-"));
    try {
      const legacyPy = plantUnixVenv(fridayRoot);
      const picked = withoutFridayPython(() =>
        project.resolveDatabasePython({ root: fridayRoot, install: repo }),
      );
      expect(picked.exe).toBe(legacyPy);
      expect(picked.source).toBe("workspace:legacy");
      expect(picked.tried).toContain(venvInterpreter(join(fridayRoot, "runtime")));
      expect(picked.reason).toMatch(/runtime interpreter not found/);
    } finally {
      rmSync(fridayRoot, { recursive: true, force: true });
    }
  });

  it("resolveDatabasePython picks a Windows runtime path from a mocked root", () => {
    const picked = withoutFridayPython(() =>
      project.resolveDatabasePython(
        { root: "D:\\FRIDAY" },
        {
          ...WIN32,
          existsSync: (file: string) => file === WIN_RUNTIME,
        },
      ),
    );
    expect(picked.exe).toBe(WIN_RUNTIME);
    expect(picked.source).toBe("workspace:runtime");
  });

  it("resolveDatabasePython records tried runtime+legacy then system when the folder has no venv", () => {
    const fridayRoot = mkdtempSync(join(tmpdir(), "friday-venv-none-"));
    const emptyInstall = mkdtempSync(join(tmpdir(), "friday-venv-app-"));
    try {
      writeFileSync(join(emptyInstall, "package.json"), JSON.stringify({ name: "scratch" }));
      const picked = withoutFridayPython(() =>
        project.resolveDatabasePython(
          { root: fridayRoot, install: emptyInstall },
          { existsSync: () => false },
        ),
      );
      const system = HOST_WIN ? "python" : "python3";
      expect(picked.exe).toBe(system);
      expect(picked.source).toBe("system");
      expect(picked.tried).toContain(venvInterpreter(join(fridayRoot, "runtime")));
      expect(picked.tried).toContain(venvInterpreter(fridayRoot));
      expect(picked.reason).toMatch(/no managed interpreter/);
      expect(picked.reason).toMatch(new RegExp(`using system ${system}`));
    } finally {
      rmSync(fridayRoot, { recursive: true, force: true });
      rmSync(emptyInstall, { recursive: true, force: true });
    }
  });

  it("ensureDatabase runs SCHEMA with the workspace runtime interpreter, not legacy .venv", async () => {
    const base = mkdtempSync(join(tmpdir(), "friday-db-py-"));
    const fridayRoot = join(base, "MyFRIDAY");
    const userData = join(base, "userdata");
    const marker = join(base, "used-python.txt");
    mkdirSync(userData, { recursive: true });

    const runtimePy = venvInterpreter(join(fridayRoot, "runtime"));
    const legacyPy = venvInterpreter(fridayRoot);
    if (HOST_WIN) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("python", ["-m", "venv", join(fridayRoot, "runtime", ".venv")], {
        timeout: 60_000,
      });
      const site = join(fridayRoot, "runtime", ".venv", "Lib", "site-packages");
      writeFileSync(
        join(site, "sitecustomize.py"),
        `import sys\nopen(${JSON.stringify(marker)}, "w", encoding="utf-8").write(sys.executable)\n`,
      );
      mkdirSync(path.dirname(legacyPy), { recursive: true });
      writeFileSync(legacyPy, "");
    } else {
      mkdirSync(path.dirname(runtimePy), { recursive: true });
      mkdirSync(path.dirname(legacyPy), { recursive: true });
      const realPy = existsSync(join(repo, ".venv", "bin", "python"))
        ? join(repo, ".venv", "bin", "python")
        : "python3";
      writeFileSync(
        runtimePy,
        `#!/bin/sh\nprintf '%s\\n' "$0" > ${JSON.stringify(marker)}\nexec ${JSON.stringify(realPy)} "$@"\n`,
      );
      chmodSync(runtimePy, 0o755);
      writeFileSync(legacyPy, "#!/bin/sh\necho LEGACY_USED >&2\nexit 99\n");
      chmodSync(legacyPy, 0o755);
    }

    try {
      const result = (await withoutFridayPythonAsync(() =>
        project.ensureDatabase({ userData, root: fridayRoot, install: repo }),
      )) as DatabaseResult;
      expect(result.ok).toBe(true);
      expect(result.integrity).toBe("ok");
      expect(result.tables).toContain("chats");
      expect(existsSync(marker)).toBe(true);
      const used = readFileSync(marker, "utf8").trim();
      expect(HOST_WIN ? used.toLowerCase() : used).toBe(
        HOST_WIN ? runtimePy.toLowerCase() : runtimePy,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("ensureDatabase names the exact interpreter, source, and tried paths when Python fails", async () => {
    const base = mkdtempSync(join(tmpdir(), "friday-db-fail-"));
    const fridayRoot = join(base, "MyFRIDAY");
    const userData = join(base, "userdata");
    mkdirSync(userData, { recursive: true });
    const runtimePy = venvInterpreter(join(fridayRoot, "runtime"));
    if (HOST_WIN) {
      const { execFileSync } = await import("node:child_process");
      execFileSync("python", ["-m", "venv", join(fridayRoot, "runtime", ".venv")], {
        timeout: 60_000,
      });
      const site = join(fridayRoot, "runtime", ".venv", "Lib", "site-packages");
      writeFileSync(
        join(site, "sitecustomize.py"),
        "import sys\nsys.stderr.write('FAIL_DB\\n')\nraise SystemExit(1)\n",
      );
    } else {
      mkdirSync(path.dirname(runtimePy), { recursive: true });
      writeFileSync(runtimePy, "#!/bin/sh\necho FAIL_DB >&2\nexit 1\n");
      chmodSync(runtimePy, 0o755);
    }

    try {
      const result = (await withoutFridayPythonAsync(() =>
        project.ensureDatabase({ userData, root: fridayRoot, install: repo }),
      )) as DatabaseResult;
      expect(result.ok).toBe(false);
      const line = result.log.join("\n");
      expect(line).toContain(`using ${runtimePy}`);
      expect(line).toContain("source=workspace:runtime");
      expect(line).toMatch(/tried:/);
      expect(line).toContain(runtimePy);
      expect(line).toContain("FAIL_DB");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("document-extract uses the same resolver", () => {
  it("prefers a selected folder runtime/.venv over that folder's legacy .venv", () => {
    const fridayRoot = mkdtempSync(join(tmpdir(), "friday-extract-py-"));
    try {
      const runtimePy = plantUnixVenv(join(fridayRoot, "runtime"));
      plantUnixVenv(fridayRoot);
      expect(withoutFridayPython(() => extract.pythonExecutable(fridayRoot))).toBe(runtimePy);
    } finally {
      rmSync(fridayRoot, { recursive: true, force: true });
    }
  });

  it("stops hardcoding checkout .venv joins in project.cjs and document-extract.cjs", () => {
    const projectSrc = readFileSync(join(repo, "electron/project.cjs"), "utf8");
    const extractSrc = readFileSync(join(repo, "electron/document-extract.cjs"), "utf8");
    expect(projectSrc).toContain("resolveManagedPython");
    expect(extractSrc).toContain("resolveManagedPython");
    expect(projectSrc).not.toMatch(/path\.join\(\s*root,\s*"\.venv"/);
    expect(extractSrc).not.toContain('path.join(__dirname, "..", ".venv", "bin", "python")');
    expect(extractSrc).not.toContain(
      'path.join(__dirname, "..", ".venv", "Scripts", "python.exe")',
    );
  });
});
