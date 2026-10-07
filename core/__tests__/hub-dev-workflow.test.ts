import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dev = require(path.join(process.cwd(), "electron/dev-workflow.cjs"));

/**
 * Friday Hub owns development / repo control only. These tests defend the two
 * properties that keep it from colliding with the release + update system:
 * main is never a commit target, and change sets survive as real disk state.
 */
describe("Friday Hub · development workflow", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-dev-"));
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("treats release branches as protected", () => {
    for (const branch of ["main", "MAIN", " master ", "release", "gh-pages"]) {
      expect(dev.isProtected(branch)).toBe(true);
    }
    expect(dev.isProtected("feature/new-voice")).toBe(false);
  });

  it("derives a safe prefixed branch name from free text", () => {
    expect(dev.branchName("Add Swara voice!!", "feature")).toBe("feature/add-swara-voice");
    expect(dev.branchName("fix/Crash on boot", "fix")).toBe("fix/crash-on-boot");
    expect(dev.branchName("", "chore").startsWith("chore/")).toBe(true);
    expect(dev.branchName("x", "nonsense").startsWith("feature/")).toBe(true);
  });

  it("persists, updates and removes change sets on disk", () => {
    const queued = dev.queueChangeSet(root, {
      title: "Imported upgrade",
      origin: "import-build",
      files: ["src/a.ts", "src/b.ts"],
    });
    expect(queued.ok).toBe(true);
    expect(queued.changeSet.status).toBe("queued");
    expect(queued.changeSet.fileCount).toBe(2);
    expect(fs.existsSync(dev.storeFile(root))).toBe(true);

    const updated = dev.updateChangeSet(root, queued.changeSet.id, {
      status: "pr-open",
      branch: "feature/imported-upgrade",
    });
    expect(updated.changeSet.status).toBe("pr-open");
    expect(dev.changeSets(root)[0].branch).toBe("feature/imported-upgrade");

    dev.removeChangeSet(root, queued.changeSet.id);
    expect(dev.changeSets(root)).toHaveLength(0);
  });

  it("refuses to commit onto a protected branch", async () => {
    const result = await dev.publishBranch(root, { dir: root, message: "x", confirm: true });
    expect(result.ok).toBe(false);
  });

  it("loads publisher identity from the resources folder when the archive copy is absent", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "electron/dev-workflow.cjs"), "utf8");
    expect(source).not.toMatch(/require\(\s*["']\.\.\/scripts\/identity\.cjs["']\s*\)/);
    expect(source).toContain('path.join(__dirname, "..", "scripts", "identity.cjs")');
    expect(source).toContain('path.join(process.resourcesPath || "", "scripts", "identity.cjs")');

    const missing = path.join(root, "app.asar", "scripts", "identity.cjs");
    expect(() => dev.loadFirstExisting([missing])).toThrow(/identity\.cjs/);

    const installed = path.join(root, "resources", "scripts", "identity.cjs");
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), "scripts/identity.cjs"), installed);
    const loaded = dev.loadFirstExisting([missing, installed]);
    expect(loaded.OWNER).toBe("Devendra Singh Meena");
    expect(loaded.GITHUB).toBe("devendrarj25");
  });
});
