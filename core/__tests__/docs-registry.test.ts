/**
 * FRIDAY - documentation registry contract.
 *
 * Every Markdown document is declared exactly once in `scripts/docs-engine.cjs`,
 * carries the title its name promises, is indexed in `docs/README.md`, appears in
 * the README documentation map, and never repeats another document's paragraph.
 * The index and the map are generated, so this test is what keeps them true after
 * any future upgrade.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../..");

type DocsEngine = {
  DOCUMENTS: Array<{
    file: string;
    title: string | null;
    section: string;
    audience: string;
    answers: string;
    topic: string;
    inMap?: boolean;
    role?: string;
  }>;
  SECTIONS: Array<{ id: string; title: string }>;
  UNREGISTERED_OK: RegExp[];
  DOC_ROLES: string[];
  indexBlock: () => string;
  mapBlock: () => string;
  duplicates: () => Array<{ files: string[]; excerpt: string }>;
  inspect: () => {
    missing: string[];
    unregistered: string[];
    thin: string[];
    mistitled: Array<{ file: string; found: string; expected: string | null }>;
    duplicates: Array<{ files: string[]; excerpt: string }>;
    indexStale: boolean;
    mapStale: boolean;
    countDrift: Array<{ file: string; kind: string; stated: number | null; actual: number }>;
    ok: boolean;
  };
  capabilityCounts: () => Record<string, number>;
  countDrift: () => Array<{ file: string; kind: string; stated: number | null; actual: number }>;
  sync: () => string[];
};

const docs = require("../../scripts/docs-engine.cjs") as DocsEngine;
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("documentation registry", () => {
  const report = docs.inspect();

  it("registers every Markdown document that exists in the checkout", () => {
    expect(report.unregistered, "unregistered documents").toEqual([]);
    expect(report.missing, "registered documents that do not exist").toEqual([]);
  });

  /**
   * Regression (v1.8.0 release): prepare/publish stage a transient
   * `release-notes.md` at the repo root, then run `npm test`. That scratch file
   * is not a registered document, so inspect() must ignore it.
   *
   * The file is also the GitHub Release body. This test must NEVER create or
   * overwrite that live path — doing so is what leaked `v0.0.0` into the
   * published v1.8.0 GitHub release.
   */
  it("ignores Main Safety Recovery records merged onto main", () => {
    // An earlier run: merging recovery/main-* brought
    // recovery/<timestamp>.md onto main and prepare's npm test failed this
    // registry. Those records stay in the tree; they are not product docs.
    expect(docs.UNREGISTERED_OK.some((rx) => rx.test("recovery/20261004T054914Z.md"))).toBe(true);
    expect(docs.UNREGISTERED_OK.some((rx) => rx.test("recovery/not-a-record.txt"))).toBe(false);
    expect(report.unregistered).not.toContain("recovery/20261004T054914Z.md");
  });

  it("does not flag a repo-root release-notes.md and never writes one", () => {
    expect(docs.UNREGISTERED_OK.some((rx) => rx.test("release-notes.md"))).toBe(true);
    const inspectSrc = read("scripts/docs-engine.cjs");
    const start = inspectSrc.indexOf("function inspect(");
    const end = inspectSrc.indexOf("function main(", start);
    expect(inspectSrc.slice(start, end)).not.toContain("writeFileSync");
    expect(read("core/__tests__/docs-registry.test.ts")).not.toMatch(
      /writeFileSync\(\s*scratch,\s*[\s\S]{0,160}v0\.0\.0/,
    );
    const fresh = docs.inspect();
    expect(fresh.unregistered, "transient release-notes.md must be ignored").not.toContain(
      "release-notes.md",
    );
  });

  it("keeps every registered document real, titled and non-trivial", () => {
    expect(report.thin, "documents below 400 characters").toEqual([]);
    expect(report.mistitled.map((m) => `${m.file}: ${m.found}`)).toEqual([]);
  });

  it("declares a unique purpose, topic and known section for each document", () => {
    const sections = new Set(docs.SECTIONS.map((s) => s.id));
    const answers = new Set<string>();
    const files = new Set<string>();
    for (const doc of docs.DOCUMENTS) {
      expect(sections.has(doc.section), `${doc.file}: unknown section`).toBe(true);
      expect(doc.answers.length, `${doc.file}: empty purpose`).toBeGreaterThan(20);
      expect(doc.topic.length, `${doc.file}: empty topic`).toBeGreaterThan(5);
      expect(answers.has(doc.answers), `${doc.file}: duplicate purpose`).toBe(false);
      expect(files.has(doc.file), `${doc.file}: registered twice`).toBe(false);
      const role = doc.role || "canonical";
      expect(docs.DOC_ROLES.includes(role), `${doc.file}: unknown role ${role}`).toBe(true);
      answers.add(doc.answers);
      files.add(doc.file);
    }
  });

  it("never repeats the same paragraph in two documents", () => {
    expect(report.duplicates.map((d) => `${d.files.join(" == ")} :: ${d.excerpt}`)).toEqual([]);
  });

  it("keeps the generated index and README map in sync with the registry", () => {
    expect(report.indexStale, "docs/README.md is stale - run `npm run docs:sync`").toBe(false);
    expect(report.mapStale, "README.md map is stale - run `npm run docs:sync`").toBe(false);
    expect(read("docs/README.md")).toContain(docs.indexBlock());
    expect(read("README.md")).toContain(docs.mapBlock());
  });

  it("regenerates idempotently, so a second sync changes nothing", () => {
    expect(docs.sync()).toEqual([]);
  });

  it("links every registered document from the generated index", () => {
    const index = read("docs/README.md");
    for (const doc of docs.DOCUMENTS) {
      if (doc.file === "README.md") continue;
      const target = path
        .relative(path.join(ROOT, "docs"), path.join(ROOT, doc.file))
        .split(path.sep)
        .join("/");
      expect(index, `${doc.file} is not linked from docs/README.md`).toContain(`(${target})`);
    }
  });

  it("exposes the sync entry points the owner and the release engine use", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:sync"]).toContain("docs-engine.cjs");
    expect(pkg.scripts["docs:check"]).toContain("docs-engine.cjs");
    expect(read("scripts/release-engine.cjs")).toContain("docs-engine.cjs");
  });

  it("keeps the stated skill / tool / agent / plugin / workflow / module counts equal to the disk", () => {
    const counts = docs.capabilityCounts();
    for (const kind of ["Skills", "Tools", "Agents", "Plugins", "Workflows", "Modules"]) {
      expect(counts[kind], `${kind} counted from disk`).toBeGreaterThan(0);
    }
    // A stale number (or a reworded sentence the guard can no longer find) fails here.
    // Fix with `npm run docs:sync`; it also runs on every release.
    expect(docs.countDrift(), "stated counts that differ from the disk").toEqual([]);
    expect(report.countDrift).toEqual([]);
  });

  it("gives Claude Code a one-line import of AGENTS.md instead of a second copy", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
    expect(read("AGENTS.md")).toContain("`CLAUDE.md`");
    const registered = new Set(docs.DOCUMENTS.map((doc) => doc.file));
    expect(registered.has("READMEFIRST.md")).toBe(false);
    expect(registered.has("AGENTS.md")).toBe(true);
  });

  it("AGENTS.md only points at repository paths that exist", () => {
    const text = read("AGENTS.md");
    const roots = "src|core|electron|kernel|scripts|config|docs|installer|builder|modules|agents";
    const refs = [...text.matchAll(new RegExp("`((?:" + roots + ")/[A-Za-z0-9_./-]+)`", "g"))]
      .map((m) => (m[1] ?? "").replace(/[.,]+$/, ""))
      .filter((rel) => !/[*<>{}]/.test(rel));
    const missing = refs.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    expect(missing, "AGENTS.md references that do not exist").toEqual([]);
  });
});
