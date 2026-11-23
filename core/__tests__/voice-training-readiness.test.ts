import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessReadiness,
  trainSetSha256,
  type ReadinessSpec,
} from "../../src/lib/friday/voice-engine/voice-training-readiness";
import { testSetLock, validateManifest } from "../../src/lib/friday/voice-engine/voice-eval-set";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const root = join(__dirname, "..", "..");
const realSpec = JSON.parse(
  readFileSync(join(root, "config/voice/training-readiness.json"), "utf8"),
);

// small thresholds so a test manifest can be built by hand
const spec: ReadinessSpec = {
  ...realSpec,
  thresholds: { ...realSpec.thresholds, minTestItemsPerLanguage: 2, minTrainHours: 0.001 },
};
const everything = () => true;

type Raw = any;
function item(id: string, over: Raw = {}): Raw {
  return {
    id,
    source: "own",
    language: "en",
    split: "test",
    condition: "quiet",
    speaker: "owner",
    room: "desk",
    sha256: sha(`audio:${id}`),
    referenceSha256: sha(`ref:${id}`),
    durationMs: 5000,
    ...over,
  };
}
function goodManifest(): Raw {
  const items: Raw[] = [];
  for (const lang of ["hi", "en", "hinglish"]) {
    items.push(item(`t-${lang}-1`, { language: lang }));
    items.push(item(`t-${lang}-2`, { language: lang, condition: "noisy", room: "hall" }));
    items.push(item(`r-${lang}-1`, { language: lang, split: "train" }));
  }
  const m: Raw = {
    schema: 1,
    id: "own-1",
    title: "owner recordings",
    createdOn: "2026-11-23",
    sources: [
      {
        id: "own",
        name: "Owner recordings",
        kind: "own-recording",
        licence: "owner-private",
        licenceCheckedOn: "2026-11-23",
        access: "local-only",
        origin: "recorded on the owner's PC",
        languages: ["hi", "en", "hinglish"],
        uses: ["evaluate", "train"],
        consent: { basis: "owner-self", recordedOn: "2026-11-20" },
      },
    ],
    items,
    testLock: null,
  };
  m.testLock = {
    sha256: testSetLock(validateManifest(m, sha).manifest!, sha),
    items: 6,
    frozenOn: "2026-11-23",
  };
  return m;
}
const run = (over: Raw = {}): Raw => ({
  id: "run-1",
  createdOn: "2026-11-24",
  method: "lora",
  baseModel: { id: "openai/whisper-small", revision: "abc1234", licence: "MIT" },
  offline: true,
  networkUsed: false,
  dataSources: ["own"],
  trainItemIds: ["r-hi-1", "r-en-1", "r-hinglish-1"],
  testLockSha256: (goodManifest().testLock as Raw).sha256,
  artifact: { sha256: sha("adapter-1") },
  ...over,
});
const report = (wer: Record<string, number>, lock?: string): Raw => ({
  split: "test",
  lock: lock ?? (goodManifest().testLock as Raw).sha256,
  engine: "x",
  overall: { corpusWer: wer["all"], claimable: true },
  byLanguage: Object.fromEntries(
    Object.entries(wer)
      .filter(([k]) => k !== "all")
      .map(([k, v]) => [k, { corpusWer: v, claimable: true }]),
  ),
});
const release = (over: Raw = {}): Raw => ({
  version: "1.0.0",
  run: "run-1",
  status: "active",
  artifactSha256: sha("adapter-1"),
  previous: null,
  rollbackTestedOn: "2026-11-26",
  evaluation: {
    base: report({ all: 0.3, hi: 0.35, en: 0.2, hinglish: 0.4 }),
    adapter: report({ all: 0.25, hi: 0.3, en: 0.2, hinglish: 0.33 }),
  },
  ...over,
});
const records = (r: Raw[] = [run()], rel: Raw[] = [release()]) => ({
  schema: 1,
  runs: r,
  releases: rel,
});
const assess = (input: {
  manifest?: unknown;
  records?: unknown;
  exists?: (p: string) => boolean;
}) => assessReadiness({ spec, sha256: sha, exists: input.exists ?? everything, ...input });
const check = (out: ReturnType<typeof assess>, level: number, id: string) =>
  out.levels[level - 1]!.checks.find((c) => c.id === id)!;

