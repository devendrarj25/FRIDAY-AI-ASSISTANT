/**
 * voice-bench stt-stream with a fake streaming ear: no weights, no audio of a person, no network. The recordings are
 * tiny files whose bytes are the synthetic manifest's placeholders; the baseline is written under a temp root.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const fixtures = join(root, "core", "fixtures", "voice-eval");
const req = createRequire(import.meta.url);
const bench = req("../../scripts/voice-bench.cjs") as {
  EXIT: Record<string, number>;
  readPcm16: (file: string) => Buffer;
  main: (argv: string[], deps?: Record<string, unknown>) => Promise<number>;
};

type Item = { id: string; language: string; split: string };
const references = JSON.parse(
  readFileSync(join(fixtures, "synthetic-references.json"), "utf8"),
) as Record<string, string>;
let dir = "";
let manifest = "";
let friday = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stt-stream-"));
  friday = join(dir, "friday");
  manifest = join(dir, "manifest.json");
  copyFileSync(join(fixtures, "synthetic-manifest.json"), manifest);
  mkdirSync(join(dir, "audio"));
  for (const item of JSON.parse(readFileSync(manifest, "utf8")).items as Item[])
    writeFileSync(join(dir, "audio", `${item.id}.wav`), `synthetic-audio:${item.id}`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake ear: says the reference, except where `wrong` names an id; partials and a timeline on the audio clock. */
const fakeAdapter =
  (wrong: Record<string, string> = {}) =>
  () => ({
    available: async () => ({ ok: true }),
    open: async () => {},
    sample: async (item: { id: string }) => {
      const text = wrong[item.id] ?? references[item.id] ?? "";
      const first = text.split(" ")[0] ?? "";
      return {
        hypothesis: text,
        partials: [first, text],
        timeline: {
          audioMs: 1000,
          computeMs: 200,
          events: [
            { t: 0, kind: "speech_start" },
            { t: 160, kind: "partial", text: first },
            { t: 480, kind: "partial", text },
            { t: 1000, kind: "speech_end" },
            { t: 1200, kind: "endpoint" },
            { t: 1300, kind: "final", text },
          ],
        },
      };
    },
    close: () => {},
  });

async function run(extra: string[], deps: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await bench.main(
    ["stt-stream", "--manifest", manifest, "--references", join(fixtures, "synthetic-references.json"),
     "--audio", join(dir, "audio"), "--root", friday, ...extra], // prettier-ignore
    { out: (l: string) => lines.push(l), clock: () => new Date("2026-11-24T10:00:00Z"), ...deps },
  );
  return { code, text: lines.join("\n") };
}
const baselineFile = () => join(friday, "reports", "stt-baseline-stream-ear-nemotron.json");

describe("voice-bench stt-stream", () => {
  it("writes one baseline with a block per language under <root>/reports", async () => {
    const { code, text } = await run([], { streamAdapter: fakeAdapter() });
    expect(code).toBe(bench.EXIT["OK"]);
    const data = JSON.parse(readFileSync(baselineFile(), "utf8"));
    expect(data.kind).toBe("stt-baseline");
    expect(data.normaliser).toBe("fold-1");
    expect(Object.keys(data.languages).length).toBeGreaterThan(1);
    expect(data.overall.foldedWer).toBe(0);
    expect(data.overall.latency.timeToFirstPartialMs.p50).toBe(160);
    expect(text).toMatch(/baseline written/);
    expect(text).toMatch(/no earlier baseline/);
  });

  it("gates a worse run against the earlier baseline and passes an equal one", async () => {
    await run([], { streamAdapter: fakeAdapter() });
    const earlier = join(dir, "earlier.json");
    copyFileSync(baselineFile(), earlier);
    const same = await run(["--baseline", earlier], { streamAdapter: fakeAdapter() });
    expect(same.code).toBe(bench.EXIT["OK"]);
    expect(same.text).toMatch(/GATE PASS/);
    const ids = (JSON.parse(readFileSync(earlier, "utf8")).rows as { id: string }[]).map(
      (r) => r.id,
    );
    const wrong = Object.fromEntries(ids.map((id) => [id, "zzz qqq"]));
    const worse = await run(["--baseline", earlier], { streamAdapter: fakeAdapter(wrong) });
    expect(worse.code).toBe(bench.EXIT["REFUSED"]);
    expect(worse.text).toMatch(/GATE FAIL/);
  });

  it("refuses clearly with no weights and writes nothing", async () => {
    const noWeights = () => ({
      available: async () => ({ ok: true }),
      open: async () => {},
      sample: async () => {
        throw new Error("no-weights");
      },
      close: () => {},
    });
    const { code, text } = await run([], { streamAdapter: noWeights });
    expect(code).toBe(bench.EXIT["REFUSED"]);
    expect(text).toMatch(/REFUSED: the streaming ear could not run \(no-weights\)/);
    expect(existsSync(baselineFile())).toBe(false);
  });

  it("says no data without a manifest and refuses a root inside the repository", async () => {
    const none: string[] = [];
    expect(await bench.main(["stt-stream"], { out: (l: string) => none.push(l) })).toBe(
      bench.EXIT["NO_DATA"],
    );
    expect(none.join("\n")).toMatch(/NO DATA/);
    const inRepo = await run(["--root", join(root, "never-written")], {
      streamAdapter: fakeAdapter(),
    });
    expect(inRepo.code).toBe(bench.EXIT["REFUSED"]);
    expect(existsSync(join(root, "never-written"))).toBe(false);
  });

  it("refuses recordings that are not the manifest's", async () => {
    const first = (JSON.parse(readFileSync(manifest, "utf8")).items as Item[])[0]!;
    writeFileSync(join(dir, "audio", `${first.id}.wav`), "tampered");
    const { code, text } = await run([], { streamAdapter: fakeAdapter() });
    expect(code).toBe(bench.EXIT["REFUSED"]);
    expect(text).toMatch(/does not match the manifest SHA-256/);
  });

  it("reads only 16 kHz mono 16-bit wav", () => {
    const wav = (rate: number) => {
      const h = Buffer.alloc(44);
      h.write("RIFF", 0, "latin1");
      h.writeUInt32LE(40, 4);
      h.write("WAVEfmt ", 8, "latin1");
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(rate, 24);
      h.writeUInt16LE(16, 34);
      h.write("data", 36, "latin1");
      h.writeUInt32LE(4, 40);
      return Buffer.concat([h, Buffer.from([1, 0, 2, 0])]);
    };
    const ok = join(dir, "ok.wav");
    writeFileSync(ok, wav(16000));
    expect(bench.readPcm16(ok).length).toBe(4);
    writeFileSync(ok, wav(44100));
    expect(() => bench.readPcm16(ok)).toThrow(/16 kHz mono/);
  });
});
