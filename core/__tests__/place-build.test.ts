/**
 * Placing a CMD build in the FRIDAY folder (scripts/place-build.cjs): the release outputs are copied to
 * <root>/installer/installers/<version>/ as <file>.part, checked by size then SHA-256 and renamed; a same-version
 * folder with equal hashes is left alone; other versions are never touched; the FRIDAY packs are opt-in.
 * Hermetic: temp folders, an injected spawn and a wrapped fs; no network, no clock, no registry, no real pack build.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const place = req("../../scripts/place-build.cjs");
const bundleLib = req("../../electron/build-bundle.cjs");
const pipeline = req("../../scripts/build-pipeline.cjs");

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const VERSION = "1.2.5.8";

let tmp = "";
let root = "";
let release = "";

const FILES: Record<string, string> = {
  [`FRIDAY-Setup-${VERSION}.exe`]: "setup bytes ".repeat(40),
  [`FRIDAY-Portable-${VERSION}.exe`]: "portable bytes ".repeat(30),
  [`FRIDAY-Setup-${VERSION}.exe.blockmap`]: "blockmap",
  "latest.yml": "version: 1.2.5\n",
  "SHA256SUMS.txt": "sums\n",
};

function kindOf(name: string) {
  if (/blockmap$/.test(name)) return "blockmap";
  if (name === "latest.yml") return "latest";
  if (name === "SHA256SUMS.txt") return "sums";
  return /Portable/.test(name) ? "portable" : "installer";
}

/** A release folder as release-manifest.cjs leaves it: the files, the bundle record and the update manifest. */
function makeRelease(dir: string, files: Record<string, string> = FILES) {
  nodeFs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files))
    nodeFs.writeFileSync(path.join(dir, name), text);
  const bundle = bundleLib.build({
    product: "FRIDAY",
    channel: "stable",
    version: VERSION,
    commit: null,
    caller: "cmd",
    app: Object.entries(files).map(([name, text]) => ({
      name,
      kind: kindOf(name),
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
    })),
    inExe: { builtins: { sha256: sha("builtins") }, wheelhouse: null },
    packs: [],
    models: [],
  });
  bundleLib.write(path.join(dir, "friday-bundle.json"), bundle);
  const bundleText = nodeFs.readFileSync(path.join(dir, "friday-bundle.json"));
  nodeFs.writeFileSync(
    path.join(dir, "friday-update.json"),
    JSON.stringify({
      version: VERSION,
      assets: [],
      bundle: { name: "friday-bundle.json", bytes: bundleText.length, sha256: sha(bundleText) },
    }),
  );
  return bundle;
}

const placed = () => path.join(root, "installer", "installers", VERSION);

/** A fs that records the order of copy and rename calls and can corrupt a copy. */
function spyFs(
  options: { corrupt?: (to: string) => boolean; failRename?: (to: string) => boolean } = {},
) {
  const calls: string[] = [];
  const wrapped = {
    ...nodeFs,
    copyFileSync(from: string, to: string, ...rest: unknown[]) {
      calls.push(`copy ${path.basename(to)}`);
      (nodeFs.copyFileSync as (...a: unknown[]) => void)(from, to, ...rest);
      if (options.corrupt?.(to)) nodeFs.appendFileSync(to, "X");
    },
    renameSync(from: string, to: string) {
      calls.push(`rename ${path.basename(from)} -> ${path.basename(to)}`);
      if (options.failRename?.(to)) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      nodeFs.renameSync(from, to);
    },
  };
  return { fs: wrapped, calls };
}

beforeEach(() => {
  tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), "friday-place-"));
  root = path.join(tmp, "FRIDAY");
  release = path.join(tmp, "checkout", "release");
  nodeFs.mkdirSync(root, { recursive: true });
  makeRelease(release);
});
afterEach(() => nodeFs.rmSync(tmp, { recursive: true, force: true }));

const run = (extra: Record<string, unknown> = {}) =>
  place.placeBuild({ root, releaseDir: release, caller: "cmd", env: {}, ...extra });

