/**
 * A GitHub source update merges the repository into a source checkout: every
 * file lands where it lives in the repository, new files arrive, and the
 * owner's own data is never replaced.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const importer = require_(path.resolve(import.meta.dirname, "../../electron/importer.cjs"));
const classifyMod = require_(
  path.resolve(import.meta.dirname, "../../electron/import-classify.cjs"),
);

let root = "";
let repo = "";
const put = (base: string, rel: string, text: string) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-merge-"));
  root = path.join(base, "FRIDAY");
  repo = path.join(base, "incoming");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
});
afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("where a repository file lands", () => {
  const ctx = { mode: "friday", packageName: "friday" };

  it("keeps root files, tooling and workflows in place in the repository layout", () => {
    for (const file of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vite.config.ts",
      "eslint.config.js",
      ".github/workflows/release.yml",
      "AGENTS.md",
      "LICENSE",
      ".gitignore",
    ]) {
      const verdict = classifyMod.classify(file, { ...ctx, layout: "repo" });
      expect(verdict.dest, file).toBe(file);
      expect(verdict.area, file).toBe("root");
    }
    expect(classifyMod.classify("kernel/main.py", { ...ctx, layout: "repo" }).dest).toBe(
      "kernel/main.py",
    );
  });

  it("leaves the routing of every other import exactly as it was", () => {
    expect(classifyMod.classify("package.json", ctx).dest).toBe("config/package.json");
    expect(classifyMod.classify("LICENSE", ctx).dest).toBe("updates/unsorted/friday/LICENSE");
  });
});

describe("merging a repository update into a source checkout", () => {
  async function stage() {
    put(root, "package.json", '{"version":"1.0.0"}');
    put(root, "src/app.ts", "old");
    put(root, "memory/permanent/profile.json", '{"name":"owner"}');
    put(root, "conversations/history/chat.json", "owner chat");
    put(root, "config/settings.json", '{"voice":"swara"}');
    put(root, "database/friday.sqlite3", "owner rows");

    put(repo, "package.json", '{"version":"2.0.0"}');
    put(repo, "kernel/requirements.txt", "fastapi>=1");
    put(repo, "tsconfig.json", "{}");
    put(repo, ".github/workflows/ci.yml", "name: ci");
    put(repo, "src/app.ts", "new");
    put(repo, "src/brand-new.ts", "added");
    put(repo, "skills/demo/SKILL.md", "# demo");
    put(repo, "memory/permanent/profile.json", '{"name":"template"}');
    put(repo, "conversations/history/chat.json", "template");
    put(repo, "memory/archived/.gitkeep", "");
    const scan = await importer.scanImport({ root, source: repo, layout: "repo" });
    expect(scan.ok).toBe(true);
    return { ...scan, githubRef: "v2.0.0" };
  }

  it("updates root files and new source files where they belong", async () => {
    const scan = await stage();
    const out = await importer.applyImport({ root, scan });
    expect(out.ok).toBe(true);
    expect(read("package.json")).toBe('{"version":"2.0.0"}');
    expect(read("src/app.ts")).toBe("new");
    expect(read("src/brand-new.ts")).toBe("added");
    expect(read("tsconfig.json")).toBe("{}");
    expect(read(".github/workflows/ci.yml")).toBe("name: ci");
    expect(read("kernel/requirements.txt")).toBe("fastapi>=1");
    expect(read("skills/demo/SKILL.md")).toBe("# demo");
    // Nothing was misfiled into the capability folders.
    expect(fs.existsSync(path.join(root, "config", "package.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "skills", "custom", "tsconfig.json"))).toBe(false);
    expect(out.restartRequired).toBe(true);
  });

  it("never replaces the owner's own data, and adds only what is missing", async () => {
    const scan = await stage();
    const out = await importer.applyImport({ root, scan });
    expect(read("memory/permanent/profile.json")).toBe('{"name":"owner"}');
    expect(read("conversations/history/chat.json")).toBe("owner chat");
    expect(read("config/settings.json")).toBe('{"voice":"swara"}');
    expect(read("database/friday.sqlite3")).toBe("owner rows");
    expect(out.preserved).toBe(2);
    expect(fs.existsSync(path.join(root, "memory", "archived", ".gitkeep"))).toBe(true);
  });

  it("says when packages must be refreshed, and can be rolled back", async () => {
    const scan = await stage();
    const out = await importer.applyImport({ root, scan });
    expect(out.dependencyChanges).toEqual(
      expect.arrayContaining([
        { file: "package.json", command: "npm ci" },
        { file: "kernel/requirements.txt", command: "npm run setup:python" },
      ]),
    );
    expect(out.backup).toBeTruthy();
    const back = importer.rollbackImport({ root, backup: out.backup });
    expect(back.ok).toBe(true);
    expect(read("package.json")).toBe('{"version":"1.0.0"}');
    expect(read("src/app.ts")).toBe("old");
    expect(read("memory/permanent/profile.json")).toBe('{"name":"owner"}');
  });

  it("applies nothing and says so when the repository holds only what is already here", async () => {
    put(root, "package.json", '{"version":"2.0.0"}');
    put(repo, "package.json", '{"version":"2.0.0"}');
    const scan = {
      ...(await importer.scanImport({ root, source: repo, layout: "repo" })),
      githubRef: "v2",
    };
    const out = await importer.applyImport({ root, scan });
    expect(out).toMatchObject({ ok: true, applied: 0, preserved: 0, dependencyChanges: [] });
  });
});

describe("how the update pipeline uses it", () => {
  const sync = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../electron/github-sync.cjs"),
    "utf8",
  );
  it("asks for the repository layout when it stages a GitHub source zip", () => {
    expect(sync).toContain('layout: "repo"');
  });
});
