import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { toolchainDoctorRows, toolchainDriftRows } from "../../src/lib/friday/toolchain-manifest";
import { holdUnstable } from "../../src/lib/friday/speech-stt";
import { pickEngine, wordError, advanceFlow, freshMachine } from "../../src/lib/friday/speech-eval";
import { storeCachedPhrase, takeCachedPhrase } from "../../src/lib/friday/speech-cache";
import { chunkSentences } from "../../src/lib/friday/speech-normalize";

const require_ = createRequire(import.meta.url);
const stage = require_("../../scripts/stage-toolchain.cjs");
const pack = require_("../../electron/toolchain-pack.cjs");
const whisper = require_("../../electron/whisper-cpp.cjs");

const ROOT = path.resolve(__dirname, "../..");

function sha(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("wave 7 bundled stage", () => {
  it("plans the real bundled tier inside the budget and keeps copyleft on demand", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "config/toolchain-manifest.json"), "utf8"),
    );
    const plan = stage.stagePlan(manifest);
    expect(plan.errors).toEqual([]);
    expect(plan.sum).toBe(205084080);
    expect(plan.sum).toBeLessThanOrEqual(plan.budget);
    expect(plan.packs.map((row: { id: string }) => row.id)).toEqual([
      "python-embed",
      "get-pip",
      "node-win",
      "whisper-cpp",
      "ggml-base",
    ]);
    expect(plan.packs.find((row: { id: string }) => row.id === "whisper-cpp")?.dest).toBe("speech");
    expect(plan.packs.find((row: { id: string }) => row.id === "python-embed")?.dest).toBe(
      "toolchain",
    );
    const yml = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
    expect(yml).toContain("beforePack: scripts/stage-toolchain.cjs");
    expect(yml).toContain("asarUnpack:");
    expect(yml).toContain("resources/toolchain/**");
    expect(yml).toContain("resources/speech/**");
    expect(yml).toContain("oneClick: false");
    expect(yml).toContain("include: installer/build/installer.nsh");
    const cmd = readFileSync(path.join(ROOT, "scripts/build-windows.cmd"), "utf8");
    expect(cmd).not.toContain("stage-toolchain");
    const packText = readFileSync(path.join(ROOT, "electron/toolchain-pack.cjs"), "utf8");
    expect(packText).toContain("stageBundledPacks");
    expect(packText).toContain("stagePlan");
  });

  it("stages a fake archive and fails a hash mismatch", async () => {
    const body = Buffer.from("pack");
    const manifest = {
      budgetBytes: 10,
      packs: [
        {
          id: "python-embed",
          tier: "bundled",
          sha256: sha(body),
          bytes: body.length,
          url: "https://example.invalid/python",
          license: "MIT",
        },
      ],
    };
    const root = mkdtempSync(path.join(tmpdir(), "friday-stage-"));
    const staged = await stage.stageBundledPacks({
      manifest,
      cacheDir: path.join(root, "cache"),
      stageDir: path.join(root, "resources"),
      fetchImpl: async () => ({ body }),
    });
    expect(staged.staged[0].bytes).toBe(4);
    expect(readFileSync(staged.staged[0].file).equals(body)).toBe(true);
    const again = await stage.stageBundledPacks({
      manifest,
      cacheDir: path.join(root, "cache"),
      stageDir: path.join(root, "resources"),
      fetchImpl: async () => {
        throw new Error("network");
      },
    });
    expect(again.staged).toHaveLength(1);
    await expect(
      stage.stageBundledPacks({
        manifest: {
          budgetBytes: 10,
          packs: [{ ...manifest.packs[0], sha256: "ab".repeat(32) }],
        },
        cacheDir: path.join(root, "bad-cache"),
        stageDir: path.join(root, "bad"),
        fetchImpl: async () => ({ body }),
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  it("rejects a copyleft pack and a budget overflow", () => {
    const copyleft = stage.stagePlan({
      budgetBytes: 100,
      packs: [
        {
          id: "mingit",
          tier: "bundled",
          sha256: "a".repeat(64),
          bytes: 10,
          license: "GPL-2.0",
        },
      ],
    });
    expect(copyleft.errors.join(" ")).toMatch(/copyleft/);
    const overflow = stage.stagePlan({
      budgetBytes: 10,
      packs: [
        { id: "python-embed", tier: "bundled", sha256: "b".repeat(64), bytes: 8, license: "MIT" },
        { id: "node-win", tier: "bundled", sha256: "c".repeat(64), bytes: 8, license: "MIT" },
      ],
    });
    expect(overflow.errors.join(" ")).toMatch(/exceeds budget/);
  });

  it("skips the real download only when the pack stage is explicitly disabled", async () => {
    const previous = process.env["FRIDAY_SKIP_TOOLCHAIN_STAGE"];
    process.env["FRIDAY_SKIP_TOOLCHAIN_STAGE"] = "1";
    try {
      const result = await stage.beforePack();
      expect(result.skipped).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["FRIDAY_SKIP_TOOLCHAIN_STAGE"];
      else process.env["FRIDAY_SKIP_TOOLCHAIN_STAGE"] = previous;
    }
  });
});

describe("wave 7 pack resolve", () => {
  it("finds a tool in dev, packaged, and portable layouts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "friday-pack-"));
    const entry = path.join(root, "resources", "toolchain", "python-embed", "python.exe");
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "py");
    expect(
      pack.resolvePackagedTool({ id: "python-embed", entry: "python.exe", roots: [root] })?.file,
    ).toBe(entry);
    const portable = mkdtempSync(path.join(tmpdir(), "friday-portable-"));
    const runtime = path.join(portable, "runtime", "node-win", "node.exe");
    mkdirSync(path.dirname(runtime), { recursive: true });
    writeFileSync(runtime, "node");
    expect(
      pack.resolvePackagedTool({ id: "node-win", entry: "node.exe", roots: [portable] })?.file,
    ).toBe(runtime);
    expect(pack.resolvePackagedTool({ id: "missing", entry: "no.exe", roots: [root] })).toBeNull();
  });

  it("keeps a matching pack, stages a new one, and marks drift", () => {
    const same = pack.applyPackRefresh(
      { version: "1", sha256: "aa" },
      { version: "1", sha256: "aa" },
    );
    expect(same.action).toBe("keep");
    const next = pack.applyPackRefresh(
      { version: "1", sha256: "aa" },
      { version: "2", sha256: "bb" },
    );
    expect(next.action).toBe("stage-new");
    expect(next.rollback).toBe("1");
    const plan = pack.planExtraction({ sha256: "aa", version: "1" }, path.join(tmpdir(), "rt"));
    expect(plan.ok).toBe(true);
    expect(pack.planExtraction({}, path.join(tmpdir(), "rt")).retry).toBe(true);
    const drift = pack.driftRows({ "python-embed": "0" });
    expect(drift.find((row: { id: string }) => row.id === "python-embed")?.drifted).toBe(true);
  });

  it("marks Doctor Ready only after a verify proof", () => {
    const present = { "python-embed": true };
    const unverified = toolchainDoctorRows(present, {});
    expect(unverified.find((row) => row.id === "toolchain:python-embed")?.status).toBe("Warning");
    const proved = toolchainDoctorRows(present, { "python-embed": true });
    expect(proved.find((row) => row.id === "toolchain:python-embed")?.status).toBe("Ready");
    const drift = toolchainDriftRows({ "python-embed": "0" });
    expect(drift.find((row) => row.id === "toolchain-drift:python-embed")?.status).toBe("Warning");
  });
});

describe("wave 7 whisper server", () => {
  it("keeps a warm server, measures latency, and falls back to the cli", async () => {
    let killed = false;
    let tick = 1000;
    const session = whisper.createWhisperSession({
      binary: "whisper-server.exe",
      cli: "whisper-cli.exe",
      model: "ggml-base.bin",
      port: whisper.WHISPER_PORT,
      clock: { now: () => (tick += 25) },
      spawn: () => ({
        kill: () => {
          killed = true;
        },
      }),
      health: async () => true,
    });
    const started = await session.start();
    expect(started.ok).toBe(true);
    expect(started.mode).toBe("server");
    expect(started.argv).toContain("127.0.0.1");
    expect(started.argv.join(" ")).not.toContain("0.0.0.0");
    const job = await session.submit("turn.wav");
    expect(job.mode).toBe("server");
    expect(job.latencyMs).toBeGreaterThan(0);
    expect(session.stop().stopped).toBe(true);
    expect(killed).toBe(true);
    const cold = whisper.createWhisperSession({ cli: "whisper-cli.exe", model: "ggml-base.bin" });
    expect((await cold.start()).mode).toBe("cli");
    const fallback = await cold.submit("turn.wav");
    expect(fallback.mode).toBe("cli");
    expect(fallback.argv).toEqual(
      whisper.transcribeArgv("whisper-cli.exe", "ggml-base.bin", "turn.wav"),
    );
  });
});

describe("wave 7 speech depth", () => {
  it("holds an unstable word, caches a phrase, and picks the fastest engine", () => {
    const first = holdUnstable("kal subah");
    expect(first.held).toBe("subah");
    expect(holdUnstable("kal subah", first.held).stable).toBe("kal subah");
    expect(wordError("kal subah", "kal subah").wer).toBe(0);
    expect(chunkSentences("Hello. Kal subah.").length).toBeGreaterThan(0);
    storeCachedPhrase("Good morning", new Float32Array([1, 2, 3]));
    expect(takeCachedPhrase("good morning")?.length).toBe(3);
    const picked = pickEngine(
      [
        { id: "whisper.cpp", ms: 40, ok: true },
        { id: "faster-whisper", ms: 12, ok: true },
      ],
      "cpu-a",
      "cpu-b",
    );
    expect(picked.id).toBe("faster-whisper");
    expect(picked.rebenchmark).toBe(true);
    const staged = advanceFlow(freshMachine(), "pack-staged");
    expect(staged.line).toBe("staged-pack");
    const flow = advanceFlow(staged, "free-board");
    expect(flow.line).toBe("free-board");
    expect(advanceFlow(flow, "chat-turn").line).toBe("chat-turn");
    expect(advanceFlow(flow, "auto-turn").line).toBe("auto-turn");
  });
});
