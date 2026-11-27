import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * friday-bundle.json (schema 1): the one reader and writer. A build writes it next to the installer, the installed
 * app reads it to find locally built assets. Pure Node, deterministic, strict, fail-closed. These tests run on a
 * throwaway temp folder and never touch the network, the clock or this machine's registry.
 */
const require_ = createRequire(import.meta.url);
const bb = require_("../../electron/build-bundle.cjs");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function opts(over: Record<string, unknown> = {}) {
  return {
    product: "FRIDAY",
    channel: "stable",
    version: "1.2.5.8",
    commit: "0123abc",
    caller: "cmd",
    app: [
      { name: "FRIDAY-Setup-1.2.5.8.exe", kind: "installer", bytes: 10, sha256: HEX_A },
      { name: "latest.yml", kind: "latest", bytes: 3, sha256: HEX_B },
    ],
    inExe: { builtins: { sha256: HEX_A }, wheelhouse: null },
    packs: [
      {
        id: "voice-weights",
        tag: "friday-voice-weights-2026.11.1",
        revision: "2026.11.1",
        location: "release",
        dir: null,
      },
    ],
    models: [
      {
        fridayId: "friday-ear-tiny",
        dir: "models/friday-ear-tiny",
        files: [
          { path: "config.json", bytes: 5, sha256: HEX_A },
          { path: "sub/model.bin", bytes: 7, sha256: HEX_B },
        ],
      },
    ],
    ...over,
  };
}

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-bundle-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function errorsOf(mutate: (o: any) => void): string[] {
  const o = JSON.parse(bb.stringify(bb.build(opts())));
  mutate(o);
  const r = bb.validate(o);
  expect(r.ok).toBe(false);
  return r.errors;
}

