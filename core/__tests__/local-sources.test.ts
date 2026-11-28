/**
 * Locally built assets: where the app looks for a `friday-bundle.json`, which pinned model a bundle can serve, and the
 * download chain that tries it before the FRIDAY release and the official source. Offline and hermetic: temp folders,
 * an injected registry reader, a fake fetch; nothing reads this PC's registry, network or clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const local = req("../../electron/local-sources.cjs");
const bundleLib = req("../../electron/build-bundle.cjs");
const staged = req("../../electron/staged-assets.cjs");
const weights = req("../../electron/voice-weights.cjs");
const download = req("../../electron/model-download.cjs");
const pins = req("../../electron/voice-pins.cjs");
const core = req("../../electron/friday-core.cjs");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const REPO = "test/pinned-local";
const TAG = "friday-voice-weights-2026.1.1";
const BASE = `https://github.com/o/r/releases/download/${TAG}/`;
const ID = "friday-test";
const FILES: Record<string, string> = {
  "config.json": "{}",
  "model.bin": "0123456789",
  "onnx/head.onnx": "head",
};
const PIN = {
  revision: "c".repeat(40),
  files: Object.fromEntries(
    Object.entries(FILES).map(([name, text]) => [name, { sha256: sha(text), bytes: text.length }]),
  ),
};
const pinList = Object.entries(PIN.files).map(([name, row]) => ({ path: name, ...row }));

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-local-sources-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (...parts: string[]) => {
  const dir = path.join(tmp, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

type ModelRow = {
  fridayId: string;
  dir: string;
  files: { path: string; bytes: number; sha256: string }[];
};

function modelRow(files: Record<string, string> = FILES, id = ID): ModelRow {
  return {
    fridayId: id,
    dir: `models/${id}`,
    files: Object.entries(files).map(([name, text]) => ({
      path: name,
      bytes: text.length,
      sha256: sha(text),
    })),
  };
}

const APP = [{ name: "FRIDAY-Setup-1.2.5.8.exe", kind: "installer", bytes: 3, sha256: sha("exe") }];

function bundleOf(models: ModelRow[] = [modelRow()], packs: unknown[] = []) {
  return bundleLib.build({
    product: "FRIDAY",
    channel: "stable",
    version: "1.2.5.8",
    commit: null,
    caller: "cmd",
    app: APP,
    inExe: { builtins: { sha256: sha("b") }, wheelhouse: null },
    packs,
    models,
  });
}

function writeBundle(dir: string, bundle = bundleOf()) {
  fs.mkdirSync(dir, { recursive: true });
  bundleLib.write(path.join(dir, bundleLib.FILE_NAME), bundle);
}

function writeFiles(base: string, id = ID, files: Record<string, string> = FILES) {
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(base, "models", id, ...name.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

const noRegistry = () => null;
const discover = (root: string | null, extra: Record<string, unknown> = {}) =>
  local.discoverLocalBundles(root, {
    env: {},
    readRegistry: noRegistry,
    portableDir: "",
    readBuildRoots: () => [],
    ...extra,
  });

describe("discoverLocalBundles: where a build is looked for", () => {
  it("lists the five sources in the D5 order, each real folder once", () => {
    const root = mk("root");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "friday" }));
    const registry = mk("setup-here");
    const v1 = mk("root", "installer", "installers", "1.2.5.7");
    const v2 = mk("root", "installer", "installers", "1.2.5.8");
    const v3 = mk("root", "installer", "installers", "1.2.5.10");
    const release = mk("root", "release");
    const portable = mk("portable");
    const built = mk("elsewhere");
    for (const dir of [registry, v1, v2, v3, release, portable, built]) writeBundle(dir);
    const found = local.discoverLocalBundles(root, {
      env: {},
      appVersion: "1.2.5.8",
      readRegistry: (keyPath: string, name: string) =>
        keyPath === "HKCU\\Software\\FRIDAY" && name === "InstallSourceDir" ? registry : null,
      portableDir: portable,
      readBuildRoots: () => [{ root: built, kind: "staging" }],
    });
    expect(found.map((f: { origin: string }) => f.origin)).toEqual([
      "install-source",
      "installers",
      "installers",
      "installers",
      "release",
      "portable",
      "build-root",
    ]);
    expect(found.map((f: { dir: string }) => f.dir)).toEqual([
      registry,
      v2,
      v3,
      v1,
      release,
      portable,
      built,
    ]);
    expect(found[0].bundle.schema).toBe(1);
  });

  it("returns [] with FRIDAY_LOCAL_BUNDLES=0, with useLocalBuilds=false and with the stored setting off", () => {
    const root = mk("root");
    const source = mk("src");
    writeBundle(source);
    const on = { readRegistry: () => source };
    expect(discover(root, on)).toHaveLength(1);
    expect(discover(root, { ...on, env: { FRIDAY_LOCAL_BUNDLES: "0" } })).toEqual([]);
    expect(discover(root, { ...on, useLocalBuilds: false })).toEqual([]);
    mk("root", "config");
    fs.writeFileSync(
      path.join(root, "config", "friday-preferences.json"),
      JSON.stringify({ toggles: { installUseLocalBuilds: false } }),
    );
    expect(discover(root, on)).toEqual([]);
    // An explicit true wins over nothing stored, and a damaged file is read as the default (on).
    fs.writeFileSync(path.join(root, "config", "friday-preferences.json"), "{ not json");
    expect(discover(root, on)).toHaveLength(1);
  });

  it("counts a folder only when its friday-bundle.json parses and validates", () => {
    const root = mk("root");
    const empty = mk("empty");
    const broken = mk("broken");
    fs.writeFileSync(path.join(broken, bundleLib.FILE_NAME), "{ not json");
    const invalid = mk("invalid");
    fs.writeFileSync(path.join(invalid, bundleLib.FILE_NAME), JSON.stringify({ schema: 1 }));
    const good = mk("good");
    writeBundle(good);
    const found = discover(root, {
      readBuildRoots: () =>
        [empty, broken, invalid, good].map((d) => ({ root: d, kind: "staging" })),
    });
    expect(found.map((f: { dir: string }) => f.dir)).toEqual([good]);
  });

  it("looks in <root>/release only when the root is a checkout", () => {
    const root = mk("root");
    writeBundle(mk("root", "release"));
    expect(discover(root)).toEqual([]);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "someone-else" }));
    expect(discover(root)).toEqual([]);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "friday" }));
    expect(discover(root).map((f: { origin: string }) => f.origin)).toEqual(["release"]);
  });

  it("compares folders case-insensitively after realpath, so one folder is listed once", () => {
    const root = mk("root");
    const real = mk("one-real-folder");
    writeBundle(real);
    const link = path.join(tmp, "link-to-it");
    fs.symlinkSync(real, link, "dir");
    const upper = {
      ...fs,
      realpathSync: Object.assign((p: string) => fs.realpathSync(p), {
        native: (p: string) =>
          p === real ? fs.realpathSync.native(p).toUpperCase() : fs.realpathSync.native(p),
      }),
    };
    const found = local.discoverLocalBundles(root, {
      env: {},
      fs: upper,
      readRegistry: () => real,
      portableDir: link,
      readBuildRoots: () => [{ root: real.toLowerCase() === real ? real : real, kind: "staging" }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].origin).toBe("install-source");
  });

  it("reads the recorded build roots from the staged-assets pointer", () => {
    const root = mk("root");
    const appdata = mk("appdata");
    const built = mk("built");
    writeBundle(built);
    staged.recordBuildRoot(built, { kind: "checkout", env: { APPDATA: appdata } });
    const found = local.discoverLocalBundles(root, {
      env: { APPDATA: appdata },
      readRegistry: noRegistry,
      portableDir: "",
    });
    expect(found.map((f: { origin: string; dir: string }) => [f.origin, f.dir])).toEqual([
      ["build-root", built],
    ]);
  });

  it("never reaches reg.exe off Windows and survives a registry reader that throws", () => {
    expect(
      local.defaultReadRegistry("HKCU\\Software\\FRIDAY", "InstallSourceDir", {
        platform: "linux",
      }),
    ).toBeNull();
    const found = discover(mk("root"), {
      readRegistry: () => {
        throw new Error("no registry");
      },
    });
    expect(found).toEqual([]);
  });
});

describe("planLocalModel: which pinned model a bundle can serve", () => {
  function setup(models: ModelRow[] = [modelRow()], files: Record<string, string> = FILES) {
    const root = mk("root");
    const built = mk("built");
    writeFiles(built, ID, files);
    writeBundle(built, bundleOf(models));
    const bundles = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    return { root, built, bundles };
  }
  const plan = (s: { root: string; bundles: unknown[] }, extra: Record<string, unknown> = {}) =>
    local.planLocalModel({
      bundles: s.bundles,
      installRoot: s.root,
      modelId: ID,
      pinFiles: pinList,
      ...extra,
    });

  it("uses a bundle model that holds exactly the pinned files with matching bytes", () => {
    const s = setup();
    const found = plan(s);
    expect(found.origin).toBe("build-root");
    expect(found.via).toBe("models");
    expect(found.files.map((f: { name: string }) => f.name).sort()).toEqual(
      Object.keys(FILES).sort(),
    );
    for (const f of found.files) expect(f.parts[0].path.startsWith(s.built)).toBe(true);
  });

  it("lets the config pin win: a bundle that lists other hashes is not usable, even when its files are whole", () => {
    const other = { ...FILES, "model.bin": "ABCDEFGHIJ" };
    const s = setup([modelRow(other)], other);
    expect(plan(s)).toBeNull();
    const extra = [...pinList.slice(0, 2)];
    const s2 = setup();
    expect(plan(s2, { pinFiles: extra })).toBeNull();
    expect(plan(s2, { pinFiles: [] })).toBeNull();
  });

  it("checks the bytes on disk with bundleFilesMatch (deep) and by size alone with deep off", () => {
    const bad = { ...FILES, "model.bin": "XXXXXXXXXX" };
    const s = setup([modelRow()], bad);
    expect(plan(s)).toBeNull();
    // Same size, other bytes: only the streaming copy (hash against the pin) can tell, so the plan allows it.
    expect(plan(s, { deep: false })).not.toBeNull();
    fs.rmSync(path.join(s.built, "models", ID, "config.json"));
    expect(plan(s, { deep: false })).toBeNull();
  });

  it("never offers the install root's own model folder as a source", () => {
    const root = mk("root");
    writeFiles(root);
    writeBundle(root);
    const bundles = discover(root, { readBuildRoots: () => [{ root, kind: "checkout" }] });
    expect(bundles).toHaveLength(1);
    expect(
      local.planLocalModel({ bundles, installRoot: root, modelId: ID, pinFiles: pinList }),
    ).toBeNull();
  });

  it("serves a model from a local pack: parts in order, tag must match, every part must be there", () => {
    const root = mk("root");
    const built = mk("built");
    const packDir = mk("built", "installer", "packs", TAG);
    const releasePlan = {
      tag: TAG,
      files: Object.entries(FILES).map(([name, text]) => {
        const file = `friday-test--${name.replace(/\//g, "-")}`;
        const half = Math.ceil(text.length / 2);
        const parts = text.length > 4 ? [text.slice(0, half), text.slice(half)] : [text];
        return {
          name,
          file,
          bytes: text.length,
          sha256: sha(text),
          parts: parts.map((p, i) => ({
            file: parts.length > 1 ? `${file}.part00${i + 1}` : file,
            bytes: p.length,
            url: "x",
          })),
          _parts: parts,
        };
      }),
    };
    for (const f of releasePlan.files) {
      f.parts.forEach((p, i) => fs.writeFileSync(path.join(packDir, p.file), f._parts[i]!));
    }
    const pack = {
      id: "voice-weights",
      tag: TAG,
      revision: "2026.1.1",
      location: "local",
      dir: `installer/packs/${TAG}`,
    };
    writeBundle(built, bundleOf([], [pack]));
    const bundles = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    const found = local.planLocalModel({
      bundles,
      installRoot: root,
      modelId: ID,
      pinFiles: pinList,
      releasePlan,
    });
    expect(found.via).toBe("pack");
    const bin = found.files.find((f: { name: string }) => f.name === "model.bin");
    expect(bin.parts.map((p: { path: string }) => path.basename(p.path))).toEqual([
      "friday-test--model.bin.part001",
      "friday-test--model.bin.part002",
    ]);
    expect(
      local.planLocalModel({
        bundles,
        installRoot: root,
        modelId: ID,
        pinFiles: pinList,
        releasePlan: { ...releasePlan, tag: "friday-voice-weights-2026.9.9" },
      }),
    ).toBeNull();
    fs.rmSync(path.join(packDir, "friday-test--model.bin.part002"));
    expect(
      local.planLocalModel({
        bundles,
        installRoot: root,
        modelId: ID,
        pinFiles: pinList,
        releasePlan,
      }),
    ).toBeNull();
  });
});

describe("the source order of the chain", () => {
  const releaseManifest = {
    pack: "friday-models",
    tag: TAG,
    repository: "o/r",
    partBytes: 1_900_000_000,
    assets: Object.entries(FILES).map(([name, text]) => ({
      fridayId: ID,
      path: name,
      file: `friday-test--${name.replace(/\//g, "-")}`,
      sha256: sha(text),
      bytes: text.length,
      parts: 1,
      from: { pin: REPO, file: name, recipe: "copy", recipeVersion: 1 },
    })),
  };
  const baseDeps = (extra: Record<string, unknown> = {}) => ({
    pinForRepo: (name: string) => (name === REPO ? PIN : null),
    hub: { engineMode: () => "own", isBroken: () => false },
    env: {},
    fridayModels: releaseManifest,
    modelId: ID,
    ...extra,
  });
  const sources = [{ kind: "hf-repo", repo: REPO, label: "Hugging Face" }];

  it("puts local-bundle before friday-release before the official source", () => {
    const root = mk("root");
    const built = mk("built");
    writeFiles(built);
    writeBundle(built);
    const bundles = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    const chain = weights.withFridayRelease(
      sources,
      baseDeps({ localBundles: bundles, installRoot: root }),
    );
    expect(chain.map((s: { kind: string }) => s.kind)).toEqual([
      "local-bundle",
      "friday-release",
      "hf-repo",
    ]);
    expect(chain[0].label).toBe("local build");
    expect(chain[2]).toBe(sources[0]);
  });

  it("adds nothing without a bundle, with the setting off, or when the bundle's hashes differ from the pin", () => {
    expect(
      weights.withFridayRelease(sources, baseDeps()).map((s: { kind: string }) => s.kind),
    ).toEqual(["friday-release", "hf-repo"]);
    expect(
      weights
        .withFridayRelease(sources, baseDeps({ localBundles: [] }))
        .map((s: { kind: string }) => s.kind),
    ).toEqual(["friday-release", "hf-repo"]);
    const root = mk("root");
    const built = mk("built");
    const other = { ...FILES, "model.bin": "ABCDEFGHIJ" };
    writeFiles(built, ID, other);
    writeBundle(built, bundleOf([modelRow(other)]));
    const bundles = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    expect(
      weights
        .withFridayRelease(sources, baseDeps({ localBundles: bundles, installRoot: root }))
        .map((s: { kind: string }) => s.kind),
    ).toEqual(["friday-release", "hf-repo"]);
  });
});

describe("downloadModel copies from a local build before it downloads", () => {
  const releaseManifest = () => ({
    pack: "friday-models",
    tag: TAG,
    repository: "o/r",
    partBytes: 4,
    assets: Object.entries(FILES).map(([name, text]) => ({
      fridayId: ID,
      path: name,
      file: `friday-test--${name.replace(/\//g, "-")}`,
      sha256: sha(text),
      bytes: text.length,
      parts: Math.max(1, Math.ceil(text.length / 4)),
      from: { pin: REPO, file: name, recipe: "copy", recipeVersion: 1 },
    })),
  });

  /** A fake network: the release holds `release`, the official source holds FILES. Returns the URLs asked. */
  function network(release: Record<string, string> | null) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: { method?: string } = {}) => {
        const url = String(input);
        urls.push(url);
        const reply = (text: string | undefined) =>
          text === undefined
            ? new Response(null, { status: 404 })
            : new Response(init.method === "HEAD" ? null : text, {
                status: 200,
                headers: { "content-length": String(Buffer.byteLength(text)) },
              });
        if (url.startsWith(BASE))
          return reply(release ? release[decodeURIComponent(url.slice(BASE.length))] : undefined);
        if (url.includes("/api/models/"))
          return new Response(
            JSON.stringify({ siblings: Object.keys(FILES).map((rfilename) => ({ rfilename })) }),
            { status: 200 },
          );
        const name = decodeURIComponent(
          url.split("/resolve/")[1]!.split("/").slice(1).join("/").split("?")[0]!,
        );
        return reply(FILES[name]);
      }),
    );
    return urls;
  }

  const wholeRelease = (): Record<string, string> => ({
    "friday-test--config.json": "{}",
    "friday-test--model.bin.part001": "0123",
    "friday-test--model.bin.part002": "4567",
    "friday-test--model.bin.part003": "89",
    "friday-test--onnx-head.onnx": "head",
  });

  let modelsDir = "";
  let installRoot = "";
  beforeEach(() => {
    installRoot = mk("friday");
    modelsDir = mk("friday", "models");
  });
  const folder = () => path.join(modelsDir, ID);
  const job = () => ({
    modelId: ID,
    dir: modelsDir,
    sources: [{ kind: "hf-repo", repo: REPO, label: "Hugging Face" }],
  });
  const deps = (extra: Record<string, unknown> = {}) => ({
    pinForRepo: (name: string) => (name === REPO ? PIN : null),
    hub: { engineMode: () => "own", isBroken: () => false },
    env: {},
    fridayModels: releaseManifest(),
    ...extra,
  });
  const found = (...built: string[]) =>
    discover(installRoot, {
      readBuildRoots: () => built.map((b) => ({ root: b, kind: "staging" })),
    });

  it("copies the pinned files, records local-bundle in the source note and touches no network", async () => {
    const built = mk("built");
    writeFiles(built);
    writeBundle(built);
    const urls = network(null);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ localBundles: found(built) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("local-bundle");
    expect(result.servedFrom).toBe("local build");
    expect(urls).toEqual([]);
    for (const [name, text] of Object.entries(FILES))
      expect(fs.readFileSync(path.join(folder(), ...name.split("/")), "utf8")).toBe(text);
    expect(pins.readMarker(folder())?.revision).toBe(PIN.revision);
    const note = JSON.parse(fs.readFileSync(`${folder()}.source.json`, "utf8"));
    expect(note).toMatchObject({
      source: "local build",
      kind: "local-bundle",
      pinRevision: PIN.revision,
    });
    expect(weights.servedSource(folder(), PIN)).toBe("local build");
    // The build is only read: every file is still there, and the stage is gone.
    for (const [name, text] of Object.entries(FILES))
      expect(fs.readFileSync(path.join(built, "models", ID, ...name.split("/")), "utf8")).toBe(
        text,
      );
    expect(fs.existsSync(path.join(folder(), ".cache", "local-bundle"))).toBe(false);
    expect(pins.unexpectedFiles(folder(), PIN)).toEqual([]);
  });

  it("joins the .partNNN files of a local pack into the pinned file", async () => {
    const built = mk("built");
    const packDir = mk("built", "installer", "packs", TAG);
    for (const [name, text] of Object.entries(wholeRelease()))
      fs.writeFileSync(path.join(packDir, name), text);
    const pack = {
      id: "voice-weights",
      tag: TAG,
      revision: "2026.1.1",
      location: "local",
      dir: `installer/packs/${TAG}`,
    };
    writeBundle(built, bundleOf([], [pack]));
    const urls = network(null);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ localBundles: found(built) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("local-bundle");
    expect(fs.readFileSync(path.join(folder(), "model.bin"), "utf8")).toBe("0123456789");
    expect(urls).toEqual([]);
    expect(fs.existsSync(path.join(packDir, "friday-test--model.bin.part002"))).toBe(true);
    expect(fs.existsSync(path.join(folder(), ".cache", "local-bundle"))).toBe(false);
  });

  it("falls to the FRIDAY release when a local file has the right size but the wrong bytes, and leaves the build alone", async () => {
    const built = mk("built");
    const bad = { ...FILES, "model.bin": "XXXXXXXXXX" };
    writeFiles(built, ID, bad);
    // The bundle claims the pinned hash for the bad file, so only the copy's SHA-256 check can catch it.
    writeBundle(built, bundleOf([modelRow()]));
    const urls = network(wholeRelease());
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ localBundles: found(built) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("friday-release");
    expect(result.servedFrom).toBe("FRIDAY release");
    expect(result.attempts[0].source).toBe("local build");
    expect(result.attempts[0].error).toMatch(/checksum/i);
    expect(fs.readFileSync(path.join(folder(), "model.bin"), "utf8")).toBe("0123456789");
    expect(urls.some((u) => u.startsWith(BASE))).toBe(true);
    expect(fs.readFileSync(path.join(built, "models", ID, "model.bin"), "utf8")).toBe("XXXXXXXXXX");
    expect(fs.existsSync(path.join(folder(), ".cache", "local-bundle"))).toBe(false);
    expect(weights.servedSource(folder(), PIN)).toBe("FRIDAY release");
  });

  it("falls to the official source when there is no release either", async () => {
    const built = mk("built");
    writeFiles(built, ID, { ...FILES, "model.bin": "XXXXXXXXXX" });
    writeBundle(built);
    network(null);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ localBundles: found(built) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(result.servedFrom).toBe("official source");
    expect(fs.readFileSync(path.join(folder(), "model.bin"), "utf8")).toBe("0123456789");
  });

  it("never overwrites a folder that already verifies and never deletes the build", async () => {
    const built = mk("built");
    writeFiles(built);
    writeBundle(built);
    mk("friday", "models", ID);
    writeFiles(installRoot);
    const marker = path.join(folder(), "config.json");
    const before = fs.statSync(marker).mtimeMs;
    network(null);
    const result = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ localBundles: found(built) }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).not.toBe("local-bundle");
    expect(fs.statSync(marker).mtimeMs).toBe(before);
    expect(fs.existsSync(path.join(built, "models", ID, "model.bin"))).toBe(true);
    expect(fs.existsSync(`${folder()}.source.json`)).toBe(false);
  });

  it("discovers the build itself from the install root, and is off with useLocalBuilds=false", async () => {
    const dir = mk("friday", "installer", "installers", "1.2.5.8");
    writeFiles(installRoot);
    // The installed copy of the build holds the model beside its bundle (a Setup folder with the models next to it).
    fs.rmSync(path.join(installRoot, "models", ID), { recursive: true, force: true });
    writeFiles(dir);
    writeBundle(dir);
    const urls = network(wholeRelease());
    const off = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({ useLocalBuilds: false, readRegistry: noRegistry, portableDir: "" }),
    );
    expect(off.ok, JSON.stringify(off)).toBe(true);
    expect(off.via).toBe("friday-release");
    expect(urls.length).toBeGreaterThan(0);
    fs.rmSync(folder(), { recursive: true, force: true });
    fs.rmSync(`${folder()}.source.json`, { force: true });
    const on = await download.downloadModel(
      job(),
      undefined,
      undefined,
      deps({
        useLocalBuilds: true,
        readRegistry: noRegistry,
        portableDir: "",
        appVersion: "1.2.5.8",
      }),
    );
    expect(on.ok, JSON.stringify(on)).toBe(true);
    expect(on.via).toBe("local-bundle");
  });
});

