/**
 * The local build road end to end, the way Setup leaves it: a registry `InstallSourceDir` that names the placed folder
 * `<root>/installer/installers/<version>`, and a download that must work with the network gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const local = req("../../electron/local-sources.cjs");
const bundleLib = req("../../electron/build-bundle.cjs");
const download = req("../../electron/model-download.cjs");
const pins = req("../../electron/voice-pins.cjs");

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const REPO = "test/pinned-e2e";
const ID = "friday-e2e";
const VERSION = "1.2.5.8";
const FILES: Record<string, string> = { "config.json": "{}", "model.bin": "0123456789" };
const PIN = {
  revision: "d".repeat(40),
  files: Object.fromEntries(
    Object.entries(FILES).map(([name, text]) => [name, { sha256: sha(text), bytes: text.length }]),
  ),
};
const pinList = Object.entries(PIN.files).map(([name, row]) => ({ path: name, ...row }));

let tmp = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-discovery-e2e-"));
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

function writeBundle(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const bundle = bundleLib.build({
    product: "FRIDAY",
    channel: "stable",
    version: VERSION,
    commit: null,
    caller: "cmd",
    app: [{ name: `FRIDAY-Setup-${VERSION}.exe`, kind: "installer", bytes: 3, sha256: sha("exe") }],
    inExe: { builtins: { sha256: sha("b") }, wheelhouse: null },
    packs: [],
    models: [
      {
        fridayId: ID,
        dir: `models/${ID}`,
        files: Object.entries(FILES).map(([name, text]) => ({
          path: name,
          bytes: text.length,
          sha256: sha(text),
        })),
      },
    ],
  });
  bundleLib.write(path.join(dir, bundleLib.FILE_NAME), bundle);
}

function writeFiles(base: string, files: Record<string, string> = FILES) {
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(base, "models", ID, ...name.split("/"));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

const discover = (root: string, registry: string | null, extra: Record<string, unknown> = {}) =>
  local.discoverLocalBundles(root, {
    env: {},
    readRegistry: () => registry,
    portableDir: "",
    readBuildRoots: () => [],
    appVersion: VERSION,
    ...extra,
  });
const planFor = (bundles: unknown[], installRoot: string) =>
  local.planLocalModel({ bundles, installRoot, modelId: ID, pinFiles: pinList });

describe("Setup started from the placed folder (only InstallSourceDir is known)", () => {
  it("serves a different install root from the models three levels above the placed folder", () => {
    const srcRoot = mk("src-root");
    const placed = mk("src-root", "installer", "installers", VERSION);
    writeFiles(srcRoot);
    writeBundle(placed);
    const installRoot = mk("other-root");
    const found = discover(installRoot, placed);
    expect(found.map((f: { origin: string }) => f.origin)).toEqual(["install-source"]);
    const plan = planFor(found, installRoot);
    expect(plan).not.toBeNull();
    expect(plan.via).toBe("models");
    for (const file of plan.files) expect(file.parts[0].path.startsWith(srcRoot)).toBe(true);
  });

  it("recognises the placed folder whatever the letter case, and never hops from any other folder", () => {
    const srcRoot = mk("src-root");
    const placed = mk("src-root", "Installer", "Installers", VERSION);
    writeFiles(srcRoot);
    writeBundle(placed);
    const installRoot = mk("other-root");
    expect(planFor(discover(installRoot, placed), installRoot)).not.toBeNull();

    const loose = mk("loose", "setup", "files");
    writeBundle(loose);
    writeFiles(path.join(tmp, "loose"));
    expect(planFor(discover(installRoot, loose), installRoot)).toBeNull();
  });

  it("copies the model into the new root through downloadModel with the network gone", async () => {
    const srcRoot = mk("src-root");
    const placed = mk("src-root", "installer", "installers", VERSION);
    writeFiles(srcRoot);
    writeBundle(placed);
    const installRoot = mk("other-root");
    const modelsDir = mk("other-root", "models");
    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", offline);
    const result = await download.downloadModel(
      {
        modelId: ID,
        dir: modelsDir,
        sources: [{ kind: "hf-repo", repo: REPO, label: "official" }],
      },
      undefined,
      undefined,
      {
        pinForRepo: (name: string) => (name === REPO ? PIN : null),
        hub: { engineMode: () => "own", isBroken: () => false },
        env: {},
        readRegistry: () => placed,
        portableDir: "",
        readBuildRoots: () => [],
        appVersion: VERSION,
      },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("local-bundle");
    expect(offline).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(installRoot, "models", ID, "model.bin"), "utf8")).toBe(
      FILES["model.bin"],
    );
  });
});

describe("downloadModel with the network gone", () => {
  let installRoot = "";
  let modelsDir = "";
  let folder = "";
  let offline: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    installRoot = mk("friday");
    modelsDir = mk("friday", "models");
    folder = path.join(modelsDir, ID);
    offline = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", offline);
  });
  const run = (extra: Record<string, unknown> = {}) =>
    download.downloadModel(
      {
        modelId: ID,
        dir: modelsDir,
        sources: [{ kind: "hf-repo", repo: REPO, label: "official" }],
      },
      undefined,
      undefined,
      {
        pinForRepo: (name: string) => (name === REPO ? PIN : null),
        hub: { engineMode: () => "own", isBroken: () => false },
        env: {},
        readRegistry: () => null,
        portableDir: "",
        readBuildRoots: () => [],
        appVersion: VERSION,
        ...extra,
      },
    );
  const bundleCopy = () => {
    const built = mk("built");
    writeFiles(built);
    writeBundle(built);
    return built;
  };
  const install = (files: Record<string, string> = FILES) => writeFiles(installRoot, files);

  it("returns a complete certified folder without any network listing", async () => {
    install();
    pins.writeMarker(folder, REPO, PIN);
    const result = await run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("hf-repo");
    expect(offline).not.toHaveBeenCalled();
  });

  it("certifies a complete folder that has no marker yet, still with no network", async () => {
    install();
    expect(pins.readMarker(folder)).toBeNull();
    const result = await run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(offline).not.toHaveBeenCalled();
    expect(pins.readMarker(folder)?.revision).toBe(PIN.revision);
  });

  it("repairs a same-size corrupt file from an intact local build and leaves verified files alone", async () => {
    const built = bundleCopy();
    install({ ...FILES, "model.bin": "XXXXXXXXXX" });
    const config = path.join(folder, "config.json");
    const before = fs.statSync(config).mtimeMs;
    const result = await run({
      localBundles: discover(installRoot, null, {
        readBuildRoots: () => [{ root: built, kind: "staging" }],
      }),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("local-bundle");
    expect(fs.readFileSync(path.join(folder, "model.bin"), "utf8")).toBe(FILES["model.bin"]);
    expect(fs.statSync(config).mtimeMs).toBe(before);
    expect(offline).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(built, "models", ID, "model.bin"), "utf8")).toBe(
      FILES["model.bin"],
    );
  });

  it("does not trust an old marker over a file written after it was made", async () => {
    const built = bundleCopy();
    install();
    pins.writeMarker(folder, REPO, PIN);
    const bad = path.join(folder, "model.bin");
    fs.writeFileSync(bad, "XXXXXXXXXX");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(bad, later, later);
    const result = await run({
      localBundles: discover(installRoot, null, {
        readBuildRoots: () => [{ root: built, kind: "staging" }],
      }),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.via).toBe("local-bundle");
    expect(fs.readFileSync(bad, "utf8")).toBe(FILES["model.bin"]);
  });

  it("keeps a folder that does not verify and has no local copy honest: not ok, nothing invented", async () => {
    install({ ...FILES, "model.bin": "XXXXXXXXXX" });
    const result = await run();
    expect(result.ok).toBe(false);
  });
});
