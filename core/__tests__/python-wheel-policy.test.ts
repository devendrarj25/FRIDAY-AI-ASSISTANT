import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const runtime = require_(join(root, "scripts/python-runtime.cjs"));
const versions = JSON.parse(readFileSync(join(root, "config/toolchain-versions.json"), "utf8"));

type Found = { executable: string; version: string; explicit?: boolean };
const py = (version: string, extra: Partial<Found> = {}): Found => ({
  executable: `C:/Python${version.split(".").slice(0, 2).join("")}/python.exe`,
  version,
  ...extra,
});

/**
 * A new CPython series can reach a machine before ctranslate2 (faster-whisper)
 * publishes its wheel. Setup must not pick that series while a proven one is
 * installed, and must take it once pip proves its kernel wheels.
 */
describe("Python wheel-proven selection", () => {
  it("keeps the floor and records the newest wheel-proven series", () => {
    expect(versions.pythonMinimum).toBe("3.12.10");
    expect(versions.pythonWheelProven).toMatch(/^3\.\d+$/);
    expect(runtime.WHEEL_PROVEN).toBe(versions.pythonWheelProven);
  });

  it("treats a series above the proven one as unproven", () => {
    expect(runtime.isWheelProven("3.14.7", "3.14")).toBe(true);
    expect(runtime.isWheelProven("3.12.10", "3.14")).toBe(true);
    expect(runtime.isWheelProven("3.15.0", "3.14")).toBe(false);
    expect(runtime.isWheelProven("3.16.1", "3.14")).toBe(false);
    expect(runtime.isWheelProven("", "3.14")).toBe(false);
  });

  it("skips a newer series without wheels when a proven one is installed", () => {
    const checked: string[] = [];
    const chosen = runtime.choosePython([py("3.15.0"), py("3.15.0"), py("3.14.7")], {
      proven: "3.14",
      wheelCheck: (exe: string) => {
        checked.push(exe);
        return false;
      },
    });
    expect(chosen.version).toBe("3.14.7");
    expect(checked).toEqual(["C:/Python315/python.exe"]);
  });

  it("takes the newer series once pip proves its kernel wheels", () => {
    const chosen = runtime.choosePython([py("3.15.2"), py("3.14.7")], {
      proven: "3.14",
      wheelCheck: () => true,
    });
    expect(chosen.version).toBe("3.15.2");
    expect(chosen.wheelsProven).toBe(true);
  });

  it("still uses a newer series when it is the only Python", () => {
    const chosen = runtime.choosePython([py("3.15.0")], {
      proven: "3.14",
      wheelCheck: () => false,
    });
    expect(chosen.version).toBe("3.15.0");
    expect(runtime.choosePython([], { proven: "3.14" })).toBeNull();
  });

  it("installs a proven series when only an unproven one is present", () => {
    expect(runtime.isBuildable(py("3.14.7"))).toBe(true);
    expect(runtime.isBuildable(py("3.15.0", { explicit: true }))).toBe(true);
    expect(runtime.isBuildable({ ...py("3.15.0"), wheelsProven: true })).toBe(true);
    expect(runtime.isBuildable(py("3.15.0"))).toBe(false);
    expect(runtime.isBuildable(null)).toBe(false);
    const source = readFileSync(join(root, "scripts/python-runtime.cjs"), "utf8");
    const ensure = source.slice(source.indexOf("function ensurePython"));
    expect(ensure).toContain("if (isBuildable(found) || !install) return found;");
    expect(ensure).toContain("installPython({ fallback: found })");
    const install = source.slice(source.indexOf("function installPython"));
    expect(install).toContain("if (isBuildable(found)) return found;");
    expect(install).toContain("return fallback;");
  });

  it("never second-guesses FRIDAY_PYTHON or an existing venv", () => {
    const chosen = runtime.choosePython([py("3.15.0", { explicit: true }), py("3.14.7")], {
      proven: "3.14",
      wheelCheck: () => false,
    });
    expect(chosen.version).toBe("3.15.0");
  });

  it("probes wheels with a pip dry run against kernel/requirements.txt", () => {
    const source = readFileSync(join(root, "scripts/python-runtime.cjs"), "utf8");
    const probe = source.slice(source.indexOf("function requiredWheelsPublished"));
    expect(probe).toContain('"--dry-run"');
    expect(probe).toContain('"--only-binary=:all:"');
    expect(probe).toContain('"requirements.txt"');
    expect(source).toContain("discoverPython({ wheelCheck: requiredWheelsPublished })");
    // The official installer list stays inside the proven series.
    expect(source).toContain("isSupported(v) && isWheelProven(v)");
  });

  it("keeps the Windows installer helper on the same proven series", () => {
    const helper = readFileSync(join(root, "installer/build/install-python.ps1"), "utf8");
    expect(helper).toContain(`[string]$WheelProven = "${versions.pythonWheelProven}"`);
    expect(helper).toContain("function Test-WheelProven");
    expect(helper).toContain("(Test-Floor $_) -and (Test-WheelProven $_)");
    const find = helper.slice(helper.indexOf("function Find-Python"));
    expect(find.indexOf("$proven.Minor")).toBeGreaterThan(-1);
    expect(find.indexOf("$proven.Minor")).toBeLessThan(find.indexOf('"-3", "-3.16"'));
  });
});
