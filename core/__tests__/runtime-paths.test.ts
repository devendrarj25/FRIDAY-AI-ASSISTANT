import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const fridayRoot = require_(join(root, "scripts/friday-root.cjs"));

/**
 * One canonical database, one packaged runtime, real path containment.
 */
describe("runtime paths", () => {
  it("keeps every script on <root>/database/friday.sqlite3", () => {
    expect(fridayRoot.layout("/tmp/MyFRIDAY").database).toBe(
      join("/tmp/MyFRIDAY", "database", "friday.sqlite3"),
    );
    for (const file of ["scripts/env-registry.cjs", "scripts/init-runtime.cjs"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toMatch(/join\(dataRoot, "friday\.sqlite3"\)/);
    }
  });

  it("bounds the Windows registry read so a GUI boot cannot sit on reg.exe", () => {
    const source = readFileSync(join(root, "scripts/friday-root.cjs"), "utf8");
    const call = source.slice(source.indexOf('spawnSync("reg"'));
    expect(call.slice(0, 500)).toContain("windowsHide: true");
    expect(call.slice(0, 500)).toContain("timeout: 8000");
  });

  it("probes the runtime venv the installed app actually uses", () => {
    const source = readFileSync(join(root, "scripts/python-runtime.cjs"), "utf8");
    expect(source).toContain("FRIDAY_INSTALL_DIR");
    expect(source).toContain('pythonIn(path.join(root, "..", "runtime"))');
    expect(source).toContain("friday-root.cjs");
    expect(source).toContain("targetVenvPython");
  });

  it("targets a selected FRIDAY folder runtime/.venv for setup-python", () => {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        "const r=require('./scripts/python-runtime.cjs'); process.stdout.write(JSON.stringify({target:r.targetVenvPython(), resolved:r.resolveVenvPython()}))",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, FRIDAY_WORKSPACE_ROOT: join("/tmp", "MyFRIDAY") },
      },
    );
    expect(probe.status).toBe(0);
    const paths = JSON.parse(probe.stdout) as { target: string; resolved: string };
    expect(paths.target.replace(/\\/g, "/")).toContain("MyFRIDAY/runtime/.venv/");
  });

  it("re-probes Python when the selected FRIDAY folder changes", () => {
    const source = readFileSync(join(root, "electron/python.cjs"), "utf8");
    expect(source).toContain("cacheKey");
    expect(source).toContain("invalidatePython");
  });

  it("waits for the old kernel and its port before starting a new one", () => {
    const source = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(source).toContain("async function stopKernel");
    expect(source).toContain("portBusy(KERNEL_PORT)");
    expect(source).not.toContain(
      "if (kernel) kernel.kill();\n  kernel = null;\n  void startKernel",
    );
  });

  it("uses real path containment instead of string prefixes", () => {
    for (const file of ["electron/capabilities.cjs", "electron/hub-lab.cjs"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).toContain("function contains(base, target)");
      expect(source).not.toMatch(/startsWith\(path\.resolve\(/);
    }
  });

  it("never adopts a test sandbox left by the installer smoke or readiness run", () => {
    const smoke =
      "C:\\Users\\o\\AppData\\Local\\Temp\\friday-installer-smoke-159e554ae32c4e0988aac6b39f610efa\\FRIDAY";
    expect(fridayRoot.isThrowawayRoot(smoke)).toBe(true);
    expect(
      fridayRoot.isThrowawayRoot(
        "C:\\Users\\o\\AppData\\Local\\Temp\\friday-readiness-YBHBRt\\root",
      ),
    ).toBe(true);
    expect(fridayRoot.isThrowawayRoot("/tmp/friday-readiness-abc123/root")).toBe(true);
    expect(fridayRoot.isThrowawayRoot("D:\\FRIDAY")).toBe(false);
    expect(fridayRoot.isThrowawayRoot("D:\\friday-readiness-notes")).toBe(false);
    expect(fridayRoot.isThrowawayRoot("")).toBe(false);
    // The app and the scripts must refuse exactly the same folders.
    const main = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(main.replace(/=\s+\//g, "= /")).toContain(
      `const THROWAWAY_ROOT = ${fridayRoot.THROWAWAY_ROOT.toString()};`,
    );
  });

  it("lets the readiness restart rediscover its own sandbox", () => {
    const main = readFileSync(join(root, "electron/main.cjs"), "utf8");
    expect(main).toMatch(
      /const settled = \(value\) => \{\s*if \(value && process\.env\.FRIDAY_READINESS !== "1" && THROWAWAY_ROOT\.test\(String\(value\)\)\)/,
    );
  });

  it("resolves the FRIDAY root in the same order as the app: env, registry, pointer", () => {
    const source = readFileSync(join(root, "scripts/friday-root.cjs"), "utf8");
    expect(source).toContain("return fromRegistry() || fromSettingsPointer();");
    expect(source).toMatch(/fromSettingsPointer[\s\S]*!isThrowawayRoot\(value\)/);
    expect(source).toMatch(/fromRegistry[\s\S]*!isThrowawayRoot\(value\)/);
  });

  it("gives readiness the interpreter setup-python built, and the smoke restores the pointer", () => {
    const readiness = readFileSync(join(root, "scripts/readiness-test.cjs"), "utf8");
    const fn = readiness.slice(readiness.indexOf("function checkoutPython()"));
    expect(fn.slice(0, 900)).toContain("runtime.resolveVenvPython()");
    const smoke = readFileSync(join(root, "scripts/windows-installer-smoke.ps1"), "utf8");
    expect(smoke).toContain('"friday-settings.json"');
    expect(smoke).toContain("[System.IO.File]::WriteAllBytes($file, $pointerBackup[$file])");
  });
});
