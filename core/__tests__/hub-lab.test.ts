import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const hubLab = require(path.resolve(process.cwd(), "electron/hub-lab.cjs")) as {
  analyze: (a: { root: string; dir: string }) => {
    ok: boolean;
    candidates?: { id: string; status: string; kind: string }[];
    summary?: { new: number; updated: number; identical: number };
  };
  extract: (a: { root: string; dir: string; groups: string[] }) => {
    ok: boolean;
    applied?: number;
    backup?: string | null;
  };
  readStaged: (a: { dir: string; file: string }) => { ok: boolean; content?: string };
  writeStaged: (a: { dir: string; file: string; content: string }) => { ok: boolean };
  listStaged: (a: { dir: string }) => { ok: boolean; files?: { path: string }[] };
};

const roots: string[] = [];
const tmp = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-hub-lab-"));
  roots.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
};

afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const pack = () => ({
  "manifest.json": JSON.stringify({ name: "Nova Skill", kind: "skill", version: "2.0.0" }),
  "index.js": "module.exports = { run: () => 'nova' };\n",
});

describe("hub lab", () => {
  it("lists what a staged import contains and marks it as new", () => {
    const root = tmp({ "package.json": "{}" });
    const staged = tmp(pack());
    const result = hubLab.analyze({ root, dir: staged });
    expect(result.ok).toBe(true);
    expect(result.candidates?.length).toBeGreaterThan(0);
    expect(result.summary?.new).toBeGreaterThan(0);
  });

  it("installs only the selected capability and backs the tree up", () => {
    const root = tmp({ "package.json": "{}" });
    const staged = tmp(pack());
    const analysis = hubLab.analyze({ root, dir: staged });
    const pick = analysis.candidates?.[0]?.id as string;
    const applied = hubLab.extract({ root, dir: staged, groups: [pick] });
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBeGreaterThan(0);
    expect(existsSync(path.join(root, pick))).toBe(true);
    expect(applied.backup && existsSync(applied.backup)).toBeTruthy();
  });

  it("re-analysing after an install reports the same content as identical", () => {
    const root = tmp({ "package.json": "{}" });
    const staged = tmp(pack());
    const first = hubLab.analyze({ root, dir: staged });
    hubLab.extract({ root, dir: staged, groups: [first.candidates?.[0]?.id as string] });
    const second = hubLab.analyze({ root, dir: staged });
    expect(second.summary?.new).toBe(0);
    expect(second.summary?.identical).toBeGreaterThan(0);
  });

  it("edits stay in the staging copy until they are installed", () => {
    const root = tmp({ "package.json": "{}" });
    const staged = tmp(pack());
    const listed = hubLab.listStaged({ dir: staged });
    expect(listed.files?.some((f) => f.path === "index.js")).toBe(true);

    hubLab.writeStaged({ dir: staged, file: "index.js", content: "// edited\n" });
    expect(hubLab.readStaged({ dir: staged, file: "index.js" }).content).toContain("edited");
    expect(existsSync(path.join(root, "skills"))).toBe(false);

    const analysis = hubLab.analyze({ root, dir: staged });
    hubLab.extract({ root, dir: staged, groups: [analysis.candidates?.[0]?.id as string] });
    const installed = path.join(root, analysis.candidates?.[0]?.id as string, "index.js");
    expect(readFileSync(installed, "utf8")).toContain("edited");
  });

  it("refuses to read or write outside the staged import", () => {
    const staged = tmp(pack());
    expect(hubLab.readStaged({ dir: staged, file: "../../etc/passwd" }).ok).toBe(false);
    expect(hubLab.writeStaged({ dir: staged, file: "../escape.txt", content: "x" }).ok).toBe(false);
  });
});

describe("build runner preflight", () => {
  const builder = require(path.resolve(process.cwd(), "electron/builder-run.cjs")) as {
    preflight: (root: string) => { ready: boolean; missing: string[]; version: string | null };
    sourceRoot: (ctx: { projectRoot?: string }) => string | null;
  };

  it("accepts the real FRIDAY project", () => {
    const root = process.cwd();
    const checks = builder.preflight(root);
    expect(checks.missing).toEqual([]);
    expect(checks.ready).toBe(true);
    expect(checks.version).toBeTruthy();
  });

  it("explains what a non-project folder is missing", () => {
    const dir = tmp({ "readme.txt": "hi" });
    const checks = builder.preflight(dir);
    expect(checks.ready).toBe(false);
    expect(checks.missing).toContain("package.json");
    // Pointing at an unrelated folder must never be treated as that project:
    // resolution falls back to FRIDAY's own source tree, not the stray folder.
    expect(builder.sourceRoot({ projectRoot: dir })).not.toBe(dir);
  });

  it("finds the project when pointed at a subfolder or its parent", () => {
    const root = process.cwd();
    expect(builder.sourceRoot({ projectRoot: path.join(root, "electron") })).toBe(root);
    expect(builder.sourceRoot({ projectRoot: path.dirname(root) })).toBe(root);
  });
});
