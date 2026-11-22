/**
 * The numbers FRIDAY_STATE.md, ARCHITECTURE.md and AUDIT.md state must be the ones the files say.
 *
 * The 2026-11-18 audit found the Snapshot still naming version 1.1.4.6 (the file says 1.1.5.7), three different
 * counts of kernel tools (78, 69 and 76; the table has 79) and 140 layout folders (the manifest declares 141),
 * because the version check only read one sentence and nothing read the table. Each fact is read from its own
 * source here, not typed a second time.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const state = read("FRIDAY_STATE.md");

const version = JSON.parse(read("config/friday-version.json")) as {
  major: number;
  minor: number;
  patch: number;
  revision: number;
};
const current = `${version.major}.${version.minor}.${version.patch}.${version.revision}`;
const next = `${version.major}.${version.minor}.${version.patch}.${version.revision + 1}`;

describe("the Snapshot table states the version the version file holds", () => {
  it("the public version and the release it names", () => {
    const row =
      /\| Public version\s*\| `([\d.]+)` \(`config\/friday-version\.json`\), published as GitHub release `v([\d.]+)`/.exec(
        state,
      );
    expect(row, "the Public version row").not.toBeNull();
    expect(row?.[1]).toBe(current);
    expect(row?.[2]).toBe(current);
  });

  it("the next public revision, which AGENTS.md also states", () => {
    expect(/\| Next public revision\s*\| `([\d.]+)`/.exec(state)?.[1]).toBe(next);
    expect(read("AGENTS.md")).toContain(`Next public revision is **${next}**`);
  });

  it("the worked bump example starts from the current version and moves one place each", () => {
    const parts = [version.major, version.minor, version.patch, version.revision];
    const bump = (index: number) =>
      parts.map((value, place) => (place === index ? value + 1 : value)).join(".");
    const line = state.split("\n").find((row) => row.includes("From public `")) ?? "";
    expect(line).toContain(`From public \`${current}\``);
    expect(line).toContain(`patch is \`${bump(3)}\``);
    expect(line).toContain(`minor is \`${bump(2)}\``);
    expect(line).toContain(`major is \`${bump(1)}\``);
    expect(line).toContain(`extreme is \`${bump(0)}\``);
  });
});

describe("the kernel tool count is the size of the RISK table", () => {
  const { surfaceManifest } = require("../../electron/mcp-catalog.cjs") as {
    surfaceManifest: (root: string) => { kernelTools: number };
  };
  const tools = surfaceManifest(root).kernelTools;

  it("is counted from kernel/tools.py, not typed", () => {
    const source = read("kernel/tools.py");
    const block = /RISK\s*=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s{4}"([a-z0-9_.-]+)":/gim)].length;
    expect(keys).toBe(tools);
    expect(tools).toBeGreaterThan(70);
  });

  it("FRIDAY_STATE.md, ARCHITECTURE.md, the MCP surface and the MCP doc agree", () => {
    expect(Number(/\| Kernel tools\s*\| (\d+)/.exec(state)?.[1])).toBe(tools);
    expect(Number(/\((\d+) entries in the `RISK` table/.exec(read("ARCHITECTURE.md"))?.[1])).toBe(
      tools,
    );
    expect(JSON.parse(read("config/mcp-surface.json")).kernelTools).toBe(tools);
    expect(read("docs/FRIDAY_MCP.md")).toContain(`Kernel tools in the risk table: ${tools}.`);
  });
});

describe("the layout folder count is the manifest's", () => {
  it("FRIDAY_STATE.md and AUDIT.md state the number arrange:check prints", () => {
    const { declaredFolders } = require("../../scripts/arrange-project.cjs") as {
      declaredFolders: (manifest: unknown) => string[];
    };
    const manifest = JSON.parse(read("config/project-structure.json"));
    const count = declaredFolders(manifest).length;
    expect(Number(/declares (\d+) layout folders/.exec(state)?.[1])).toBe(count);
    expect(Number(/\*\*(\d+) folders\*\*/.exec(read("AUDIT.md"))?.[1])).toBe(count);
  });
});

describe("the Brain benchmark counts are the registry's", () => {
  it("the roadmap, the benchmark doc and the features table agree with the category bank", async () => {
    const { CATEGORIES } = await import("../../src/lib/friday/self/benchmark-bank");
    const total = CATEGORIES.length;
    const scored = CATEGORIES.filter((row) => row.backing === "app").length;
    for (const rel of [
      "docs/research/FRIDAY_BRAIN_BENCHMARK.md",
      "docs/FRIDAY_FEATURES.md",
      "docs/research/FRIDAY_BRAIN_IMPLEMENTATION_ROADMAP.md",
    ]) {
      const text = read(rel);
      expect(text, rel).toMatch(new RegExp(`${total}[- ]categor`));
      expect(text, rel).toMatch(
        new RegExp(`${scored} (are )?scored in the app|${scored} scored in the app`),
      );
    }
  });
});

describe("a release moves the Snapshot with the version", () => {
  // FRIDAY Release run 3 (a major bump to 1.2.5.7) stopped in its own prepare tests: heal moved the version
  // everywhere except these Snapshot facts. The release engine now rewrites them and reports them as drift.
  const engine = require("../../scripts/release-engine.cjs") as {
    rewriteStateSnapshot: (text: string, version: string) => string;
    stateSnapshotDrift: (text: string, version: string) => { found: string; expected: string }[];
  };
  const sample = [
    "| Public version       | `1.1.5.7` (`config/friday-version.json`), published as GitHub release `v1.1.5.7` (Setup) |",
    "| Next public revision | `1.1.5.8`, not bumped until the owner asks |",
    "- From public `1.1.5.7`, patch is `1.1.5.8`, minor is `1.1.6.7`, major is `1.2.5.7`, and extreme is `2.1.5.7`. Rest.",
    "- History: the release of 1.1.5.7 stays as written.",
  ].join("\n");

  it("rewrites the public version, the release, the next revision and the worked example, and nothing else", () => {
    const out = engine.rewriteStateSnapshot(sample, "1.2.5.7");
    expect(out).toContain(
      "| `1.2.5.7` (`config/friday-version.json`), published as GitHub release `v1.2.5.7` (Setup)",
    );
    expect(out).toContain("| Next public revision | `1.2.5.8`, not bumped");
    expect(out).toContain(
      "From public `1.2.5.7`, patch is `1.2.5.8`, minor is `1.2.6.7`, major is `1.3.5.7`, and extreme is `2.2.5.7`. Rest.",
    );
    expect(out).toContain("- History: the release of 1.1.5.7 stays as written.");
    expect(engine.rewriteStateSnapshot(out, "1.2.5.7")).toBe(out);
  });

  it("reports a Snapshot that disagrees with the version, so verify:version catches it before a release", () => {
    expect(engine.stateSnapshotDrift(sample, "1.1.5.7")).toEqual([]);
    const drift = engine.stateSnapshotDrift(sample, "1.2.5.7");
    expect(drift.map((d) => d.expected)).toEqual([
      "1.2.5.7",
      "1.2.5.8",
      "From public `1.2.5.7`, patch is `1.2.5.8`, minor is `1.2.6.7`, major is `1.3.5.7`, and extreme is `2.2.5.7`",
    ]);
  });
});