describe("placing the release outputs", () => {
  it("copies every output as <file>.part, then renames it, and never writes a final name before the rename", () => {
    const spy = spyFs();
    const result = run({ fs: spy.fs });
    expect(result.status).toBe("placed");
    expect(result.dir).toBe(placed());
    const names = [...Object.keys(FILES), "friday-bundle.json", "friday-update.json"];
    for (const name of names) {
      const copy = spy.calls.indexOf(`copy ${name}.part`);
      const rename = spy.calls.indexOf(`rename ${name}.part -> ${name}`);
      expect(copy, name).toBeGreaterThanOrEqual(0);
      expect(rename, name).toBeGreaterThan(copy);
      expect(spy.calls.filter((c) => c === `copy ${name}`)).toHaveLength(0);
      expect(
        nodeFs
          .readFileSync(path.join(placed(), name))
          .equals(nodeFs.readFileSync(path.join(release, name))),
      ).toBe(true);
    }
    expect(nodeFs.readdirSync(placed()).filter((n) => n.endsWith(".part"))).toEqual([]);
    expect(result.files.every((f: { result: string }) => f.result === "copied")).toBe(true);
  });

  it("verifies the .part (size, then SHA-256) before it renames: a bad copy is refused, nothing is renamed", () => {
    const spy = spyFs({ corrupt: (to) => to.endsWith("latest.yml.part") });
    const result = run({ fs: spy.fs });
    expect(result.status).toBe("failed");
    expect(String(result.reason)).toContain("latest.yml");
    expect(spy.calls.filter((c) => c.startsWith("rename "))).toEqual([]);
    expect(nodeFs.existsSync(path.join(placed(), "latest.yml"))).toBe(false);
    expect(nodeFs.readdirSync(placed()).filter((n) => n.endsWith(".part"))).toEqual([]);
    expect(nodeFs.existsSync(path.join(root, "installer", "manifests", "local-build.json"))).toBe(
      false,
    );
  });

  it("refuses a release file that no longer matches its friday-bundle.json record", () => {
    nodeFs.writeFileSync(path.join(release, "latest.yml"), "version: 9.9.9\n");
    const result = run();
    expect(result.status).toBe("failed");
    expect(String(result.reason)).toContain("latest.yml");
    expect(nodeFs.existsSync(placed())).toBe(false);
  });

  it("skips a same-version folder whose files already have equal hashes: no copy, no rename", () => {
    expect(run().status).toBe("placed");
    const before = nodeFs.statSync(path.join(placed(), "latest.yml")).mtimeMs;
    const spy = spyFs();
    const again = run({ fs: spy.fs });
    expect(again.status).toBe("placed");
    expect(spy.calls.filter((c) => !c.includes("local-build"))).toEqual([]);
    expect(again.files.every((f: { result: string }) => f.result === "same")).toBe(true);
    expect(again.unchanged).toBe(true);
    expect(nodeFs.statSync(path.join(placed(), "latest.yml")).mtimeMs).toBe(before);
  });

  it("replaces a differing file only after its .part verified; a bad copy leaves the old file whole", () => {
    nodeFs.mkdirSync(placed(), { recursive: true });
    nodeFs.writeFileSync(path.join(placed(), "latest.yml"), "old\n");
    const bad = run({ fs: spyFs({ corrupt: (to) => to.endsWith(".part") }).fs });
    expect(bad.status).toBe("failed");
    expect(nodeFs.readFileSync(path.join(placed(), "latest.yml"), "utf8")).toBe("old\n");

    const good = run();
    expect(good.status).toBe("placed");
    expect(nodeFs.readFileSync(path.join(placed(), "latest.yml"), "utf8")).toBe(
      FILES["latest.yml"],
    );
    expect(good.files.find((f: { name: string }) => f.name === "latest.yml").result).toBe(
      "replaced",
    );
  });

  it("a locked file (rename refused) keeps the old copy and leaves no .part behind", () => {
    nodeFs.mkdirSync(placed(), { recursive: true });
    nodeFs.writeFileSync(path.join(placed(), "latest.yml"), "old\n");
    const result = run({ fs: spyFs({ failRename: (to) => to.endsWith("latest.yml") }).fs });
    expect(result.status).toBe("failed");
    expect(nodeFs.readFileSync(path.join(placed(), "latest.yml"), "utf8")).toBe("old\n");
    expect(nodeFs.readdirSync(placed()).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("never deletes or touches another version, nor a file it does not own", () => {
    const other = path.join(root, "installer", "installers", "1.0.0.0");
    nodeFs.mkdirSync(other, { recursive: true });
    nodeFs.writeFileSync(path.join(other, "FRIDAY-Setup-1.0.0.0.exe"), "older release");
    nodeFs.mkdirSync(placed(), { recursive: true });
    nodeFs.writeFileSync(path.join(placed(), "notes-by-owner.txt"), "mine");
    expect(run().status).toBe("placed");
    expect(nodeFs.readFileSync(path.join(other, "FRIDAY-Setup-1.0.0.0.exe"), "utf8")).toBe(
      "older release",
    );
    expect(nodeFs.readFileSync(path.join(placed(), "notes-by-owner.txt"), "utf8")).toBe("mine");
  });

  it("writes installer/manifests/local-build.json {schema:1, version, dir, bundleSha256}", () => {
    expect(run().status).toBe("placed");
    const pointer = JSON.parse(
      nodeFs.readFileSync(path.join(root, "installer", "manifests", "local-build.json"), "utf8"),
    );
    const bundle = bundleLib.read(path.join(release, "friday-bundle.json"));
    expect(pointer).toEqual({
      schema: 1,
      version: VERSION,
      dir: `installer/installers/${VERSION}`,
      bundleSha256: bundleLib.hashOf(bundle),
    });
    expect(
      nodeFs
        .readdirSync(path.join(root, "installer", "manifests"))
        .filter((n) => /\.(tmp|part)$/.test(n)),
    ).toEqual([]);
  });

  it("is skipped with a reason when there is no friday-bundle.json or a file is missing", () => {
    nodeFs.rmSync(path.join(release, "friday-bundle.json"));
    const none = run();
    expect(none.status).toBe("skipped");
    expect(none.reason).toMatch(/friday-bundle\.json/);
    nodeFs.rmSync(release, { recursive: true });
    makeRelease(release);
    nodeFs.rmSync(path.join(release, "friday-update.json"));
    expect(run().status).toBe("skipped");
  });
});

describe("when placing is skipped", () => {
  it.each([
    ["FRIDAY_PLACE_BUILD=0", { FRIDAY_PLACE_BUILD: "0" }, "cmd", /FRIDAY_PLACE_BUILD=0/],
    ["CI", { CI: "true" }, "cmd", /CI/],
    ["GitHub Actions", { GITHUB_ACTIONS: "true" }, "cmd", /CI/],
    ["the release caller", {}, "release", /CMD build only/],
    ["the test caller", {}, "test", /CMD build only/],
    ["the npm caller", {}, "npm", /CMD build only/],
  ])("%s: nothing is copied, no folder is made", (_name, env, caller, reason) => {
    const result = run({ env, caller });
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(reason);
    expect(nodeFs.existsSync(path.join(root, "installer"))).toBe(false);
  });

  it("the table row is PASS <dir> after a placement and SKIP <reason> otherwise, and it is not a 14th phase", () => {
    const row = place.rowFor({
      status: "placed",
      dir: "D:\\FRIDAY\\installer\\installers\\1.2.5.8",
      unchanged: false,
    });
    expect(row).toMatchObject({ name: "placed", status: "ok" });
    expect(row.detail).toContain("installers");
    const skip = place.rowFor({ status: "skipped", reason: "FRIDAY_PLACE_BUILD=0" });
    expect(skip).toMatchObject({ name: "placed", status: "skipped" });
    expect(skip.detail).toBe("skipped: FRIDAY_PLACE_BUILD=0");
    const lines = pipeline
      .readySummary(
        pipeline.parseArgs(["node", "x", "--caller", "cmd"]),
        { ok: true, phases: [{ name: "package", status: "ok", detail: "done" }, row] },
        root,
        { readdirSync: () => [], statSync: () => ({ size: 0 }), existsSync: () => false },
      )
      .join("\n");
    expect(lines).toMatch(/PASS placed\s+D:/);
    expect(lines).toContain("FRIDAY BUILD READY");
    expect(pipeline.PHASES).toHaveLength(13);
    expect(pipeline.PHASES).not.toContain("placed");
  });
});

describe("the FRIDAY packs are opt-in", () => {
  const plan = [
    {
      pack: "voice-weights",
      tag: "friday-voice-weights-2026.11.1",
      models: ["a", "b"],
      partBytes: 10,
      assets: {},
    },
  ];

  it("are off by default: nothing is spawned unless FRIDAY_BUILD_PACKS=1", () => {
    expect(place.packsRequested({})).toBe(false);
    expect(place.packsRequested({ FRIDAY_BUILD_PACKS: "0" })).toBe(false);
    expect(place.packsRequested({ FRIDAY_BUILD_PACKS: "1" })).toBe(true);
    const spawned: unknown[] = [];
    const result = place.buildPacks({
      root,
      projectRoot: path.join(tmp, "checkout"),
      env: {},
      plan,
      spawn: (...a: unknown[]) => (spawned.push(a), { status: 0 }),
    });
    expect(result.status).toBe("skipped");
    expect(spawned).toEqual([]);
    expect(nodeFs.existsSync(path.join(root, "installer"))).toBe(false);
  });

  it("builds one model at a time into <root>/installer/packs/<tag>/ through build-friday-models.cjs", () => {
    const spawned: { args: string[] }[] = [];
    const result = place.buildPacks({
      root,
      projectRoot: path.join(tmp, "checkout"),
      env: { FRIDAY_BUILD_PACKS: "1" },
      plan,
      spawn: (_cmd: string, args: string[]) => (spawned.push({ args }), { status: 0 }),
    });
    expect(result.status).toBe("built");
    // Two one-model runs, then the pack's final metadata run over both (see "the pack metadata describes every model").
    expect(spawned).toHaveLength(3);
    const out = path.join(root, "installer", "packs", "friday-voice-weights-2026.11.1");
    spawned.slice(0, 2).forEach((call, i) => {
      expect(call.args[0]).toMatch(/build-friday-models\.cjs$/);
      expect(call.args).toEqual(
        expect.arrayContaining(["--pack", "voice-weights", "--out", out, "--only", ["a", "b"][i]]),
      );
    });
  });

  it("does not rebuild a model whose part files are already there, and keeps going after a failed one", () => {
    const out = path.join(root, "installer", "packs", plan[0]!.tag);
    nodeFs.mkdirSync(out, { recursive: true });
    nodeFs.writeFileSync(path.join(out, "a--m.bin"), "0123456789");
    const withAssets = [
      {
        ...plan[0]!,
        assets: { a: [{ file: "a--m.bin", bytes: 10 }], b: [{ file: "b--m.bin", bytes: 4 }] },
      },
    ];
    const spawned: string[] = [];
    const result = place.buildPacks({
      root,
      projectRoot: path.join(tmp, "checkout"),
      env: { FRIDAY_BUILD_PACKS: "1" },
      plan: withAssets,
      spawn: (_c: string, args: string[]) => (
        spawned.push(args[args.indexOf("--only") + 1]!),
        { status: 1 }
      ),
    });
    expect(spawned).toEqual(["b"]);
    expect(result.status).toBe("failed");
    expect(result.notes.join(" ")).toMatch(/b/);
  });

  it("is skipped on CI and when the FRIDAY folder is inside the checkout (the tool needs --out outside the repository)", () => {
    const base = { plan, spawn: () => ({ status: 0 }) };
    const ci = place.buildPacks({
      root,
      projectRoot: repoRoot,
      env: { FRIDAY_BUILD_PACKS: "1", CI: "1" },
      ...base,
    });
    expect(ci.status).toBe("skipped");
    const inside = place.buildPacks({
      root: path.join(repoRoot, ".friday-dev"),
      projectRoot: repoRoot,
      env: { FRIDAY_BUILD_PACKS: "1" },
      ...base,
    });
    expect(inside.status).toBe("skipped");
    expect(inside.reason).toMatch(/outside the repository/);
  });

  it("plans from the real packs of config/friday-models.json (a pure read: no download)", () => {
    const real = place.planPacks();
    expect(real.length).toBeGreaterThanOrEqual(3);
    for (const row of real) {
      expect(row.tag).toMatch(/^friday-[a-z-]+-\d{4}\.\d+\.\d+$/);
      expect(row.models.length).toBeGreaterThan(0);
    }
    expect(new Set(real.map((r: { pack: string }) => r.pack)).size).toBe(real.length);
  });
});

describe("the CMD chain keeps its shape", () => {
  const read = (file: string) => nodeFs.readFileSync(path.join(repoRoot, file), "utf8");

  it("the pipeline still counts build N/13 and places only after the whole run, for the CMD caller", () => {
    const source = read("scripts/build-pipeline.cjs");
    expect(source).toContain("build ${index + 1}/${phases.length}: ${phase}");
    expect(source).toContain("place-build.cjs");
    expect(pipeline.PHASES).toHaveLength(13);
  });

  it("prefetch-models records the build root on every run and builds packs only through the opt-in hook", () => {
    const source = read("scripts/prefetch-models.cjs");
    // The staging folder is still recorded as before (staged-assets.test.ts pins recordStaging); any other root is a build root.
    expect(source).toContain(
      'if (picked.development) require("../electron/staged-assets.cjs").recordStaging(picked.root);',
    );
    expect(source).toContain('recordBuildRoot(picked.root, { kind: "checkout" })');
    expect(source).toContain("place-build.cjs");
    expect(source).not.toMatch(/build-friday-models/);
  });

  it("config/cmd-chain-lock.json matches the files it locks (node scripts/workflow-lock.cjs --cmd-chain --write)", () => {
    const lock = req("../../scripts/workflow-lock.cjs");
    expect(lock.compare(lock.readChainLock(), lock.currentChain())).toEqual([]);
  });

  it("place-build.cjs is ASCII text and reads the bundle record only through the one shared module", () => {
    const source = read("scripts/place-build.cjs");
    expect(/[^\u0000-\u007f]/.test(source)).toBe(false);
    expect(source).toContain('require("../electron/build-bundle.cjs")');
    expect(source).not.toMatch(/JSON\.parse\([^)]*friday-bundle/);
  });
});

describe("the installed app finds the placed build where local-sources looks (D5)", () => {
  const sources = req("../../electron/local-sources.cjs");
  const discover = (target: string, extra: Record<string, unknown> = {}) =>
    sources.discoverLocalBundles(target, {
      env: {},
      readRegistry: () => null,
      portableDir: null,
      readBuildRoots: () => [],
      useLocalBuilds: true,
      fs: nodeFs,
      ...extra,
    });

  it("leaves friday-bundle.json inside installer/installers/<version>/, found as origin `installers`", () => {
    expect(run().status).toBe("placed");
    expect(nodeFs.existsSync(path.join(placed(), "friday-bundle.json"))).toBe(true);
    const found = discover(root, { appVersion: VERSION });
    expect(found).toHaveLength(1);
    expect(found[0].origin).toBe("installers");
    expect(path.resolve(found[0].dir)).toBe(path.resolve(placed()));
    expect(found[0].bundle.version).toBe(VERSION);
  });

  it("the placed copy is the same record as the release one, so the app and the build agree", () => {
    run();
    const here = bundleLib.read(path.join(placed(), "friday-bundle.json"));
    const there = bundleLib.read(path.join(release, "friday-bundle.json"));
    expect(bundleLib.hashOf(here)).toBe(bundleLib.hashOf(there));
  });

  it("local-build.json names the folder and the version discoverLocalBundles takes as appVersion", () => {
    run();
    const pointer = JSON.parse(
      nodeFs.readFileSync(path.join(root, "installer", "manifests", "local-build.json"), "utf8"),
    );
    const found = discover(root, { appVersion: pointer.version });
    expect(found[0].origin).toBe("installers");
    expect(path.resolve(root, ...pointer.dir.split("/"))).toBe(path.resolve(found[0].dir));
    expect(bundleLib.hashOf(found[0].bundle)).toBe(pointer.bundleSha256);
  });

  it("a checkout root also finds its own release/ folder (D5 step 3), after the placed copy", () => {
    const checkout = path.join(tmp, "checkout");
    nodeFs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "friday" }));
    const result = place.placeBuild({
      root: checkout,
      releaseDir: path.join(checkout, "release"),
      caller: "cmd",
      env: {},
    });
    expect(result.status).toBe("placed");
    const found = discover(checkout, { appVersion: VERSION });
    expect(found.map((f: { origin: string }) => f.origin)).toEqual(["installers", "release"]);
    expect(path.resolve(found[1].dir)).toBe(path.resolve(checkout, "release"));
  });
});

