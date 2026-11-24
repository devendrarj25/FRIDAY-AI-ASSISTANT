/**
 * The three optional pins added with the voice engine registry (the DPDFNet denoiser, the WeSpeaker speaker model, the
 * Hindi Vaani ear): exact pins, Models rows with credit, the fit the Install Manager shows from facts, and the Doctor
 * self-test rows. Offline: a fake runner stands in for the kernel, the disk is a temp folder, nothing is downloaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { modelById } from "../../src/lib/friday/model-catalog";
import { VOICE_MODEL_IDS } from "../../src/lib/friday/models-engine";

type Pin = {
  revision: string;
  license: string;
  files: Record<string, { sha256: string; bytes: number }>;
};
type Row = {
  id: string;
  ok: boolean;
  optional?: boolean;
  installId?: string;
  detail: string;
  label?: string;
  blocked?: boolean;
  required?: boolean;
};
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
  SELF_TESTS: Record<
    string,
    {
      kind: string;
      wrapper: string | null;
      file?: string;
      needs?: string[];
      companion?: { file: string; sourceRepo: string; reason: string };
    }
  >;
};
const weights = req("../../electron/voice-weights.cjs") as {
  DENOISE_REPO: string;
  SPEAKER_REPO: string;
  HINDI_VAANI_REPO: string;
  pinSelfTests: (
    root: string,
    deps: {
      exists?: (file: string) => boolean;
      runSelfTest?: (input: { catalogId: string; dir: string; spec: unknown }) => Promise<unknown>;
    },
  ) => Promise<Row[]>;
};
const catalog = req("../../electron/installer-catalog.cjs") as {
  voiceRows: (
    root: string,
    deps: Record<string, unknown>,
  ) => { id: string; byRevision?: boolean; [key: string]: unknown }[];
};
const fit = req("../../electron/engine-fit.cjs") as {
  classify: (row: unknown, facts: unknown) => { state: string; reasons: { text: string }[] };
};

const HEX64 = /^[0-9a-f]{64}$/;
const made: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-optpins-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
});

const PINNED = [
  { id: "denoise-dpdfnet", repo: weights.DENOISE_REPO },
  { id: "speaker-wespeaker", repo: weights.SPEAKER_REPO },
  { id: "hindi-vaani-ear", repo: weights.HINDI_VAANI_REPO },
];

describe("the pins read from the Hugging Face API on 2026-11-23", () => {
  it("pin the one graph each needs, by revision, SHA-256 and bytes", () => {
    const dpdf = pins.pinForRepo("Ceva-IP/DPDFNet")!;
    expect(dpdf.license).toBe("Apache-2.0");
    expect(dpdf.revision).toBe("dd6818d00f50c836fed43a6243ebe49116de5964");
    expect(Object.keys(dpdf.files)).toEqual(["onnx/dpdfnet8.onnx"]);
    expect(dpdf.files["onnx/dpdfnet8.onnx"]).toEqual({
      sha256: "899d4f23f3ff86edbffa8c537e4bcbdc49da1b4e84e0ef390611e0604a3b26cb",
      bytes: 14542517,
    });
    const speaker = pins.pinForRepo("onnx-community/wespeaker-voxceleb-resnet34-LM")!;
    expect(speaker.license).toBe("CC-BY-4.0");
    expect(speaker.revision).toBe("6a61a1833ff2583aabeba044f5c8221f00b67ceb");
    expect(speaker.files["onnx/model_int8.onnx"]).toEqual({
      sha256: "6416fae0599c33bdaf7188e99695edc5fafde190a102c511c881245a109de4c3",
      bytes: 6685123,
    });
    expect(Object.keys(speaker.files)).not.toContain("onnx/model.onnx");
    const vaani = pins.pinForRepo("bjollans/whisper-large-v3-vaani-hindi-ct2")!;
    expect(vaani.license).toBe("Apache-2.0");
    expect(vaani.revision).toBe("27e81d52186393a5e7ee6f3a64ebd5c627dc25ed");
    expect(vaani.files["model.bin"]).toEqual({
      sha256: "34c0d6c1c80fabd91af9d8c91c5089c2f3f314bda9ee3169b3e844c7ad2d011b",
      bytes: 3087284237,
    });
    for (const pin of [dpdf, speaker, vaani]) {
      expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
      for (const row of Object.values(pin.files)) expect(row.sha256).toMatch(HEX64);
    }
  });

  it("have a self-test, and none of them claims a live wrapper", () => {
    for (const { repo } of PINNED) {
      const spec = pins.SELF_TESTS[repo]!;
      expect(["onnx-signature", "ct2-folder"]).toContain(spec.kind);
      expect(spec.wrapper).toBeNull();
    }
    expect(pins.SELF_TESTS["Ceva-IP/DPDFNet"]!.file).toBe("onnx/dpdfnet8.onnx");
  });
});

describe("the Models rows and the Install Manager rows", () => {
  it("list each with its licence, credit and size, uninstalled by default, as audio", () => {
    for (const { id, repo } of PINNED) {
      const row = modelById.get(id)!;
      expect(row.url).toBe(`https://huggingface.co/${repo}`);
      expect(row.license).toBe(pins.pinForRepo(repo)!.license);
      expect(row.installed ?? null).toBeNull();
      expect(VOICE_MODEL_IDS).toContain(id);
    }
    expect(modelById.get("speaker-wespeaker")!.name).toMatch(/credit: WeSpeaker.*CC-BY-4\.0/);
    expect(modelById.get("hindi-vaani-ear")!.name).toMatch(/candidate/);
  });

  it("show in the Install Manager as optional voice models, with the fit read from facts", () => {
    const root = temp();
    const rows = catalog.voiceRows(root, {});
    for (const { id } of PINNED) {
      const row = rows.find((entry) => entry.id === `voice:${id}`)!;
      expect(row, id).toMatchObject({ kind: "voice-model", optional: true, installed: false });
      expect(row.byRevision).toBe(true);
    }
    const cpuOnly = {
      ramGb: 8,
      ramFreeGb: 5,
      gpus: [],
      sources: ["os-memory"],
      os: { is64Bit: true },
      cpu: { avx2: true },
      modelDrive: { freeGb: 100 },
      cuda: {},
      network: { online: true, metered: false },
      power: { onAc: true },
      vulkan: false,
    };
    const of = (id: string) =>
      fit.classify(
        rows.find((entry) => entry.id === `voice:${id}`),
        cpuOnly,
      );
    expect(of("denoise-dpdfnet").state).toBe("supported");
    expect(of("speaker-wespeaker").state).toBe("supported");
    expect(of("hindi-vaani-ear").state).not.toBe("supported"); // 3 GB of weights, a GPU model, no GPU here
  });
});

describe("the Vaani ear and its missing tokenizer", () => {
  const spec = () => pins.SELF_TESTS["bjollans/whisper-large-v3-vaani-hindi-ct2"]!;

  it("does not ask the pinned files for a tokenizer they cannot hold, and names where it comes from", () => {
    const vaani = pins.pinForRepo("bjollans/whisper-large-v3-vaani-hindi-ct2")!;
    expect(Object.keys(vaani.files)).not.toContain("tokenizer.json");
    expect(spec().needs).toEqual(
      Object.keys(vaani.files)
        .filter((name) => name !== "preprocessor_config.json")
        .sort(),
    );
    expect(spec().needs).not.toContain("tokenizer.json");
    const companion = spec().companion!;
    expect(companion.file).toBe("tokenizer.json");
    const source = pins.pinForRepo(companion.sourceRepo)!;
    expect(source.files[companion.file]).toBeTruthy(); // the large-v3 tokenizer is already pinned
    expect(source.files["vocabulary.json"]!.sha256).toBe(vaani.files["vocabulary.json"]!.sha256); // the same vocabulary
  });

  const stage = (root: string) => {
    for (const name of Object.keys(pins.pinForRepo(weights.HINDI_VAANI_REPO)!.files)) {
      const file = path.join(root, "models", "hindi-vaani-ear", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
  };

  it("shows a blocked row with its reason, no repair button and no red, until the tokenizer is there", async () => {
    const root = temp();
    stage(root);
    const rows = await weights.pinSelfTests(root, {
      exists: (file) => fs.existsSync(file),
      runSelfTest: async ({ catalogId }) =>
        catalogId === "hindi-vaani-ear"
          ? {
              ok: true,
              blocked: true,
              reason: "blocked-needs-tokenizer.json",
              detail: "needs the large-v3 tokenizer.json",
            }
          : { ok: true, detail: "fine" },
    });
    const row = rows.find((entry) => entry.id === "selftest-hindi-vaani-ear")!;
    expect(row).toMatchObject({ ok: true, blocked: true, required: false, installId: "" });
    expect(row.label).toMatch(/blocked/);
    expect(row.detail).toMatch(/^blocked: needs the large-v3 tokenizer\.json/);
    expect(row.detail).toMatch(/no repair/);
  });
});

describe("the Doctor self-test rows", () => {
  it("offer the install button for an engine that is not installed, and never require it", async () => {
    const rows = await weights.pinSelfTests(temp(), { exists: () => false });
    expect(rows.map((row) => row.id)).toEqual([
      "optional-denoise-dpdfnet",
      "optional-speaker-wespeaker",
      "optional-hindi-vaani-ear",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ ok: true, optional: true, required: false });
      expect(row.installId).toBe(row.id.replace("optional-", ""));
    }
  });

  const stage = (root: string) => {
    for (const { id, repo } of PINNED) {
      for (const name of Object.keys(pins.pinForRepo(repo)!.files)) {
        const file = path.join(root, "models", id, ...name.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "x");
      }
    }
  };

  it("run the engine's own self-test with the pinned spec and say a pass is not use", async () => {
    const root = temp();
    stage(root);
    const seen: { catalogId: string; dir: string; spec: Record<string, unknown> }[] = [];
    const rows = await weights.pinSelfTests(root, {
      exists: (file) => fs.existsSync(file),
      runSelfTest: async (input) => {
        seen.push(input as never);
        return { ok: true, reason: "", detail: "opens and ran one pass" };
      },
    });
    expect(rows.map((row) => row.id)).toEqual([
      "selftest-denoise-dpdfnet",
      "selftest-speaker-wespeaker",
      "selftest-hindi-vaani-ear",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ ok: true, required: false, installId: "" });
      expect(row.detail).toMatch(/no live wrapper runs it yet/);
    }
    expect(seen.map((entry) => entry.dir)).toEqual(
      PINNED.map(({ id }) => path.join(root, "models", id)),
    );
    expect(seen[0]!.spec).toBe(pins.SELF_TESTS["Ceva-IP/DPDFNet"]);
  });

  it("go red with the reason and a repair button when the engine does not open, or the runner breaks", async () => {
    const root = temp();
    stage(root);
    const rows = await weights.pinSelfTests(root, {
      exists: (file) => fs.existsSync(file),
      runSelfTest: async ({ catalogId }) => {
        if (catalogId === "speaker-wespeaker") throw new Error("python is gone");
        return { ok: false, reason: "inputs-differ", detail: "graph inputs are ['x']" };
      },
    });
    for (const row of rows) {
      expect(row.ok, row.id).toBe(false);
      expect(row.required, row.id).toBe(false);
      expect(row.installId, row.id).toBe(row.id.replace("selftest-", ""));
    }
    expect(rows[0]!.detail).toBe("inputs-differ: graph inputs are ['x']");
    expect(rows[1]!.detail).toMatch(/run-failed: python is gone/);
    const noRunner = await weights.pinSelfTests(root, { exists: (file) => fs.existsSync(file) });
    expect(noRunner.every((row) => !row.ok && /no-runner/.test(row.detail))).toBe(true);
  });

  it("is wired into the voice check, which passes the pinned spec to the kernel self-test", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../electron/voice-verify.cjs"), "utf8");
    expect(source).toMatch(/pinSelfTests\(/);
    expect(source).toMatch(/voice_pin_selftest\.py/);
    expect(source).toMatch(/"--spec", JSON\.stringify\(spec\)/);
    expect(fs.existsSync(path.join(__dirname, "../../kernel/voice_pin_selftest.py"))).toBe(true);
  });
});

describe("the registry and the TTS ladder", () => {
  it("the ladder reads the registry and keeps today's order", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../src/lib/friday/voice-engine/tts-provider.ts"),
      "utf8",
    );
    expect(source).toMatch(/const LADDER_ORDER = ttsLadderOrder\(\);/);
    expect(source).not.toMatch(/const LADDER_ORDER = \[/);
  });

  it("pinnedBytes of each pin is its disk number", () => {
    for (const { repo } of PINNED)
      expect(pins.pinnedBytes(pins.pinForRepo(repo)!)).toBeGreaterThan(0);
  });
});
