/**
 * Setup and the build download models before a FRIDAY folder is chosen, into
 * `.friday-dev`. The installed app must move them into its folder instead of
 * downloading them again, and must never overwrite what the folder holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const staged = require("../../electron/staged-assets.cjs");
const voiceWeights = require("../../electron/voice-weights.cjs");

let temp = "";
let root = "";
let appData = "";
let env: NodeJS.ProcessEnv = {};

const write = (base: string, rel: string, body = "x") => {
  const full = path.join(base, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-staged-"));
  root = path.join(temp, "FRIDAY");
  appData = path.join(temp, "AppData");
  fs.mkdirSync(root, { recursive: true });
  env = { APPDATA: appData };
});

afterEach(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("staged build downloads", () => {
  it("moves speech, voice and chat models from the checkout's .friday-dev into the chosen folder", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "cache/stt/small/model.bin", "weights");
    write(dev, "cache/stt/small/config.json", "{}");
    write(dev, "models/supertonic-3/onnx/vocoder.onnx", "voice");
    write(dev, "models/smart-turn/smart-turn-v3.2-cpu.onnx", "turn");
    expect(staged.recordStaging(dev, { env })).toBe(true);

    const report = await staged.adopt(root, { env });

    expect(report.failed).toEqual([]);
    expect(report.moved.map((row: { item: string }) => row.item).sort()).toEqual([
      "cache/stt/small",
      "models/smart-turn",
      "models/supertonic-3",
    ]);
    expect(voiceWeights.weightsReady(path.join(root, "cache", "stt", "small"), fs.existsSync)).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, "models", "supertonic-3", "onnx", "vocoder.onnx"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dev, "cache", "stt", "small"))).toBe(false);
    // Once everything arrived the pointer is gone, so a later launch looks at nothing.
    expect(fs.existsSync(staged.pointerPath(env))).toBe(false);
  });

  it("moves the unpacked llama.cpp engine with its zip, so the chosen folder can start it", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "runtime/installers/llamacpp/llama-b1-bin-win-cpu-x64.zip", "zip");
    write(dev, "runtime/engines/llama.cpp/b1/llama-server.exe", "exe");
    expect(staged.recordStaging(dev, { env })).toBe(true);
    const report = await staged.adopt(root, { env });
    expect(report.failed).toEqual([]);
    expect(
      fs.existsSync(path.join(root, "runtime", "engines", "llama.cpp", "b1", "llama-server.exe")),
    ).toBe(true);
    expect(require("../../electron/llama-runtime.cjs").installed(root)).toBe(
      process.platform === "win32",
    );
  });

  it("finds .friday-dev inside the chosen folder without any pointer", async () => {
    write(root, ".friday-dev/cache/stt/base/model.bin", "weights");
    write(root, ".friday-dev/cache/stt/base/config.json", "{}");
    const report = await staged.adopt(root, { env });
    expect(report.moved).toEqual([{ item: "cache/stt/base", how: "renamed" }]);
    expect(fs.existsSync(path.join(root, "cache", "stt", "base", "model.bin"))).toBe(true);
  });

  it("never overwrites a model the FRIDAY folder already has", async () => {
    write(root, "cache/stt/small/model.bin", "kept");
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "cache/stt/small/model.bin", "staged");
    write(dev, "cache/stt/small/config.json", "{}");
    staged.recordStaging(dev, { env });

    const report = await staged.adopt(root, { env });

    expect(report.kept).toEqual(["cache/stt/small"]);
    expect(report.moved).toEqual([]);
    expect(fs.readFileSync(path.join(root, "cache", "stt", "small", "model.bin"), "utf8")).toBe(
      "kept",
    );
    // The staged copy is left where it is: nothing is deleted that was not moved.
    expect(fs.existsSync(path.join(dev, "cache", "stt", "small", "model.bin"))).toBe(true);
  });

  it("leaves the staged database, memory and settings alone", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "database/friday.sqlite3", "db");
    write(dev, "memory/note.md", "memory");
    write(dev, "models/silero-vad/silero_vad.onnx", "vad");
    staged.recordStaging(dev, { env });
    await staged.adopt(root, { env });
    expect(fs.existsSync(path.join(dev, "database", "friday.sqlite3"))).toBe(true);
    expect(fs.existsSync(path.join(dev, "memory", "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "database"))).toBe(false);
    expect(fs.existsSync(path.join(root, "models", "silero-vad", "silero_vad.onnx"))).toBe(true);
  });

  it("only ever reads or records a folder named .friday-dev", async () => {
    const other = path.join(temp, "checkout", "something-else");
    write(other, "models/m/model.gguf", "x");
    expect(staged.recordStaging(other, { env })).toBe(false);
    fs.mkdirSync(path.dirname(staged.pointerPath(env)), { recursive: true });
    fs.writeFileSync(staged.pointerPath(env), JSON.stringify({ staging: other }));
    const report = await staged.adopt(root, { env });
    expect(report.sources).toEqual([]);
    expect(fs.existsSync(path.join(other, "models", "m", "model.gguf"))).toBe(true);
  });

  it("does nothing without a root, with the opt-out, or when nothing was staged", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/a/file.bin", "x");
    staged.recordStaging(dev, { env });
    expect((await staged.adopt("", { env })).moved).toEqual([]);
    expect((await staged.adopt(root, { env: { ...env, FRIDAY_ADOPT_STAGED: "0" } })).moved).toEqual(
      [],
    );
    expect(fs.existsSync(path.join(dev, "models", "a", "file.bin"))).toBe(true);
    const empty = await staged.adopt(path.join(temp, "elsewhere"), { env: { APPDATA: "" } });
    expect(empty.failed).toEqual([]);
  });

  it("moves nothing during the build's readiness run: its FRIDAY folder is thrown away afterwards", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "cache/stt/small/model.bin", "weights");
    write(dev, "models/m/model.gguf", "x");
    staged.recordStaging(dev, { env });
    const report = await staged.adopt(root, { env: { ...env, FRIDAY_READINESS: "1" } });
    expect(report.moved).toEqual([]);
    expect(report.sources).toEqual([]);
    expect(fs.existsSync(path.join(dev, "cache", "stt", "small", "model.bin"))).toBe(true);
    expect(fs.existsSync(path.join(dev, "models", "m", "model.gguf"))).toBe(true);
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
  });

  it("across volumes the item is copied under a temporary name, then renamed into place", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "cache/stt/medium/model.bin", "weights");
    write(dev, "cache/stt/medium/config.json", "{}");
    staged.recordStaging(dev, { env });
    const real = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (String(from) === path.join(dev, "cache", "stt", "medium")) {
        throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      }
      return real(from, to);
    });
    try {
      const report = await staged.adopt(root, { env });
      expect(report.moved).toEqual([{ item: "cache/stt/medium", how: "copied" }]);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(root, "cache", "stt", "medium", "model.bin"), "utf8")).toBe(
      "weights",
    );
    expect(fs.existsSync(path.join(root, "cache", "stt", "medium.adopting"))).toBe(false);
    expect(fs.existsSync(path.join(dev, "cache", "stt", "medium"))).toBe(false);
  });

  it("a second adoption is a no-op", async () => {
    write(root, ".friday-dev/models/x/file.bin", "x");
    await staged.adopt(root, { env });
    const again = await staged.adopt(root, { env });
    expect(again.moved).toEqual([]);
    expect(again.failed).toEqual([]);
  });

  it("is wired: the build records the staging folder, the app adopts it, speech waits for it", () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
    for (const file of [
      "scripts/prefetch-models.cjs",
      "scripts/prefetch-toolkit.cjs",
      "scripts/setup-python.cjs",
      "scripts/init-runtime.cjs",
    ]) {
      expect(read(file)).toContain("recordStaging(");
    }
    const main = read("electron/main.cjs");
    expect(main).toContain("adoptStagedDownloads(root)");
    expect(main).toContain("await adoptStagedDownloads(resolvedRoot)");
    expect(read("electron/stt.cjs")).toContain('require("./staged-assets.cjs").whenIdle()');
  });
});

const GIB = 1024 ** 3;
const roomy = async () => ({ bavail: 10_000, bsize: GIB });
const readPointerFile = (e: NodeJS.ProcessEnv) =>
  JSON.parse(fs.readFileSync(staged.pointerPath(e), "utf8"));

describe("build roots: recordBuildRoot and adoption rules", () => {
  it("recordBuildRoot writes a schema 2 pointer, once per root, and rejects a bad kind", () => {
    const checkout = path.join(temp, "checkout");
    fs.mkdirSync(checkout, { recursive: true });
    expect(staged.recordBuildRoot(checkout, { kind: "checkout", env })).toBe(true);
    expect(staged.recordBuildRoot(checkout, { kind: "checkout", env })).toBe(true);
    expect(staged.recordBuildRoot(checkout, { kind: "nonsense", env })).toBe(false);
    expect(staged.recordBuildRoot("", { kind: "checkout", env })).toBe(false);
    // a staging record must still be a .friday-dev folder
    expect(staged.recordBuildRoot(checkout, { kind: "staging", env })).toBe(false);
    const file = readPointerFile(env);
    expect(file.schema).toBe(2);
    expect(file.buildRoots).toEqual([{ root: path.resolve(checkout), kind: "checkout" }]);
    const dev = path.join(checkout, ".friday-dev");
    expect(staged.recordBuildRoot(dev, { kind: "staging", env })).toBe(true);
    expect(readPointerFile(env).staging).toBe(path.resolve(dev));
    expect(readPointerFile(env).buildRoots).toHaveLength(1);
    expect(staged.readPointer(env)).toBe(path.resolve(dev));
  });

  it("a schema 1 pointer still works and is migrated forward on the next record", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/old/file.bin", "old");
    fs.mkdirSync(path.dirname(staged.pointerPath(env)), { recursive: true });
    fs.writeFileSync(
      staged.pointerPath(env),
      JSON.stringify({ staging: dev, recordedAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(staged.readPointer(env)).toBe(path.resolve(dev));
    expect(staged.readBuildRoots(env)).toEqual([]);

    const other = path.join(temp, "other");
    fs.mkdirSync(other, { recursive: true });
    staged.recordBuildRoot(other, { kind: "checkout", env });
    const migrated = readPointerFile(env);
    expect(migrated.schema).toBe(2);
    expect(migrated.staging).toBe(path.resolve(dev));
    expect(migrated.buildRoots).toEqual([{ root: path.resolve(other), kind: "checkout" }]);

    const report = await staged.adopt(root, { env });
    expect(report.moved.map((row: { item: string }) => row.item)).toEqual(["models/old"]);
    // The staging link is spent; the recorded build root stays for later launches.
    expect(readPointerFile(env).staging).toBeUndefined();
    expect(readPointerFile(env).buildRoots).toHaveLength(1);
  });

  it("a build root that is the install root is used in place: nothing moves, nothing is copied", async () => {
    write(root, "models/smart-turn/model.onnx", "turn");
    const alias = path.join(temp, "alias");
    fs.symlinkSync(root, alias, "dir");
    staged.recordBuildRoot(alias, { kind: "checkout", env });
    const verify = vi.fn(async () => true);
    const report = await staged.adopt(root, { env, verify, statfs: roomy });
    expect(report.items).toEqual([
      {
        id: "models/smart-turn",
        origin: path.resolve(alias),
        result: "in-place",
        reason: "build root is the install root",
      },
    ]);
    expect(report.moved).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, "models", "smart-turn", "model.onnx"), "utf8")).toBe(
      "turn",
    );
  });

  it("compares roots case-insensitively on win32 through the injected realpath", async () => {
    write(root, "models/a/file.bin", "a");
    staged.recordBuildRoot(root, { kind: "checkout", env });
    const report = await staged.adopt(root, {
      env,
      platform: "win32",
      realpath: (p: string) => (p === path.resolve(root) ? p.toUpperCase() : p.toLowerCase()),
    });
    expect(report.items.map((row: { result: string }) => row.result)).toEqual(["in-place"]);
  });

  it("copies, never moves, a verified item from another build root", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/supertonic-3/onnx/vocoder.onnx", "voice");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const verify = vi.fn(async () => true);
    const report = await staged.adopt(root, { env, verify, statfs: roomy });
    expect(report.items).toEqual([
      {
        id: "models/supertonic-3",
        origin: path.resolve(checkout),
        result: "adopted",
        reason: "copied",
      },
    ]);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      fs.readFileSync(path.join(root, "models", "supertonic-3", "onnx", "vocoder.onnx"), "utf8"),
    ).toBe("voice");
    // The source is never removed and no temporary copy is left.
    expect(
      fs.existsSync(path.join(checkout, "models", "supertonic-3", "onnx", "vocoder.onnx")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "models", "supertonic-3.adopting"))).toBe(false);
    // The pointer keeps the build root; a second run finds the destination taken and copies nothing.
    expect(readPointerFile(env).buildRoots).toHaveLength(1);
    const again = await staged.adopt(root, { env, verify, statfs: roomy });
    expect(again.items).toEqual([
      {
        id: "models/supertonic-3",
        origin: path.resolve(checkout),
        result: "skipped",
        reason: "destination already holds it",
      },
    ]);
  });

  it("skips an item that is not verified, and the whole build root when local bundles are off", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/m/file.bin", "m");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const bad = await staged.adopt(root, { env, verify: async () => false, statfs: roomy });
    expect(bad.items).toEqual([
      {
        id: "models/m",
        origin: path.resolve(checkout),
        result: "skipped",
        reason: "not verified",
      },
    ]);
    const off = await staged.adopt(root, {
      env: { ...env, FRIDAY_LOCAL_BUNDLES: "0" },
      verify: async () => true,
      statfs: roomy,
    });
    expect(off.items).toEqual([]);
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
  });

  it("the default check needs a valid bundle manifest and a config pin with matching size and sha256", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/good/a.bin", "aaaa");
    write(checkout, "models/bad/a.bin", "bbbb");
    write(checkout, "models/none/a.bin", "cccc");
    const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
    const row = (fridayId: string, body: string) => ({
      fridayId,
      dir: `models/${fridayId}`,
      files: [{ path: "a.bin", bytes: 4, sha256: sha(body) }],
    });
    const bundle = require("../../electron/build-bundle.cjs").build({
      product: "FRIDAY",
      channel: "stable",
      version: "1.2.5.7",
      caller: "cmd",
      inExe: { builtins: { sha256: sha("builtins") }, wheelhouse: null },
      // the bad row declares bytes the folder does not hold
      models: [row("good", "aaaa"), row("bad", "zzzz")],
    });
    write(checkout, "friday-bundle.json", JSON.stringify(bundle));
    const pins = [
      { fridayId: "good", path: "a.bin", bytes: 4, sha256: sha("aaaa") },
      { fridayId: "bad", path: "a.bin", bytes: 4, sha256: sha("zzzz") },
    ];
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, pins, statfs: roomy });
    const by = Object.fromEntries(
      report.items.map((row: { id: string; result: string }) => [row.id, row.result]),
    );
    expect(by).toEqual({
      "models/good": "adopted",
      "models/bad": "skipped",
      "models/none": "skipped",
    });
    for (const item of report.items.filter((row: { result: string }) => row.result === "skipped")) {
      expect(item.reason).toBe("not verified");
    }
    expect(fs.existsSync(path.join(root, "models", "good", "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(root, "models", "bad"))).toBe(false);
    expect(fs.existsSync(path.join(root, "models", "none"))).toBe(false);
  });

  it("skips a copy when free space is under bytes plus 2 GiB, and leaves everything", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/big/file.bin", "12345678");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const tight = async () => ({ bavail: 2 * GIB + 7, bsize: 1 });
    const report = await staged.adopt(root, { env, verify: async () => true, statfs: tight });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ id: "models/big", result: "skipped" });
    expect(report.items[0].reason).toMatch(/free space/);
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
    expect(fs.existsSync(path.join(checkout, "models", "big", "file.bin"))).toBe(true);
    // Exactly enough room is enough.
    const exact = async () => ({ bavail: 2 * GIB + 8, bsize: 1 });
    const ok = await staged.adopt(root, { env, verify: async () => true, statfs: exact });
    expect(ok.items[0]).toMatchObject({ id: "models/big", result: "adopted" });
  });

  it("a destination that fills up between the check and the move is kept, not removed", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/race/file.bin", "staged");
    staged.recordStaging(dev, { env });
    const target = path.join(root, "models", "race");
    const real = fs.promises.mkdir.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (dir, options) => {
      const made = await real(dir, options as never);
      if (String(dir) === path.dirname(target)) write(target, "file.bin", "owner data");
      return made;
    });
    let report;
    try {
      report = await staged.adopt(root, { env });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(target, "file.bin"), "utf8")).toBe("owner data");
    expect(fs.readFileSync(path.join(dev, "models", "race", "file.bin"), "utf8")).toBe("staged");
    expect(report.moved).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.items).toEqual([
      {
        id: "models/race",
        origin: path.resolve(dev),
        result: "skipped",
        reason: "destination appeared meanwhile",
      },
    ]);
  });

  it("the same race during a copy from a build root keeps the filled destination", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/race/file.bin", "built");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const target = path.join(root, "models", "race");
    const real = fs.promises.mkdir.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "mkdir").mockImplementation(async (dir, options) => {
      const made = await real(dir, options as never);
      if (String(dir) === path.dirname(target)) write(target, "file.bin", "owner data");
      return made;
    });
    let report;
    try {
      report = await staged.adopt(root, { env, verify: async () => true, statfs: roomy });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(path.join(target, "file.bin"), "utf8")).toBe("owner data");
    expect(fs.readFileSync(path.join(checkout, "models", "race", "file.bin"), "utf8")).toBe(
      "built",
    );
    expect(report.items[0]).toMatchObject({
      result: "skipped",
      reason: "destination appeared meanwhile",
    });
  });
});

const buildBundle = require("../../electron/build-bundle.cjs");
const realRenameSync = fs.renameSync.bind(fs);
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

type Seed = { id: string; files: Record<string, string> };

/** A valid friday-bundle.json for the seeded models, plus the matching pins (config/friday-models.json rows). */
function bundleFor(seeds: Seed[]) {
  const models = seeds.map((seed) => ({
    fridayId: seed.id,
    dir: `models/${seed.id}`,
    files: Object.entries(seed.files).map(([file, body]) => ({
      path: file,
      bytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
  }));
  const bundle = buildBundle.build({
    product: "FRIDAY",
    channel: "stable",
    version: "1.2.5.7",
    caller: "cmd",
    inExe: { builtins: { sha256: sha("builtins") }, wheelhouse: null },
    models,
  });
  const pins = seeds.flatMap((seed) =>
    Object.entries(seed.files).map(([file, body]) => ({
      fridayId: seed.id,
      path: file,
      bytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
  );
  return { bundle, pins };
}

function seedBuildRoot(checkout: string, seeds: Seed[], where = "friday-bundle.json") {
  for (const seed of seeds) {
    for (const [file, body] of Object.entries(seed.files)) {
      write(checkout, `models/${seed.id}/${file}`, body);
    }
  }
  const made = bundleFor(seeds);
  write(checkout, where, JSON.stringify(made.bundle));
  return made;
}

const byId = (report: { items: { id: string; result: string }[] }) =>
  Object.fromEntries(report.items.map((row) => [row.id, row.result]));

describe("copy from a build root uses the strict bundle reader and the config pins", () => {
  const seeds: Seed[] = [{ id: "friday-voice", files: { "a.bin": "aaaa", "sub/b.bin": "bbbbbb" } }];

  it("adopts a model whose bundle row matches the pin, from the release or the installers folder too", async () => {
    for (const where of [
      "friday-bundle.json",
      "release/friday-bundle.json",
      "installer/installers/1.2.5.7/friday-bundle.json",
    ]) {
      const checkout = path.join(temp, "checkout");
      const target = path.join(temp, `FRIDAY-${where.length}`);
      const made = seedBuildRoot(checkout, seeds, where);
      staged.recordBuildRoot(checkout, { kind: "checkout", env });
      const report = await staged.adopt(target, { env, pins: made.pins, statfs: roomy });
      expect(byId(report)).toEqual({ "models/friday-voice": "adopted" });
      expect(
        fs.readFileSync(path.join(target, "models", "friday-voice", "sub", "b.bin"), "utf8"),
      ).toBe("bbbbbb");
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("reads config/friday-models.json by default: a bundle that disagrees with the real pin is skipped", async () => {
    const checkout = path.join(temp, "checkout");
    seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, statfs: roomy });
    expect(byId(report)).toEqual({ "models/friday-voice": "skipped" });
    expect(report.items[0].reason).toBe("not verified");
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
  });

  it("the config pin wins: a self-consistent bundle for another revision is skipped", async () => {
    const checkout = path.join(temp, "checkout");
    seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const newer = bundleFor([
      { id: "friday-voice", files: { "a.bin": "NEWER", "sub/b.bin": "bbbbbb" } },
    ]);
    const report = await staged.adopt(root, { env, pins: newer.pins, statfs: roomy });
    expect(report.items).toEqual([
      expect.objectContaining({
        id: "models/friday-voice",
        result: "skipped",
        reason: "not verified",
      }),
    ]);
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
    // No pin at all is not adoptable either.
    const none = await staged.adopt(root, { env, pins: [], statfs: roomy });
    expect(byId(none)).toEqual({ "models/friday-voice": "skipped" });
  });

  it("refuses a bundle the strict reader refuses, and a missing bundle", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    write(checkout, "friday-bundle.json", JSON.stringify({ ...made.bundle, surprise: true }));
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
    fs.rmSync(path.join(checkout, "friday-bundle.json"));
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
  });

  it("refuses a duplicate manifest row", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const dup = JSON.parse(JSON.stringify(made.bundle));
    dup.models[0].files.push({ ...dup.models[0].files[0] });
    write(checkout, "friday-bundle.json", JSON.stringify(dup));
    const report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
    expect(byId(report)).toEqual({ "models/friday-voice": "skipped" });
  });

  it("refuses an unlisted file of the same size, a link, and a nested link", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    write(checkout, "models/friday-voice/extra.bin", "xxxx");
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
    fs.rmSync(path.join(checkout, "models", "friday-voice", "extra.bin"));
    const outside = path.join(temp, "outside");
    write(outside, "secret.txt", "secret");
    fs.symlinkSync(outside, path.join(checkout, "models", "friday-voice", "sub", "link"), "dir");
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
    expect(fs.existsSync(path.join(root, "models"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  it("a model folder that holds FRIDAY's own marker files on disk still verifies and is adopted without them", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    const model = "models/friday-voice";
    write(checkout, `${model}/.friday-pin.json`, '{"revision":"abc"}');
    write(checkout, `${model}/.friday-complete`, "");
    write(checkout, `${model}/.cache/huggingface/download/x.metadata`, "meta");
    write(checkout, `${model}/sub/b.bin.part`, "half");
    write(checkout, `${model}/sub/b.bin.part.json`, "{}");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
    expect(byId(report)).toEqual({ "models/friday-voice": "adopted" });
    const landed = path.join(root, "models", "friday-voice");
    expect(fs.readFileSync(path.join(landed, "sub", "b.bin"), "utf8")).toBe("bbbbbb");
    // The app certifies the folder itself later: nothing of the source's markers is carried over or written here.
    expect(fs.existsSync(path.join(landed, ".friday-pin.json"))).toBe(false);
    expect(fs.existsSync(path.join(landed, ".friday-complete"))).toBe(false);
    expect(fs.existsSync(path.join(landed, ".cache"))).toBe(false);
    expect(fs.existsSync(path.join(landed, "sub", "b.bin.part"))).toBe(false);
    // The source keeps everything it had.
    expect(fs.existsSync(path.join(checkout, model, ".friday-pin.json"))).toBe(true);
  });

  it("the hash of the copy is still checked when marker files sit beside the weights", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    write(checkout, "models/friday-voice/.friday-pin.json", "{}");
    write(checkout, "models/friday-voice/.cache/x", "meta");
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    // same size, other bytes: not what the bundle lists
    write(checkout, "models/friday-voice/a.bin", "evil");
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
    expect(fs.existsSync(path.join(root, "models", "friday-voice"))).toBe(false);
    // a file that is not FRIDAY's own marker still counts as unlisted
    write(checkout, "models/friday-voice/a.bin", "aaaa");
    write(checkout, "models/friday-voice/notes.friday-pin.json.txt", "x");
    expect(byId(await staged.adopt(root, { env, pins: made.pins, statfs: roomy }))).toEqual({
      "models/friday-voice": "skipped",
    });
  });

  it("uses the newest installers folder when several versions hold a bundle", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds, "installer/installers/1.10.0.0/friday-bundle.json");
    const stale = JSON.parse(JSON.stringify(made.bundle));
    stale.models[0].files[0].sha256 = sha("old");
    write(checkout, "installer/installers/1.9.0.0/friday-bundle.json", JSON.stringify(stale));
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
    expect(byId(report)).toEqual({ "models/friday-voice": "adopted" });
  });

  it("a source rewritten with the same size during the copy ends skipped and leaves nothing behind", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const real = fs.promises.cp.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "cp").mockImplementation(async (from, to, options) => {
      await real(from, to, options as never);
      // a running build rewrites the file in the build root after it was verified and copied
      fs.writeFileSync(path.join(String(to), "a.bin"), "evil");
    });
    let report;
    try {
      report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
    } finally {
      spy.mockRestore();
    }
    expect(byId(report)).toEqual({ "models/friday-voice": "skipped" });
    expect(report.items[0].reason).toMatch(/changed while copying/);
    expect(fs.existsSync(path.join(root, "models", "friday-voice"))).toBe(false);
    expect(fs.readdirSync(path.join(root, "models"))).toEqual([]);
    expect(fs.readFileSync(path.join(checkout, "models", "friday-voice", "a.bin"), "utf8")).toBe(
      "aaaa",
    );
  });

  it("checks free space before hashing anything", async () => {
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, seeds);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const verify = vi.fn(async () => true);
    const tight = async () => ({ bavail: 1, bsize: 1 });
    const report = await staged.adopt(root, { env, verify, pins: made.pins, statfs: tight });
    expect(verify).not.toHaveBeenCalled();
    expect(report.items[0].reason).toMatch(/free space/);
    // the default check never opens a model file either
    const open = vi.spyOn(fs, "openSync");
    try {
      await staged.adopt(root, { env, pins: made.pins, statfs: tight });
      expect(open.mock.calls.filter((call) => String(call[0]).includes("friday-voice"))).toEqual(
        [],
      );
    } finally {
      open.mockRestore();
    }
  });
});

describe("a file item is published exclusively with a random partial name", () => {
  it("keeps a file that appeared meanwhile and names the partial randomly", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "runtime/installers/setup.exe", "staged");
    staged.recordStaging(dev, { env });
    const target = path.join(root, "runtime", "installers", "setup.exe");
    const real = fs.promises.rename.bind(fs.promises);
    const realLink = fs.promises.link.bind(fs.promises);
    const names: string[] = [];
    const drop = () => {
      if (!fs.existsSync(target)) write(path.dirname(target), "setup.exe", "owner data");
    };
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (String(from) === path.join(dev, "runtime", "installers", "setup.exe")) {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      }
      if (String(from).endsWith(".adopting")) {
        names.push(String(from));
        drop();
      }
      return real(from, to);
    });
    const linkSpy = vi.spyOn(fs.promises, "link").mockImplementation(async (from, to) => {
      names.push(String(from));
      drop();
      return realLink(from, to);
    });
    let report;
    try {
      report = await staged.adopt(root, { env });
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
    }
    expect(fs.readFileSync(target, "utf8")).toBe("owner data");
    expect(report.moved).toEqual([]);
    expect(report.items[0]).toMatchObject({
      result: "skipped",
      reason: "destination appeared meanwhile",
    });
    expect(fs.readFileSync(path.join(dev, "runtime", "installers", "setup.exe"), "utf8")).toBe(
      "staged",
    );
    expect(names[0]).toMatch(/setup\.exe\.[0-9a-f]{8}\.adopting$/);
    expect(fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith(".adopting"))).toEqual([]);
  });
});

