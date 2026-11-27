/**
 * Every voice model the owner reads about is a FRIDAY name (FRIDAY Ear, FRIDAY Voice, FRIDAY Denoise, ...), never an
 * upstream product name. The rename is label-only: ids, folders, stored words, pin keys and row ids stay as they
 * are (the setup scripts, stored settings and the kernel read them). A short origin credit stays only where a
 * licence needs it, inside a "(credit: ...)" parenthesis or a "... is based on ..." credit line.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { modelById, voicePacks } from "../../src/lib/friday/model-catalog";
import { VOICE_ENGINE_TABLE } from "../../src/lib/friday/voice-engine/voice-engine-table";

const req = createRequire(import.meta.url);
const weights = req("../../electron/voice-weights.cjs") as {
  EAR_MODELS: Array<{ label: string }>;
  EXTRA_MODELS: Array<{ label: string }>;
  modelRegistry: () => Array<{ catalogId: string; label: string }>;
};
const root = path.resolve(__dirname, "../..");

/** Upstream product names that must not be the name of a FRIDAY voice row. */
const UPSTREAM =
  /whisper|nemotron|supertonic|indicconformer|wespeaker|silero|smart[ -]?turn|dpdfnet|gtcrn|vosk|piper|coqui|xtts|pipecat|ctranslate|faster[- ]?whisper|openwakeword/i;

/** A credit parenthesis is the one place an upstream name may stay in a label. */
const withoutCredit = (text: string) => text.replace(/credit:[^)]*\)/g, ")");

/**
 * Where an upstream name stays on purpose (file: reason). Pin keys, repo ids, ids and licence credit lines are
 * data, not product names.
 */
export const ALLOWLIST = [
  "src/lib/friday/model-catalog.ts: row ids, repo urls, and the credit lines of each pack (FRIDAY ... is based on ...)",
  "src/lib/friday/voice-engine/voice-engine-table.ts: ids, repo and pinRepo, evidence links and candidate engines that are not installable",
  "electron/voice-weights.cjs: repo constants, pin keys, source labels naming the download host, and comments",
  "electron/voice-verify.cjs: 'import faster_whisper' and 'import edge_tts' are Python module checks, not product names",
  "model-catalog.ts: cloud and Ollama chat rows such as nemotron-super-49b are provider ids",
];

const VOICE_IDS = {
  catalog: [
    "whisper-large-v3",
    "whispercpp-base",
    "faster-whisper",
    "faster-whisper-tiny",
    "faster-whisper-base",
    "faster-whisper-small",
    "faster-whisper-medium",
    "faster-whisper-large-v3-turbo",
    "vosk-en",
    "piper-en",
    "coqui-tts",
    "xtts-v2",
    "silero-vad",
    "supertonic-3",
    "smart-turn",
    "hindi-ear",
    "hinglish-ear",
    "hindi-fallback-ear",
    "hindi-punct",
    "hindi-light-tts",
    "denoise-dpdfnet",
    "denoise-gtcrn",
    "speaker-wespeaker",
    "hindi-vaani-ear",
    "stream-ear-nemotron",
    "hinglish-ear-trelis",
  ],
};

const EXPECTED_NAME: Record<string, RegExp> = {
  "stream-ear-nemotron": /^FRIDAY Ear Live\b/,
  "hindi-ear": /^FRIDAY Ear Hindi$/,
  "hinglish-ear": /^FRIDAY Ear Hinglish\b/,
  "hinglish-ear-trelis": /^FRIDAY Ear Hinglish Large\b/,
  "faster-whisper-small": /^FRIDAY Ear small$/,
  "supertonic-3": /^FRIDAY Voice$/,
  "hindi-light-tts": /^FRIDAY Voice Lite\b/,
  "denoise-dpdfnet": /^FRIDAY Denoise\b/,
  "denoise-gtcrn": /^FRIDAY Denoise Lite\b/,
  "speaker-wespeaker": /^FRIDAY Speaker\b/,
  "silero-vad": /^FRIDAY Listen Gate$/,
  "smart-turn": /^FRIDAY Turn$/,
  "hindi-punct": /^FRIDAY Punctuate Hindi\b/,
};

