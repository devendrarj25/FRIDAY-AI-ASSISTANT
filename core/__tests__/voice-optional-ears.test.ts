/**
 * The Hinglish ear and the Hindi fallback: two optional faster-whisper folders, pinned by revision, SHA-256 and
 * bytes, never bundled, each with a Models-page row, a Doctor pin row and a repair. The default listening path
 * never reaches the Hinglish ear. Offline: the disk is a temp folder and nothing is downloaded.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { modelById } from "../../src/lib/friday/model-catalog";
import { VOICE_MODEL_IDS } from "../../src/lib/friday/models-engine";
import { sttHotwords, whisperLanguageArg } from "../../src/lib/friday/voice-stt";

type Pin = {
  revision: string;
  license: string;
  files: Record<string, { sha256: string; bytes: number }>;
};
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => Pin | null;
  auditDir: (
    dir: string,
    pin: Pin,
    options?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; missing: string[]; wrongSize: string[]; wrongDigest: string[] }>;
  removeBad: (dir: string, audit: { wrongSize: string[]; wrongDigest: string[] }) => string[];
  selectPinned: (
    listing: { files: string[]; meta?: Record<string, { sha256?: string }> },
    pin: Pin,
  ) => { ok: boolean; error?: string };
};
const weights = req("../../electron/voice-weights.cjs") as {
  HINGLISH_EAR_REPO: string;
  HINDI_FALLBACK_REPO: string;
  EAR_MODELS: Array<{ catalogId: string; repo: string; rowId: string }>;
  voiceModelsOnDisk: (
    root: string,
    exists: (file: string) => boolean,
  ) => Array<{ catalogId: string; kind: string }>;
  pinChecks: (
    root: string,
    deps: Record<string, unknown>,
  ) => Promise<Array<{ id: string; ok: boolean; detail: string }>>;
};
const caps = req("../../electron/model-capabilities.cjs") as {
  resolveCapabilities: (model: Record<string, unknown>) => Record<string, unknown>;
};
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");

const HEX64 = /^[0-9a-f]{64}$/;
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-ears-"));
  folders.push(dir);
  return dir;
}

describe("the Hinglish ear is pinned", () => {
  const pin = () => pins.pinForRepo(weights.HINGLISH_EAR_REPO)!;

  it("is the Apache-2.0 CTranslate2 conversion at one revision, with every file's digest and size", () => {
    expect(weights.HINGLISH_EAR_REPO).toBe("MSpider3/whisper-hindi2hinglish-swift-ct2");
    expect(pin().revision).toBe("484362f23d657c07c2762ce1c52d7b4a7ab49d25");
    expect(pin().license).toBe("Apache-2.0");
    expect(Object.keys(pin().files).sort()).toEqual([
      "config.json",
      "model.bin",
      "preprocessor_config.json",
      "tokenizer.json",
      "vocabulary.json",
    ]);
    expect(pin().files["model.bin"]).toEqual({
      sha256: "223a6e80ea056a01a7bf748a44e7a1c11ab79601ce5f84720365aac38565b87f",
      bytes: 76396677,
    });
    for (const row of Object.values(pin().files)) expect(row.sha256).toMatch(HEX64);
  });
});

describe("the Hindi fallback is pinned and credited", () => {
  const pin = () => pins.pinForRepo(weights.HINDI_FALLBACK_REPO)!;

  it("is the CC-BY-4.0 Collabora conversion at one revision, with every file's digest and size", () => {
    expect(weights.HINDI_FALLBACK_REPO).toBe("collabora/faster-whisper-small-hindi");
    expect(pin().revision).toBe("92e09a8982af971cf2033ed592d4ef8b249baad2");
    expect(pin().license).toBe("CC-BY-4.0");
    expect(Object.keys(pin().files).sort()).toEqual([
      "config.json",
      "model.bin",
      "preprocessor_config.json",
      "tokenizer.json",
      "vocabulary.json",
    ]);
    expect(pin().files["model.bin"]).toEqual({
      sha256: "0ad00358a5dd71fc8e094a768caa1f67dad9dbb107641cc6323502a0bf7c2ef7",
      bytes: 483546977,
    });
    for (const row of Object.values(pin().files)) expect(row.sha256).toMatch(HEX64);
  });

  it("shows the FRIDAY name and no credit in the Models page text", () => {
    const row = modelById.get("hindi-fallback-ear")!;
    expect(row.license).toBe("CC-BY-4.0");
    expect(row.name).toBe("FRIDAY Ear Hindi Backup");
    expect(row.url).toBe("https://huggingface.co/collabora/faster-whisper-small-hindi");
  });
});

describe("both ears have a Models row, a disk check, a Doctor pin row and a repair", () => {
  const ears = () => weights.EAR_MODELS.filter((ear) => ear.catalogId !== "hindi-ear");

  it("lists both in the catalogue as speech models, installed only from the disk", () => {
    expect(ears().map((ear) => ear.catalogId)).toEqual(["hinglish-ear", "hindi-fallback-ear"]);
    for (const ear of ears()) {
      const row = modelById.get(ear.catalogId)!;
      expect(row.category).toBe("Speech to Text");
      expect(row.installed ?? null).toBeNull();
      expect(VOICE_MODEL_IDS).toContain(ear.catalogId);
      expect(row.url).toBe(`https://huggingface.co/${ear.repo}`);
    }
  });

  it("is recognised as audio, not a chat model", () => {
    for (const ear of ears()) {
      const found = caps.resolveCapabilities({ id: ear.catalogId, name: ear.catalogId }) as {
        audio?: boolean;
        chat?: boolean;
      };
      expect(found.audio, ear.catalogId).toBe(true);
      expect(found.chat, ear.catalogId).not.toBe(true);
    }
  });

  it("is installed only when every pinned file is on disk", () => {
    for (const ear of ears()) {
      const names = Object.keys(pins.pinForRepo(ear.repo)!.files);
      const have = (missing: string) => (file: string) =>
        names.some(
          (name) => name !== missing && file.endsWith(`${ear.catalogId}${path.sep}${name}`),
        );
      const ids = (missing: string) =>
        weights.voiceModelsOnDisk("/friday", have(missing)).map((row) => row.catalogId);
      expect(ids("")).toContain(ear.catalogId);
      expect(ids("tokenizer.json")).not.toContain(ear.catalogId);
    }
  });

  it("gives the voice check one pin row each, only when installed, red for a short file", async () => {
    const root = temp();
    const exists = (file: string) => fs.existsSync(file);
    expect((await weights.pinChecks(root, { exists })).map((row) => row.id)).toEqual([]);
    for (const ear of ears()) {
      const dir = path.join(root, "models", ear.catalogId);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of Object.keys(pins.pinForRepo(ear.repo)!.files)) {
        fs.writeFileSync(path.join(dir, name), "x");
      }
    }
    const rows = await weights.pinChecks(root, { exists });
    for (const ear of ears()) {
      const row = rows.find((entry) => entry.id === ear.rowId);
      expect(row?.ok, ear.rowId).toBe(false);
      expect(row?.detail).toMatch(/model\.bin wrong size/);
    }
    expect(ears().map((ear) => ear.rowId)).toEqual(["hinglish-ear-pin", "hindi-fallback-ear-pin"]);
  });

  it("repairs only the damaged file, with a hash check when asked", async () => {
    const root = temp();
    const dir = path.join(root, "models", "hinglish-ear");
    fs.mkdirSync(dir, { recursive: true });
    const pin = pins.pinForRepo(weights.HINGLISH_EAR_REPO)!;
    // A tiny stand-in pin: one good file and one wrong-size file, the same audit and repair the real pin gets.
    const small: Pin = {
      ...pin,
      files: {
        "config.json": { sha256: pin.files["config.json"]!.sha256, bytes: 4 },
        "model.bin": { sha256: pin.files["model.bin"]!.sha256, bytes: 8 },
      },
    };
    fs.writeFileSync(path.join(dir, "config.json"), "abcd");
    fs.writeFileSync(path.join(dir, "model.bin"), "short");
    const audit = await pins.auditDir(dir, small);
    expect(audit.wrongSize).toEqual(["model.bin"]);
    expect(pins.removeBad(dir, audit)).toEqual(["model.bin"]);
    expect(fs.existsSync(path.join(dir, "model.bin"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("refuses a listing that lacks a pinned file or names another digest", () => {
    for (const ear of ears()) {
      const pin = pins.pinForRepo(ear.repo)!;
      const names = Object.keys(pin.files);
      expect(pins.selectPinned({ files: names.slice(1) }, pin).ok).toBe(false);
      const meta = { "model.bin": { sha256: "0".repeat(64) } };
      expect(pins.selectPinned({ files: names, meta }, pin).ok).toBe(false);
      expect(pins.selectPinned({ files: names }, pin).ok).toBe(true);
    }
  });
});

describe("the default path never uses the Hinglish ear", () => {
  it("listens in auto by default (never the Roman mode) and keeps the new settings off", () => {
    expect(DEFAULT_PREFERENCES.voice.recognitionLang).toBe("auto");
    expect(DEFAULT_PREFERENCES.voice.recognitionLang).not.toMatch(/latn|roman/i);
    expect(DEFAULT_PREFERENCES.voice.sttMultilingual).toBe(false);
  });

  it("offers the Roman mode as an explicit extra choice, not as the first or the default", () => {
    const source = read("src/components/friday/settings/VoiceSettings.tsx");
    const list = /const RECOGNITION_LANGS = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
    expect(list).toContain('value: "hi-Latn"');
    expect(list.indexOf('"auto"')).toBeLessThan(list.indexOf('"hi-IN"'));
    expect(list.indexOf('"hi-IN"')).toBeLessThan(list.indexOf('"hi-Latn"'));
    expect(source).toContain("sttMultilingual");
  });

  it("does not lock Whisper's language for the Roman mode (the kernel decodes it as English itself)", () => {
    expect(whisperLanguageArg("hi-Latn")).toBe("");
    expect(whisperLanguageArg("hi-IN")).toBe("");
    expect(whisperLanguageArg("auto")).toBe("");
  });

  it("the kernel reaches it only for hi-Latn and hinglish-roman", () => {
    const source = read("kernel/whisper_ears.py");
    expect(source).toMatch(/ROMAN_MODES = frozenset\(\{"hi-latn", "hinglish-roman"\}\)/);
    const worker = read("kernel/stt.py");
    expect(worker).toMatch(/whisper_ears\.choose\(/);
  });
});

describe("hotwords and multilingual are sent only when set", () => {
  it("builds the owner's dictionary as one deduplicated line, empty when there are none", () => {
    expect(sttHotwords([])).toBe("");
    expect(sttHotwords(["", "  ", null, undefined])).toBe("");
    expect(sttHotwords(["Friday", "friday", " Rahul  Sharma ", "GitHub, Jira"])).toBe(
      "Friday, Rahul Sharma, GitHub Jira",
    );
    expect(
      sttHotwords(Array.from({ length: 80 }, (_, i) => `name${i}`)).length,
    ).toBeLessThanOrEqual(200);
  });

  it("adds them to the request only when non-empty, in the transcribe call and the main process", () => {
    const stt = read("src/lib/friday/voice-stt.ts");
    expect(stt).toMatch(/\.\.\.\(hotwords \? \{ hotwords \} : \{\}\)/);
    expect(stt).toMatch(/\.\.\.\(multilingual \? \{ multilingual: true \} : \{\}\)/);
    expect(stt).toContain("voice.sttMultilingual === true");
    const main = read("electron/stt.cjs");
    expect(main.match(/\.\.\.decodeExtras\(req\)/g)?.length).toBe(3);
    expect(main).toMatch(/req\.multilingual === true \? \{ multilingual: true \}/);
  });
});
