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
