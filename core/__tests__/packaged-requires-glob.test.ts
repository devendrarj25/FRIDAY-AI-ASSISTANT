import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { load as parseYaml } from "js-yaml";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");
const checker = require_(path.join(ROOT, "scripts/packaged-requires.cjs")) as {
  globMatches: (rel: string, pattern: string) => boolean;
  matcherFrom: (
    loaded: unknown,
  ) => (file: string, pattern: string, options: { dot: true }) => boolean;
  filesFromPatterns: (root: string, patterns: string[]) => string[];
};

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "release", "dist-desktop", ".output"].includes(entry.name))
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

describe("the glob matcher that replaced the hoisted minimatch", () => {
  it("handles the forms electron-builder entries use", () => {
    const m = checker.globMatches;
    expect(m("electron/main.cjs", "electron/**/*")).toBe(true);
    expect(m("electron/a/b/c.cjs", "electron/**/*.cjs")).toBe(true);
    expect(m("electron/main.cjs", "electron/*.cjs")).toBe(true);
    expect(m("electron/a/main.cjs", "electron/*.cjs")).toBe(false);
    expect(m("package.json", "package.json")).toBe(true);
    expect(m("a.json", "?.json")).toBe(true);
    expect(m("ab.json", "?.json")).toBe(false);
    expect(m("src/a.ts", "src/*.{ts,tsx}")).toBe(true);
    expect(m("src/a.tsx", "src/*.{ts,tsx}")).toBe(true);
    expect(m("src/a.js", "src/*.{ts,tsx}")).toBe(false);
    expect(m(".hidden/x.txt", "**/*.txt")).toBe(true);
    expect(m("x/.env", "**/.env")).toBe(true);
    expect(m("a.b", "a.b")).toBe(true);
    expect(m("axb", "a.b")).toBe(false);
    expect(m("v1.0/file", "v[0-9].[0-9]/*")).toBe(true);
    expect(m("deep/dir/file.md", "**")).toBe(true);
  });

  it("agrees with minimatch on every file of this repository for the real build patterns", () => {
    const config = parseYaml(fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8")) as {
      files?: unknown[];
    };
    const patterns = (config.files ?? [])
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.replace(/^!/, ""));
    expect(patterns.length).toBeGreaterThan(3);
    const minimatch = checker.matcherFrom(require_("minimatch"));
    const files = listFiles(ROOT).slice(0, 4000);
    const disagreements: string[] = [];
    for (const pattern of patterns) {
      for (const file of files) {
        const ours = checker.globMatches(file, pattern);
        const theirs = minimatch(file, pattern, { dot: true });
        if (ours !== theirs)
          disagreements.push(`${pattern} vs ${file}: ours ${ours}, minimatch ${theirs}`);
        if (disagreements.length > 5) break;
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("applies negative patterns when collecting files", () => {
    const found = checker.filesFromPatterns(ROOT, ["scripts/*.cjs", "!scripts/docs-engine.cjs"]);
    expect(found).toContain("scripts/packaged-requires.cjs");
    expect(found).not.toContain("scripts/docs-engine.cjs");
  });
});
