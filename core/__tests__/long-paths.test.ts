/**
 * Windows refuses a path over 260 characters unless long paths are enabled, and a Python environment unpacks
 * packages whose own folders are deep. Setup, Doctor and the build report it with the command that fixes it, and
 * only when the FRIDAY folder is deep enough for it to matter.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const lp = require_("../../scripts/long-paths.cjs") as {
  DEEPEST_PACKAGE_PATH: number;
  LIMIT: number;
  readLongPathsEnabled: (platform?: string, run?: (...args: unknown[]) => unknown) => string;
  assess: (input: { state: string; root: string }) => { ok: boolean; note: string; fix: string };
};

const reg =
  (stdout: string, status = 0) =>
  () => ({ stdout, status });

describe("reading the long-paths switch", () => {
  it("reads 1 as enabled, 0 and a missing value as disabled, and does not guess off Windows", () => {
    const on = "    LongPathsEnabled    REG_DWORD    0x1\r\n";
    const off = "    LongPathsEnabled    REG_DWORD    0x0\r\n";
    expect(lp.readLongPathsEnabled("win32", reg(on))).toBe("Enabled");
    expect(lp.readLongPathsEnabled("win32", reg(off))).toBe("Disabled");
    expect(lp.readLongPathsEnabled("win32", reg("", 1))).toBe("Disabled");
    expect(lp.readLongPathsEnabled("linux", reg(on))).toBe("Unknown");
  });

  it("treats a registry tool that throws as unknown rather than failing the check", () => {
    const boom = () => {
      throw new Error("no reg.exe");
    };
    expect(lp.readLongPathsEnabled("win32", boom)).toBe("Unknown");
  });
});

describe("whether the FRIDAY folder needs it", () => {
  it("passes when long paths are on, or the state cannot be read", () => {
    expect(lp.assess({ state: "Enabled", root: "C:\\" + "x".repeat(200) }).ok).toBe(true);
    expect(lp.assess({ state: "Unknown", root: "C:\\" + "x".repeat(200) }).ok).toBe(true);
  });

  it("passes with long paths off when the folder is short enough for the deepest package path", () => {
    const room = lp.LIMIT - lp.DEEPEST_PACKAGE_PATH;
    const shortRoot = "C:\\" + "x".repeat(room - 3);
    expect(shortRoot.length).toBe(room);
    expect(lp.assess({ state: "Disabled", root: shortRoot }).ok).toBe(true);
    expect(lp.assess({ state: "Disabled", root: "C:\\FRIDAY" }).ok).toBe(true);
  });

  it("warns with the fix when the folder is deep and long paths are off", () => {
    const deep =
      "C:\\Users\\someone\\Documents\\Projects\\" + "nested-folder\\".repeat(6) + "FRIDAY";
    const result = lp.assess({ state: "Disabled", root: deep });
    expect(result.ok).toBe(false);
    expect(result.note).toContain(String(deep.length));
    expect(result.fix).toContain("LongPathsEnabled");
    expect(result.fix).toContain("C:\\FRIDAY");
  });
});

describe("where it is reported", () => {
  it("is a recommended row in the environment check: it never blocks, and it names the fix", () => {
    const source = readFileSync(path.join(root, "scripts/check-environment.cjs"), "utf8");
    const at = source.indexOf('name: "Windows long paths"');
    expect(at).toBeGreaterThan(-1);
    const row = source.slice(at, source.indexOf("});", at));
    expect(row).toContain("required: false");
    expect(row).toContain("fix: assessed.fix");
    expect(source).toContain('require("./long-paths.cjs")');
  });

  it("never writes the registry (that needs administrator rights and is the owner's call)", () => {
    const source = readFileSync(path.join(root, "scripts/long-paths.cjs"), "utf8");
    expect(source).not.toMatch(/reg(\.exe)?["'],\s*\[\s*["']add["']/);
    expect(source).not.toContain("Set-ItemProperty");
  });
});