describe("build and canonical form", () => {
  it("builds a valid schema 1 object and fills the model byte total", () => {
    const o = bb.build(opts());
    expect(o.schema).toBe(1);
    expect(bb.validate(o)).toEqual({ ok: true, errors: [] });
    expect(o.models[0].bytes).toBe(12);
  });

  it("two runs and any input order give the same bytes and the same sha256", () => {
    const a = bb.build(opts());
    const shuffled = opts({
      app: [...opts().app].reverse(),
      models: [{ ...opts().models[0], files: [...opts().models[0]!.files].reverse() }],
    });
    const b = bb.build(shuffled);
    expect(bb.stringify(a)).toBe(bb.stringify(b));
    expect(bb.hashOf(a)).toBe(bb.hashOf(b));
    expect(bb.hashOf(a)).toBe(sha(bb.stringify(a)));
    expect(bb.hashOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is LF only, ends with one newline, sorts keys and carries no timestamp", () => {
    const text = bb.stringify(bb.build(opts()));
    expect(text).not.toContain("\r");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    const keys = Object.keys(JSON.parse(text));
    expect(keys).toEqual([...keys].sort());
    expect(text).not.toMatch(/"[A-Za-z]*(time|date|stamp|At)"\s*:/);
  });

  it("changes the hash when one byte of one file hash changes", () => {
    const o = opts();
    o.models[0]!.files[0]!.sha256 = HEX_B;
    expect(bb.hashOf(bb.build(o))).not.toBe(bb.hashOf(bb.build(opts())));
  });

  it("build throws a readable error for an invalid input", () => {
    expect(() => bb.build(opts({ channel: "beta" }))).toThrow(/channel/);
  });
});

describe("validate is strict", () => {
  it("rejects a wrong schema, product, channel, version, caller and commit", () => {
    expect(errorsOf((o) => (o.schema = 2)).join()).toMatch(/schema/);
    expect(errorsOf((o) => (o.product = "")).join()).toMatch(/product/);
    expect(errorsOf((o) => (o.channel = "beta")).join()).toMatch(/channel/);
    expect(errorsOf((o) => (o.version = "latest")).join()).toMatch(/version/);
    expect(errorsOf((o) => (o.caller = "robot")).join()).toMatch(/caller/);
    expect(errorsOf((o) => (o.commit = "not hex!")).join()).toMatch(/commit/);
  });

  it("rejects a non-hex or short sha256, and negative or fractional bytes", () => {
    expect(errorsOf((o) => (o.app[0].sha256 = "xyz")).join()).toMatch(/sha256/);
    expect(errorsOf((o) => (o.app[0].sha256 = "a".repeat(63))).join()).toMatch(/sha256/);
    expect(errorsOf((o) => (o.app[0].bytes = -1)).join()).toMatch(/bytes/);
    expect(errorsOf((o) => (o.app[0].bytes = 1.5)).join()).toMatch(/bytes/);
    expect(errorsOf((o) => (o.app[0].bytes = "10")).join()).toMatch(/bytes/);
  });

  it("rejects an unknown app kind and unknown keys anywhere", () => {
    expect(errorsOf((o) => (o.app[0].kind = "zip")).join()).toMatch(/kind/);
    expect(errorsOf((o) => (o.extra = 1)).join()).toMatch(/unknown/);
    expect(errorsOf((o) => (o.models[0].note = "x")).join()).toMatch(/unknown/);
  });

  it("rejects a non-object and accepts nothing from a prototype key", () => {
    expect(bb.validate(null).ok).toBe(false);
    expect(bb.validate([]).ok).toBe(false);
    const bad = JSON.parse('{"__proto__": {"x": 1}, "schema": 1}');
    expect(bb.validate(bad).ok).toBe(false);
  });

  it("rejects a case-insensitive duplicate app name, pack id, model id, model dir and file path", () => {
    expect(errorsOf((o) => (o.app[1].name = "friday-setup-1.2.5.8.EXE")).join()).toMatch(
      /duplicate/i,
    );
    expect(errorsOf((o) => o.packs.push({ ...o.packs[0], id: "Voice-Weights" })).join()).toMatch(
      /duplicate/i,
    );
    expect(
      errorsOf((o) => o.models.push({ ...o.models[0], dir: "models/other" } as never)).join(),
    ).toMatch(/duplicate/i);
    expect(
      errorsOf((o) =>
        o.models.push({ ...o.models[0], fridayId: "friday-ear-base" } as never),
      ).join(),
    ).toMatch(/duplicate/i);
    expect(errorsOf((o) => (o.models[0].files[1].path = "CONFIG.json")).join()).toMatch(
      /duplicate/i,
    );
  });

  it("rejects a model byte total that is not the sum of its files", () => {
    expect(errorsOf((o) => (o.models[0].bytes = 99)).join()).toMatch(/bytes/);
  });

  it("rejects traversal, absolute and drive paths in dir and path fields", () => {
    const bad = [
      "../x",
      "a/../../x",
      "a/./b",
      "/etc/passwd",
      "\\\\server\\share",
      "C:/Windows",
      "C:",
      "a\\b",
      "a//b",
      "",
      "con",
      "dir./x",
      "a/b ",
      "a\u0000b",
    ];
    for (const p of bad) {
      expect(
        errorsOf((o) => (o.models[0].dir = p)).length,
        `dir ${JSON.stringify(p)}`,
      ).toBeGreaterThan(0);
      expect(
        errorsOf((o) => (o.models[0].files[0].path = p)).length,
        `path ${JSON.stringify(p)}`,
      ).toBeGreaterThan(0);
    }
    expect(
      errorsOf((o) => {
        o.packs[0].location = "local";
        o.packs[0].dir = "../packs";
      }).length,
    ).toBeGreaterThan(0);
    expect(errorsOf((o) => (o.app[0].name = "../evil.exe")).length).toBeGreaterThan(0);
    expect(errorsOf((o) => (o.app[0].name = "sub/evil.exe")).length).toBeGreaterThan(0);
  });

  it("ties a pack's dir to its location", () => {
    expect(errorsOf((o) => (o.packs[0].dir = "packs/x")).join()).toMatch(/dir/);
    expect(
      errorsOf((o) => {
        o.packs[0].location = "local";
        o.packs[0].dir = null;
      }).join(),
    ).toMatch(/dir/);
    const ok = bb.build(
      opts({ packs: [{ id: "p", tag: "t", revision: "1", location: "local", dir: "packs/p" }] }),
    );
    expect(ok.packs[0].dir).toBe("packs/p");
  });

  it("accepts an empty models list (a non-cmd caller) and a wheelhouse record", () => {
    const o = bb.build(
      opts({
        caller: "release",
        models: [],
        inExe: { builtins: { sha256: HEX_A }, wheelhouse: { bytes: 4, sha256: HEX_B } },
      }),
    );
    expect(o.models).toEqual([]);
    expect(o.inExe.wheelhouse).toEqual({ bytes: 4, sha256: HEX_B });
  });
});

describe("read and write", () => {
  it("round-trips through a file with the same hash and leaves no temp file", () => {
    const file = path.join(tmp, "friday-bundle.json");
    const o = bb.build(opts());
    bb.write(file, o);
    expect(fs.readdirSync(tmp)).toEqual(["friday-bundle.json"]);
    expect(fs.readFileSync(file, "utf8")).toBe(bb.stringify(o));
    expect(bb.hashOf(bb.read(file))).toBe(bb.hashOf(o));
  });

  it("read strips a BOM and fails closed to null on a missing, damaged, oversized or invalid file", () => {
    const file = path.join(tmp, "b.json");
    fs.writeFileSync(file, "\uFEFF" + bb.stringify(bb.build(opts())));
    expect(bb.read(file)).not.toBeNull();
    expect(bb.read(path.join(tmp, "missing.json"))).toBeNull();
    fs.writeFileSync(file, "{ not json");
    expect(bb.read(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schema: 1 }));
    expect(bb.read(file)).toBeNull();
    fs.writeFileSync(file, " ".repeat(bb.MAX_BYTES + 1));
    expect(bb.read(file)).toBeNull();
    expect(bb.read(tmp)).toBeNull();
  });

  it("write refuses an invalid object and keeps the old file whole", () => {
    const file = path.join(tmp, "friday-bundle.json");
    bb.write(file, bb.build(opts()));
    const before = fs.readFileSync(file, "utf8");
    expect(() => bb.write(file, { schema: 1 })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(tmp)).toEqual(["friday-bundle.json"]);
  });

  it("write is atomic: a failed rename removes the temp file and keeps the old bytes", () => {
    const file = path.join(tmp, "friday-bundle.json");
    bb.write(file, bb.build(opts()));
    const before = fs.readFileSync(file, "utf8");
    const failing = {
      ...fs,
      renameSync: () => {
        throw new Error("EBUSY");
      },
    };
    expect(() => bb.write(file, bb.build(opts({ version: "1.2.5.9" })), { fs: failing })).toThrow(
      /EBUSY/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(tmp)).toEqual(["friday-bundle.json"]);
  });
});