describe("FRIDAY Core: the local build is the first road to a file", () => {
  const BYTES = "core-weights!";
  const file = {
    kind: "model",
    disk: "friday-core-t1.gguf",
    bytes: BYTES.length,
    sha256: sha(BYTES),
    upstream: { repo: "o/r", revision: "a".repeat(40), file: "m.gguf" },
  };
  const manifest = {
    schemaVersion: 1,
    diskDir: "models/friday-core",
    mirrors: [
      { id: "friday-models", kind: "release", repository: "o/r", tagPrefix: "friday-models-" },
      { id: "upstream", kind: "upstream" },
    ],
    variants: [{ id: "t1", fridayName: "T1", role: "default", files: [file] }],
  };

  it("lists a local-bundle road before the release and upstream ones, and none without a build", () => {
    const root = mk("root");
    const built = mk("built");
    const dir = path.join(built, "models", "friday-core");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file.disk), BYTES);
    writeBundle(
      built,
      bundleOf([
        {
          fridayId: "friday-core",
          dir: "models/friday-core",
          files: [{ path: file.disk, bytes: BYTES.length, sha256: sha(BYTES) }],
        },
      ]),
    );
    const bundles = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    const plain = core.sourcesFor(manifest, file, null, "t1");
    expect(plain.map((s: { id: string }) => s.id)).toEqual(["upstream"]);
    const withLocal = core.sourcesFor(manifest, file, null, "t1", {
      localBundles: bundles,
      installRoot: root,
    });
    expect(withLocal.map((s: { id: string }) => s.id)).toEqual(["local-bundle", "upstream"]);
    expect(withLocal[0].local.parts[0].path).toBe(path.join(dir, file.disk));
    const planned = core.planAssets(root, "t1", {
      manifest,
      pack: null,
      localBundles: bundles,
      installRoot: root,
    });
    expect(planned.assets[0].sources[0].id).toBe("local-bundle");
    // A bundle with another hash for the same file is not a road: the pin wins.
    writeBundle(
      built,
      bundleOf([
        {
          fridayId: "friday-core",
          dir: "models/friday-core",
          files: [{ path: file.disk, bytes: BYTES.length, sha256: sha("other") }],
        },
      ]),
    );
    const other = discover(root, { readBuildRoots: () => [{ root: built, kind: "staging" }] });
    expect(
      core
        .sourcesFor(manifest, file, null, "t1", { localBundles: other, installRoot: root })
        .map((s: { id: string }) => s.id),
    ).toEqual(["upstream"]);
  });
});

