import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MIN_ITEMS_FOR_CLAIM,
  manifestSummary,
  scoreHeldOut,
  testSetLock,
  validateManifest,
} from "../../src/lib/friday/voice-engine/voice-eval-set";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Raw = any;

function item(id: string, over: Raw = {}): Raw {
  return {
    id,
    source: "pub",
    language: "en",
    split: "test",
    condition: "quiet",
    speaker: `s-${id}`,
    room: "r1",
    sha256: sha(`audio:${id}`),
    referenceSha256: sha(`ref:${id}`),
    durationMs: 2000,
    ...over,
  };
}

function manifest(over: Raw = {}): Raw {
  return {
    schema: 1,
    id: "t",
    title: "test manifest",
    createdOn: "2026-11-23",
    sources: [
      {
        id: "pub",
        name: "A public set",
        kind: "public-dataset",
        licence: "CC-BY-4.0",
        licenceCheckedOn: "2026-11-23",
        access: "open",
        origin: "https://example.org/set",
        languages: ["en", "hi"],
        uses: ["evaluate", "train"],
        consent: { basis: "public-licence" },
      },
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
    items: [
      item("t1"),
      item("t2", { language: "hi", condition: "noisy" }),
      item("d1", { split: "dev" }),
      item("r1", { split: "train" }),
    ],
    testLock: null,
    ...over,
  };
}

const problems = (raw: unknown) => validateManifest(raw, sha).problems.join("\n");

describe("manifest schema", () => {
  it("accepts a well-formed manifest and counts it", () => {
    const result = validateManifest(manifest(), sha);
    expect(result.problems).toEqual([]);
    const summary = manifestSummary(result.manifest!);
    expect(summary.splits.test).toMatchObject({ items: 2, speakers: 2, rooms: 1 });
    expect(summary.splits.train.items).toBe(1);
    expect(summary.byLanguage.hi.test).toBe(1);
    expect(summary.byCondition["noisy"]).toBe(1);
  });

  it("rejects fields that could carry audio or private text, and unknown keys everywhere", () => {
    const m = manifest();
    m.items[0].audio = "UklGRg==";
    m.items[1].text = "private sentence";
    m.sources[0].email = "x";
    m.extra = 1;
    const out = problems(m);
    expect(out).toMatch(/item t1: unknown field "audio"/);
    expect(out).toMatch(/item t2: unknown field "text"/);
    expect(out).toMatch(/source pub: unknown field "email"/);
    expect(out).toMatch(/manifest: unknown field "extra"/);
  });

  it("rejects bad hashes, duplicate ids, unknown source, language outside the source, bad enums", () => {
    const m = manifest();
    m.items[0].sha256 = "abc";
    m.items[1].id = "t1";
    m.items[2].source = "nope";
    m.items[3].language = "fr";
    m.items.push(
      item("x9", { condition: "underwater" }),
      item("x8", { source: "pub", language: "hinglish" }),
    );
    const out = problems(m);
    expect(out).toMatch(/item t1: sha256 must be 64 lowercase hex/);
    expect(out).toMatch(/duplicate item id "t1"/);
    expect(out).toMatch(/item d1: unknown source "nope"/);
    expect(out).toMatch(/item r1: language "fr"/);
    expect(out).toMatch(/item x9: condition "underwater"/);
    expect(out).toMatch(/item x8: language "hinglish" is not listed for source pub/);
  });

  it("keeps speaker and room as plain pseudonyms, never an address or a name with spaces", () => {
    const m = manifest();
    m.items[0].speaker = "someone@example.org";
    m.items[1].room = "living room";
    const out = problems(m);
    expect(out).toMatch(/item t1: speaker/);
    expect(out).toMatch(/item t2: room/);
  });
});

describe("licence, consent and use", () => {
  it("accepts only licences that allow reuse and fit the source kind", () => {
    const m = manifest();
    m.sources[0].licence = "CC-BY-NC-4.0";
    expect(problems(m)).toMatch(/source pub: licence "CC-BY-NC-4.0" is not allowed/);
    const n = manifest();
    n.sources[0].licence = "owner-private";
    expect(problems(n)).toMatch(
      /source pub: licence "owner-private" does not fit kind public-dataset/,
    );
    const o = manifest();
    o.sources[0].licence = "CC0-1.0";
    expect(problems(o)).toBe("");
  });

  it("needs a dated licence check", () => {
    const m = manifest();
    delete m.sources[0].licenceCheckedOn;
    expect(problems(m)).toMatch(/source pub: licenceCheckedOn/);
  });

  it("holds the owner's own recordings to a consent record", () => {
    const m = manifest();
    m.sources[1].consent = { basis: "public-licence" };
    expect(problems(m)).toMatch(
      /source own: consent basis "public-licence" does not fit kind own-recording/,
    );
    const n = manifest();
    n.sources[1].consent = { basis: "owner-self" };
    expect(problems(n)).toMatch(/source own: consent needs recordedOn/);
    const o = manifest();
    o.items.push(
      item("o1", { source: "own", speaker: "owner" }),
      item("o2", { source: "own", speaker: "guest", split: "dev" }),
    );
    expect(problems(o)).toMatch(/source own: consent owner-self covers one speaker, found 2/);
    o.sources[1].consent = { basis: "speaker-written", recordedOn: "2026-11-20" };
    expect(problems(o)).toBe("");
  });

  it("refuses a split the source is not cleared for", () => {
    const m = manifest();
    m.sources[0].uses = ["evaluate"];
    expect(problems(m)).toMatch(/item r1: split train is not allowed for source pub/);
  });
});

describe("held-out guarantees", () => {
  it("finds the same audio, or the same sentence, in the test set and in training", () => {
    const m = manifest();
    m.items[3].sha256 = m.items[0].sha256;
    m.items.push(item("r2", { split: "train", referenceSha256: m.items[1].referenceSha256 }));
    const out = problems(m);
    expect(out).toMatch(/same audio sha256 in items t1 and r1/);
    expect(out).toMatch(/same reference in items t2 and r2 across splits test and train/);
  });

  it("keeps public speakers in one split, but lets the owner's own voice be in several", () => {
    const m = manifest();
    m.items[3].speaker = m.items[0].speaker;
    expect(problems(m)).toMatch(/speaker s-t1 of source pub is in splits test and train/);
    const n = manifest();
    n.items.push(
      item("o1", { source: "own", speaker: "owner", split: "test" }),
      item("o2", { source: "own", speaker: "owner", split: "train" }),
    );
    expect(problems(n)).toBe("");
  });

  it("freezes the test set and notices any change after that", () => {
    const m = manifest();
    const raw = validateManifest(m, sha).manifest!;
    const lock = testSetLock(raw, sha);
    m.testLock = { sha256: lock, items: 2, frozenOn: "2026-11-23" };
    expect(problems(m)).toBe("");
    // training data may grow after the freeze
    m.items.push(item("r5", { split: "train" }));
    expect(problems(m)).toBe("");
    // a test item swapped, added or moved out is caught
    const swapped = JSON.parse(JSON.stringify(m));
    swapped.items[0].sha256 = sha("other");
    expect(problems(swapped)).toMatch(/test set changed after it was frozen/);
    const moved = JSON.parse(JSON.stringify(m));
    moved.items[1].split = "train";
    expect(problems(moved)).toMatch(/test set changed after it was frozen/);
    const added = JSON.parse(JSON.stringify(m));
    added.items.push(item("t3"));
    expect(problems(added)).toMatch(/test set changed after it was frozen/);
  });

  it("gives the same lock whatever the item order", () => {
    const a = validateManifest(manifest(), sha).manifest!;
    const b = validateManifest(manifest({ items: [...manifest().items].reverse() }), sha).manifest!;
    expect(testSetLock(a, sha)).toBe(testSetLock(b, sha));
  });
});

describe("scoring against a manifest", () => {
  const refs: Record<string, string> = {
    t1: "turn on the light",
    t2: "आज मौसम कैसा रहेगा",
    t3: "what is the weather",
    d1: "set an alarm",
  };
  function frozen(extra: Raw[] = []) {
    const m = manifest();
    m.items = [
      item("t1", { referenceSha256: sha(refs["t1"]!) }),
      item("t2", { language: "hi", condition: "noisy", referenceSha256: sha(refs["t2"]!) }),
      item("t3", { condition: "noisy", referenceSha256: sha(refs["t3"]!) }),
      item("d1", { split: "dev", referenceSha256: sha(refs["d1"]!) }),
      ...extra,
    ];
    const raw = validateManifest(m, sha).manifest!;
    m.testLock = { sha256: testSetLock(raw, sha), items: 3, frozenOn: "2026-11-23" };
    return m;
  }
  const hyps = { t1: "turn on the lite", t2: "आज मौसम कैसा रहेगा", t3: "what is the weather" };

  it("reports word and character error with ranges per language and per condition", () => {
    const out = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: hyps,
      sha256: sha,
      engine: "fake",
    });
    expect(out.status).toBe("scored");
    if (out.status !== "scored") return;
    const r = out.report;
    expect(r.split).toBe("test");
    expect(r.items).toBe(3);
    expect(r.missing).toEqual([]);
    // en: "turn on the light" -> 1 word wrong of 4; "what is the weather" exact -> 1 of 8
    expect(r.byLanguage.en!.samples).toBe(2);
    expect(r.byLanguage.en!.wordEdits).toBe(1);
    expect(r.byLanguage.en!.referenceWords).toBe(8);
    expect(r.byLanguage.hi!.corpusWer).toBe(0);
    expect(r.byCondition["noisy"]!.samples).toBe(2);
    expect(r.byCondition["quiet"]!.corpusWer).toBeCloseTo(1 / 4, 10);
    expect(r.byLanguageCondition["en/noisy"]!.samples).toBe(1);
    expect(r.byLanguage.en!.corpusCerRange).not.toBeNull();
    expect(r.overall.corpusWerRange).not.toBeNull();
  });

  it("says a group is too small to be a claim, but still shows it", () => {
    const out = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: hyps,
      sha256: sha,
    });
    if (out.status !== "scored") throw new Error("expected a report");
    expect(MIN_ITEMS_FOR_CLAIM).toBeGreaterThanOrEqual(30);
    expect(out.report.overall.claimable).toBe(false);
    expect(out.report.byLanguage.en!.claimable).toBe(false);
    expect(out.report.notes.join(" ")).toMatch(/fewer than/);
  });

  it("counts an item with no transcript as everything missed, and lists it", () => {
    const out = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: { t1: hyps["t1"], t2: hyps["t2"] },
      sha256: sha,
    });
    if (out.status !== "scored") throw new Error("expected a report");
    expect(out.report.missing).toEqual(["t3"]);
    expect(out.report.byLanguage.en!.wordEdits).toBe(1 + 4);
  });

  it("refuses a transcript for an id the manifest does not list", () => {
    const out = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: { ...hyps, zz: "invented" },
      sha256: sha,
    });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.reasons.join(" ")).toMatch(/no manifest entry for zz/);
  });

  it("refuses a transcript for an item of another split", () => {
    const out = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: { ...hyps, d1: "set an alarm" },
      sha256: sha,
    });
    expect(out.status).toBe("refused");
    if (out.status === "refused") expect(out.reasons.join(" ")).toMatch(/d1 is in split dev/);
  });

  it("refuses a reference that is missing or is not the one the manifest hashed", () => {
    const missing = scoreHeldOut({
      manifest: frozen(),
      references: { t1: refs["t1"]!, t2: refs["t2"]! },
      hypotheses: hyps,
      sha256: sha,
    });
    expect(missing.status).toBe("refused");
    const changed = scoreHeldOut({
      manifest: frozen(),
      references: { ...refs, t1: "turn on the lights" },
      hypotheses: hyps,
      sha256: sha,
    });
    expect(changed.status).toBe("refused");
    if (changed.status === "refused")
      expect(changed.reasons.join(" ")).toMatch(/reference of t1 does not match/);
  });

  it("refuses to report on the test set before it is frozen, on the training split, or on a broken manifest", () => {
    const open = frozen();
    open.testLock = null;
    const a = scoreHeldOut({ manifest: open, references: refs, hypotheses: hyps, sha256: sha });
    expect(a.status === "refused" && a.reasons.join(" ")).toMatch(/not frozen/);
    const b = scoreHeldOut({
      manifest: frozen(),
      references: refs,
      hypotheses: hyps,
      sha256: sha,
      split: "train" as never,
    });
    expect(b.status === "refused" && b.reasons.join(" ")).toMatch(/split train is never scored/);
    const broken = frozen();
    broken.items[0].sha256 = "zz";
    const c = scoreHeldOut({ manifest: broken, references: refs, hypotheses: hyps, sha256: sha });
    expect(c.status === "refused" && c.reasons.join(" ")).toMatch(/manifest is not valid/);
  });

  it("scores dev without a freeze, and refuses an empty manifest rather than printing a number", () => {
    const open = frozen();
    open.testLock = null;
    const dev = scoreHeldOut({
      manifest: open,
      references: refs,
      hypotheses: { d1: "set an alarm" },
      sha256: sha,
      split: "dev",
    });
    expect(dev.status).toBe("scored");
    const empty = manifest({ items: [] });
    const out = scoreHeldOut({ manifest: empty, references: {}, hypotheses: {}, sha256: sha });
    expect(out.status === "refused" && out.reasons.join(" ")).toMatch(/no items in split test/);
  });

  it("holds Hindi text and apostrophes as they are", () => {
    const m = frozen();
    const ref = "यह मेरा 'घर' है & 100% सही";
    m.items = [item("t1", { language: "hi", referenceSha256: sha(ref) })];
    m.testLock = null;
    const lock = testSetLock(validateManifest(m, sha).manifest!, sha);
    m.testLock = { sha256: lock, items: 1, frozenOn: "2026-11-23" };
    const out = scoreHeldOut({
      manifest: m,
      references: { t1: ref },
      hypotheses: { t1: ref },
      sha256: sha,
    });
    if (out.status !== "scored") throw new Error("expected a report");
    expect(out.report.byLanguage.hi!.corpusWer).toBe(0);
  });
});
