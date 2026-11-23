/**
 * Every voice weight FRIDAY downloads is pinned by revision and SHA-256. The downloader fetches the
 * pinned revision, refuses a file that differs, and a repair removes only a bad file. Offline: the
 * network, the clock and the disk reads are faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

type Pin = { revision: string; files: Record<string, { sha256: string; bytes: number }> };
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  PINS: Record<string, Pin>;
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
  selectPinned: (
    listing: { files: string[]; meta?: Record<string, { sha256?: string }> },
    pin: Pin,
  ) => { ok: boolean; error?: string; files?: string[]; meta?: Record<string, { sha256: string }> };
  auditDir: (
    dir: string,
    pin: Pin,
    options?: Record<string, unknown>,
  ) => Promise<{
    ok: boolean;
    missing: string[];
    wrongSize: string[];
    wrongDigest: string[];
    checked: number;
  }>;
  removeBad: (
    dir: string,
    audit: { wrongSize: string[]; wrongDigest: string[] },
    remove?: (file: string) => void,
  ) => string[];
};
const weights = req("../../electron/voice-weights.cjs") as {
  STT_REPOS: Record<string, string>;
  STT_FALLBACK_REPOS: Record<string, string[]>;
  sttPlan: (size: string, root: string) => { pin: Pin | null; sha256: string | null };
  ensureSttWeights: (
    model: string,
    root: string,
    deps: Record<string, unknown>,
  ) => Promise<{ ok: boolean; cause?: string; error?: string; repaired?: string[] }>;
  pinChecks: (
    root: string,
    deps: Record<string, unknown>,
  ) => Promise<Array<{ id: string; ok: boolean; detail: string }>>;
  otherVoiceJobs: () => Array<{ id: string; pinned?: boolean; url: string | null }>;
  voiceModelsOnDisk: (
    root: string,
    exists: (file: string) => boolean,
  ) => Array<{ catalogId: string; kind: string }>;
  HINDI_EAR_REPO: string;
};
const download = req("../../electron/model-download.cjs") as {
  downloadModel: (
    job: Record<string, unknown>,
    onEvent: (event: unknown) => void,
    signal: AbortSignal | undefined,
    deps: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string; attempts?: Array<{ error?: string }> }>;
};

const HEX64 = /^[0-9a-f]{64}$/;
const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pins-"));
  folders.push(dir);
  return dir;
}

describe("the pin table", () => {
  it("pins every speech size and its renamed fallback, and the neural voice", () => {
    for (const repo of Object.values(weights.STT_REPOS)) {
      expect(pins.pinForRepo(repo), repo).not.toBeNull();
    }
    for (const list of Object.values(weights.STT_FALLBACK_REPOS)) {
      for (const repo of list) expect(pins.pinForRepo(repo), repo).not.toBeNull();
    }
    expect(pins.pinForRepo("mobiuslabsgmbh/faster-whisper-large-v3-turbo")).toBe(
      pins.pinForRepo("dropbox-dash/faster-whisper-large-v3-turbo"),
    );
    expect(pins.pinForRepo("Supertone/supertonic-3")?.files["onnx/vocoder.onnx"]).toBeTruthy();
    expect(pins.pinForRepo("someone/else")).toBeNull();
  });

  it("holds a real digest, size and revision for every file", () => {
    for (const [repo, pin] of Object.entries(pins.PINS)) {
      expect(pin.revision, repo).toMatch(/^[0-9a-f]{40}$/);
      for (const [name, row] of Object.entries(pin.files)) {
        expect(row.sha256, `${repo}/${name}`).toMatch(HEX64);
        expect(row.bytes, `${repo}/${name}`).toBeGreaterThan(0);
      }
    }
  });

  it("covers the files a speech size needs to open", () => {
    for (const repo of Object.values(weights.STT_REPOS)) {
      const names = Object.keys(pins.pinForRepo(repo)!.files);
      expect(names, repo).toEqual(
        expect.arrayContaining(["config.json", "model.bin", "tokenizer.json"]),
      );
      expect(
        names.some((name) => /^vocabulary\.(txt|json)$/.test(name)),
        repo,
      ).toBe(true);
    }
  });

  it("sizes the speech weights as Hugging Face lists them (tiny to large-v3)", () => {
    const total = (repo: string) => pins.pinnedBytes(pins.pinForRepo(repo)!);
    expect(total("Systran/faster-whisper-tiny")).toBeLessThan(80_000_000);
    expect(total("Systran/faster-whisper-large-v3")).toBeGreaterThan(3_000_000_000);
    expect(total("Supertone/supertonic-3")).toBeGreaterThan(400_000_000);
  });

  it("plans a speech size with its pin, and the neural voice is pinned not skipped", () => {
    const plan = weights.sttPlan("small", "/friday");
    expect(plan.pin).toBe(pins.pinForRepo("Systran/faster-whisper-small"));
    const tts = weights.otherVoiceJobs().find((row) => row.id === "supertonic-3");
    expect(tts?.pinned).toBe(true);
    expect(tts?.url).toBeNull();
  });
});

describe("selecting and auditing against a pin", () => {
  const body = "hello";
  const pin: Pin = {
    revision: "a".repeat(40),
    files: {
      "config.json": { sha256: sha("{}"), bytes: 2 },
      "model.bin": { sha256: sha(body), bytes: body.length },
    },
  };

  it("takes only the pinned files and enforces the pinned digest", () => {
    const chosen = pins.selectPinned(
      { files: ["README.md", "config.json", "model.bin", "extra.json"], meta: {} },
      pin,
    );
    expect(chosen.ok).toBe(true);
    expect(chosen.files).toEqual(["config.json", "model.bin"]);
    expect(chosen.meta?.["model.bin"]?.sha256).toBe(sha(body));
  });

  it("refuses a listing that lacks a pinned file or names another digest", () => {
    expect(pins.selectPinned({ files: ["config.json"] }, pin).error).toMatch(/model\.bin/);
    const other = pins.selectPinned(
      { files: ["config.json", "model.bin"], meta: { "model.bin": { sha256: sha("other") } } },
      pin,
    );
    expect(other.ok).toBe(false);
    expect(other.error).toMatch(/differs from the pinned/);
  });

  it("reports a missing, short and tampered file separately and removes only the bad ones", async () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, "model.bin"), "hellx"); // right size, wrong bytes
    const hashed = await pins.auditDir(dir, pin, { hash: true });
    expect(hashed.missing).toEqual(["config.json"]);
    expect(hashed.wrongDigest).toEqual(["model.bin"]);
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    fs.writeFileSync(path.join(dir, "model.bin"), "hel"); // short
    const sized = await pins.auditDir(dir, pin);
    expect(sized.ok).toBe(false);
    expect(sized.wrongSize).toEqual(["model.bin"]);
    const removed = pins.removeBad(dir, sized);
    expect(removed).toEqual(["model.bin"]);
    expect(fs.existsSync(path.join(dir, "model.bin"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(true);
    fs.writeFileSync(path.join(dir, "model.bin"), body);
    expect((await pins.auditDir(dir, pin, { hash: true })).ok).toBe(true);
  });

  it("does not hash unless asked (a size check is cheap)", async () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, "config.json"), "{}");
    fs.writeFileSync(path.join(dir, "model.bin"), "hellx");
    const hashFile = vi.fn(async () => "");
    expect((await pins.auditDir(dir, pin, { hashFile })).ok).toBe(true);
    expect(hashFile).not.toHaveBeenCalled();
  });
});

describe("a speech size is verified and repaired before the worker opens it", () => {
  /** A folder that holds the real pinned file names at the wrong size. */
  function stage(size: string, root: string) {
    const dir = path.join(root, "cache", "stt", size);
    fs.mkdirSync(dir, { recursive: true });
    const pin = pins.pinForRepo(weights.STT_REPOS[size]!)!;
    for (const name of Object.keys(pin.files)) fs.writeFileSync(path.join(dir, name), "x");
    return { dir, pin };
  }

  it("leaves the old behaviour when no verification is asked for", async () => {
    const root = temp();
    stage("tiny", root);
    const downloadModel = vi.fn(async () => ({ ok: true }));
    const result = await weights.ensureSttWeights("tiny", root, {
      exists: (file: string) => fs.existsSync(file),
      downloadModel,
    });
    expect(result.ok).toBe(true);
    expect(downloadModel).not.toHaveBeenCalled();
  });

  it("removes a damaged file and fetches the size again", async () => {
    const root = temp();
    const { dir, pin } = stage("tiny", root);
    const downloadModel = vi.fn(async () => {
      // The downloader writes the real bytes: here, files of the pinned size.
      for (const [name, row] of Object.entries(pin.files)) {
        fs.writeFileSync(path.join(dir, name), Buffer.alloc(row.bytes));
      }
      return { ok: true };
    });
    const result = await weights.ensureSttWeights("tiny", root, {
      exists: (file: string) => fs.existsSync(file),
      downloadModel,
      verify: "size",
    });
    expect(downloadModel).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.repaired?.length).toBeGreaterThan(0);
  });

  it("fails honestly when the repair cannot download, and when the download is still wrong", async () => {
    const root = temp();
    stage("tiny", root);
    const noDownloader = await weights.ensureSttWeights("tiny", root, {
      exists: (file: string) => fs.existsSync(file),
      verify: "size",
    });
    expect(noDownloader.ok).toBe(false);
    expect(noDownloader.cause).toBe("checksum");
    const root2 = temp();
    stage("tiny", root2);
    const wrong = await weights.ensureSttWeights("tiny", root2, {
      exists: (file: string) => fs.existsSync(file),
      downloadModel: async () => {
        stage("tiny", root2); // the download left files of the wrong size again
        return { ok: true };
      },
      verify: "size",
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.cause).toBe("checksum");
  });

  it("keeps weights that open when only a pinned file is missing and the network is gone", async () => {
    const root = temp();
    const { dir } = stage("tiny", root);
    fs.rmSync(path.join(dir, "vocabulary.txt"));
    const result = await weights.ensureSttWeights("tiny", root, {
      exists: (file: string) => fs.existsSync(file),
      downloadModel: async () => ({ ok: false, cause: "network", error: "offline" }),
      verify: "size",
    });
    // Every other file is the wrong size here, so those are repaired and the download is needed.
    expect(result.ok).toBe(false);
    const root2 = temp();
    const staged = stage("tiny", root2);
    const pin = pins.pinForRepo(weights.STT_REPOS["tiny"]!)!;
    for (const [name, row] of Object.entries(pin.files)) {
      fs.writeFileSync(path.join(staged.dir, name), Buffer.alloc(row.bytes));
    }
    fs.rmSync(path.join(staged.dir, "vocabulary.txt"));
    const offline = await weights.ensureSttWeights("tiny", root2, {
      exists: (file: string) => fs.existsSync(file),
      downloadModel: async () => ({ ok: false, cause: "network", error: "offline" }),
      verify: "size",
    });
    expect(offline.ok).toBe(true);
    expect((offline as { unverified?: boolean }).unverified).toBe(true);
  });

  it("gives the voice check one row per installed model", async () => {
    const root = temp();
    stage("tiny", root);
    const rows = await weights.pinChecks(root, { exists: (file: string) => fs.existsSync(file) });
    expect(rows.map((row) => row.id)).toEqual(["stt-pin-tiny"]);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.detail).toMatch(/wrong size/);
  });
});

