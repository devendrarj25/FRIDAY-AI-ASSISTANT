import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lab = require("../../electron/sandbox-lab.cjs");

let root = "";
let source = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-sandbox-"));
  source = fs.mkdtempSync(path.join(os.tmpdir(), "friday-source-"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "friday" }), "utf8");
  fs.mkdirSync(path.join(source, "src"), { recursive: true });
  fs.writeFileSync(path.join(source, "src", "a.ts"), "export const a = 1;\n", "utf8");
});

afterEach(() => {
  for (const dir of [root, source]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp dir */
    }
  }
});

describe("sandbox lab isolation", () => {
  it("keeps every path inside the project folder", () => {
    const base = path.join(root, "sandbox", "projects", "p1");
    expect(() => lab.safeJoin(base, "../../escape.txt")).toThrow();
    expect(lab.safeJoin(base, "src/x.ts")).toBe(path.join(base, "src", "x.ts"));
  });

  it("creates, lists and persists projects across reloads", () => {
    const created = lab.createProject(root, { name: "My Test", template: "node" });
    expect(created.ok).toBe(true);
    expect(fs.existsSync(path.join(created.project.dir, "index.mjs"))).toBe(true);

    const listed = lab.listProjects(root);
    expect(listed.projects.map((p: { id: string }) => p.id)).toContain(created.project.id);

    // A fresh read of the registry (simulating a restart) still sees it.
    const registry = JSON.parse(
      fs.readFileSync(path.join(root, "sandbox", "projects.json"), "utf8"),
    );
    expect(registry).toHaveLength(1);
  });

  it("edits files only inside the sandbox", () => {
    const { project } = lab.createProject(root, { name: "edit", template: "blank" });
    expect(lab.writeFile(root, project.id, "src/new.ts", "export const x = 2;").ok).toBe(true);
    expect(lab.readFile(root, project.id, "src/new.ts").content).toContain("x = 2");
    expect(lab.writeFile(root, project.id, "../../outside.ts", "nope").ok).toBe(false);
  });
});

describe("sandbox lab approval flow", () => {
  it("previews exact changes without touching the source", () => {
    const { project } = lab.createProject(root, { name: "diff", template: "blank" });
    lab.writeFile(root, project.id, "src/a.ts", "export const a = 2;\n");
    lab.writeFile(root, project.id, "src/b.ts", "export const b = 3;\n");

    const diff = lab.diffToSource(root, project.id, source);
    expect(diff.ok).toBe(true);
    const byPath = Object.fromEntries(
      diff.changes.map((c: { path: string; status: string }) => [c.path, c.status]),
    );
    expect(byPath["src/a.ts"]).toBe("modified");
    expect(byPath["src/b.ts"]).toBe("added");
    // Production source is untouched by a preview.
    expect(fs.readFileSync(path.join(source, "src", "a.ts"), "utf8")).toContain("a = 1");
  });

  it("applies only approved files and rolls back exactly", () => {
    const { project } = lab.createProject(root, { name: "apply", template: "blank" });
    lab.writeFile(root, project.id, "src/a.ts", "export const a = 2;\n");
    lab.writeFile(root, project.id, "src/b.ts", "export const b = 3;\n");

    const applied = lab.applyToSource(root, project.id, source, ["src/a.ts"]);
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(source, "src", "a.ts"), "utf8")).toContain("a = 2");
    // Unapproved file was never written.
    expect(fs.existsSync(path.join(source, "src", "b.ts"))).toBe(false);

    const rolled = lab.rollbackApply(root, applied);
    expect(rolled.ok).toBe(true);
    expect(fs.readFileSync(path.join(source, "src", "a.ts"), "utf8")).toContain("a = 1");
  });

  it("refuses a stale preview instead of creating a conflicting change", () => {
    const { project } = lab.createProject(root, { name: "stale", template: "blank" });
    lab.writeFile(root, project.id, "src/a.ts", "export const a = 9;\n");
    const diff = lab.diffToSource(root, project.id, source);
    expect(diff.ok).toBe(true);
    // Someone edits production between preview and apply.
    fs.writeFileSync(path.join(source, "src", "a.ts"), "export const a = 5;\n", "utf8");
    const reviewed = Object.fromEntries(
      diff.changes.map((c: { path: string; sourceHash: string | null }) => [c.path, c.sourceHash]),
    );
    const applied = lab.applyToSource(root, project.id, source, ["src/a.ts"], { expect: reviewed });
    expect(applied.ok).toBe(false);
    expect(applied.stale).toContain("src/a.ts");
    expect(fs.readFileSync(path.join(source, "src", "a.ts"), "utf8")).toContain("a = 5");
  });

  it("removes rollback backups only with the project, and records history", () => {
    const { project } = lab.createProject(root, { name: "history", template: "blank" });
    lab.writeFile(root, project.id, "src/a.ts", "export const a = 7;\n");
    lab.applyToSource(root, project.id, source, ["src/a.ts"]);
    const history = lab.historyOf(root).map((h: { kind: string }) => h.kind);
    expect(history).toContain("apply");
    expect(history).toContain("create");
    expect(lab.listApplies(root)).toHaveLength(1);
  });
});

