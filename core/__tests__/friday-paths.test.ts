import { describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const root = resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const paths = require_(resolve(root, "electron/friday-paths.cjs"));

/**
 * Single-folder architecture: one selected folder is the canonical home of the
 * whole application. These tests guard that invariant at the source level so a
 * future change cannot quietly scatter FRIDAY data across the machine again.
 */
describe("canonical FRIDAY folder", () => {
  it("resolves every FRIDAY-owned area inside the selected root", () => {
    const home = process.platform === "win32" ? "C:\\FRIDAY-test" : "/tmp/friday-test-root";
    paths.setRoot(home);
    expect(paths.root()).toBe(resolve(home));
    for (const name of [
      "app",
      "config",
      "database",
      "memory",
      "models",
      "voices",
      "browser",
      "downloads",
      "sandbox",
      "logs",
      "backups",
      "runtime",
      "cache",
    ]) {
      expect(paths.dir(name).startsWith(resolve(home))).toBe(true);
    }
    paths.setRoot(null);
  });

  it("never invents a home folder when nothing has been selected", () => {
    paths.setRoot(null);
    expect(paths.hasRoot()).toBe(false);
    expect(paths.dir("config")).not.toContain("FRIDAY-test");
  });

  it("keeps FRIDAY subsystems on the path service instead of raw AppData joins", () => {
    for (const file of [
      "electron/screen-vision.cjs",
      "electron/browser-live.cjs",
      "electron/python.cjs",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).toContain("friday-paths.cjs");
    }
  });

  it("does not guess a FRIDAY folder in the user's home from setup scripts", () => {
    for (const file of ["scripts/init-runtime.cjs", "scripts/env-registry.cjs"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/homedir\(\),\s*"FRIDAY"/);
      // The exe install location may still be probed; a *data* folder there may not.
      expect(source).not.toMatch(/APPDATA[^\n]*"FRIDAY",\s*"data"/);
    }
  });

  it("initialises the selected folder through ensureStructure, not a second list", () => {
    const source = readFileSync(resolve(root, "scripts/init-runtime.cjs"), "utf8");
    expect(source).toContain("friday-paths.cjs");
    expect(source).toContain("ensureStructure");
    expect(source).toContain("installBundledModel");
    expect(source).not.toMatch(/const folders = \[/);
  });

  it("creates nothing new when ensureStructure runs twice on the same root", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-ensure-twice-"));
    const first = paths.ensureStructure(folder);
    expect(first.created.length).toBeGreaterThan(0);
    const second = paths.ensureStructure(folder);
    expect(second.created).toEqual([]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("does not rename the Git kernel/ or src/ trees into backend/ or frontend/", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-checkout-"));
    mkdirSync(join(folder, "kernel"));
    writeFileSync(join(folder, "kernel", "main.py"), "print('kernel')\n");
    writeFileSync(join(folder, "kernel", "requirements.txt"), "fastapi>=0.115\n");
    mkdirSync(join(folder, "src", "lib", "friday"), { recursive: true });
    mkdirSync(join(folder, "src", "routes"), { recursive: true });
    writeFileSync(join(folder, "src", "routes", "index.tsx"), "export {}\n");
    paths.setRoot(folder);
    expect(paths.dir("backend")).toBe(resolve(join(folder, "backend")));
    expect(paths.dir("frontend")).toBe(resolve(join(folder, "frontend")));
    const result = paths.ensureStructure(folder);
    paths.setRoot(null);
    expect(existsSync(join(folder, "kernel", "requirements.txt"))).toBe(true);
    expect(existsSync(join(folder, "kernel", "main.py"))).toBe(true);
    expect(existsSync(join(folder, "src", "routes"))).toBe(true);
    expect(existsSync(join(folder, "backend"))).toBe(true);
    expect(existsSync(join(folder, "frontend"))).toBe(true);
    expect(existsSync(join(folder, "kernel", "api"))).toBe(false);
    expect(result.migrated.some((row: { from: string }) => row.from === "kernel")).toBe(false);
    expect(result.migrated.some((row: { from: string }) => row.from === "src")).toBe(false);
    rmSync(folder, { recursive: true, force: true });
  });

  it("puts a stolen FastAPI tree back from backend/ to kernel/", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-stolen-kernel-"));
    mkdirSync(join(folder, "backend"));
    writeFileSync(join(folder, "backend", "main.py"), "print('kernel')\n");
    writeFileSync(join(folder, "backend", "requirements.txt"), "fastapi>=0.115\n");
    expect(paths.resolveKernelSource(folder)).toBe(resolve(join(folder, "backend")));
    const restored = paths.restoreCheckoutCollisions(folder);
    expect(restored).toEqual([{ from: "backend", to: "kernel" }]);
    expect(existsSync(join(folder, "kernel", "requirements.txt"))).toBe(true);
    expect(existsSync(join(folder, "backend", "requirements.txt"))).toBe(false);
    expect(paths.resolveKernelSource(folder)).toBe(resolve(join(folder, "kernel")));
    rmSync(folder, { recursive: true, force: true });
  });

  it("ensureStructure restores a stolen kernel and creates a sibling backend data folder", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-stolen-ensure-"));
    mkdirSync(join(folder, "backend"));
    writeFileSync(join(folder, "backend", "main.py"), "print('kernel')\n");
    writeFileSync(join(folder, "backend", "requirements.txt"), "fastapi>=0.115\n");
    const result = paths.ensureStructure(folder);
    expect(result.restored).toEqual([{ from: "backend", to: "kernel" }]);
    expect(existsSync(join(folder, "kernel", "main.py"))).toBe(true);
    expect(existsSync(join(folder, "backend", "api"))).toBe(true);
    expect(existsSync(join(folder, "kernel", "api"))).toBe(false);
    rmSync(folder, { recursive: true, force: true });
  });

  it("still migrates a data kernel/ folder that is not the FastAPI source tree", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-data-kernel-"));
    mkdirSync(join(folder, "kernel", "api"), { recursive: true });
    writeFileSync(join(folder, "kernel", "api", "note.txt"), "user data");
    const result = paths.ensureStructure(folder);
    expect(
      result.migrated.some(
        (row: { from: string; to: string }) => row.from === "kernel" && row.to === "backend",
      ),
    ).toBe(true);
    expect(existsSync(join(folder, "backend", "api", "note.txt"))).toBe(true);
    expect(existsSync(join(folder, "kernel", "api"))).toBe(false);
    rmSync(folder, { recursive: true, force: true });
  });

  it("treats friday.sqlite3 and legacy friday.db as existing database data", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-existing-"));
    mkdirSync(join(folder, "database"));
    expect(paths.describeExisting(folder)).not.toContain("database");
    writeFileSync(join(folder, "database", "friday.sqlite3"), "x");
    expect(paths.describeExisting(folder)).toContain("database");
    rmSync(join(folder, "database", "friday.sqlite3"));
    writeFileSync(join(folder, "database", "friday.db"), "x");
    expect(paths.describeExisting(folder)).toContain("database");
    rmSync(folder, { recursive: true, force: true });
  });
});