describe("bundleFilesMatch", () => {
  function lay(content: Record<string, string>) {
    for (const [rel, text] of Object.entries(content)) {
      const full = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
  }
  function bundleFor(content: Record<string, string>) {
    return bb.build(
      opts({
        app: [
          {
            name: "app.exe",
            kind: "installer",
            bytes: content["app.exe"]!.length,
            sha256: sha(content["app.exe"]!),
          },
        ],
        models: [
          {
            fridayId: "friday-ear-tiny",
            dir: "models/tiny",
            files: [
              {
                path: "w.bin",
                bytes: content["models/tiny/w.bin"]!.length,
                sha256: sha(content["models/tiny/w.bin"]!),
              },
            ],
          },
        ],
      }),
    );
  }
  const good = { "app.exe": "installer-bytes", "models/tiny/w.bin": "weights" };

  it("accepts listed files whose size and sha256 match", () => {
    lay(good);
    const r = bb.bundleFilesMatch(tmp, bundleFor(good));
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2);
    expect(r.bad).toEqual([]);
  });

  it("reports a missing file, a same-size changed file and a size change", () => {
    const bundle = bundleFor(good);
    lay({ "models/tiny/w.bin": "weights" });
    expect(bb.bundleFilesMatch(tmp, bundle).bad).toEqual([{ path: "app.exe", reason: "missing" }]);
    lay({ "app.exe": "installer-bytez" });
    expect(bb.bundleFilesMatch(tmp, bundle).bad).toEqual([{ path: "app.exe", reason: "sha256" }]);
    lay({ "app.exe": "short" });
    expect(bb.bundleFilesMatch(tmp, bundle).bad).toEqual([{ path: "app.exe", reason: "size" }]);
  });

  it("checks the size first and opens no file when the size already differs", () => {
    const bundle = bundleFor(good);
    lay({ "app.exe": "short", "models/tiny/w.bin": "weights!" });
    let opened = 0;
    const counting = {
      ...fs,
      openSync: (...a: Parameters<typeof fs.openSync>) => {
        opened += 1;
        return fs.openSync(...a);
      },
    };
    const r = bb.bundleFilesMatch(tmp, bundle, { fs: counting });
    expect(r.ok).toBe(false);
    expect(r.bad.map((b: { reason: string }) => b.reason)).toEqual(["size", "size"]);
    expect(opened).toBe(0);
  });

  it("takes model files from a separate root and can limit the scope", () => {
    const rootDir = path.join(tmp, "root");
    const buildDir = path.join(tmp, "build");
    fs.mkdirSync(path.join(rootDir, "models/tiny"), { recursive: true });
    fs.mkdirSync(buildDir);
    fs.writeFileSync(path.join(rootDir, "models/tiny/w.bin"), "weights");
    fs.writeFileSync(path.join(buildDir, "app.exe"), "installer-bytes");
    const bundle = bundleFor(good);
    expect(bb.bundleFilesMatch(buildDir, bundle, { modelsRoot: rootDir }).ok).toBe(true);
    expect(bb.bundleFilesMatch(buildDir, bundle, { scope: "app" }).checked).toBe(1);
    expect(bb.bundleFilesMatch(buildDir, bundle, { scope: "models" }).bad[0].reason).toBe(
      "missing",
    );
  });

  it("refuses a symlink and a directory standing in for a file", () => {
    lay({ "app.exe": "installer-bytes", "other.bin": "weights" });
    fs.mkdirSync(path.join(tmp, "models/tiny"), { recursive: true });
    const bundle = bundleFor(good);
    fs.mkdirSync(path.join(tmp, "models/tiny/w.bin"));
    expect(bb.bundleFilesMatch(tmp, bundle).bad).toEqual([
      { path: "models/tiny/w.bin", reason: "not-a-file" },
    ]);
    fs.rmdirSync(path.join(tmp, "models/tiny/w.bin"));
    try {
      fs.symlinkSync(path.join(tmp, "other.bin"), path.join(tmp, "models/tiny/w.bin"));
    } catch {
      return; // no symlink right on this machine: the directory case above still ran
    }
    expect(bb.bundleFilesMatch(tmp, bundle).bad).toEqual([
      { path: "models/tiny/w.bin", reason: "not-a-file" },
    ]);
  });

  it("never reads outside the folder even for a hand-made bundle", () => {
    const evil = JSON.parse(bb.stringify(bundleFor(good)));
    evil.models[0].dir = "../outside";
    const r = bb.bundleFilesMatch(tmp, evil);
    expect(r.ok).toBe(false);
    expect(r.bad[0].reason).toBe("invalid-bundle");
  });
});

