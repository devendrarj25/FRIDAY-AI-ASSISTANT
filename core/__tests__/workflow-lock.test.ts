/**
 * The workflows and composite actions are locked: they ran green on hosted
 * runners and change only when the owner asks and confirms a second time
 * (AGENTS.md, GitHub workflows stay locked). This fails on any difference from
 * config/workflow-lock.json. No network, no git history.
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const lock = require("../../scripts/workflow-lock.cjs") as {
  lockedFiles: (base?: string) => string[];
  current: (base?: string) => Record<string, string>;
  compare: (recorded: Record<string, string>, actual: Record<string, string>) => string[];
  readLock: () => Record<string, string>;
};
const root = path.resolve(__dirname, "..", "..");

describe("workflow lock", () => {
  it("holds: every workflow and composite action is exactly as it was locked", () => {
    expect(lock.compare(lock.readLock(), lock.current())).toEqual([]);
  });

  it("covers all eleven workflows and the three composite actions", () => {
    const files = lock.lockedFiles();
    expect(files.filter((f) => f.startsWith(".github/workflows/"))).toHaveLength(11);
    expect(files.filter((f) => f.startsWith(".github/actions/"))).toEqual([
      ".github/actions/checkout/action.yml",
      ".github/actions/friday-node/action.yml",
      ".github/actions/python/action.yml",
    ]);
    expect(Object.keys(lock.readLock()).sort()).toEqual([...files].sort());
  });

  it("is blind to line endings and sees every other change, an added file and a removed one", () => {
    const copy = mkdtempSync(path.join(tmpdir(), "friday-lock-"));
    try {
      cpSync(path.join(root, ".github"), path.join(copy, ".github"), { recursive: true });
      const recorded = lock.current(copy);
      const file = path.join(copy, ".github", "workflows", "branch-cleanup.yml");
      const text = readFileSync(file, "utf8");
      writeFileSync(file, text.replace(/\n/g, "\r\n"));
      expect(lock.compare(recorded, lock.current(copy))).toEqual([]);
      writeFileSync(file, `${text}# one more line\n`);
      expect(lock.compare(recorded, lock.current(copy))).toEqual([
        ".github/workflows/branch-cleanup.yml: changed since it was locked",
      ]);
      writeFileSync(path.join(copy, ".github", "workflows", "twelfth.yml"), "name: x\n");
      expect(lock.compare(recorded, lock.current(copy))).toContain(
        ".github/workflows/twelfth.yml: added, not in the lock",
      );
      rmSync(path.join(copy, ".github", "workflows", "security.yml"));
      expect(lock.compare(recorded, lock.current(copy))).toContain(
        ".github/workflows/security.yml: removed, still in the lock",
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