/** Every entry under `folder` as `relative/path` (directories end in `/`), sorted. */
function treeOf(folder: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(folder, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else out.push(rel);
    }
  };
  walk(folder);
  return out.sort();
}

describe("ensureStructure is idempotent and never destructive (D8)", () => {
  it("yields an identical tree when it runs twice", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-tree-twice-"));
    paths.ensureStructure(folder);
    const first = treeOf(folder);
    const second = paths.ensureStructure(folder);
    expect(treeOf(folder)).toEqual(first);
    expect(second.created).toEqual([]);
    expect(second.migrated).toEqual([]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("uses a differently cased Models folder in place and never makes a second one", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-case-alias-"));
    mkdirSync(join(folder, "Models", "whisper"), { recursive: true });
    writeFileSync(join(folder, "Models", "whisper", "weights.bin"), "w");
    const result = paths.ensureStructure(folder);
    const names = readdirSync(folder).filter((name) => name.toLowerCase() === "models");
    expect(names).toEqual(["Models"]);
    expect(existsSync(join(folder, "Models", "whisper", "weights.bin"))).toBe(true);
    expect(result.created).not.toContain("models");
    expect(result.migrated).toEqual([]);
    paths.setRoot(folder);
    expect(paths.dir("models")).toBe(join(folder, "Models"));
    paths.setRoot(null);
    paths.ensureStructure(folder);
    expect(readdirSync(folder).filter((name) => name.toLowerCase() === "models")).toEqual([
      "Models",
    ]);
    rmSync(folder, { recursive: true, force: true });
  });

  it("finds an entry through a lowercase alias with one shared helper", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-find-entry-"));
    mkdirSync(join(folder, "Skills", "Core"), { recursive: true });
    expect(paths.findEntry(folder, "skills/core")).toBe(join(folder, "Skills", "Core"));
    expect(paths.findEntry(folder, "skills/core", { exact: true })).toBeNull();
    expect(paths.findEntry(folder, "Skills/Core", { exact: true })).toBe(
      join(folder, "Skills", "Core"),
    );
    expect(paths.findEntry(folder, "skills/missing")).toBeNull();
    rmSync(folder, { recursive: true, force: true });
  });

  it("never creates backend/ or frontend/ in a checkout-shaped root", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-checkout-shaped-"));
    writeFileSync(join(folder, "package.json"), "{}\n");
    mkdirSync(join(folder, "src"));
    mkdirSync(join(folder, "kernel"));
    writeFileSync(join(folder, "kernel", "notes.txt"), "kept");
    const result = paths.ensureStructure(folder);
    expect(existsSync(join(folder, "backend"))).toBe(false);
    expect(existsSync(join(folder, "frontend"))).toBe(false);
    expect(existsSync(join(folder, "kernel", "notes.txt"))).toBe(true);
    expect(existsSync(join(folder, "src"))).toBe(true);
    expect(result.created).not.toContain("backend");
    expect(result.created).not.toContain("frontend");
    expect(result.migrated).toEqual([]);
    expect(existsSync(join(folder, "models"))).toBe(true);
    rmSync(folder, { recursive: true, force: true });
  });

  it("counts a symlinked or dangling child as existing and leaves it alone", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-link-child-"));
    const outside = mkdtempSync(join(tmpdir(), "friday-link-target-"));
    writeFileSync(join(outside, "keep.txt"), "kept");
    symlinkSync(outside, join(folder, "downloads"), "junction");
    symlinkSync(join(outside, "gone"), join(folder, "logs"), "junction");
    const result = paths.ensureStructure(folder);
    expect(lstatSync(join(folder, "downloads")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(folder, "logs")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(existsSync(join(outside, "gone"))).toBe(false);
    expect(result.created).not.toContain("downloads");
    expect(result.created).not.toContain("logs");
    expect(result.existing).toContain("downloads");
    expect(result.existing).toContain("logs");
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("never removes or renames away anything that was already there", () => {
    const folder = mkdtempSync(join(tmpdir(), "friday-nothing-removed-"));
    const seed: Record<string, string> = {
      "models/a.bin": "a",
      "Memory/m.db": "m",
      "Config/friday-settings.json": "{}",
      "custom-user-folder/note.txt": "n",
      "skills/mine/skill.md": "s",
      "loose.txt": "l",
    };
    for (const [rel, body] of Object.entries(seed)) {
      mkdirSync(join(folder, rel, ".."), { recursive: true });
      writeFileSync(join(folder, rel), body);
    }
    const before = treeOf(folder);
    paths.ensureStructure(folder);
    const after = new Set(treeOf(folder));
    for (const entry of before) expect(after.has(entry)).toBe(true);
    for (const [rel, body] of Object.entries(seed)) {
      expect(readFileSync(join(folder, rel), "utf8")).toBe(body);
    }
    rmSync(folder, { recursive: true, force: true });
  });
});
