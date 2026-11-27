/**
 * The offline Hinglish lexicon builder: spelling proposal rules, the WER fixture builder and the CLI guards.
 * Tiny inline fixtures only; no network, no dataset, no date.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../src/lib/friday/voice-engine/voice-eval-set";

type Row = { native: string; latin: string; count: number };
type Builder = {
  parseDakshinaLexicon: (t: string) => Row[];
  proposeSpellings: (
    rows: Row[],
    existing: Record<string, unknown>,
    options?: { minCount?: number },
  ) => {
    sureHindiAdded: [string, string][];
    ambiguousCandidates: [string, string][];
    skipped: { word: string; why: string }[];
  };
  buildWerFixture: (
    rows: Record<string, unknown>[],
    options?: Record<string, unknown>,
  ) => { items: { id: string; condition: string }[] } & Record<string, unknown>;
  main: (argv: string[], io: { log: (m: string) => void; error: (m: string) => void }) => number;
};
const script = resolve(__dirname, "../../scripts/build-hinglish-lexicon.cjs");
const builder = createRequire(import.meta.url)(script) as Builder;
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const EXISTING = {
  sureHindi: [["kya", "क्या"]],
  sureHindiAdded: [["ruko", "रुको"]],
  ambiguous: [["do", "दो"]],
  loanwords: [["meeting", "मीटिंग"]],
};
const TSV = [
  "क्या\tkyaa\t5",
  "क्या\tkya\t9",
  "क्या\tkyaaa\t1",
  "क्या\tthe\t7",
  "रुको\tto\t4",
  "रुको\trukoo\t3",
].join("\n");

describe("parseDakshinaLexicon", () => {
  it("reads native, latin and count and skips short lines", () => {
    const rows = builder.parseDakshinaLexicon(`${TSV}\nbroken\n\n`);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ native: "क्या", latin: "kyaa", count: 5 });
  });
});

describe("proposeSpellings", () => {
  const out = builder.proposeSpellings(builder.parseDakshinaLexicon(TSV), EXISTING, {
    minCount: 3,
  });
  it("merges a spelling into the existing pair only at count >= 3", () => {
    expect(out.sureHindiAdded).toContainEqual(["kya|kyaa", "क्या"]);
    expect(out.sureHindiAdded).toContainEqual(["ruko|rukoo", "रुको"]);
    expect(JSON.stringify(out.sureHindiAdded)).not.toContain("kyaaa");
    expect(out.skipped).toContainEqual({ word: "kyaaa", why: "low-count" });
    expect(out.skipped).toContainEqual({ word: "kya", why: "already-known" });
  });
  it("sends common English words to the candidates, never to sure words", () => {
    expect(out.ambiguousCandidates.map((p) => p[0]).sort()).toEqual(["the", "to"]);
    expect(JSON.stringify(out.sureHindiAdded)).not.toMatch(/\bthe\b|\bto\b/);
  });
  it("sends a spelling shared by two native words to the candidates", () => {
    const rows = [
      { native: "क्या", latin: "kyo", count: 4 },
      { native: "क्यों", latin: "kyo", count: 4 },
    ];
    expect(builder.proposeSpellings(rows, EXISTING).ambiguousCandidates).toHaveLength(1);
  });
});

describe("buildWerFixture", () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({
    id: `u${i}`,
    text: `private sentence ${i}`,
    stratum: i % 2 ? "hinglish_clean" : "hinglish_noisy",
  }));
  const opts = { perStratum: 50, seed: 1, createdOn: "2026-01-01" };
  it("is deterministic for a seed and caps each stratum", () => {
    const a = builder.buildWerFixture(rows, opts);
    const b = builder.buildWerFixture(rows, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.items.filter((i) => i.condition === "quiet")).toHaveLength(50);
    expect(a.items.filter((i) => i.condition === "noisy")).toHaveLength(50);
    expect(JSON.stringify(builder.buildWerFixture(rows, { ...opts, seed: 2 }))).not.toBe(
      JSON.stringify(a),
    );
  });
  it("holds hashes only and passes the manifest validator", () => {
    const fixture = builder.buildWerFixture(rows, opts);
    expect(JSON.stringify(fixture)).not.toContain("private sentence");
    expect(JSON.stringify(fixture)).not.toMatch(/"audio|path/);
    expect(validateManifest(fixture, sha256).problems).toEqual([]);
  });
  it("refuses a share-alike source", () => {
    expect(() => builder.buildWerFixture(rows, { ...opts, licence: "CC-BY-SA-4.0" })).toThrow(
      /refuses licence/,
    );
  });
});

describe("command line", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  it("exits 2 with usage when no input flag is given", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });
  it("exits 2 when --out is inside the repository and writes nothing", () => {
    const inside = resolve(__dirname, "../../testing-out");
    const r = run(["--dakshina", tmpdir(), "--out", inside]);
    expect(r.status).toBe(2);
    expect(existsSync(inside)).toBe(false);
  });
  it("exits 2 when an input path is missing and writes nothing", () => {
    const out = join(tmpdir(), "friday-hl-missing-out");
    const code = builder.main(["--dakshina", join(tmpdir(), "no-such-dakshina"), "--out", out], {
      log: () => undefined,
      error: () => undefined,
    });
    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
  it("writes a proposal under an outside --out", () => {
    const dir = mkdtempSync(join(tmpdir(), "friday-hl-"));
    try {
      const input = join(dir, "in");
      const lex = join(input, "hi", "lexicons");
      mkdirSync(lex, { recursive: true });
      writeFileSync(join(lex, "hi.translit.sampled.train.tsv"), TSV);
      const r = run(["--dakshina", input, "--out", join(dir, "out")]);
      expect(r.status).toBe(0);
      const body = JSON.parse(readFileSync(join(dir, "out", "spelling-proposal.json"), "utf8"));
      expect(body.licence).toContain("CC-BY-SA-4.0");
      expect(body.sureHindiAdded).toContainEqual(["kya|kyaa", "क्या"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