describe("the Models page names every voice model as FRIDAY", () => {
  it("starts each voice row with FRIDAY and carries no upstream name (credit parentheses excepted)", () => {
    expect(VOICE_IDS.catalog.length).toBe(26);
    for (const id of VOICE_IDS.catalog) {
      const row = modelById.get(id);
      expect(row, id).toBeTruthy();
      expect(row!.name, id).toMatch(
        /^FRIDAY (Ear|Voice|Denoise|Speaker|Listen Gate|Turn|Punctuate)/,
      );
      expect(withoutCredit(row!.name), id).not.toMatch(UPSTREAM);
    }
  });

  it("uses the agreed names for the main models, and keeps every id as it was", () => {
    for (const [id, name] of Object.entries(EXPECTED_NAME)) {
      expect(modelById.get(id)!.name, id).toMatch(name);
    }
    expect(modelById.get("faster-whisper")!.name).toBe("FRIDAY Ear large-v3");
  });

  it("names the pack members and descriptions with FRIDAY names, upstream only in credit lines", () => {
    for (const pack of voicePacks) {
      expect(pack.description, pack.id).not.toMatch(UPSTREAM);
      for (const member of pack.members) {
        expect(member.role, `${pack.id} ${member.id}`).not.toMatch(UPSTREAM);
      }
      for (const line of pack.credits) {
        const name = /^(FRIDAY [A-Za-z ]+?) is based on /.exec(line);
        expect(name !== null, `${pack.id}: ${line}`).toBe(true);
      }
    }
  });

  it("keeps the credit duty: the CC-BY rows still name their author in the row", () => {
    expect(modelById.get("hindi-light-tts")!.name).toMatch(/Sulabh Katiyar/);
    expect(modelById.get("hindi-fallback-ear")!.name).toMatch(/Collabora/);
    expect(modelById.get("speaker-wespeaker")!.name).toMatch(/CC-BY-4\.0/);
  });
});

describe("the voice registry table, the installer and the Doctor use the same names", () => {
  const TABLE_IDS = [
    "faster-whisper-tiny",
    "faster-whisper-base",
    "faster-whisper-small",
    "faster-whisper-medium",
    "faster-whisper",
    "faster-whisper-large-v3-turbo",
    "hindi-ear",
    "hinglish-ear",
    "hindi-fallback-ear",
    "stream-ear-nemotron",
    "hindi-vaani-ear",
    "hinglish-ear-trelis",
    "hindi-punct",
    "silero-vad",
    "smart-turn",
    "speaker-wespeaker",
    "wespeaker-ecapa",
    "denoise-dpdfnet",
    "denoise-gtcrn",
    "hindi-light-tts",
    "supertonic-3",
  ];

  it("labels each registry row FRIDAY", () => {
    for (const id of TABLE_IDS) {
      const row = VOICE_ENGINE_TABLE.find((r) => r.id === id);
      expect(row, id).toBeTruthy();
      expect(row!.label, id).toMatch(/^FRIDAY /);
      expect(withoutCredit(row!.label), id).not.toMatch(UPSTREAM);
    }
  });

  it("labels each installer and Doctor row FRIDAY", () => {
    const labels = [...weights.EAR_MODELS, ...weights.EXTRA_MODELS].map((r) => r.label);
    const registry = weights.modelRegistry().map((r) => r.label);
    for (const label of [...labels, ...registry]) {
      if (label.startsWith("wake") || label === "Wake word embedding") continue;
      expect(label, label).toMatch(/^FRIDAY /);
      expect(label, label).not.toMatch(UPSTREAM);
    }
  });

  it("says FRIDAY Turn in the Turn Doctor row text", () => {
    const text = fs.readFileSync(path.join(root, "electron/voice-weights.cjs"), "utf8");
    expect(text).toContain('"FRIDAY Turn loads and runs"');
    expect(text).not.toContain('"Smart Turn loads and runs"');
  });
});

describe("the voice settings page", () => {
  const source = fs.readFileSync(
    path.join(root, "src/components/friday/settings/VoiceSettings.tsx"),
    "utf8",
  );

  it("shows FRIDAY Ear Live and FRIDAY Voice, never an upstream name, in the text the owner reads", () => {
    expect(source).toContain("FRIDAY Ear Live, int8 (the pinned download)");
    // Strip stored words (value="nemotron"), property reads and comments; what is left is what is displayed.
    const shown = source
      .replace(/value="[^"]*"/g, "")
      .replace(/prefs\.voice\.whisperMode/g, "")
      .replace(/whisperMode/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(shown).not.toMatch(
      /nemotron|supertonic|silero|indicconformer|faster-whisper|openwakeword/i,
    );
  });
});