describe("wiring", () => {
  it("the preference toggle exists, defaults on, and the chain reads the same key", () => {
    const text = fs.readFileSync(path.join(repoRoot, "src/lib/friday/preferences.ts"), "utf8");
    expect(text).toMatch(/installUseLocalBuilds: true/);
    expect(local.SETTING_TOGGLE).toBe("installUseLocalBuilds");
    expect(local.ENV_OFF).toBe("FRIDAY_LOCAL_BUNDLES");
  });
});

describe("discoverLocalBundles: a network path is never opened", () => {
  const recording = () => {
    const seen: string[] = [];
    const wrap =
      <T extends (...args: never[]) => unknown>(fn: T) =>
      (...args: Parameters<T>) => {
        seen.push(String(args[0]));
        return fn(...args);
      };
    const fake = {
      ...fs,
      statSync: wrap(fs.statSync.bind(fs)),
      realpathSync: Object.assign(wrap(fs.realpathSync.bind(fs)), {
        native: wrap(fs.realpathSync.native.bind(fs)),
      }),
      readFileSync: wrap(fs.readFileSync.bind(fs)),
      readdirSync: wrap(fs.readdirSync.bind(fs)),
    };
    return { fake, seen };
  };

  it.each([
    "\\\\fileserver\\share\\FRIDAY",
    "\\\\?\\UNC\\fileserver\\share\\FRIDAY",
    "//fileserver/share/FRIDAY",
  ])("refuses %s from the InstallSourceDir registry value without any disk call", (value) => {
    const { fake, seen } = recording();
    const found = discover(mk("root"), { fs: fake, readRegistry: () => value });
    expect(found).toEqual([]);
    expect(seen.filter((entry) => entry.includes("fileserver"))).toEqual([]);
  });

  it("refuses a UNC portable folder and a UNC recorded build root the same way", () => {
    const { fake, seen } = recording();
    const found = discover(mk("root"), {
      fs: fake,
      portableDir: "\\\\fileserver\\share",
      readBuildRoots: () => [{ root: "\\\\fileserver\\builds" }],
    });
    expect(found).toEqual([]);
    expect(seen.filter((entry) => entry.includes("fileserver"))).toEqual([]);
  });

  it("still takes a local folder from the registry", () => {
    const dir = mk("src");
    writeBundle(dir);
    const found = discover(mk("root"), { readRegistry: () => dir });
    expect(found.map((entry: { origin: string }) => entry.origin)).toEqual(["install-source"]);
  });
});
