/**
 * Chat-engine choice between FRIDAY's own llama.cpp build and the official one: the winner rule, the bench file,
 * the standby plan and the Doctor strings. Pure module, fake runs and a throwaway folder: no network, no GPU, no clock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "../..");
const sel = require_(path.join(repo, "electron/llm-engine-select.cjs"));
const llama = require_(path.join(repo, "electron/llama-runtime.cjs"));

const toks = (n: number, flipAt = -1) =>
  Array.from({ length: n }, (_, i) => (i === flipAt ? 9999 : i + 1));
const run = (tps: number, tokens = toks(32), smokePassed = true) => ({ smokePassed, tps, tokens });
const facts = {
  ramGb: 16,
  cores: 8,
  cpuModel: "CPU X",
  gpu: "none",
  ownTag: "b1234",
  officialTag: "b1234",
};
const folder = (name: string, origin: string | undefined, extra: Record<string, unknown> = {}) => ({
  name,
  dir: `/e/${name}`,
  trusted: true,
  marker: { ...(origin ? { origin } : {}), ...extra },
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "friday-llm-sel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("decideWinner", () => {
  it("own wins with a 16-token prefix match and at least 1.05x speed", () => {
    const d = sel.decideWinner(run(21), run(20));
    expect(d.winner).toBe("own");
    expect(d.sameTokens).toBe(32);
  });
  it("a 16 token prefix is enough: a later difference does not fail it", () => {
    expect(sel.decideWinner(run(30, toks(32, 20)), run(20)).winner).toBe("own");
  });
  it("a difference before token 16 gives the official engine the win", () => {
    const d = sel.decideWinner(run(30, toks(32, 10)), run(20));
    expect(d.winner).toBe("official");
    expect(d.reason).toBe("tokens-differ");
  });
  it("fewer than 16 tokens cannot prove equality", () => {
    expect(sel.decideWinner(run(30, toks(15)), run(20, toks(15))).winner).toBe("official");
  });
  it("below 1.05x the official engine stays", () => {
    const d = sel.decideWinner(run(20.9), run(20));
    expect(d.winner).toBe("official");
    expect(d.reason).toBe("not-faster");
  });
  it("a failed smoke on the own build loses at once", () => {
    const d = sel.decideWinner(run(99, toks(32), false), run(20));
    expect(d.winner).toBe("official");
    expect(d.reason).toBe("own-smoke-failed");
  });
  it("nothing measured gives no winner and flags it", () => {
    const d = sel.decideWinner({ smokePassed: false }, { smokePassed: false });
    expect(d.winner).toBeNull();
    expect(d.measured).toBe(false);
  });
  it("the thresholds are exported and marked unverified", () => {
    expect(sel.MIN_PREFIX_TOKENS).toBe(16);
    expect(sel.MIN_SPEEDUP).toBe(1.05);
    expect(sel.THRESHOLDS_UNVERIFIED).toBe(true);
  });
});

describe("fingerprint and the bench file", () => {
  it("is stable and changes with RAM, tag or CPU", () => {
    expect(sel.fingerprint(facts)).toEqual(sel.fingerprint({ ...facts }));
    expect(
      sel.sameFingerprint(sel.fingerprint(facts), sel.fingerprint({ ...facts, ramGb: 32 })),
    ).toBe(false);
    expect(
      sel.sameFingerprint(sel.fingerprint(facts), sel.fingerprint({ ...facts, ownTag: "b1300" })),
    ).toBe(false);
    expect(
      sel.sameFingerprint(sel.fingerprint(facts), sel.fingerprint({ ...facts, cpuModel: "CPU Y" })),
    ).toBe(false);
  });
  it("writes v1 atomically and reads it back", () => {
    const d = sel.decideWinner(run(21), run(20));
    expect(
      sel.writeBench(
        dir,
        { fingerprint: sel.fingerprint(facts), ...d, spec: "off" },
        { now: () => 1000 },
      ),
    ).toBe(true);
    const file = path.join(dir, "cache", "llm-engine-auto.json");
    expect(JSON.parse(readFileSync(file, "utf8")).v).toBe(1);
    expect(readdirSync(path.join(dir, "cache")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const back = sel.readBench(dir, { fingerprint: sel.fingerprint(facts) });
    expect(back.winner).toBe("own");
    expect(back.at).toBe(1000);
  });
  it("never stores a bench that measured nothing", () => {
    const d = sel.decideWinner({ smokePassed: false }, { smokePassed: false });
    expect(sel.writeBench(dir, { fingerprint: sel.fingerprint(facts), ...d })).toBe(false);
    expect(existsSync(path.join(dir, "cache", "llm-engine-auto.json"))).toBe(false);
  });
  it("a changed fingerprint invalidates the stored bench", () => {
    sel.writeBench(dir, {
      fingerprint: sel.fingerprint(facts),
      ...sel.decideWinner(run(21), run(20)),
    });
    expect(
      sel.readBench(dir, { fingerprint: sel.fingerprint({ ...facts, ramGb: 64 }) }),
    ).toBeNull();
  });
  it("a missing, broken or wrong-version file reads as null", () => {
    expect(sel.readBench(dir)).toBeNull();
    mkdirSync(path.join(dir, "cache"), { recursive: true });
    const file = path.join(dir, "cache", "llm-engine-auto.json");
    writeFileSync(file, "{nope");
    expect(sel.readBench(dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ v: 2, winner: "own", ownTps: 1 }));
    expect(sel.readBench(dir)).toBeNull();
    writeFileSync(file, JSON.stringify({ v: 1, winner: "../evil", ownTps: 1 }));
    expect(sel.readBench(dir)).toBeNull();
  });
});

describe("pickEngine", () => {
  const both = [
    folder("b1234-own", "friday-own", { tag: "b1234" }),
    folder("b1234", "official", { tag: "b1234" }),
  ];
  const bench = { v: 1, winner: "own", ownTps: 21, officialTps: 20 };

  it("auto with an own-winning bench picks own and keeps official as standby", () => {
    const p = sel.pickEngine({ markers: both, bench, prefer: "auto", tagsEqual: true });
    expect(p.engine).toBe("own");
    expect(p.entry.name).toBe("b1234-own");
    expect(p.standby.name).toBe("b1234");
  });
  it("auto without a bench starts the official engine", () => {
    expect(
      sel.pickEngine({ markers: both, bench: null, prefer: "auto", tagsEqual: true }).engine,
    ).toBe("official");
  });
  it("differing tags: official wins and the own build is reported outdated", () => {
    const p = sel.pickEngine({ markers: both, bench, prefer: "auto", tagsEqual: false });
    expect(p.engine).toBe("official");
    expect(p.outdated).toBe(true);
  });
  it("a marker without origin counts as official", () => {
    const p = sel.pickEngine({
      markers: [folder("b1", undefined)],
      bench: null,
      prefer: "auto",
      tagsEqual: true,
    });
    expect(p.engine).toBe("official");
  });
  it("prefer own and prefer official are honoured; a missing one falls to the other", () => {
    expect(
      sel.pickEngine({ markers: both, bench: null, prefer: "own", tagsEqual: true }).engine,
    ).toBe("own");
    expect(
      sel.pickEngine({ markers: both, bench, prefer: "official", tagsEqual: true }).engine,
    ).toBe("official");
    const onlyOfficial = [folder("b1", "official")];
    expect(
      sel.pickEngine({ markers: onlyOfficial, bench, prefer: "own", tagsEqual: true }).engine,
    ).toBe("official");
  });
  it("an unhealthy own folder (callback or untrusted marker) is skipped", () => {
    const p = sel.pickEngine({
      markers: both,
      bench,
      prefer: "own",
      tagsEqual: true,
      isHealthy: (e: { name: string }) => e.name !== "b1234-own",
    });
    expect(p.engine).toBe("official");
    const demoted = [{ ...both[0], trusted: false }, both[1]];
    expect(sel.pickEngine({ markers: demoted, bench, prefer: "own", tagsEqual: true }).engine).toBe(
      "official",
    );
  });
  it("nothing installed gives engine null", () => {
    expect(
      sel.pickEngine({ markers: [], bench: null, prefer: "auto", tagsEqual: true }).engine,
    ).toBeNull();
  });
  it("consumes orderedFolders: a healthy:false own marker is demoted by that function, not by a second rule", () => {
    const base = path.join(dir, "engines");
    const put = (name: string, marker: Record<string, unknown>) => {
      mkdirSync(path.join(base, name), { recursive: true });
      writeFileSync(path.join(base, name, llama.ENGINE_MARKER), JSON.stringify(marker));
    };
    put("b1234-own", { origin: "friday-own", healthy: false, installedAt: 5 });
    put("b1234", { origin: "official", installedAt: 1 });
    const p = sel.pickEngine({
      markers: llama.orderedFolders(base),
      bench,
      prefer: "own",
      tagsEqual: true,
    });
    expect(p.engine).toBe("official");
  });
});

describe("standbyPlan", () => {
  const GB = 1024 ** 3;
  it("is cold by default with a small context", () => {
    const p = sel.standbyPlan({ totalRamGb: 16, freeRamGb: 12, modelBytes: 2.5 * GB });
    expect(p.mode).toBe("cold");
    expect(p.args).toEqual(["-c", "2048", "-np", "1"]);
  });
  it("is hot only with 32 GB total and free RAM above model plus 4 GB", () => {
    expect(sel.standbyPlan({ totalRamGb: 32, freeRamGb: 10, modelBytes: 5 * GB }).mode).toBe("hot");
    expect(sel.standbyPlan({ totalRamGb: 32, freeRamGb: 8, modelBytes: 5 * GB }).mode).toBe("cold");
    expect(sel.standbyPlan({ totalRamGb: 31, freeRamGb: 30, modelBytes: 1 * GB }).mode).toBe(
      "cold",
    );
  });
  it("bad numbers fall to cold", () => {
    expect(sel.standbyPlan({ totalRamGb: NaN, freeRamGb: 40, modelBytes: 1 }).mode).toBe("cold");
    expect(sel.standbyPlan({}).mode).toBe("cold");
  });
});

describe("rowNames", () => {
  it("names the two engines", () => {
    const r = sel.rowNames({ ownTag: "b1234", officialTag: "b1234" });
    expect(r.own).toBe("FRIDAY Runtime LLM (own build b1234, native)");
    expect(r.official).toBe("llama.cpp b1234 (official, cpu)");
    expect(sel.rowNames({ officialTag: "b9", officialBackend: "cuda" }).official).toBe(
      "llama.cpp b9 (official, cuda)",
    );
  });
  it("states own active with the measured gain", () => {
    const r = sel.rowNames({
      ownTag: "b1",
      officialTag: "b1",
      active: "own",
      ownTps: 21,
      officialTps: 20,
    });
    expect(r.status).toBe(
      "FRIDAY Runtime LLM: own active, official ready as fallback (own +5 percent on this PC)",
    );
  });
  it("says own build outdated when the tags differ", () => {
    const r = sel.rowNames({ ownTag: "b1", officialTag: "b2", active: "official" });
    expect(r.outdated).toBe("own build outdated");
  });
  it("has no outdated row for equal tags and no adapter text", () => {
    const r = sel.rowNames({ ownTag: "b1", officialTag: "b1", active: "official" });
    expect(r.outdated).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/adapter/i);
  });
});
