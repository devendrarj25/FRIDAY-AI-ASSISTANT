/**
 * The FRIDAY Models pack (scripts/build-friday-models.cjs, config/friday-models.json) is an owner-run job. These checks
 * pin the manifest against the voice pins, the split math, the refusal of a refused licence, the notice lines, the
 * build with an injected downloader (no network), and that the locked Windows CMD chain never reaches it.
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

type Asset = {
  fridayId: string;
  fridayName: string;
  path: string;
  file: string;
  sha256: string;
  bytes: number;
  parts: number;
  from: {
    pin: string;
    file: string;
    recipe: string;
    recipeVersion: number;
    derivedSha256?: string;
  };
};
type Manifest = {
  pack: string;
  revision: string;
  repository: string;
  tag: string;
  title: string;
  partBytes: number;
  assets: Asset[];
};
type Pins = Record<
  string,
  {
    revision: string;
    files: Record<string, { sha256: string; bytes: number }>;
    licenseRecord?: Record<string, unknown>;
  }
>;
type Download = (
  url: string,
  dest: string,
  options: { sha256: string; needBytes: number; label: string },
) => Promise<number>;
type BuildResult = {
  built: { fridayId: string }[];
  skipped: { fridayId: string; reason: string }[];
  files: string[];
  rows: { file: string; bytes: number; sha256: string }[];
  manifest: Manifest & { skipped?: unknown[] };
  command: string;
};
const pack = require_("../../scripts/build-friday-models.cjs") as {
  DEFAULT_PART_BYTES: number;
  ASSET_LIMIT: number;
  readManifest: () => Manifest;
  partCount: (bytes: number, partBytes?: number) => number;
  partName: (file: string, index: number, count: number) => string;
  splitPlan: (
    file: string,
    bytes: number,
    partBytes?: number,
  ) => { file: string; offset: number; length: number }[];
  splitFile: (
    source: string,
    outDir: string,
    file: string,
    partBytes?: number,
  ) => Promise<{ file: string; bytes: number; sha256: string }[]>;
  modelsOf: (
    manifest: Manifest,
  ) => { fridayId: string; fridayName: string; pin: string; assets: Asset[] }[];
  manifestProblems: (manifest: unknown, pins: Pins) => string[];
  refusedModels: (
    manifest: unknown,
    pins: Pins,
    gate: (pin: unknown) => boolean,
  ) => { fridayName: string }[];
  noticeLine: (model: { fridayName: string; pin: string }, pin: unknown) => string;
  buildNotice: (manifest: Manifest, built: unknown[], pins: Pins) => string;
  sha256sumsText: (rows: { file: string; sha256: string }[]) => string;
  uploadCommand: (manifest: Manifest, files: string[]) => string;
  hfUrl: (repo: string, revision: string, file: string) => string;
  buildPack: (options: Record<string, unknown>) => Promise<BuildResult>;
  manifestFileName: (manifest: { pack: string }) => string;
  parseArgs: (argv: string[]) => {
    pack: string;
    out: string;
    maxGb: number;
    only: string[] | null;
    dryRun: boolean;
  };
};
const voicePins = require_("../../electron/voice-pins.cjs") as {
  PINS: Pins;
  bundleAllowed: (pin: unknown) => boolean;
};
const releaseEngine = require_("../../scripts/release-engine.cjs") as {
  compareBuilds: (a: string, b: string) => number;
};

const manifest = pack.readManifest();
const sha = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("the manifest matches the voice pins", () => {
  it("is sound against the pin table", () => {
    expect(pack.manifestProblems(manifest, voicePins.PINS)).toEqual([]);
  });

  it("names the pack, the revision and the tag the owner publishes", () => {
    expect(manifest.pack).toBe("friday-models");
    expect(manifest.tag).toBe(`friday-models-${manifest.revision}`);
    expect(manifest.repository).toBe("devendrarj25/FRIDAY-AI-ASSISTANT");
    expect(manifest.title).toBe(`FRIDAY Models ${manifest.revision}`);
    expect(manifest.partBytes).toBeLessThan(pack.ASSET_LIMIT);
  });

  it("covers every file of every pinned voice model, once", () => {
    const listed = new Set(manifest.assets.map((a) => `${a.from.pin}|${a.from.file}`));
    expect(listed.size).toBe(manifest.assets.length);
    for (const [key, pin] of Object.entries(voicePins.PINS))
      for (const file of Object.keys(pin.files)) expect(listed.has(`${key}|${file}`)).toBe(true);
  });

  it("gives every asset a FRIDAY name and file name, and keeps the product version out", () => {
    for (const a of manifest.assets) {
      expect(a.fridayName.startsWith("FRIDAY ")).toBe(true);
      expect(a.file.startsWith(`${a.fridayId}--`)).toBe(true);
    }
    expect(JSON.stringify(manifest)).not.toMatch(/friday-version|1\.2\.5/);
  });

  it("every pin passes the bundle gate", () => {
    expect(pack.refusedModels(manifest, voicePins.PINS, voicePins.bundleAllowed)).toEqual([]);
  });

  it("its release tag never outranks a product release in the update check", () => {
    for (const product of ["v1.0.0.0", "v1.2.5.7", "1.2.5.8"])
      expect(releaseEngine.compareBuilds(manifest.tag, product)).toBeLessThan(0);
  });
});

describe("the manifest checks catch a wrong plan", () => {
  const problems = (change: (m: Manifest) => void) => {
    const copy = clone(manifest);
    change(copy);
    return pack.manifestProblems(copy, voicePins.PINS);
  };

  it("refuses a hash or size that differs from the pin", () => {
    expect(problems((m) => (m.assets[0]!.sha256 = "0".repeat(64))).join("\n")).toContain(
      "SHA-256 of its pin",
    );
    expect(problems((m) => (m.assets[0]!.bytes += 1)).join("\n")).toContain("SHA-256 of its pin");
  });

  it("refuses a bad revision, tag, repository, duplicate name and wrong part count", () => {
    expect(problems((m) => (m.revision = "latest"))).not.toEqual([]);
    expect(problems((m) => (m.tag = "v1.2.5.8"))).not.toEqual([]);
    expect(problems((m) => (m.repository = "someone"))).not.toEqual([]);
    expect(
      problems((m) => (m.assets[1]!.file = m.assets[0]!.file.toUpperCase())).join("\n"),
    ).toContain("duplicate");
    expect(problems((m) => (m.assets[0]!.parts = 5)).join("\n")).toContain("parts must be");
  });

  it("refuses an unknown pin, an unknown recipe, and a derived recipe with no pinned hash", () => {
    expect(problems((m) => (m.assets[0]!.from.pin = "nobody/nothing")).join("\n")).toContain(
      "no pin",
    );
    expect(problems((m) => (m.assets[0]!.from.recipe = "magic")).join("\n")).toContain(
      "recipe must be",
    );
    expect(problems((m) => (m.assets[0]!.from.recipe = "int8-dynamic")).join("\n")).toContain(
      "derived recipe",
    );
    const ok = problems((m) => {
      const a = m.assets[0]!;
      a.from.recipe = "int8-dynamic";
      a.from.derivedSha256 = "1".repeat(64);
      a.sha256 = "1".repeat(64);
    });
    expect(ok).toEqual([]);
  });

  it("refuses a file name with a path separator or a space, or one that is not the model's", () => {
    expect(problems((m) => (m.assets[0]!.file = "friday-ear-tiny--a b")).join("\n")).toContain(
      "bad character",
    );
    expect(problems((m) => (m.assets[0]!.file = "other--config.json")).join("\n")).toContain(
      "<fridayId>--",
    );
  });
});

describe("the split math", () => {
  const GB = 1_900_000_000;

  it("counts parts with every part at most the part size", () => {
    expect(pack.partCount(1, GB)).toBe(1);
    expect(pack.partCount(GB, GB)).toBe(1);
    expect(pack.partCount(GB + 1, GB)).toBe(2);
    expect(pack.partCount(3_087_284_237, GB)).toBe(2);
    expect(pack.partCount(0, GB)).toBe(1);
    expect(() => pack.partCount(-1, GB)).toThrow();
    expect(() => pack.partCount(10, 0)).toThrow();
  });

  it("plans contiguous ranges that add up to the file and stay under the release limit", () => {
    for (const bytes of [1, 99, 100, 101, 250, 3_087_284_237]) {
      const size = bytes > 1000 ? GB : 100;
      const plan = pack.splitPlan("f.bin", bytes, size);
      expect(plan.reduce((sum, p) => sum + p.length, 0)).toBe(bytes);
      plan.forEach((p, i) => {
        expect(p.offset).toBe(i === 0 ? 0 : plan[i - 1]!.offset + plan[i - 1]!.length);
        expect(p.length).toBeLessThanOrEqual(size);
        expect(p.length).toBeLessThan(pack.ASSET_LIMIT);
      });
    }
  });

  it("names parts in order and leaves an unsplit file alone", () => {
    expect(pack.partName("f.bin", 0, 1)).toBe("f.bin");
    expect(pack.partName("f.bin", 0, 3)).toBe("f.bin.part001");
    expect(pack.partName("f.bin", 2, 3)).toBe("f.bin.part003");
  });

  it("the committed manifest splits exactly the files over the part size", () => {
    const split = manifest.assets.filter((a) => a.parts > 1).map((a) => a.file);
    expect(split.sort()).toEqual(
      manifest.assets
        .filter((a) => a.bytes > manifest.partBytes)
        .map((a) => a.file)
        .sort(),
    );
    expect(split.length).toBeGreaterThan(0);
  });

  it("splits a real file into parts that join back to it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-split-"));
    try {
      const data = crypto.randomBytes(1005);
      const source = path.join(dir, "src.bin");
      fs.writeFileSync(source, data);
      const rows = await pack.splitFile(source, dir, "friday-x--m.bin", 400);
      expect(rows.map((r) => r.file)).toEqual([
        "friday-x--m.bin.part001",
        "friday-x--m.bin.part002",
        "friday-x--m.bin.part003",
      ]);
      expect(rows.map((r) => r.bytes)).toEqual([400, 400, 205]);
      const joined = Buffer.concat(rows.map((r) => fs.readFileSync(path.join(dir, r.file))));
      expect(sha(joined)).toBe(sha(data));
      for (const r of rows) expect(r.sha256).toBe(sha(fs.readFileSync(path.join(dir, r.file))));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("licence refusal and the notice", () => {
  it("refuses a pin the bundle gate refuses, before anything is fetched", async () => {
    const pins = clone(voicePins.PINS);
    const key = manifest.assets[0]!.from.pin;
    pins[key]!.licenseRecord = { ...pins[key]!.licenseRecord, id: "GPL-3.0" };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-refuse-"));
    let calls = 0;
    try {
      await expect(
        pack.buildPack({
          manifest,
          pins,
          gate: voicePins.bundleAllowed,
          outDir: dir,
          download: async () => {
            calls += 1;
            return 0;
          },
        }),
      ).rejects.toThrow(/refused by the bundle gate/);
      expect(calls).toBe(0);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes one licence line per model, from its pin, and nothing about any tool", () => {
    const models = pack.modelsOf(manifest);
    const text = pack.buildNotice(manifest, models, voicePins.PINS);
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(models.length);
    for (const model of models) {
      const rec = voicePins.PINS[model.pin]!.licenseRecord as { id: string; url: string };
      const line = pack.noticeLine(model, voicePins.PINS[model.pin]);
      expect(lines).toContain(line);
      expect(line).toContain(rec.id);
      expect(line).toContain(rec.url);
      expect(line.startsWith(`- ${model.fridayName}:`)).toBe(true);
    }
    expect(text).toContain("devendrarj25");
    expect(text).not.toMatch(/claude|anthropic|gpt|openai|co-authored|@/i);
  });

  it("mentions the upstream licence only in the notice, not in the manifest or the script comments", () => {
    // File names may carry a licence file that the publisher ships with the weights; no other field may name one.
    const fields = JSON.stringify(manifest, (key, value) =>
      ["path", "file"].includes(key) ? undefined : value,
    );
    expect(fields).not.toMatch(/licen[cs]e|MIT|Apache|CC-BY|OpenRAIL/i);
    const script = read("scripts/build-friday-models.cjs");
    const comments = script.split("\n").filter((l) => /^\s*(\/\/|\*|\/\*)/.test(l));
    expect(comments.join("\n")).not.toMatch(/MIT|Apache|CC-BY|OpenRAIL|NVIDIA/);
  });

  it("the notice line tells the use-restricted voice to pass its limits on", () => {
    const voice = pack.modelsOf(manifest).find((m) => m.fridayId === "friday-voice")!;
    expect(pack.noticeLine(voice, voicePins.PINS[voice.pin])).toContain("use limits");
  });
});

describe("a build with an injected downloader", () => {
  const tiny = () => {
    const data = {
      "config.json": Buffer.from('{"a":1}'),
      "model.bin": crypto.randomBytes(1000),
    };
    const pins: Pins = {
      "pub/tiny": {
        revision: "r".repeat(40),
        files: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, { sha256: sha(v), bytes: v.length }]),
        ),
        licenseRecord: {
          id: "MIT",
          url: "https://opensource.org/license/mit",
          redistribution: "permissive",
        },
      },
    };
    const m: Manifest = {
      pack: "friday-models",
      revision: "2026.1.1",
      repository: "devendrarj25/FRIDAY-AI-ASSISTANT",
      tag: "friday-models-2026.1.1",
      title: "FRIDAY Models 2026.1.1",
      partBytes: 400,
      assets: Object.entries(data).map(([file, buf]) => ({
        fridayId: "friday-ear-tiny",
        fridayName: "FRIDAY Ear Tiny",
        path: file,
        file: `friday-ear-tiny--${file}`,
        sha256: sha(buf),
        bytes: buf.length,
        parts: Math.max(1, Math.ceil(buf.length / 400)),
        from: { pin: "pub/tiny", file, recipe: "copy", recipeVersion: 1 },
      })),
    };
    const urls: string[] = [];
    const download: Download = async (url, dest, options) => {
      urls.push(url);
      const name = url.split("/").pop()!;
      const buf = data[name as keyof typeof data];
      if (sha(buf) !== options.sha256) throw new Error("wrong hash");
      fs.writeFileSync(dest, buf);
      return buf.length;
    };
    return { pins, m, download, urls, data };
  };

  it("fetches the pinned revision, splits the big file, and writes sums, notice, manifest and command", async () => {
    const t = tiny();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    try {
      const out = await pack.buildPack({
        manifest: t.m,
        pins: t.pins,
        gate: voicePins.bundleAllowed,
        outDir: dir,
        download: t.download,
      });
      expect(t.urls).toEqual([
        `https://huggingface.co/pub/tiny/resolve/${"r".repeat(40)}/config.json`,
        `https://huggingface.co/pub/tiny/resolve/${"r".repeat(40)}/model.bin`,
      ]);
      const names = fs.readdirSync(dir).sort();
      expect(names).toEqual([
        "NOTICE.md",
        "SHA256SUMS",
        "friday-ear-tiny--config.json",
        "friday-ear-tiny--model.bin.part001",
        "friday-ear-tiny--model.bin.part002",
        "friday-ear-tiny--model.bin.part003",
        "friday-models.json",
        "upload-command.txt",
      ]);
      const sums = fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
      expect(sums.length).toBe(4);
      for (const line of sums) {
        const [hash, file] = line.split("  ") as [string, string];
        expect(sha(fs.readFileSync(path.join(dir, file)))).toBe(hash);
      }
      const joined = Buffer.concat(
        ["001", "002", "003"].map((n) =>
          fs.readFileSync(path.join(dir, `friday-ear-tiny--model.bin.part${n}`)),
        ),
      );
      expect(sha(joined)).toBe(t.m.assets[1]!.sha256);
      const filled = JSON.parse(
        fs.readFileSync(path.join(dir, "friday-models.json"), "utf8"),
      ) as Manifest & {
        assets: (Asset & { partFiles?: string[] })[];
      };
      expect(filled.assets[1]!.partFiles).toHaveLength(3);
      expect(out.command).toBe(
        fs.readFileSync(path.join(dir, "upload-command.txt"), "utf8").trim(),
      );
      expect(
        out.command.startsWith(
          "gh release create friday-models-2026.1.1 --repo devendrarj25/FRIDAY-AI-ASSISTANT",
        ),
      ).toBe(true);
      expect(out.command).toContain("--notes-file NOTICE.md");
      expect(out.command).toContain("--latest=false");
      for (const file of out.files) expect(out.command).toContain(file);
      expect(fs.readFileSync(path.join(dir, "NOTICE.md"), "utf8")).toContain(
        "FRIDAY Ear Tiny: MIT",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a named pack: its own tag in the command, its own manifest file, a pin that brings its own URL", async () => {
    const t = tiny();
    const named = clone(t.m) as Manifest & { fridayName: string };
    named.pack = "voice-weights";
    named.fridayName = "FRIDAY Voice Weights";
    named.tag = "friday-voice-weights-2026.1.1";
    named.title = "FRIDAY Voice Weights 2026.1.1";
    named.assets = named.assets.slice(0, 1);
    const pins = clone(t.pins);
    (pins["pub/tiny"] as Record<string, unknown>)["urlFor"] = () =>
      "https://example.com/own/config.json";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    try {
      const out = await pack.buildPack({
        manifest: named,
        pins,
        gate: voicePins.bundleAllowed,
        outDir: dir,
        download: t.download,
      });
      expect(out.files).toContain("friday-voice-weights.json");
      expect(fs.existsSync(path.join(dir, "friday-models.json"))).toBe(false);
      expect(out.command.startsWith("gh release create friday-voice-weights-2026.1.1 ")).toBe(true);
      expect(out.command).toContain('--title "FRIDAY Voice Weights 2026.1.1"');
      const notice = fs.readFileSync(path.join(dir, "NOTICE.md"), "utf8");
      expect(notice).toContain("as the FRIDAY Voice Weights pack");
      expect(notice).toContain("the file named in friday-voice-weights.json");
      expect(t.urls).toEqual(["https://example.com/own/config.json"]);
      expect(sha(fs.readFileSync(path.join(dir, named.assets[0]!.file)))).toBe(
        sha(t.data["config.json"]),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second run keeps the checked files and fetches nothing", async () => {
    const t = tiny();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    const options = {
      manifest: t.m,
      pins: t.pins,
      gate: voicePins.bundleAllowed,
      outDir: dir,
      download: t.download,
    };
    try {
      await pack.buildPack(options);
      t.urls.length = 0;
      await pack.buildPack(options);
      expect(t.urls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a whole model when one file is over the limit, and says which", async () => {
    const t = tiny();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    try {
      const out = await pack.buildPack({
        manifest: t.m,
        pins: t.pins,
        gate: voicePins.bundleAllowed,
        outDir: dir,
        maxBytes: 500,
        download: t.download,
      });
      expect(out.built).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0]!.reason).toContain("friday-ear-tiny--model.bin");
      expect(t.urls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops on a download whose bytes differ, leaving no sums file", async () => {
    const t = tiny();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    try {
      await expect(
        pack.buildPack({
          manifest: t.m,
          pins: t.pins,
          gate: voicePins.bundleAllowed,
          outDir: dir,
          download: async () => {
            throw new Error("checksum mismatch");
          },
        }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(fs.existsSync(path.join(dir, "SHA256SUMS"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a derived file only when it matches the pinned derived hash", async () => {
    const t = tiny();
    const derived = Buffer.from("derived-bytes");
    const a = t.m.assets[0]!;
    a.from.recipe = "int8-dynamic";
    a.from.derivedSha256 = sha(derived);
    a.sha256 = sha(derived);
    a.bytes = derived.length;
    a.parts = 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pack-"));
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), "friday-derived-"));
    try {
      fs.writeFileSync(path.join(dd, "config.json"), "not the derived bytes");
      await expect(
        pack.buildPack({
          manifest: t.m,
          pins: t.pins,
          gate: voicePins.bundleAllowed,
          outDir: dir,
          derived: dd,
          download: t.download,
        }),
      ).rejects.toThrow(/derived file is missing or does not match/);
      fs.writeFileSync(path.join(dd, "config.json"), derived);
      await pack.buildPack({
        manifest: t.m,
        pins: t.pins,
        gate: voicePins.bundleAllowed,
        outDir: dir,
        derived: dd,
        download: t.download,
      });
      expect(fs.readFileSync(path.join(dir, a.file))).toEqual(derived);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dd, { recursive: true, force: true });
    }
  });
});

describe("the command line and the upload command", () => {
  it("parses its options and refuses an unknown one", () => {
    const parsed = pack.parseArgs(["--out", "/x", "--max-gb", "3", "--only", "a,b", "--dry-run"]);
    expect(parsed).toMatchObject({ out: "/x", maxGb: 3, only: ["a", "b"], dryRun: true });
    expect(() => pack.parseArgs(["--upload"])).toThrow(/unknown argument/);
  });

  it("takes the pack to build with --pack and names its filled manifest after it", () => {
    expect(pack.parseArgs(["--pack", "voice-weights", "--out", "/x"]).pack).toBe("voice-weights");
    expect(pack.parseArgs(["--out", "/x"]).pack).toBe("");
    expect(pack.manifestFileName({ pack: "friday-models" })).toBe("friday-models.json");
    expect(pack.manifestFileName({ pack: "voice-weights" })).toBe("friday-voice-weights.json");
  });

  it("builds a download URL at the pinned revision, never a branch", () => {
    expect(pack.hfUrl("a/b", "c".repeat(40), "onnx/m n.onnx")).toBe(
      `https://huggingface.co/a/b/resolve/${"c".repeat(40)}/onnx/m%20n.onnx`,
    );
  });

  it("prints a gh release create command and the script never runs it", () => {
    const cmd = pack.uploadCommand(manifest, ["a.bin", "SHA256SUMS"]);
    expect(cmd).toBe(
      `gh release create ${manifest.tag} --repo ${manifest.repository} --title "${manifest.title}" --notes-file NOTICE.md --latest=false a.bin SHA256SUMS`,
    );
    const script = read("scripts/build-friday-models.cjs");
    // The one process the script starts is its own converter (`python kernel/voice_merge.py convert`); it never starts
    // `gh`, a shell, or anything else, so nothing is uploaded or published from here.
    expect(script).not.toMatch(/spawn|exec\(|execSync|execFile\(|shell\s*:/);
    expect(script.match(/child_process/g)).toHaveLength(1);
    expect(script.match(/execFileSync\(/g)).toHaveLength(1);
    expect(script).toMatch(/execFileSync\(\s*python,\s*\["-I", CT2_SCRIPT, "convert"/);
    expect(pack.sha256sumsText([{ file: "a.bin", sha256: "f".repeat(64) }])).toBe(
      `${"f".repeat(64)}  a.bin\n`,
    );
  });
});

describe("the locked chain never reaches it", () => {
  const chain = [
    "scripts/setup-windows.ps1",
    "scripts/build-windows.cmd",
    "scripts/build-pipeline.cjs",
    "scripts/doctor.cjs",
    "scripts/check-environment.cjs",
    "scripts/setup-python.cjs",
    "scripts/prefetch-toolkit.cjs",
    "scripts/prefetch-models.cjs",
    "scripts/ensure-electron.cjs",
    "scripts/stage-toolchain.cjs",
    "scripts/electron-pack.cjs",
    "scripts/verify-build.cjs",
    "scripts/live-console.cjs",
    "scripts/console-bar.cjs",
    "scripts/download-board.cjs",
    "electron-builder.yml",
    "package.json",
    "config/friday-version.json",
  ];

  it.each(chain)("%s does not mention the pack", (file) => {
    const text = read(file);
    expect(text).not.toContain("build-friday-models");
    expect(text).not.toContain("friday-models.json");
  });

  it("no workflow runs it except the one release step that publishes the missing weight packs", () => {
    const dir = path.join(root, ".github", "workflows");
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      if (name !== "release.yml") {
        expect(text, name).not.toContain("build-friday-models");
        continue;
      }
      const start = text.indexOf("- name: Publish missing weight packs");
      const end = text.indexOf("- name: Create GitHub Release");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      let at = text.indexOf("build-friday-models");
      expect(at).toBeGreaterThan(start);
      while (at !== -1) {
        expect(at).toBeLessThan(end);
        at = text.indexOf("build-friday-models", at + 1);
      }
    }
  });
});