describe("the downloader enforces the pin", () => {
  const files = { "config.json": "{}", "model.bin": "weights-v1" };
  const repo = "test/pinned-voice";
  const pin: Pin = {
    revision: "b".repeat(40),
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        { sha256: sha(text), bytes: text.length },
      ]),
    ),
  };

  function serve(content: Record<string, string>) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: { method?: string } = {}) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/api/models/")) {
          return new Response(
            JSON.stringify({
              siblings: Object.keys(files).map((name) => ({ rfilename: name })),
            }),
            { status: 200 },
          );
        }
        const name = decodeURIComponent(
          url.split("/resolve/")[1]!.split("/").slice(1).join("/").split("?")[0]!,
        );
        const text = content[name] ?? "";
        if (init.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(text.length) },
          });
        }
        return new Response(text, {
          status: 200,
          headers: { "content-length": String(text.length) },
        });
      }),
    );
    return urls;
  }
  const deps = {
    pinForRepo: (name: string) => (name === repo ? pin : null),
    hub: { engineMode: () => "own", isBroken: () => false },
  };
  const job = (dir: string) => ({
    modelId: "pinned-voice",
    dir,
    sources: [{ kind: "hf-repo", repo, label: "test" }],
  });

  it("asks for the pinned revision, not main, and keeps files that match", async () => {
    const urls = serve(files);
    const dir = temp();
    const result = await download.downloadModel(job(dir), () => {}, undefined, deps);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(urls.some((url) => url.includes(`/revision/${pin.revision}`))).toBe(true);
    expect(
      urls.filter((url) => url.includes("/resolve/")).every((url) => url.includes(pin.revision)),
    ).toBe(true);
    expect(fs.readFileSync(path.join(dir, "pinned-voice", "model.bin"), "utf8")).toBe("weights-v1");
  });

  it("refuses and removes a file whose bytes do not match the pin", async () => {
    serve({ ...files, "model.bin": "weights-v2" });
    const dir = temp();
    const result = await download.downloadModel(job(dir), () => {}, undefined, deps);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "pinned-voice", "model.bin"))).toBe(false);
  });

  it("repairs a short file already on disk and leaves a good one alone", async () => {
    serve(files);
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "config.json"), "{}");
    fs.writeFileSync(path.join(target, "model.bin"), "weigh");
    const events: string[] = [];
    const result = await download.downloadModel(
      job(dir),
      (event) => events.push(JSON.stringify(event)),
      undefined,
      deps,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(events.join("\n")).toMatch(/repairing 1 damaged file/);
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v1");
  });
});