describe("the pointer file", () => {
  const writeRaw = (body: unknown) => {
    fs.mkdirSync(path.dirname(staged.pointerPath(env)), { recursive: true });
    fs.writeFileSync(
      staged.pointerPath(env),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };

  it("accepts local drive paths only: no UNC share, device path or relative path is ever touched", async () => {
    for (const bad of [
      "\\\\host\\share\\FRIDAY",
      "//host/share/FRIDAY",
      "\\\\?\\C:\\FRIDAY",
      "\\\\.\\PhysicalDrive0",
      "relative/build",
    ]) {
      expect(staged.recordBuildRoot(bad, { kind: "checkout", env })).toBe(false);
    }
    const stat = vi.spyOn(fs, "statSync");
    writeRaw({
      schema: 2,
      buildRoots: [
        { root: "\\\\host\\share\\x", kind: "checkout" },
        { root: "//host/share/y", kind: "checkout" },
        "\\\\?\\C:\\z",
      ],
    });
    try {
      expect(staged.readBuildRoots(env)).toEqual([]);
      const report = await staged.adopt(root, { env });
      expect(report.sources).toEqual([]);
      expect(
        stat.mock.calls.map((call) => String(call[0])).filter((p) => /host|\?|share/.test(p)),
      ).toEqual([]);
    } finally {
      stat.mockRestore();
    }
  });

  it("compares roots case-sensitively on Linux, so /A and /a stay two roots", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (process.platform === "win32" || process.platform === "darwin" || !platform) return;
    const upper = path.join(temp, "Checkout");
    const lower = path.join(temp, "checkout");
    expect(staged.recordBuildRoot(upper, { kind: "checkout", env })).toBe(true);
    expect(staged.recordBuildRoot(lower, { kind: "checkout", env })).toBe(true);
    expect(staged.readBuildRoots(env).map((row: { root: string }) => row.root)).toEqual([
      upper,
      lower,
    ]);
  });

  it("writes atomically through a temp file and keeps unknown fields and rows", async () => {
    const checkout = path.join(temp, "checkout");
    fs.mkdirSync(checkout, { recursive: true });
    writeRaw({
      schema: 3,
      note: "from a newer build",
      extras: { keep: [1, 2] },
      buildRoots: [
        { root: path.join(temp, "known"), kind: "checkout", tag: "mine" },
        { root: path.join(temp, "future"), kind: "cloud-mirror" },
        { weird: true },
      ],
    });
    expect(staged.readBuildRoots(env)).toEqual([
      { root: path.join(temp, "known"), kind: "checkout" },
    ]);
    const renames: string[] = [];
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
      renames.push(`${path.basename(String(from))}>${path.basename(String(to))}`);
      return realRenameSync(from, to);
    }) as never);
    try {
      expect(staged.recordBuildRoot(checkout, { kind: "checkout", env })).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(renames.some((entry) => /\.tmp>staged-assets\.json$/.test(entry))).toBe(true);
    const file = readPointerFile(env);
    expect(file.schema).toBe(3);
    expect(file.note).toBe("from a newer build");
    expect(file.extras).toEqual({ keep: [1, 2] });
    expect(file.buildRoots).toEqual([
      { root: path.join(temp, "known"), kind: "checkout", tag: "mine" },
      { root: path.join(temp, "future"), kind: "cloud-mirror" },
      { weird: true },
      { root: checkout, kind: "checkout" },
    ]);
    // clearing the staging link keeps them as well
    const dev = path.join(temp, "x", ".friday-dev");
    write(dev, "models/q/f.bin", "q");
    staged.recordStaging(dev, { env });
    await staged.adopt(root, { env, verify: async () => false, statfs: roomy });
    expect(readPointerFile(env).staging).toBeUndefined();
    expect(readPointerFile(env).note).toBe("from a newer build");
    expect(readPointerFile(env).buildRoots).toHaveLength(4);
  });
});