describe("config pins always win", () => {
  const pin = {
    files: [
      { path: "config.json", bytes: 5, sha256: HEX_A },
      { path: "sub/model.bin", bytes: 7, sha256: HEX_B },
    ],
  };
  const model = () => bb.build(opts()).models[0];

  it("is true when every pinned file matches in size and hash, in any case of hex", () => {
    expect(bb.pinWins(model(), pin)).toBe(true);
    const upper = { files: pin.files.map((f) => ({ ...f, sha256: f.sha256.toUpperCase() })) };
    expect(bb.pinWins(model(), upper)).toBe(true);
  });

  it("is false when the bundle hash or size differs from the pin", () => {
    const hashDiff = { files: [{ ...pin.files[0], sha256: HEX_B }, pin.files[1]] };
    const sizeDiff = { files: [{ ...pin.files[0], bytes: 6 }, pin.files[1]] };
    expect(bb.pinWins(model(), hashDiff)).toBe(false);
    expect(bb.pinWins(model(), sizeDiff)).toBe(false);
  });

  it("is false when the bundle lists a file the pin lacks or lacks one the pin lists", () => {
    expect(bb.pinWins(model(), { files: [pin.files[0]] })).toBe(false);
    expect(
      bb.pinWins(model(), { files: [...pin.files, { path: "x.bin", bytes: 1, sha256: HEX_A }] }),
    ).toBe(false);
  });

  it("is false with no pin, an empty pin or a malformed model", () => {
    expect(bb.pinWins(model(), null)).toBe(false);
    expect(bb.pinWins(model(), { files: [] })).toBe(false);
    expect(bb.pinWins(null, pin)).toBe(false);
    expect(bb.pinWins({ files: "x" }, pin)).toBe(false);
  });

  it("builds a pin from the rows of config/friday-models.json", () => {
    const rows = [
      { fridayId: "friday-ear-tiny", path: "config.json", sha256: HEX_A, bytes: 5 },
      { fridayId: "friday-ear-tiny", path: "sub/model.bin", sha256: HEX_B, bytes: 7 },
      { fridayId: "friday-voice", path: "v.onnx", sha256: HEX_A, bytes: 1 },
    ];
    const p = bb.pinFromAssets(rows, "friday-ear-tiny");
    expect(p.files).toHaveLength(2);
    expect(bb.pinWins(model(), p)).toBe(true);
    expect(bb.pinFromAssets(rows, "missing").files).toEqual([]);
  });

  it("holds against the real repo pins: a model that echoes them wins, one tampered hash does not", () => {
    const real = require_("../../config/friday-models.json");
    const id = real.assets[0].fridayId as string;
    const p = bb.pinFromAssets(real.assets, id);
    expect(p.files.length).toBeGreaterThan(0);
    const mine = { fridayId: id, dir: `models/${id}`, files: p.files.map((f: any) => ({ ...f })) };
    const echoed = bb.build(opts({ models: [mine] })).models[0];
    expect(bb.pinWins(echoed, p)).toBe(true);
    const tampered = bb.build(
      opts({
        models: [
          {
            ...mine,
            files: mine.files.map((f: any, i: number) =>
              i === 0 ? { ...f, sha256: sha("x") } : f,
            ),
          },
        ],
      }),
    ).models[0];
    expect(bb.pinWins(tampered, p)).toBe(false);
  });
});

describe("independence", () => {
  it("is pure Node: no electron, no network, no child process", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "electron", "build-bundle.cjs"),
      "utf8",
    );
    expect(src).not.toMatch(/require\(["']electron["']\)/);
    expect(src).not.toMatch(/child_process|node:https?|require\(["']https?["']\)/);
    expect(src).not.toMatch(/Date\.now|new Date/);
  });
});