describe("FRIDAY's Hindi ear is pinned, found on disk and checked", () => {
  const pin = () => pins.pinForRepo(weights.HINDI_EAR_REPO)!;

  it("pins exactly the int8 model, its vocabulary and its config", () => {
    expect(Object.keys(pin().files).sort()).toEqual([
      "config.json",
      "model.int8.onnx",
      "vocab.txt",
    ]);
    expect(pin().files["model.int8.onnx"]!.bytes).toBe(137677313);
  });

  it("is listed as installed only when every pinned file is on disk", () => {
    const names = Object.keys(pin().files);
    const have = (missing: string) => (file: string) =>
      names.some((name) => name !== missing && file.endsWith(`hindi-ear${path.sep}${name}`));
    const ids = (missing: string) =>
      weights.voiceModelsOnDisk("/friday", have(missing)).map((row) => row.catalogId);
    expect(ids("")).toContain("hindi-ear");
    expect(ids("vocab.txt")).not.toContain("hindi-ear");
  });

  it("gives the voice check a row for it, red for a short file", async () => {
    const root = temp();
    const dir = path.join(root, "models", "hindi-ear");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(pin().files)) fs.writeFileSync(path.join(dir, name), "x");
    const rows = await weights.pinChecks(root, { exists: (file: string) => fs.existsSync(file) });
    const row = rows.find((entry) => entry.id === "hindi-ear-pin");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/wrong size/);
  });
});
