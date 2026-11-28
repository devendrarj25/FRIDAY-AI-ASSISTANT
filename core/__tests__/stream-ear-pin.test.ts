/**
 * The optional streaming ear (NVIDIA Nemotron 3.5 ASR Streaming 0.6B, ONNX int8 by soniqo): the exact pin read from the
 * Hugging Face tree API on 2026-11-26, the encoder's declared tensor contract that FRIDAY's own onnxruntime loop codes
 * against, and the guarantee that setup fetches it only through this PC's voice plan (never by a hard-coded job or
 * source; the plan gate itself is core/__tests__/stream-ear-setup.test.ts). Offline: no weights are read, a fake runner stands in for the
 * kernel self-test, the disk is a temp folder.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { modelById, voiceModelFacts } from "../../src/lib/friday/model-catalog";

type Pin = {
  revision: string;
  license: string;
  files: Record<string, { sha256: string; bytes: number }>;
};
type Tensor = { name: string; shape: number[]; type?: string };
type Spec = {
  kind: string;
  wrapper: string | null;
  file: string;
  inputs: Tensor[];
  outputs: Tensor[];
};
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
  manifestFor: (repo: string) => Record<string, unknown> | null;
  pinnedRepos: () => string[];
  SELF_TESTS: Record<string, Spec>;
};
const weights = req("../../electron/voice-weights.cjs") as {
  STREAM_EAR_REPO: string;
  pinnedJobs: () => { id: string }[];
  modelRegistry: () => { catalogId: string; kind: string }[];
  voiceInstallPlan: (
    root: string,
    probe: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => {
    items: { id: string }[];
    optional: string[];
    streamEar: { id: string; state: string } | null;
  };
  pinSelfTests: (
    root: string,
    deps: {
      exists?: (file: string) => boolean;
      runSelfTest?: (input: { catalogId: string; dir: string; spec: unknown }) => Promise<unknown>;
    },
  ) => Promise<
    { id: string; ok: boolean; required?: boolean; installId?: string; detail: string }[]
  >;
};

const prefetch = req("../../scripts/prefetch-models.cjs") as {
  prefetchPlan: (
    root: string,
    env: Record<string, string>,
    platform: string,
    have?: Record<string, unknown>,
  ) => { id: string }[];
};
const STRONG_PC = {
  totalRamGb: 64,
  freeRamGb: 48,
  cpuThreads: 32,
  gpu: { name: "big GPU", vramGb: 24, source: "driver", cudaRuntimeReady: true },
};

const REPO = "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8";
const REVISION = "1ce4daedd303e01d4e603634a72c28562f1a6855";
const ID = "stream-ear-nemotron";
const root = path.join(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const made: string[] = [];
afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-streamear-"));
  made.push(dir);
  return dir;
};

describe("the pin is the revision and bytes read from the Hugging Face tree API", () => {
  const pin = pins.pinForRepo(REPO)!;

  it("names a 40-hex commit, never a branch, and the licence tag of the repository", () => {
    expect(weights.STREAM_EAR_REPO).toBe(REPO);
    expect(pin.revision).toBe(REVISION);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.license).toBe("NVIDIA-Open-Model-License");
  });

  it("records the upstream OpenMDW-1.1 card at its revision while the conservative class stays", () => {
    const rec = (
      pin as unknown as {
        licenseRecord: {
          redistribution: string;
          upstream: { id: string; revision: string; checkedAt: string; source: string };
        };
      }
    ).licenseRecord;
    expect(rec.upstream.id).toBe("OpenMDW-1.1");
    expect(rec.upstream.revision).toBe("ea30d66debe3740a08b573244286791d423d6b3e");
    expect(rec.upstream.checkedAt).toBe("2026-11-28");
    expect(rec.upstream.source).toBe(
      "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b",
    );
    expect(rec.redistribution).toBe("attribution");
  });

  it("lists exactly the eight files, each with the SHA-256 and size of the pinned revision", () => {
    expect(pin.files).toEqual({
      "config.json": {
        sha256: "0592a224f30670e00f5e0f1f106f0171428b0abde0fd4cbc64237b02c2241502",
        bytes: 602,
      },
      "decoder.onnx": {
        sha256: "68e7c40e673e94b364476303d687478ed7726bfb984e3496d0234d8e368b0894",
        bytes: 4345,
      },
      "decoder.onnx.data": {
        sha256: "4f2ced2289e1a62f7576ae9b42a97b972bdbc001eca8b41c4cc4c2421c0982eb",
        bytes: 59760640,
      },
      "encoder.onnx": {
        sha256: "faba6d952270255f1f9c4c22a44fbc60439638d808cb9feee51bba6a8daf0f87",
        bytes: 657558932,
      },
      "joint.onnx": {
        sha256: "c2839f49ac23e353c60b82ad325afcabee38e5ee6f8238fe575799908f877fc4",
        bytes: 2023,
      },
      "joint.onnx.data": {
        sha256: "5e96c9d54ee68a924f58fd734cd64ddf6fa0dd0f81c981ceb1a5bac5e860d74c",
        bytes: 37822592,
      },
      "languages.json": {
        sha256: "a1efe863e1057d4658bce8175c978020ac35a63a3c9a65ae899f324a32c8e4f6",
        bytes: 2020,
      },
      "vocab.json": {
        sha256: "fd726dc25cc0c0b46403675127e831bab56ca56b8c7ae3ee7781f5c6d7692f4f",
        bytes: 236127,
      },
    });
    expect(pins.pinnedBytes(pin)).toBe(755387281);
    expect(pins.manifestFor(REPO)).toMatchObject({
      diskBytes: 755387281,
      cpuOk: true,
      gpuOk: false,
      fallbackPriority: "experimental",
      basis: "measured",
    });
  });

  it("the plain source holds no branch URL for it and the model card's phantom encoder.onnx.data is not pinned", () => {
    expect(Object.keys(pin.files)).not.toContain("encoder.onnx.data");
    const text = read("electron/voice-pins.cjs") + read("electron/voice-weights.cjs");
    expect(text).not.toMatch(/soniqo\/[^\s"']*\/(resolve|raw|blob)\/(main|master)\b/);
  });
});

describe("the encoder contract the transducer loop codes against", () => {
  const spec = pins.SELF_TESTS[REPO]!;
  it("declares the cache-aware streaming signature read from the pinned encoder.onnx with onnxruntime 1.32", () => {
    expect(spec).toMatchObject({ kind: "onnx-signature", file: "encoder.onnx", wrapper: null });
    expect(spec.inputs).toEqual([
      { name: "audio_signal", shape: [1, 128, 32], type: "float32" },
      { name: "audio_length", shape: [1], type: "int32" },
      { name: "language_mask", shape: [1, 128], type: "float32" },
      { name: "pre_cache", shape: [1, 128, 9], type: "float32" },
      { name: "cache_last_channel", shape: [24, 1, 56, 1024], type: "float32" },
      { name: "cache_last_time", shape: [24, 1, 1024, 8], type: "float32" },
      { name: "cache_last_channel_len", shape: [1], type: "int32" },
    ]);
    expect(spec.outputs).toEqual([
      { name: "encoded_output", shape: [1, 4, 1024] },
      { name: "encoded_length", shape: [1] },
      { name: "new_pre_cache", shape: [1, 128, 9] },
      { name: "new_cache_last_channel", shape: [24, 1, 56, 1024] },
      { name: "new_cache_last_time", shape: [24, 1, 1024, 8] },
      { name: "new_cache_last_channel_len", shape: [1] },
    ]);
  });

  it("every cache comes back under a new_ name with the shape it went in with, so it can be fed straight back", () => {
    for (const input of [
      "pre_cache",
      "cache_last_channel",
      "cache_last_time",
      "cache_last_channel_len",
    ]) {
      const out = spec.outputs.find((item) => item.name === `new_${input}`)!;
      expect(out.shape, input).toEqual(spec.inputs.find((item) => item.name === input)!.shape);
    }
  });
});

describe("setup fetches it only through this PC's voice plan", () => {
  it("is not a pinned job, not a base plan item, not in a plan-less prefetch, and named in no setup source", () => {
    expect(weights.pinnedJobs().map((row) => row.id)).not.toContain(ID);
    const plan = weights.voiceInstallPlan(temp(), STRONG_PC, { exists: () => false });
    expect(plan.items.map((item) => item.id)).not.toContain(ID);
    expect(plan.optional).not.toContain(ID);
    // The plan decides it apart, and only the pinned repository is ever its source.
    expect(plan.streamEar?.id).toBe(ID);
    const fetched = prefetch.prefetchPlan(temp(), {}, "win32").map((row) => row.id);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched).not.toContain(ID);
    const planned = prefetch
      .prefetchPlan(temp(), {}, "win32", { plan })
      .filter((row) => row.id === ID) as unknown as { job: { sources: unknown[] } }[];
    expect(planned).toHaveLength(plan.streamEar?.state === "download" ? 1 : 0);
    for (const row of planned)
      expect(row.job.sources).toEqual([expect.objectContaining({ kind: "hf-repo", repo: REPO })]);
    for (const file of [
      "scripts/prefetch-models.cjs",
      "scripts/setup-windows.ps1",
      "electron/setup-plan.cjs",
    ]) {
      const text = read(file);
      expect(text, file).not.toMatch(/stream-ear-nemotron|Nemotron|soniqo/i);
    }
  });

  it("is an optional registry model that the Models page and the Install Manager can fetch on demand", () => {
    const row = weights.modelRegistry().find((entry) => entry.catalogId === ID)!;
    expect(row.kind).toBe("stt");
    const model = modelById.get(ID)!;
    expect(model.url).toBe(`https://huggingface.co/${REPO}`);
    expect(model.license).toBe("NVIDIA-Open-Model-License");
    expect(model.name).toMatch(/candidate/);
    expect(model.installed ?? null).toBeNull();
    const facts = voiceModelFacts[ID]!;
    expect(facts.diskBytes).toBe(pins.pinnedBytes(pins.pinForRepo(REPO)!));
    expect(facts.fallbackPriority).toBe("experimental");
  });
});

describe("the Doctor rows, with a fake runtime", () => {
  const stage = (dir: string) => {
    for (const name of Object.keys(pins.pinForRepo(REPO)!.files)) {
      const file = path.join(dir, "models", ID, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
  };
  const rowOf = <T extends { id: string }>(rows: T[], id: string) =>
    rows.find((row) => row.id === id);

  it("offers the install button when it is absent and never requires it", async () => {
    const rows = await weights.pinSelfTests(temp(), { exists: () => false });
    expect(rowOf(rows, `optional-${ID}`)).toMatchObject({
      ok: true,
      optional: true,
      required: false,
      installId: ID,
    });
  });

  it("passes the pinned spec to the runner and says a pass is not use while no wrapper runs it", async () => {
    const dir = temp();
    stage(dir);
    const seen: unknown[] = [];
    const rows = await weights.pinSelfTests(dir, {
      exists: (file) => fs.existsSync(file),
      runSelfTest: async (input) => {
        seen.push(input);
        return { ok: true, reason: "", detail: "opens and ran one pass" };
      },
    });
    const row = rowOf(rows, `selftest-${ID}`)!;
    expect(row).toMatchObject({ ok: true, required: false });
    expect(row.detail).toMatch(/no live wrapper runs it yet/);
    expect(seen.map((input) => (input as { spec: unknown }).spec)).toContain(pins.SELF_TESTS[REPO]);
  });

  it("goes red with a repair button when the encoder does not open", async () => {
    const dir = temp();
    stage(dir);
    const rows = await weights.pinSelfTests(dir, {
      exists: (file) => fs.existsSync(file),
      runSelfTest: async () => ({ ok: false, reason: "cannot-open", detail: "InvalidProtobuf" }),
    });
    expect(rowOf(rows, `selftest-${ID}`)).toMatchObject({
      ok: false,
      required: false,
      installId: ID,
      detail: "cannot-open: InvalidProtobuf",
    });
  });
});
