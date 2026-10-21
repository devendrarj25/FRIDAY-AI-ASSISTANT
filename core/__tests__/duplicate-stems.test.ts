/**
 * A new file whose basename already exists fails this test.
 * The allowlist is the set that was already in the tree. Placeholders,
 * pack manifests, and caches are exempt.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const skip = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-desktop",
  "release",
  "releases",
  ".venv",
  "debug",
  "coverage",
  "build",
  "out",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".friday-dev",
  ".friday-readiness-root",
]);
const exempt = new Set([
  "index.js",
  "index.cjs",
  "index.ts",
  "index.mjs",
  "index.tsx",
  "__init__.py",
  "main.py",
  "manifest.json",
  "skill.json",
  "tool.json",
  "plugin.json",
  "workflow.json",
  "skill.mjs",
  "README.md",
  "action.yml",
  "readme.md",
  ".gitkeep",
  ".gitignore",
  "CACHEDIR.TAG",
]);

const ALLOWED: Record<string, string[]> = {
  "bridge.ts": ["src/lib/friday/bridge.ts", "src/lib/friday/character/bridge.ts"],
  "cli.mjs": ["builder/cli.mjs", "updater/cli.mjs"],
  "environment.ts": ["core/__tests__/helpers/environment.ts", "src/lib/friday/environment.ts"],
  "favicon.png": ["public/favicon.png", "src/renderer/favicon.png"],
  "model-registry.ts": [
    "src/lib/friday/brain/model-registry.ts",
    "src/lib/friday/model-registry.ts",
  ],
  "paths.ts": ["core/__tests__/helpers/paths.ts", "core/paths.ts"],
  "phrase-bank.ts": ["src/lib/friday/data/phrase-bank.ts", "src/lib/friday/phrase-bank.ts"],
  "requirements.txt": ["kernel/requirements.txt", "requirements.txt"],
  "types.ts": ["core/types.ts", "src/lib/friday/character/types.ts", "src/lib/friday/types.ts"],
};

function walk(dir: string, acc: string[]) {
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, acc);
    else acc.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

describe("duplicate file names", () => {
  it("allows only the recorded stems", () => {
    const files: string[] = [];
    walk(root, files);
    const groups = new Map<string, string[]>();
    for (const file of files) {
      const base = path.posix.basename(file);
      if (exempt.has(base)) continue;
      const list = groups.get(base) || [];
      list.push(file);
      groups.set(base, list);
    }
    const duplicates = [...groups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([base, list]) => [base, [...list].sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const actual = Object.fromEntries(duplicates);
    const expected = Object.fromEntries(
      Object.entries(ALLOWED)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([base, list]) => [base, [...list].sort()]),
    );
    expect(actual).toEqual(expected);
  });
});
