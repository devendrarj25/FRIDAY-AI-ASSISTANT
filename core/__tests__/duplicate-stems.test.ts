/**
 * A new file whose basename already exists fails this test.
 * The allowlist is the set that was already in the tree. Placeholders,
 * pack manifests, and caches are exempt.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  ".cache",
  "build",
  "out",
  "__pycache__",
  ".pytest_cache",
  ".ruff_cache",
  ".friday-dev",
  // FRIDAY installed into its own checkout: <root>\App holds the installed program, which is not source.
  "App",
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

/**
 * Files git ignores are not part of the source (when the FRIDAY folder is this checkout the app writes its starter kit
 * and runtime files into it). A tracked file is never reported as ignored. Without git nothing is filtered.
 */
function dropIgnored(files: string[]): string[] {
  if (!files.length || !fs.existsSync(path.join(root, ".git"))) return files;
  const run = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: root,
    input: files.join("\n"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || (run.status !== 0 && run.status !== 1)) return files;
  const ignored = new Set(String(run.stdout).split(/\r?\n/).filter(Boolean));
  return files.filter((file) => !ignored.has(file));
}

describe("duplicate file names", () => {
  it("allows only the recorded stems", () => {
    const walked: string[] = [];
    walk(root, walked);
    const counts = new Map<string, number>();
    for (const file of walked)
      counts.set(path.posix.basename(file), (counts.get(path.posix.basename(file)) ?? 0) + 1);
    // Only a name that appears more than once can be a duplicate, so only those files go to git.
    const files = [
      ...dropIgnored(walked.filter((file) => (counts.get(path.posix.basename(file)) ?? 0) > 1)),
      ...walked.filter((file) => (counts.get(path.posix.basename(file)) ?? 0) <= 1),
    ];
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
