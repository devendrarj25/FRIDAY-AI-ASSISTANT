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

  it("the default check needs a bundle manifest with matching size and sha256", async () => {
    const checkout = path.join(temp, "checkout");
    write(checkout, "models/good/a.bin", "aaaa");
    write(checkout, "models/bad/a.bin", "bbbb");
    write(checkout, "models/none/a.bin", "cccc");
    const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
    write(
      checkout,
      "friday-bundle.json",
      JSON.stringify({
        schema: 1,
        models: [
          {
            fridayId: "good",
            dir: "models/good",
            files: [{ path: "a.bin", bytes: 4, sha256: sha("aaaa") }],
          },
          {
            fridayId: "bad",
            dir: "models/bad",
            files: [{ path: "a.bin", bytes: 4, sha256: sha("zzzz") }],
          },
        ],
      }),
    );
    staged.recordBuildRoot(checkout, { kind: "checkout", env });
    const report = await staged.adopt(root, { env, statfs: roomy });
    const by = Object.fromEntries(
      report.items.map((row: { id: string; result: string }) => [row.id, row.result]),
    );
    expect(by).toEqual({
      "models/good": "adopted",
      "models/bad": "skipped",
      "models/none": "skipped",
    });
    expect(fs.existsSync(path.join(root, "models", "good", "a.bin"))).toBe(true);
    expect(fs.existsSync(path.join(root, "models", "bad"))).toBe(false);
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