describe("a CMD build whose root is the checkout leaves nothing untracked", () => {
  const ignore = nodeFs
    .readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim());

  it("ignores installer/installers, installer/manifests and installer/packs only", () => {
    for (const folder of ["installers", "manifests", "packs"])
      expect(ignore, folder).toContain(`/installer/${folder}/`);
  });

  it("keeps the installer sources tracked: no rule hides the folder or its source subfolders", () => {
    expect(ignore).not.toContain("installer");
    expect(ignore).not.toContain("/installer/");
    expect(ignore).not.toContain("/installer/*");
    for (const source of ["build", "first-run", "migration", "setup", "uninstall"])
      expect(ignore.some((line) => line === `/installer/${source}/`)).toBe(false);
  });
});

describe("the pack metadata describes every model, not only the last one built", () => {
  const plan = [
    {
      pack: "voice-weights",
      tag: "friday-voice-weights-2026.11.1",
      models: ["a", "b", "c"],
      partBytes: 10,
      assets: {},
    },
  ];
  const base = { projectRoot: path.join(tmp, "checkout"), env: { FRIDAY_BUILD_PACKS: "1" } };
  const onlyOf = (args: string[]) => args[args.indexOf("--only") + 1]!;

  it("runs the pack's final manifest build once, after every per-model run, with every model that is present", () => {
    const spawned: string[][] = [];
    const result = place.buildPacks({
      root,
      ...base,
      projectRoot: path.join(tmp, "checkout"),
      plan,
      spawn: (_c: string, args: string[]) => (spawned.push(args), { status: 0 }),
    });
    expect(result.status).toBe("built");
    expect(spawned.map(onlyOf)).toEqual(["a", "b", "c", "a,b,c"]);
    const last = spawned[spawned.length - 1]!;
    const out = path.join(root, "installer", "packs", plan[0]!.tag);
    expect(last).toEqual(
      expect.arrayContaining(["--pack", "voice-weights", "--out", out, "--only", "a,b,c"]),
    );
  });

  it("lists only the models that exist when one failed, and says the pack is incomplete", () => {
    const spawned: string[][] = [];
    const result = place.buildPacks({
      root,
      ...base,
      plan,
      spawn: (_c: string, args: string[]) => (
        spawned.push(args),
        { status: onlyOf(args) === "b" ? 1 : 0 }
      ),
    });
    expect(spawned.map(onlyOf)).toEqual(["a", "b", "c", "a,c"]);
    expect(result.status).toBe("failed");
  });

  it("runs no final build when nothing was built in this run, or when no model exists", () => {
    const spawned: string[][] = [];
    const none = place.buildPacks({
      root,
      ...base,
      plan,
      spawn: (_c: string, args: string[]) => (spawned.push(args), { status: 1 }),
    });
    expect(spawned.map(onlyOf)).toEqual(["a", "b", "c"]);
    expect(none.status).toBe("failed");
  });

  it("a failed final build is reported, never thrown", () => {
    const result = place.buildPacks({
      root,
      ...base,
      plan,
      spawn: (_c: string, args: string[]) => ({ status: onlyOf(args).includes(",") ? 1 : 0 }),
    });
    expect(result.status).toBe("failed");
    expect(result.notes.join(" ")).toMatch(/metadata|SHA256SUMS|manifest/i);
  });

  it("is a pure ordering: the real build is never run from a test", () => {
    const tool = nodeFs.readFileSync(path.join(repoRoot, "scripts", "prefetch-models.cjs"), "utf8");
    expect(tool).not.toMatch(/build-friday-models/);
  });
});