describe("one running job per root, stale partials and half copies", () => {
  it("two roots adopted at once each get their own report, and whenIdle waits for both", async () => {
    const other = path.join(temp, "FRIDAY-two");
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/one/f.bin", "1");
    write(other, ".friday-dev/models/two/f.bin", "2");
    staged.recordStaging(dev, { env });
    const first = staged.adopt(root, { env });
    const second = staged.adopt(other, { env });
    expect(staged.adopt(root, { env })).toBe(first);
    let idle = false;
    const waiting = staged.whenIdle().then(() => {
      idle = true;
    });
    const [a, b] = await Promise.all([first, second]);
    await waiting;
    expect(idle).toBe(true);
    expect(a.moved.map((row: { item: string }) => row.item)).toEqual(["models/one"]);
    expect(b.moved.map((row: { item: string }) => row.item)).toEqual(["models/two"]);
    expect(a.sources).toEqual([path.resolve(dev)]);
    await expect(staged.whenIdle()).resolves.toBeUndefined();
  });

  it("sweeps stale .adopting partials in the adopted parents and nothing else", async () => {
    write(root, "models/old.adopting/f.bin", "half");
    write(root, "models/old.0123abcd.adopting/f.bin", "half");
    write(root, "runtime/installers/x.exe.adopting", "half");
    write(root, "models/mine/model.bin", "keep");
    write(root, "docs/notes.adopting", "not an adopted parent");
    // A partial is ours when a source still holds its item, and stale after ten minutes (an injected clock).
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/old/f.bin", "1");
    write(dev, "runtime/installers/x.exe", "1");
    staged.recordStaging(dev, { env });
    const report = await staged.adopt(root, { env, now: () => Date.now() + 11 * 60 * 1000 });
    expect(fs.existsSync(path.join(root, "models", "old.adopting"))).toBe(false);
    expect(fs.existsSync(path.join(root, "models", "old.0123abcd.adopting"))).toBe(false);
    expect(fs.existsSync(path.join(root, "runtime", "installers", "x.exe.adopting"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "models", "mine", "model.bin"), "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(root, "docs", "notes.adopting"))).toBe(true);
    expect(report.swept).toHaveLength(3);
  });

  it("reports a half-copied destination from a foreign copier and never deletes it", async () => {
    const dev = path.join(temp, "checkout", ".friday-dev");
    write(dev, "models/m1/a.bin", "aaaa");
    write(dev, "models/m1/b.bin", "bbbb");
    write(root, "models/m1/a.bin", "aaaa");
    staged.recordStaging(dev, { env });
    const report = await staged.adopt(root, { env });
    expect(report.items).toEqual([expect.objectContaining({ id: "models/m1", result: "skipped" })]);
    expect(report.items[0].reason).toMatch(/unfinished copy/);
    expect(report.kept).toEqual(["models/m1"]);
    expect(fs.readFileSync(path.join(root, "models", "m1", "a.bin"), "utf8")).toBe("aaaa");
    expect(fs.existsSync(path.join(root, "models", "m1", "b.bin"))).toBe(false);
    expect(fs.existsSync(path.join(dev, "models", "m1", "b.bin"))).toBe(true);
  });
});

describe("sweep only our own stale partials, and never follow a link item", () => {
  const dev = () => path.join(temp, "checkout", ".friday-dev");
  const later = { now: () => Date.now() + 11 * 60 * 1000 };

  it("leaves an owner folder named like a partial, and a partial no source item explains", async () => {
    write(dev(), "models/m1/f.bin", "1");
    staged.recordStaging(dev(), { env });
    write(root, "models/userdata.adopting/keep.txt", "mine");
    write(root, "models/userdata.0123abcd.adopting/keep.txt", "mine");
    write(root, "models/m1.0123abcd.adopting/f.bin", "half");
    const report = await staged.adopt(root, { env, ...later });
    expect(report.swept).toEqual(["models/m1.0123abcd.adopting"]);
    expect(
      fs.readFileSync(path.join(root, "models", "userdata.adopting", "keep.txt"), "utf8"),
    ).toBe("mine");
    expect(fs.existsSync(path.join(root, "models", "userdata.0123abcd.adopting"))).toBe(true);
    expect(fs.existsSync(path.join(root, "models", "m1.0123abcd.adopting"))).toBe(false);
  });

  it("leaves a partial younger than ten minutes (another instance may still be writing it)", async () => {
    write(dev(), "models/m1/f.bin", "1");
    staged.recordStaging(dev(), { env });
    write(root, "models/m1.0123abcd.adopting/f.bin", "live");
    const fresh = await staged.adopt(root, { env, now: () => Date.now() + 9 * 60 * 1000 });
    expect(fresh.swept).toEqual([]);
    expect(fs.existsSync(path.join(root, "models", "m1.0123abcd.adopting", "f.bin"))).toBe(true);
    staged.recordStaging(dev(), { env });
    write(dev(), "models/m1/f.bin", "1");
    const stale = await staged.adopt(root, { env, ...later });
    expect(stale.swept).toEqual(["models/m1.0123abcd.adopting"]);
  });

  it("a build-root item that is a symlink or junction is skipped with the reason link, and nothing is published", async () => {
    const outside = path.join(temp, "elsewhere");
    write(outside, "m1/a.bin", "aaaa");
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, [{ id: "m1", files: { "a.bin": "aaaa" } }]);
    fs.rmSync(path.join(checkout, "models", "m1"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "m1"),
      path.join(checkout, "models", "m1"),
      process.platform === "win32" ? "junction" : "dir",
    );
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
    expect(report.items).toEqual([expect.objectContaining({ id: "models/m1", result: "skipped" })]);
    expect(report.items[0].reason).toBe("link");
    expect(report.copied).toEqual([]);
    expect(fs.existsSync(path.join(root, "models", "m1"))).toBe(false);
  });

  it("a staged (moved) item that is a link is refused too, and stays where it was", async () => {
    const outside = path.join(temp, "elsewhere");
    write(outside, "m2/a.bin", "aaaa");
    fs.mkdirSync(path.join(dev(), "models"), { recursive: true });
    fs.symlinkSync(
      path.join(outside, "m2"),
      path.join(dev(), "models", "m2"),
      process.platform === "win32" ? "junction" : "dir",
    );
    staged.recordStaging(dev(), { env });
    const report = await staged.adopt(root, { env });
    expect(report.items[0]).toMatchObject({ id: "models/m2", result: "skipped", reason: "link" });
    expect(report.moved).toEqual([]);
    expect(fs.existsSync(path.join(root, "models", "m2"))).toBe(false);
    expect(fs.lstatSync(path.join(dev(), "models", "m2")).isSymbolicLink()).toBe(true);
  });

  it("a copy that turned into a link before it was published is refused and removed", async () => {
    const outside = path.join(temp, "elsewhere");
    write(outside, "m1/a.bin", "aaaa");
    const checkout = path.join(temp, "checkout");
    const made = seedBuildRoot(checkout, [{ id: "m1", files: { "a.bin": "aaaa" } }]);
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const realCp = fs.promises.cp.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, "cp").mockImplementation(async (from, to, ...rest) => {
      await realCp(from, to, ...rest);
      await fs.promises.rm(to, { recursive: true });
      await fs.promises.symlink(
        path.join(outside, "m1"),
        to as string,
        process.platform === "win32" ? "junction" : "dir",
      );
    });
    try {
      const report = await staged.adopt(root, { env, pins: made.pins, statfs: roomy });
      expect(report.items[0]).toMatchObject({ id: "models/m1", result: "skipped", reason: "link" });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(path.join(root, "models"))).toEqual([]);
  });
});