describe("the real readiness spec", () => {
  it("has the three levels in order, with tooling that exists in this repository", () => {
    expect(realSpec.levels.map((l: Raw) => l.level)).toEqual([1, 2, 3]);
    for (const level of realSpec.levels) {
      for (const file of level.tooling) {
        expect(() => readFileSync(join(root, file)), file).not.toThrow();
      }
    }
  });
});

describe("with no evidence", () => {
  it("is unverified at every level and ships no trained model", () => {
    const out = assess({});
    expect(out.levels.map((l) => l.status)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED"]);
    expect(out.trainedModel).toBe("none");
    expect(out.summary).toMatch(/no trained model/i);
  });

  it("is unverified, not failed, for an empty manifest", () => {
    const empty = { ...goodManifest(), items: [], testLock: null };
    expect(assess({ manifest: empty }).levels[0]!.status).toBe("UNVERIFIED");
  });
});

describe("level 1: collect, label, consent", () => {
  it("passes for a valid, consented, frozen set with enough coverage", () => {
    const out = assess({ manifest: goodManifest() });
    expect(out.levels[0]!.status).toBe("PASS");
  });

  it("is partial when the test set is not frozen or covers one room", () => {
    const open = { ...goodManifest(), testLock: null };
    const a = assess({ manifest: open });
    expect(a.levels[0]!.status).toBe("PARTIAL");
    expect(check(a, 1, "test-frozen").status).toBe("fail");
    const m = goodManifest();
    for (const i of m.items) i.room = "desk";
    m.testLock = {
      ...m.testLock,
      sha256: testSetLock(validateManifest({ ...m, testLock: null }, sha).manifest!, sha),
    };
    const b = assess({ manifest: m });
    expect(check(b, 1, "test-coverage").status).toBe("fail");
    expect(check(b, 1, "test-coverage").detail).toMatch(/rooms/);
  });

  it("fails the manifest check and names the problem for an invalid manifest", () => {
    const m = goodManifest();
    m.items[0].audio = "UklGRg==";
    const out = assess({ manifest: m });
    expect(check(out, 1, "manifest-valid").status).toBe("fail");
    expect(check(out, 1, "manifest-valid").detail).toMatch(/unknown field "audio"/);
    expect(out.levels[0]!.status).toBe("PARTIAL");
  });

  it("fails when too few training hours were collected", () => {
    const strict: ReadinessSpec = { ...spec, thresholds: { ...spec.thresholds, minTrainHours: 5 } };
    const out = assessReadiness({
      spec: strict,
      sha256: sha,
      exists: everything,
      manifest: goodManifest(),
    });
    expect(check(out, 1, "own-train-hours").status).toBe("fail");
  });

  it("says when its own tooling is missing", () => {
    const out = assess({ manifest: goodManifest(), exists: (p) => !p.endsWith("voice-eval.cjs") });
    expect(check(out, 1, "tooling").status).toBe("fail");
    expect(check(out, 1, "tooling").detail).toMatch(/voice-eval\.cjs/);
    expect(out.levels[0]!.status).toBe("PARTIAL");
  });
});

describe("level 2: adapt offline", () => {
  const good = () => assess({ manifest: goodManifest(), records: records([run()], []) });

  it("passes for an offline run on listed train items of a consented source", () => {
    expect(good().levels[1]!.status).toBe("PASS");
  });

  it("is unverified with no run record", () => {
    const out = assess({ manifest: goodManifest(), records: records([], []) });
    expect(out.levels[1]!.status).toBe("UNVERIFIED");
  });

  it("fails on a test or dev item among the training items", () => {
    const out = assess({
      manifest: goodManifest(),
      records: records([run({ trainItemIds: ["r-hi-1", "t-en-1"] })], []),
    });
    expect(check(out, 2, "no-test-leak").status).toBe("fail");
    expect(check(out, 2, "no-test-leak").detail).toMatch(/run-1.*t-en-1/);
    expect(out.levels[1]!.status).toBe("PARTIAL");
  });

  it("fails on an unknown id, an unlisted source, or a source not cleared for training", () => {
    const unknown = assess({
      manifest: goodManifest(),
      records: records([run({ trainItemIds: ["nope"] })], []),
    });
    expect(check(unknown, 2, "consented-train-data").status).toBe("fail");
    const m = goodManifest();
    m.sources[0].uses = ["evaluate"];
    // the manifest itself is now invalid (train items in an evaluate-only source)
    const out = assess({ manifest: m, records: records([run()], []) });
    expect(check(out, 2, "consented-train-data").status).not.toBe("pass");
    const unlisted = assess({
      manifest: goodManifest(),
      records: records([run({ dataSources: [] })], []),
    });
    expect(check(unlisted, 2, "consented-train-data").status).toBe("fail");
  });

  it("fails when the run used the network, or the base licence or revision is missing", () => {
    expect(
      check(
        assess({ manifest: goodManifest(), records: records([run({ networkUsed: true })], []) }),
        2,
        "offline-attested",
      ).status,
    ).toBe("fail");
    expect(
      check(
        assess({
          manifest: goodManifest(),
          records: records(
            [run({ baseModel: { id: "x", revision: "r", licence: "CC-BY-NC-4.0" } })],
            [],
          ),
        }),
        2,
        "base-model-licence",
      ).status,
    ).toBe("fail");
    expect(
      check(
        assess({
          manifest: goodManifest(),
          records: records([run({ baseModel: { id: "x", licence: "MIT" } })], []),
        }),
        2,
        "base-model-licence",
      ).status,
    ).toBe("fail");
  });

  it("fails when the test set was changed after the run", () => {
    const out = assess({
      manifest: goodManifest(),
      records: records([run({ testLockSha256: sha("old") })], []),
    });
    expect(check(out, 2, "test-set-unchanged").status).toBe("fail");
  });

  it("needs a hashed artifact and a known method", () => {
    const out = assess({
      manifest: goodManifest(),
      records: records([run({ artifact: {}, method: "magic" })], []),
    });
    expect(check(out, 2, "artifact-hashed").status).toBe("fail");
  });

  it("cannot pass while level 1 does not", () => {
    const out = assess({
      manifest: { ...goodManifest(), testLock: null },
      records: records([run()], []),
    });
    expect(out.levels[1]!.status).toBe("PARTIAL");
    expect(check(out, 2, "previous-level").status).toBe("fail");
  });

  it("names the training set by a hash of its sorted ids", () => {
    expect(trainSetSha256(["b", "a"], sha)).toBe(trainSetSha256(["a", "b"], sha));
    expect(trainSetSha256(["a"], sha)).not.toBe(trainSetSha256(["a", "b"], sha));
  });
});

describe("level 3: evaluate, version, roll back", () => {
  const good = () => assess({ manifest: goodManifest(), records: records() });

  it("passes for a release compared with the base model on the same frozen test set", () => {
    expect(good().levels[2]!.status).toBe("PASS");
  });

  it("is unverified with no release", () => {
    expect(
      assess({ manifest: goodManifest(), records: records([run()], []) }).levels[2]!.status,
    ).toBe("UNVERIFIED");
  });

  it("fails when a report was made on another test set", () => {
    const r = release();
    r.evaluation.adapter = report({ all: 0.2, en: 0.2 }, sha("other"));
    const out = assess({ manifest: goodManifest(), records: records([run()], [r]) });
    expect(check(out, 3, "evaluated-on-frozen-test").status).toBe("fail");
  });

  it("fails when the adapter is worse than the base model, overall or in one language", () => {
    const worse = release();
    worse.evaluation.adapter = report({ all: 0.4, hi: 0.5, en: 0.3, hinglish: 0.4 });
    expect(
      check(
        assess({ manifest: goodManifest(), records: records([run()], [worse]) }),
        3,
        "not-worse-than-base",
      ).status,
    ).toBe("fail");
    const oneLang = release();
    oneLang.evaluation.adapter = report({ all: 0.25, hi: 0.2, en: 0.3, hinglish: 0.3 });
    const out = assess({ manifest: goodManifest(), records: records([run()], [oneLang]) });
    expect(check(out, 3, "not-worse-than-base").detail).toMatch(/en/);
    const within = release();
    within.evaluation.adapter = report({ all: 0.3, hi: 0.35, en: 0.21, hinglish: 0.4 });
    expect(
      check(
        assess({ manifest: goodManifest(), records: records([run()], [within]) }),
        3,
        "not-worse-than-base",
      ).status,
    ).toBe("pass");
  });

  it("does not trust a number from a group too small to be a claim", () => {
    const r = release();
    r.evaluation.adapter.overall.claimable = false;
    const out = assess({ manifest: goodManifest(), records: records([run()], [r]) });
    expect(check(out, 3, "not-worse-than-base").status).toBe("fail");
  });

  it("needs unique versions, a known run, a hashed artifact, a real previous and one active", () => {
    const a = release();
    const b = release({ version: "1.0.0" });
    expect(
      check(assess({ manifest: goodManifest(), records: records([run()], [a, b]) }), 3, "versioned")
        .status,
    ).toBe("fail");
    expect(
      check(
        assess({
          manifest: goodManifest(),
          records: records([run()], [release({ run: "run-9" })]),
        }),
        3,
        "versioned",
      ).status,
    ).toBe("fail");
    expect(
      check(
        assess({
          manifest: goodManifest(),
          records: records([run()], [release({ previous: "0.9" })]),
        }),
        3,
        "versioned",
      ).status,
    ).toBe("fail");
    expect(
      check(
        assess({
          manifest: goodManifest(),
          records: records([run()], [release({ artifactSha256: "x" })]),
        }),
        3,
        "versioned",
      ).status,
    ).toBe("fail");
    const two = [release(), release({ version: "1.1.0", previous: "1.0.0" })];
    expect(
      check(assess({ manifest: goodManifest(), records: records([run()], two) }), 3, "versioned")
        .detail,
    ).toMatch(/one active/);
  });

  it("needs a rollback that was tried on a date", () => {
    const out = assess({
      manifest: goodManifest(),
      records: records([run()], [release({ rollbackTestedOn: undefined })]),
    });
    expect(check(out, 3, "rollback-ready").status).toBe("fail");
    expect(out.levels[2]!.status).toBe("PARTIAL");
  });

  it("is only a candidate until one release is active", () => {
    const out = assess({
      manifest: goodManifest(),
      records: records([run()], [release({ status: "candidate" })]),
    });
    expect(check(out, 3, "rollback-ready").status).toBe("unverified");
    expect(out.levels[2]!.status).toBe("PARTIAL");
  });
});

describe("garbage input", () => {
  it("never throws on records of the wrong shape", () => {
    for (const bad of [
      null,
      7,
      "x",
      [],
      { runs: "no", releases: 3 },
      { runs: [null, 5], releases: [[], "x"] },
    ]) {
      const out = assess({ manifest: goodManifest(), records: bad });
      expect(out.levels).toHaveLength(3);
      expect(out.levels[1]!.status).not.toBe("PASS");
      expect(out.levels[2]!.status).not.toBe("PASS");
    }
  });
});