describe("a requested but skipped pack build says so (packsNote)", () => {
  it("is silent unless FRIDAY_BUILD_PACKS=1, and a SKIP line with the reason when it was skipped", () => {
    const skipped = {
      status: "skipped",
      reason:
        "the FRIDAY folder is inside the source checkout; the pack tool needs --out outside the repository",
      notes: [],
    };
    expect(place.packsNote(skipped, {})).toEqual([]);
    const lines = place.packsNote(skipped, { FRIDAY_BUILD_PACKS: "1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[friday\] SKIP {5}packs: .*inside the source checkout/);
  });

  it("names a failure and its notes, and says nothing for a clean build", () => {
    const env = { FRIDAY_BUILD_PACKS: "1" };
    const failed = place.packsNote(
      { status: "failed", reason: "a pack model was not built", notes: ["x: b was not built"] },
      env,
    );
    expect(failed.join("\n")).toMatch(/packs: a pack model was not built/);
    expect(failed.join("\n")).toContain("x: b was not built");
    expect(place.packsNote({ status: "built", notes: [] }, env)).toEqual([]);
  });

  it("prefetch-models prints those lines after the opt-in hook and still never fails setup for them", () => {
    const source = nodeFs.readFileSync(
      path.join(repoRoot, "scripts", "prefetch-models.cjs"),
      "utf8",
    );
    expect(source).toMatch(/packsNote\(\s*packs\.buildPacks\(\{ root: picked\.root \}\)\s*\)/);
    expect(source.indexOf("packsNote(")).toBeLessThan(source.indexOf("finish(lines.length"));
  });
});