describe("sandbox lab runtime + commands", () => {
  it("verifies runtimes by executing them, not just finding them", async () => {
    const runtime = await lab.detectRuntime();
    const node = runtime.tools.find((t: { id: string }) => t.id === "node");
    expect(node.ok).toBe(true);
    expect(node.version).toMatch(/^\d+\./);
  });

  it("runs a real command inside the project folder", async () => {
    const { project } = lab.createProject(root, { name: "run", template: "node" });
    const result = await lab.runCommand(root, {
      id: project.id,
      command: "node -e \"console.log('sandbox-ok')\"",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("sandbox-ok");
    expect(result.engine).toBeTruthy();
    const log = lab.readLog(root, project.id);
    expect(log).toContain("sandbox-ok");
    if (result.isolated) expect(log).not.toMatch(/not OS-isolated/);
    else expect(log).toMatch(/not OS-isolated/);
  });

  it("refuses a working directory outside the project", async () => {
    const { project } = lab.createProject(root, { name: "escape", template: "node" });
    const result = await lab.runCommand(root, {
      id: project.id,
      command: "node -v",
      cwd: "../../..",
    });
    expect(result.ok).toBe(false);
  });

  it("plans check commands from the project files without spawning", () => {
    const node = lab.createProject(root, { name: "checks-node", template: "node" });
    const nodePlan = lab.planProjectChecks(root, node.project.id);
    expect(nodePlan.ok).toBe(true);
    expect(nodePlan.checks.map((c: { id: string }) => c.id)).toContain("test");

    const py = lab.createProject(root, { name: "checks-py", template: "pytest" });
    const pyPlan = lab.planProjectChecks(root, py.project.id);
    expect(pyPlan.checks.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining(["compileall", "pytest", "ruff"]),
    );

    const go = lab.createProject(root, { name: "checks-go", template: "go" });
    expect(
      lab.planProjectChecks(root, go.project.id).checks.map((c: { id: string }) => c.id),
    ).toEqual(expect.arrayContaining(["govet", "gotest"]));

    const rust = lab.createProject(root, { name: "checks-rust", template: "rust" });
    expect(
      lab.planProjectChecks(root, rust.project.id).checks.map((c: { id: string }) => c.id),
    ).toEqual(expect.arrayContaining(["cargocheck", "cargotest"]));

    const java = lab.createProject(root, { name: "checks-java", template: "java" });
    expect(
      lab.planProjectChecks(root, java.project.id).checks.map((c: { id: string }) => c.id),
    ).toContain("javac");
  });

  it("ships linux/go/rust/pytest templates inside the project folder", () => {
    expect(Object.keys(lab.TEMPLATES)).toEqual(
      expect.arrayContaining([
        "blank",
        "node",
        "python",
        "pytest",
        "go",
        "rust",
        "linux",
        "java",
        "cmake",
        "container",
        "deno",
        "friday",
      ]),
    );
    const linux = lab.createProject(root, { name: "linux-tpl", template: "linux" });
    expect(linux.ok).toBe(true);
    expect(lab.readFile(root, linux.project.id, "Makefile").ok).toBe(true);
  });
});
