/**
 * FRIDAY Ear Hinglish Pro installs from the FRIDAY release only: the pin is a 1.6 GB source checkpoint FRIDAY never
 * downloads, so the downloader fetches the converted files of the release (every file held to its SHA-256 and size),
 * certifies the folder with the marker the kernel reads, and says "needs the FRIDAY release (not published yet)" with
 * no install button while the release holds no file. A fake fetch stands in for GitHub and Hugging Face (no network).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs");
const weights = require_("../../electron/voice-weights.cjs");
const pins = require_("../../electron/voice-pins.cjs");
const catalog = require_("../../electron/installer-catalog.cjs");
const verify = require_("../../electron/voice-verify.cjs");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const SOURCE = "Oriserve/Whisper-Hindi2Hinglish-Apex";
const ID = "hinglish-ear-pro";
const TAG = "friday-voice-weights-2026.1.1";
const BASE = `https://github.com/o/r/releases/download/${TAG}/`;

/** The source pin: the BF16 checkpoint (never fetched) and the small files the converted copy keeps as they are. */
const SOURCE_FILES: Record<string, string> = {
  "model.safetensors": "BF16-SOURCE-CHECKPOINT",
  "config.json": '{"a":1}',
  "tokenizer.json": '{"tok":1}',
  "vocabulary.json": '{"voc":1}',
  "preprocessor_config.json": '{"pre":1}',
};
const SOURCE_PIN = {
  revision: "d".repeat(40),
  license: "Apache-2.0",
  files: Object.fromEntries(
    Object.entries(SOURCE_FILES).map(([name, text]) => [
      name,
      { sha256: sha(text), bytes: text.length },
    ]),
  ),
};
/** What the folder holds: FRIDAY's converted `model.bin` and the copied small files. */
const EAR_FILES: Record<string, string> = {
  "model.bin": "CT2-INT8-WEIGHTS",
  "config.json": SOURCE_FILES["config.json"]!,
  "tokenizer.json": SOURCE_FILES["tokenizer.json"]!,
  "vocabulary.json": SOURCE_FILES["vocabulary.json"]!,
  "preprocessor_config.json": SOURCE_FILES["preprocessor_config.json"]!,
};
const releaseName = (name: string) => `friday-ear-hinglish-pro--${name}`;

function assets(partBytes: number) {
  return Object.entries(EAR_FILES).map(([name, text]) => {
    const converted = name === "model.bin";
    return {
      fridayId: "friday-ear-hinglish-pro",
      path: name,
      file: releaseName(name),
      sha256: sha(text),
      bytes: text.length,
      parts: Math.max(1, Math.ceil(text.length / partBytes)),
      from: converted
        ? {
            pin: SOURCE,
            file: "model.safetensors",
            recipe: "ct2-int8",
            derivedSha256: sha(text),
          }
        : { pin: SOURCE, file: name, recipe: "copy" },
    };
  });
}
const manifest = (partBytes = 1_900_000_000, list = assets(partBytes)) => ({
  pack: "friday-models",
  tag: TAG,
  repository: "o/r",
  partBytes,
  assets: list,
});
const deps = (extra: Record<string, unknown> = {}) => ({
  pinForRepo: (name: string) => (name === SOURCE ? SOURCE_PIN : null),
  hub: { engineMode: () => "own", isBroken: () => false },
  env: {},
  ...extra,
});

