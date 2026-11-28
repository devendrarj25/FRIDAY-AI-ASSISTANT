/**
 * Setup is hardware-aware and never stops on a download: a model, a voice file, a tool or a package that does not
 * arrive is ONE notice line and one entry of runtime/setup-notices.json (finished later from the Install Manager), and
 * the step exits 0. Strict mode (FRIDAY_SETUP_STRICT=1) restores exit 1. These tests use stand-in downloaders and a
 * hand-built plan: no network, no Ollama, no real PC.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));
const plans = require_(path.join(root, "electron/setup-plan.cjs"));
const notices = require_(path.join(root, "scripts/setup-notices.cjs"));
const voiceWeights = require_(path.join(root, "electron/voice-weights.cjs"));
const safety = require_(path.join(root, "electron/download-safety.cjs"));
const catalog = require_(path.join(root, "electron/installer-catalog.cjs"));
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-r10-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const recorded = (dir: string) =>
  JSON.parse(readFileSync(path.join(dir, "runtime", "setup-notices.json"), "utf8"))
    .notices as Array<Record<string, string>>;

describe("a model that does not arrive is a notice and the step exits 0", () => {
  it("strict mode is opt-in: off by default, on with FRIDAY_SETUP_STRICT=1 or the older FRIDAY_PREFETCH_STRICT=1", () => {
    expect(prefetch.strict({})).toBe(false);
    expect(prefetch.strict({ FRIDAY_PREFETCH_STRICT: "0" })).toBe(false);
    expect(prefetch.strict({ FRIDAY_SETUP_STRICT: "1" })).toBe(true);
    expect(prefetch.strict({ FRIDAY_PREFETCH_STRICT: "1" })).toBe(true);
  });

  it("the step leaves through the same verdict, records the rows and prints the summary (source)", () => {
    const src = read("scripts/prefetch-models.cjs");
    expect(src).toContain("finish(lines.length && strict() ? 1 : 0)");
    expect(src).toContain("recordRowNotices(rows, { root: picked.root })");
    expect(src).toContain("if (strict()) for (const line of lines) console.error(line)");
    expect(src).toContain("setupNotices.summaryLines(setupNotices.readNotices(picked.root))");
    expect(src).toContain('id: "model:step"');
  });

  it("records each failed row once with its Install Manager id, and clears the entry when the row verifies", () => {
    const dir = temp();
    const lines: string[] = [];
    const rows = [
      { id: "stt-small", ok: false, error: "offline" },
      { id: "silero-vad", ok: false, error: "SHA-256 mismatch", optional: true },
      { id: "ollama", ok: false, error: "installer missing" },
      { id: "qwen3.5:2b", ok: false, error: "no route" },
      { id: "supertonic-3", ok: true, downloaded: true },
    ];
    const made = prefetch.recordRowNotices(rows, { root: dir, log: (l: string) => lines.push(l) });
    expect(made).toHaveLength(4);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toMatch(/NOTICE .*Not a stop/);
    const file = recorded(dir);
    expect(file.map((entry) => entry["id"])).toEqual([
      "voice:stt-small",
      "voice:silero-vad",
      "runtime:ollama",
      "model:qwen3.5:2b",
    ]);
    expect(file[0]).toMatchObject({
      kind: "voice",
      installManagerId: `voice:${voiceWeights.STT_CATALOG["small"]}`,
    });
    expect(file[3]).toMatchObject({ kind: "model", installManagerId: "model:ollama:qwen3.5:2b" });
    // A voice file is finished from its `voice:` row, Ollama itself has no Install Manager row.
    expect(file[1]).toMatchObject({ kind: "voice", installManagerId: "voice:silero-vad" });
    expect(file[2]).toMatchObject({ kind: "runtime", installManagerId: "" });
    // The same item verifies on a later run: its notice goes away, the others stay.
    prefetch.recordRowNotices([{ id: "stt-small", ok: true, downloaded: true }], {
      root: dir,
      log: () => {},
    });
    expect(recorded(dir).map((entry) => entry["id"])).not.toContain("voice:stt-small");
    expect(recorded(dir)).toHaveLength(3);
    // A skipped or deferred row verified nothing, so it never clears an entry.
    prefetch.recordRowNotices([{ id: "ollama", ok: true, skipped: true }], {
      root: dir,
      log: () => {},
    });
    expect(recorded(dir).map((entry) => entry["id"])).toContain("runtime:ollama");
  });

  it("never throws, even when the record cannot be written", () => {
    const dir = temp();
    const blocker = path.join(dir, "runtime");
    writeFileSync(blocker, "a file where the folder should be");
    expect(() =>
      prefetch.recordRowNotices([{ id: "x", ok: false, error: "e" }], { root: dir, log: () => {} }),
    ).not.toThrow();
    expect(() => prefetch.recordRowNotices(null, { root: dir })).not.toThrow();
  });

  it("a failed download inside a run is a NOTE (FAIL only in strict mode; the one NOTICE line comes with the record) and the step still returns its rows", async () => {
    for (const [env, word] of [
      [{}, "NOTE"],
      [{ FRIDAY_SETUP_STRICT: "1" }, "FAIL"],
    ] as const) {
      const dir = temp();
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        env: {
          FRIDAY_PREFETCH: "1",
          FRIDAY_PREFETCH_MOONSHINE: "0",
          FRIDAY_PREFETCH_CHAT: "0",
          FRIDAY_MODEL_FRESHNESS: "0",
          CI: "",
          GITHUB_ACTIONS: "",
          ...env,
        },
        platform: "linux",
        log: (l: string) => lines.push(l),
        board: null,
        download: async () => ({ ok: false, error: "SHA-256 mismatch" }),
      });
      expect(rows.some((row: { ok: boolean }) => !row.ok)).toBe(true);
      expect(lines.join("\n")).toMatch(
        new RegExp(`\\[friday\\] ${word} +stt-small was not downloaded`),
      );
    }
  });
});

describe("the mirror is tried once when the host did not answer", () => {
  const pinned = () => ({
    id: "smart-turn",
    job: {
      modelId: "smart-turn",
      dir: "x",
      sources: [
        {
          kind: "url",
          url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/a.onnx",
          sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
          bytes: 10,
        },
      ],
    },
  });

  it("retries once through hf-mirror.com with the same digest, allows the opt-in only inside that call, and says what it did", async () => {
    const calls: Array<{ urls: string[]; mirror: string }> = [];
    delete process.env["FRIDAY_HF_MIRROR"];
    const lines: string[] = [];
    const out = await prefetch.retryViaMirror(
      pinned(),
      { ok: false, error: "getaddrinfo ENOTFOUND huggingface.co" },
      {
        env: {},
        say: (l: string) => lines.push(l),
        fetchModel: async (job: { sources: Array<{ url: string; sha256: string }> }) => {
          calls.push({
            urls: job.sources.map((s) => s.url),
            mirror: safety.familyFor("hf-mirror.com"),
          });
          return { ok: true, bytes: 10 };
        },
      },
    );
    expect(out).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.urls[0]).toMatch(
      /^https:\/\/hf-mirror\.com\/pipecat-ai\/smart-turn-v3\/resolve\/f766f81d3cfdf7737ac64aad813d91bbfd56bf93\//,
    );
    expect(calls[0]?.mirror).toBe("opt-in");
    expect(safety.familyFor("hf-mirror.com")).toBe("");
    expect(process.env["FRIDAY_HF_MIRROR"]).toBeUndefined();
    expect(lines).toEqual(["[friday] NOTICE: huggingface.co did not answer; used hf-mirror.com"]);
  });

  it("the download allowlist accepts hf-mirror.com only inside withOptInMirror, also after an await", async () => {
    delete process.env["FRIDAY_HF_MIRROR"];
    const url = "https://hf-mirror.com/a/b/resolve/c/d.onnx";
    expect(() => safety.assertAllowedUrl(url)).toThrow(/not allowlisted/);
    const inside = await safety.withOptInMirror(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return safety.assertAllowedUrl(url).fridayFamily;
    });
    expect(inside).toBe("opt-in");
    expect(() => safety.assertAllowedUrl(url)).toThrow(/not allowlisted/);
  });

  it("every Install Manager id a speech or voice notice carries is a real catalogue row", () => {
    const rowIds = new Set(catalog.voiceRows("").map((row: { id: string }) => row.id));
    const ids = [
      ...voiceWeights.pinnedJobs().map((job: { id: string }) => job.id),
      ...voiceWeights.modelRegistry().map((item: { catalogId: string }) => item.catalogId),
      ...Object.keys(voiceWeights.STT_CATALOG).map((size) => `stt-${size}`),
    ];
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const entry = prefetch.noticeOf({ id, ok: false });
      expect(rowIds.has(entry.installManagerId), `${id} -> ${entry.installManagerId}`).toBe(true);
    }
    // A chat model is finished from its Ollama row; the runtime of llama.cpp from its engine row.
    expect(prefetch.noticeOf({ id: "qwen3.5:2b", ok: false }).installManagerId).toBe(
      "model:ollama:qwen3.5:2b",
    );
    expect(prefetch.noticeOf({ id: "llamacpp-runtime", ok: false }).installManagerId).toBe(
      "engine:llama.cpp",
    );
    expect(prefetch.noticeOf({ id: "ollama-setup", ok: false }).installManagerId).toBe("");
  });

  it("two retries that overlap each see the allowance, and neither leaves the switch on", async () => {
    delete process.env["FRIDAY_HF_MIRROR"];
    const seen: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const fetchModel = async () => {
      started += 1;
      await gate; // both calls are in flight before either finishes
      seen.push(`${started}:${safety.familyFor("hf-mirror.com")}`);
      return { ok: false, error: "still down" };
    };
    const first = { ok: false, error: "ETIMEDOUT" };
    const both = Promise.all([
      prefetch.retryViaMirror(pinned(), first, { env: {}, say: () => {}, fetchModel }),
      prefetch.retryViaMirror(pinned(), first, { env: {}, say: () => {}, fetchModel }),
    ]);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    // While both are in flight nothing outside them has the opt-in, and the process environment is untouched.
    expect(started).toBe(2);
    expect(safety.familyFor("hf-mirror.com")).toBe("");
    expect(process.env["FRIDAY_HF_MIRROR"]).toBeUndefined();
    release();
    await both;
    expect(seen).toEqual(["2:opt-in", "2:opt-in"]);
    expect(process.env["FRIDAY_HF_MIRROR"]).toBeUndefined();
    expect(safety.familyFor("hf-mirror.com")).toBe("");
  });

  it("keeps the first result when the mirror fails too, and never retries a wrong file, an unpinned source or an owner-enabled mirror", async () => {
    const never = async () => {
      throw new Error("must not be called");
    };
    const first = { ok: false, error: "ETIMEDOUT" };
    const failed = await prefetch.retryViaMirror(pinned(), first, {
      env: {},
      say: () => {},
      fetchModel: async () => ({ ok: false, error: "SHA-256 mismatch" }),
    });
    expect(failed).toBe(first);
    const wrong = { ok: false, error: "SHA-256 mismatch" };
    expect(await prefetch.retryViaMirror(pinned(), wrong, { env: {}, fetchModel: never })).toBe(
      wrong,
    );
    const unpinned = pinned();
    delete (unpinned.job.sources[0] as { sha256?: string }).sha256;
    expect(await prefetch.retryViaMirror(unpinned, first, { env: {}, fetchModel: never })).toBe(
      first,
    );
    expect(
      await prefetch.retryViaMirror(pinned(), first, {
        env: { FRIDAY_HF_MIRROR: "1" },
        fetchModel: never,
      }),
    ).toBe(first);
    // A repository job (no immutable url) has nothing to mirror.
    const repo = { id: "x", job: { sources: [{ kind: "hf-repo", repo: "a/b" }] } };
    expect(await prefetch.retryViaMirror(repo, first, { env: {}, fetchModel: never })).toBe(first);
    const good = { ok: true };
    expect(await prefetch.retryViaMirror(pinned(), good, { env: {}, fetchModel: never })).toBe(
      good,
    );
    expect(process.env["FRIDAY_HF_MIRROR"]).toBeUndefined();
  });

  it("a real run (no injected downloader) wires the retry, and a test downloader only gets it on request (source)", () => {
    const src = read("scripts/prefetch-models.cjs");
    expect(src).toContain("if (!download || mirrorRetry === true)");
    expect(src).toContain("retryViaMirror(row, result, { fetchModel, progress, env, say })");
  });
});

describe("the fast voice chat model of the plan", () => {
  const f = {
    vramGb: null,
    vramFreeGb: null,
    ramGb: 16,
    ramFreeGb: 12,
    diskFreeGb: 200,
    gpuVendor: null,
    gpuName: null,
    gpus: [],
    cudaReady: false,
    cpuClass: "mid",
    cpu: { avx2: true, avx512: false, logicalCores: 8, physicalCores: 4 },
    vulkan: false,
    cuda: { driverCuda: null, cublas12: null, cudnn9: null, runtimeFilesFound: null },
    network: { online: true, metered: false },
    power: { batteryPresent: false, onAc: true },
    health: { level: "ok", reasons: [] },
  };
  const voice = { tag: "qwen3.5:0.8b", sizeGb: 1, ctx: 4096 };

  async function ollamaRun(
    chat: Record<string, unknown>,
    held: string[],
    pull: (tag: string) => { ok: boolean; error?: string } = () => ({ ok: true }),
  ) {
    const pulled: string[] = [];
    const lines: string[] = [];
    const rows = await prefetch.ensureOllama("C:/friday", null, {
      log: (l: string) => lines.push(l),
      deps: {
        chat,
        fetch: async () => ({
          ok: true,
          json: async () => ({ models: held.map((name) => ({ name })) }),
        }),
        pull: async (tag: string) => {
          pulled.push(tag);
          return pull(tag);
        },
        skipAnswerCheck: true,
      },
    });
    return { rows, pulled, lines };
  }
  const main = { action: "pull", tag: "qwen3.5:2b", reason: "fits", memory: { usableGb: 8 } };

  it("is pulled AFTER the main tag, as an optional model", async () => {
    const r = await ollamaRun({ ...main, voice }, []);
    expect(r.pulled).toEqual(["qwen3.5:2b", "qwen3.5:0.8b"]);
    expect(r.rows.find((row: { id: string }) => row.id === "qwen3.5:0.8b")).toMatchObject({
      ok: true,
      voiceChat: true,
      noticeId: "model:chat-voice:qwen3.5:0.8b",
    });
  });

  it("is skipped when Ollama already holds it, and is also fetched beside a kept main model", async () => {
    const held = await ollamaRun({ ...main, voice }, ["qwen3.5:0.8b"]);
    expect(held.pulled).toEqual(["qwen3.5:2b"]);
    expect(held.lines.join("\n")).toContain("qwen3.5:0.8b already in Ollama");
    const kept = await ollamaRun({ action: "keep", use: "qwen3.5:4b", reason: "kept", voice }, [
      "qwen3.5:4b",
    ]);
    expect(kept.pulled).toEqual(["qwen3.5:0.8b"]);
  });

  it("a failed pull is an optional notice with its own id and the Ollama id, and never marks the main model failed", async () => {
    const r = await ollamaRun({ ...main, voice }, [], (tag) =>
      tag === "qwen3.5:0.8b" ? { ok: false, error: "no route" } : { ok: true },
    );
    const bad = r.rows.find((row: { id: string }) => row.id === "qwen3.5:0.8b");
    expect(bad).toMatchObject({
      ok: false,
      optional: true,
      noticeId: "model:chat-voice:qwen3.5:0.8b",
      installManagerId: "model:ollama:qwen3.5:0.8b",
    });
    expect(prefetch.failureReport(r.rows)).toEqual([]);
    const dir = temp();
    prefetch.recordRowNotices(r.rows, { root: dir, log: () => {} });
    expect(recorded(dir)).toEqual([
      expect.objectContaining({
        id: "model:chat-voice:qwen3.5:0.8b",
        kind: "model",
        installManagerId: "model:ollama:qwen3.5:0.8b",
      }),
    ]);
  });

  it("an older plan with no voice model (undefined, null, or an empty tag) pulls only the main tag", async () => {
    for (const odd of [undefined, null, {}, { tag: "" }]) {
      const r = await ollamaRun({ ...main, voice: odd }, []);
      expect(r.pulled).toEqual(["qwen3.5:2b"]);
    }
    const same = await ollamaRun({ ...main, voice: { tag: "qwen3.5:2b" } }, []);
    expect(same.pulled).toEqual(["qwen3.5:2b"]);
    // A deferred or empty plan pulls no voice model either.
    const deferred = await ollamaRun(
      { action: "defer", tag: "qwen3.5:2b", reason: "metered", voice },
      [],
    );
    expect(deferred.pulled).toEqual([]);
  });

  it("is printed in the this-PC block as 'voice (fast): <tag>' only when the plan carries it", () => {
    const made = plans.buildSetupPlan(f, { root: temp(), installedModels: [] });
    // An older plan has no voice model at all: the hand-built copy drops it, then adds the fake one.
    const { voice: _dropped, ...older } = made.chat;
    const plan = { ...made, chat: older };
    const withVoice = { ...made, chat: { ...made.chat, voice } };
    expect(prefetch.fastVoiceLine(withVoice)).toBe("[friday] INFO     voice (fast): qwen3.5:0.8b");
    expect(prefetch.planLines(withVoice).filter((l: string) => l.includes("voice (fast)"))).toEqual(
      ["[friday] INFO     voice (fast): qwen3.5:0.8b"],
    );
    expect(prefetch.fastVoiceLine(plan)).toBe("");
    expect(prefetch.planLines(plan).some((l: string) => l.includes("voice (fast)"))).toBe(false);
  });
});

describe("the plan record for Doctor", () => {
  const pc = {
    ramGb: 16,
    ramFreeGb: 9,
    diskFreeGb: 120,
    gpu: { name: "RTX 3060", vramGb: 12, computeCap: 8.6, driver: "560.1" },
    cudaDriver: true,
    cudaVersion: "12.6",
    cudaLibs: false,
    vulkan: true,
    avx2: true,
    avx512: false,
    integratedOnly: false,
    online: true,
    metered: false,
    onBattery: false,
  };

  it("writes runtime/setup-plan.json {schema, at, fingerprint, pc} atomically and returns it", () => {
    const dir = temp();
    const record = prefetch.writePlanRecord(dir, { pc }, { now: "2026-01-02T03:04:05.000Z" });
    const file = JSON.parse(readFileSync(path.join(dir, "runtime", "setup-plan.json"), "utf8"));
    expect(file).toEqual(record);
    expect(file).toMatchObject({ schema: 1, at: "2026-01-02T03:04:05.000Z", pc });
    // The plan's own fingerprint when electron/setup-plan.cjs has one, else this script's hash of the PC.
    expect(file.fingerprint).toMatch(/^[0-9a-f]{16,32}$/);
    if (typeof plans.planFingerprint === "function")
      expect(file.fingerprint).toBe(plans.planFingerprint({ pc }));
    expect(existsSync(path.join(dir, "runtime", `setup-plan.json.${process.pid}.tmp`))).toBe(false);
  });

  it("the fingerprint ignores free memory, the line and the disk, and changes with the machine", () => {
    const base = prefetch.pcFingerprint(pc);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(prefetch.pcFingerprint({ ...pc, ramFreeGb: 2, diskFreeGb: 5, online: false })).toBe(
      base,
    );
    expect(prefetch.pcFingerprint({ ...pc, ramGb: 32 })).not.toBe(base);
    expect(prefetch.pcFingerprint({ ...pc, gpu: null })).not.toBe(base);
    expect(prefetch.pcFingerprint({ ...pc, gpu: { ...pc.gpu, driver: "570.0" } })).not.toBe(base);
  });

  it("is best effort: no root, no plan or an unwritable folder returns null and never throws", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "runtime"), "a file");
    expect(prefetch.writePlanRecord(dir, { pc })).toBeNull();
    expect(prefetch.writePlanRecord("", { pc })).toBeNull();
    expect(prefetch.writePlanRecord(temp(), null)).toBeNull();
    expect(prefetch.writePlanRecord(temp(), {})).toBeNull();
  });

  it("a setup run records the PC it planned for", async () => {
    const dir = temp();
    await prefetch.prefetch(dir, {
      env: {
        FRIDAY_PREFETCH: "1",
        FRIDAY_PREFETCH_MOONSHINE: "0",
        FRIDAY_PREFETCH_CHAT: "0",
        FRIDAY_MODEL_FRESHNESS: "0",
        CI: "",
        GITHUB_ACTIONS: "",
      },
      platform: "linux",
      log: () => {},
      board: null,
      facts: {
        ramGb: 16,
        ramFreeGb: 10,
        diskFreeGb: 200,
        gpus: [],
        cpu: { avx2: true },
        network: { online: true, metered: false },
        power: { batteryPresent: false, onAc: true },
        health: { level: "ok", reasons: [] },
      },
      probe: { totalRamGb: 16, freeRamGb: 10, cpuThreads: 8, gpu: { name: "", vramGb: 0 } },
      installedModels: [],
      download: async () => ({ ok: true, bytes: 1 }),
    });
    const file = JSON.parse(readFileSync(path.join(dir, "runtime", "setup-plan.json"), "utf8"));
    expect(file.schema).toBe(1);
    expect(file.fingerprint).toBeTruthy();
    expect(file.pc.ramGb).toBe(16);
  });
});

describe("the Python and toolkit steps share the notice record", () => {
  it("both steps read the same strict switch as the model step", () => {
    const toolkit = require_(path.join(root, "scripts/prefetch-toolkit.cjs"));
    for (const strict of [prefetch.strict, toolkit.strict]) {
      expect(strict({})).toBe(false);
      expect(strict({ FRIDAY_SETUP_STRICT: "1" })).toBe(true);
    }
    expect(notices.isStrict({})).toBe(false);
  });

  it("none of the three scripts names an assistant, a model or a tool of the agent kind", () => {
    for (const rel of [
      "scripts/prefetch-models.cjs",
      "scripts/prefetch-toolkit.cjs",
      "scripts/setup-python.cjs",
      "scripts/setup-notices.cjs",
    ])
      expect(read(rel), rel).not.toMatch(/\b(claude|anthropic|copilot|chatgpt|openai codex)\b/i);
  });
});
