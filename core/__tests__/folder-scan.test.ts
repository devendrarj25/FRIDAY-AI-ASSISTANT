import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ws = require_("../../electron/workspace.cjs") as {
  countFiles: (
    dir: string,
    budget?: { files: number; dirs: number },
    caps?: { dirs: number; files: number },
  ) => {
    files: number;
    dirs: number;
  };
  SKIP_DIRS: Set<string>;
  SHALLOW_FOLDERS: Set<string>;
  PROGRAM_CAPS: { dirs: number; files: number };
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-scan-"));
  dirs.push(dir);
  return dir;
};

describe("counting a folder does not walk what nobody edits", () => {
  it("skips build, vendor and Windows system folders whatever their case", () => {
    const root = make();
    writeFileSync(join(root, "note.md"), "x");
    for (const name of [
      "Node_Modules",
      "$RECYCLE.BIN",
      "System Volume Information",
      "Site-Packages",
      ".git",
    ]) {
      mkdirSync(join(root, name, "deep"), { recursive: true });
      writeFileSync(join(root, name, "deep", "a.js"), "x");
    }
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "a.md"), "x");
    const out = ws.countFiles(root);
    expect(out.files).toBe(2);
    expect(out.dirs).toBe(1);
  });

  it("maps FRIDAY's own machine folders shallowly, and keeps the owner's folders whole", () => {
    for (const name of ["runtime", "sandbox", "cache", "temporary", "temp"]) {
      expect(ws.SHALLOW_FOLDERS.has(name), name).toBe(true);
    }
    for (const name of ["docs", "memory", "knowledge", "projects", "models", "library"]) {
      expect(ws.SHALLOW_FOLDERS.has(name), name).toBe(false);
    }
    const root = make();
    for (let d = 0; d < 20; d += 1) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 5; f += 1) writeFileSync(join(root, `d${d}`, `f${f}.py`), "x");
    }
    const shallow = ws.countFiles(root, { files: 0, dirs: 0 }, { dirs: 3, files: 12 });
    // Past the cap no further folder is opened, so far fewer than all 100 files are read.
    expect(shallow.files).toBeLessThanOrEqual(20);
    expect(ws.countFiles(root).files).toBe(100);
  });
});