/** What the fake release holds, by file name (parts included); `null` is a release that is not published. */
type Release = Record<string, string> | null;
function network(release: Release) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: { method?: string } = {}) => {
      const url = String(input);
      urls.push(url);
      if (!url.startsWith(BASE) || !release) return new Response(null, { status: 404 });
      const text = release[decodeURIComponent(url.slice(BASE.length))];
      if (text === undefined) return new Response(null, { status: 404 });
      return new Response(init.method === "HEAD" ? null : text, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(text)) },
      });
    }),
  );
  return {
    urls,
    release: () => urls.filter((url) => url.startsWith(BASE)),
    elsewhere: () => urls.filter((url) => !url.startsWith(BASE)),
  };
}
const wholeRelease = (): Record<string, string> =>
  Object.fromEntries(Object.entries(EAR_FILES).map(([name, text]) => [releaseName(name), text]));

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-derived-ear-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The page sends the Hugging Face source of the source checkpoint, as it would for any other pinned repository. */
const job = (extra: Record<string, unknown> = {}) => ({
  modelId: ID,
  dir,
  sources: [{ kind: "hf-repo", repo: SOURCE, label: `Hugging Face · ${SOURCE}` }],
  ...extra,
});
const folder = () => path.join(dir, ID);
const read = (name: string) => fs.readFileSync(path.join(folder(), name), "utf8");

describe("the release holds the converted files", () => {
  it("installs every file, certifies the folder and writes the marker the kernel reads", async () => {
    const net = network(wholeRelease());
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("friday-release");
    expect(result.servedFrom).toBe("FRIDAY release");
    for (const [name, text] of Object.entries(EAR_FILES)) expect(read(name)).toBe(text);
    // The source checkpoint was never asked for: not by a file, not by a repository listing, not from any other host.
    expect(net.elsewhere()).toEqual([]);
    expect(net.urls.some((url) => /safetensors|huggingface/i.test(url))).toBe(false);
    expect(fs.existsSync(path.join(folder(), "model.safetensors"))).toBe(false);
    // The marker names the SOURCE repository (what the kernel looks for) and holds the derived hashes.
    const marker = pins.readMarker(folder());
    expect(marker?.repo.toLowerCase()).toBe(SOURCE.toLowerCase());
    expect(marker?.revision).toBe(SOURCE_PIN.revision);
    expect(marker?.files["model.bin"]).toEqual({
      sha256: sha(EAR_FILES["model.bin"]!),
      bytes: EAR_FILES["model.bin"]!.length,
    });
    expect(Object.keys(marker!.files).sort()).toEqual(Object.keys(EAR_FILES).sort());
    const audit = await pins.auditDir(
      folder(),
      weights.derivedEarPin(ID, deps({ fridayModels: manifest() })),
      {
        hash: true,
      },
    );
    expect(audit.ok).toBe(true);
    expect(
      pins.unexpectedFiles(folder(), weights.derivedEarPin(ID, deps({ fridayModels: manifest() }))),
    ).toEqual([]);
  });

  it("joins a split file from its parts and holds the whole file to the manifest hash", async () => {
    const parts = {
      [`${releaseName("model.bin")}.part001`]: "CT2-INT8-",
      [`${releaseName("model.bin")}.part002`]: "WEIGHTS",
    };
    const release = { ...wholeRelease(), ...parts };
    delete release[releaseName("model.bin")];
    const net = network(release);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest(9) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(read("model.bin")).toBe(EAR_FILES["model.bin"]);
    expect(net.release().some((url) => url.endsWith("model.bin.part002"))).toBe(true);
    expect(net.elsewhere()).toEqual([]);
    expect(fs.existsSync(path.join(folder(), ".cache", "friday-release"))).toBe(false);
    expect(pins.readMarker(folder())?.files["model.bin"]?.bytes).toBe(16);
  });

  it("refuses a file whose hash is wrong, keeps nothing of it and never reaches for the source", async () => {
    const net = network({ ...wholeRelease(), [releaseName("model.bin")]: "CT2-INT8-WEIGHTX" });
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].cause).toBe("checksum");
    expect(fs.existsSync(path.join(folder(), "model.bin"))).toBe(false);
    expect(pins.readMarker(folder())).toBeNull();
    expect(net.elsewhere()).toEqual([]);
  });

  it("refuses a joined file whose parts have the right sizes and the wrong bytes", async () => {
    const release = {
      ...wholeRelease(),
      [`${releaseName("model.bin")}.part001`]: "CT2-INT8-",
      [`${releaseName("model.bin")}.part002`]: "WEIGHTX",
    };
    delete (release as Record<string, string | undefined>)[releaseName("model.bin")];
    network(release);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest(9) }),
    );
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(folder(), "model.bin"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(folder(), ".cache", "friday-release", `${releaseName("model.bin")}.part001`),
      ),
    ).toBe(false);
  });

  it("never uses a source or a plan the caller sent: the pinned manifest decides every URL", async () => {
    const net = network(wholeRelease());
    const evil = {
      kind: "friday-release",
      repo: SOURCE,
      derived: true,
      catalogId: ID,
      label: "FRIDAY release",
      plan: {
        files: [
          {
            name: "model.bin",
            file: "x",
            sha256: sha("evil"),
            bytes: 4,
            parts: [{ file: "x", url: "https://evil.example/model.bin", bytes: 4 }],
          },
        ],
      },
    };
    const result = await download.downloadModel(
      job({ sources: [evil, { kind: "url", url: "https://evil.example/a.bin" }] }),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(net.elsewhere()).toEqual([]);
    expect(read("model.bin")).toBe(EAR_FILES["model.bin"]);
  });

  it("never writes through a link left where a file goes", async () => {
    network(wholeRelease());
    const victim = path.join(dir, "victim.txt");
    fs.writeFileSync(victim, "keep me");
    fs.mkdirSync(folder(), { recursive: true });
    try {
      fs.symlinkSync(victim, path.join(folder(), "model.bin"));
    } catch {
      return; // a PC that may not create links has nothing to follow
    }
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(fs.readFileSync(victim, "utf8")).toBe("keep me");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.lstatSync(path.join(folder(), "model.bin")).isSymbolicLink()).toBe(false);
  });

  it("is a no-op fetch for a folder that is already whole, and still certifies it", async () => {
    network(wholeRelease());
    await download.downloadModel(job(), undefined, undefined, deps({ fridayModels: manifest() }));
    fs.rmSync(path.join(folder(), ".friday-pin.json"));
    const again = network(wholeRelease());
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(again.urls).toEqual([]);
    expect(pins.readMarker(folder())?.repo.toLowerCase()).toBe(SOURCE.toLowerCase());
  });
});

