import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const fixtures = join(root, "core", "fixtures", "voice-eval");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const evalCli = (args: string[]) => run("voice-eval.cjs", args);

let dir = "";
let manifest = "";
const refs = join(fixtures, "synthetic-references.json");
const hyps = join(fixtures, "synthetic-hypotheses.json");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-eval-"));
  manifest = join(dir, "manifest.json");
  copyFileSync(join(fixtures, "synthetic-manifest.json"), manifest);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("voice-eval.cjs", () => {
  it("validates the committed catalogue and says it lists no items", () => {
    const r = evalCli(["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/lists no items.*UNVERIFIED/);
  });

  it("refuses to score the catalogue, with no number", () => {
    const r = evalCli(["score", "--references", refs, "--hypotheses", hyps]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/REFUSED/);
    expect(r.out).toMatch(/no items in split test/);
    expect(r.out).not.toMatch(/corpusWer/);
  });

  it("refuses a test number before the test set is frozen", () => {
    const r = evalCli([
      "score",
      "--manifest",
      manifest,
      "--references",
      refs,
      "--hypotheses",
      hyps,
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not frozen/);
  });

  it("freezes only on request, never twice, and notices a later change", () => {
    const dry = evalCli(["freeze", "--manifest", manifest]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/not written/);
    expect(JSON.parse(readFileSync(manifest, "utf8")).testLock).toBeNull();

    expect(evalCli(["freeze", "--manifest", manifest, "--write"]).code).toBe(0);
    const frozen = JSON.parse(readFileSync(manifest, "utf8"));
    expect(frozen.testLock.items).toBe(7);
    const again = evalCli(["freeze", "--manifest", manifest, "--write"]);
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/never overwritten/);

    const tampered = JSON.parse(JSON.stringify(frozen));
    tampered.items[0].sha256 = sha("another recording");
    const bad = join(dir, "tampered.json");
    writeFileSync(bad, JSON.stringify(tampered));
    const r = evalCli(["validate", "--manifest", bad]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/changed after it was frozen/);
  });

  it("scores the frozen fixture per language and per condition with ranges", () => {
    const r = evalCli([
      "score",
      "--manifest",
      manifest,
      "--references",
      refs,
      "--hypotheses",
      hyps,
      "--engine",
      "fixture",
    ]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.engine).toBe("fixture");
    expect(report.items).toBe(7);
    // hand-set: en 2 edits of 14 words, hi 1 of 8 (chandrabindu is a different spelling), hinglish 1 of 10
    expect(report.byLanguage.en).toMatchObject({
      samples: 3,
      wordEdits: 2,
      referenceWords: 14,
      claimable: false,
    });
    expect(report.byLanguage.hi).toMatchObject({ wordEdits: 1, referenceWords: 8 });
    expect(report.byLanguage.hinglish).toMatchObject({ wordEdits: 1, referenceWords: 10 });
    expect(report.overall.corpusWer).toBeCloseTo(4 / 32, 10);
    expect(report.overall.corpusWerRange.low).toBeLessThanOrEqual(report.overall.corpusWer);
    expect(report.overall.corpusCerRange.high).toBeGreaterThanOrEqual(report.overall.corpusCer);
    expect(report.byCondition.quiet.samples).toBe(4);
    expect(report.byCondition.noisy.samples).toBe(3);
    expect(report.notes.join(" ")).toMatch(/not a claim/);
  });

  it("refuses a transcript for an item the manifest does not list, and for a changed reference", () => {
    const extra = join(dir, "extra.json");
    writeFileSync(
      extra,
      JSON.stringify({ ...JSON.parse(readFileSync(hyps, "utf8")), "t-zz-9": "invented" }),
    );
    const a = evalCli([
      "score",
      "--manifest",
      manifest,
      "--references",
      refs,
      "--hypotheses",
      extra,
    ]);
    expect(a.code).toBe(2);
    expect(a.out).toMatch(/no manifest entry for t-zz-9/);

    const edited = join(dir, "refs.json");
    writeFileSync(
      edited,
      JSON.stringify({ ...JSON.parse(readFileSync(refs, "utf8")), "t-en-1": "turn on the lights" }),
    );
    const b = evalCli([
      "score",
      "--manifest",
      manifest,
      "--references",
      edited,
      "--hypotheses",
      hyps,
    ]);
    expect(b.code).toBe(2);
    expect(b.out).toMatch(/reference of t-en-1 does not match/);
  });

  it("keeps the reference hashes in the fixture manifest equal to its sentences (Hindi included)", () => {
    const r = evalCli(["hash-references", "--references", refs]);
    const hashes = JSON.parse(r.out);
    const items = JSON.parse(readFileSync(join(fixtures, "synthetic-manifest.json"), "utf8")).items;
    for (const item of items) expect(hashes[item.id], item.id).toBe(item.referenceSha256);
  });

  it("reports bad usage with exit 1", () => {
    expect(evalCli(["bogus"]).code).toBe(1);
    expect(evalCli(["validate", "--manifest", join(dir, "missing.json")]).code).toBe(1);
    expect(evalCli(["score"]).code).toBe(1);
  });

  it("holds no audio and no private text in the repository's eval files", () => {
    for (const folder of [join(root, "config", "voice"), fixtures]) {
      for (const name of readdirSync(folder))
        expect(name).not.toMatch(/\.(wav|mp3|flac|ogg|m4a|opus)$/i);
    }
    const catalogue = JSON.parse(
      readFileSync(join(root, "config", "voice", "eval-manifest.json"), "utf8"),
    );
    expect(catalogue.items).toEqual([]);
    expect(catalogue.sources.every((s: { kind: string }) => s.kind === "public-dataset")).toBe(
      true,
    );
  });
});

describe("voice-readiness.cjs", () => {
  it("is UNVERIFIED at every level with no evidence, exit 0, and says no model ships", () => {
    const r = run("voice-readiness.cjs", []);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No trained model ships/);
    expect(r.out.match(/UNVERIFIED {2}/g)?.length).toBe(3);
    expect(r.out).not.toMatch(/PASS {2}/);
  });

  it("exits 3 under --require when a level is not PASS, and prints JSON on request", () => {
    expect(run("voice-readiness.cjs", ["--require", "1"]).code).toBe(3);
    const json = JSON.parse(run("voice-readiness.cjs", ["--json"]).out);
    expect(json.trainedModel).toBe("none");
    expect(json.levels.map((l: { status: string }) => l.status)).toEqual([
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
    ]);
  });

  it("reads a manifest and records from paths or the environment, and reports PARTIAL for the small fixture", () => {
    const records = join(dir, "records.json");
    writeFileSync(records, JSON.stringify({ schema: 1, runs: [], releases: [] }));
    const r = run("voice-readiness.cjs", ["--manifest", manifest, "--json"], {
      FRIDAY_VOICE_TRAINING_RECORDS: records,
    });
    const json = JSON.parse(r.out);
    expect(json.levels[0].status).toBe("PARTIAL");
    const coverage = json.levels[0].checks.find((c: { id: string }) => c.id === "test-coverage");
    expect(coverage.status).toBe("fail");
    expect(json.levels[1].status).toBe("UNVERIFIED");
  });

  it("reports a missing file with exit 1", () => {
    expect(run("voice-readiness.cjs", ["--manifest", join(dir, "nope.json")]).code).toBe(1);
    expect(run("voice-readiness.cjs", ["--records", join(dir, "nope.json")]).code).toBe(1);
  });
});

describe("package scripts", () => {
  it("exposes the eval and readiness commands", () => {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    expect(scripts["voice:eval"]).toBe("node scripts/voice-eval.cjs");
    expect(scripts["voice:readiness"]).toBe("node scripts/voice-readiness.cjs");
  });
});