describe("the release holds nothing yet", () => {
  it("says it needs the FRIDAY release after one look, and fetches nothing from the source", async () => {
    const net = network(null);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest() }),
    );
    expect(result.ok).toBe(false);
    expect(result.needsRelease).toBe(true);
    expect(result.error).toBe("needs the FRIDAY release (not published yet)");
    expect(result.attempts).toHaveLength(1);
    expect(net.release()).toHaveLength(1);
    expect(net.elsewhere()).toEqual([]);
    expect(fs.existsSync(path.join(folder(), "model.bin"))).toBe(false);
  });

  it("says the same, with no request at all, when the manifest holds no converted file", async () => {
    const net = network(wholeRelease());
    for (const pack of [null, manifest(1_900_000_000, [])]) {
      const result = await download.downloadModel(
        job(),
        undefined,
        undefined,
        deps({ fridayModels: pack }),
      );
      expect(result).toMatchObject({
        ok: false,
        needsRelease: true,
        error: "needs the FRIDAY release (not published yet)",
      });
    }
    const off = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ fridayModels: manifest(), env: { FRIDAY_MODELS_RELEASE: "0" } }),
    );
    expect(off.needsRelease).toBe(true);
    expect(net.urls).toEqual([]);
  });
});

describe("the Install Manager, the Doctor and the Models page", () => {
  const releaseDeps = (pack: unknown) => deps({ fridayModels: pack });
  const rowOf = (root: string, pack: unknown) =>
    catalog
      .voiceRows(root, { releaseDeps: releaseDeps(pack) })
      .find((row: { id: string }) => row.id === `voice:${ID}`);

  it("shows a row with no Download button and the release text while the release holds nothing", () => {
    const row = rowOf(dir, null);
    expect(row.installed).toBeNull();
    expect(row.needsRelease).toBe(true);
    expect(row.note).toBe("needs the FRIDAY release (not published yet)");
    expect(row.chain).toBeNull();
  });

  it("offers the install once the release holds the files, with no source repository to ask for a newer revision", () => {
    const row = rowOf(dir, manifest());
    expect(row.installed).toBe(false);
    expect(row.needsRelease).toBeUndefined();
    expect(row.chain.sources.map((source: { kind: string }) => source.kind)).toEqual(["pinned"]);
    expect(row.chain.pinnedVersion).toBe(SOURCE_PIN.revision);
  });

  it("reads installed from the release files on disk and the marker's revision", async () => {
    network(wholeRelease());
    await download.downloadModel(job(), undefined, undefined, deps({ fridayModels: manifest() }));
    // The folder of the catalog row is <root>/models/<id>; this test installed straight into <dir>/<id>.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-derived-root-"));
    try {
      fs.mkdirSync(path.join(root, "models"));
      fs.cpSync(folder(), path.join(root, "models", ID), { recursive: true });
      const row = rowOf(root, manifest());
      expect(row.installed).toBe(true);
      expect(row.installedVersion).toBe(SOURCE_PIN.revision);
      expect(row.servedFrom).toBe("FRIDAY release");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives the Doctor row the release text and no install id while the release has nothing, the id when it has", () => {
    const missing = { hinglishPro: { status: "missing", label: "FRIDAY Ear Hinglish Pro", ms: 0 } };
    const none = verify.hinglishProRow(missing, { root: dir, releaseDeps: releaseDeps(null) });
    expect(none).toMatchObject({
      id: "friday-ear-hinglish-pro",
      ok: false,
      required: false,
      installId: "",
      detail: "needs the FRIDAY release (not published yet)",
    });
    const ready = verify.hinglishProRow(missing, {
      root: dir,
      releaseDeps: releaseDeps(manifest()),
    });
    expect(ready.installId).toBe(ID);
    expect(ready.detail).toContain("FRIDAY release");
    const ok = verify.hinglishProRow(
      { hinglishPro: { status: "ok", ms: 7 } },
      { root: dir, releaseDeps: releaseDeps(null) },
    );
    expect(ok).toMatchObject({ ok: true, detail: "heard the probe clip in 7ms" });
    expect(verify.hinglishProRow({}, {}).detail).toContain("did not list");
  });

  it("adds the row to ownEarsRows only when asked, so the three own ears keep their rows", async () => {
    const answer = async () => ({
      ok: true,
      stdout: `${JSON.stringify({ ok: true, ears: [], hinglishPro: { status: "failed", reason: "bad graph" } })}\n`,
      stderr: "",
    });
    const three = await verify.ownEarsRows("py", [], answer);
    expect(three).toHaveLength(3);
    const four = await verify.ownEarsRows("py", [], answer, { hinglishPro: true, root: dir });
    expect(four).toHaveLength(4);
    expect(four[3]).toMatchObject({ id: "friday-ear-hinglish-pro", ok: false });
    expect(four[3].detail).toContain("bad graph");
    const down = await verify.ownEarsRows("py", [], async () => ({ timedOut: true }), {
      hinglishPro: true,
    });
    expect(down).toHaveLength(4);
  });

  it("has a Models-page row that links the release, never a Hugging Face repository", () => {
    const text = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../src/lib/friday/model-catalog.ts"),
      "utf8",
    );
    const at = text.indexOf('"hinglish-ear-pro",\n    "FRIDAY Ear Hinglish Pro"');
    expect(at).toBeGreaterThan(0);
    const row = text.slice(at, text.indexOf("),", at));
    expect(row).toContain("github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/tag/");
    expect(row).not.toMatch(/huggingface|HF\(/);
  });
});
