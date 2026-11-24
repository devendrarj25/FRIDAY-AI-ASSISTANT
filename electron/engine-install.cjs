/**
 * Engine installs: the two kinds of optional engine the Install Manager downloads on demand, each verified against
 * the digest the official source published and each installed NEXT TO the old copy, then swapped, so a failed
 * install leaves what worked untouched.
 *
 *  1. Release-zip engines (llama.cpp, stable-diffusion.cpp, FFmpeg LGPL build): the zips are chosen by the measured
 *     facts, downloaded and checked (`vendor-sources.downloadVerified`), unpacked into
 *     `<FRIDAY_ROOT>/runtime/engines/<name>/<tag>-<variant>.staging`, started once as a health check, and only then
 *     renamed into place. A build that does not start is removed and the next step down is tried (CUDA, Vulkan,
 *     CPU), the reason kept in `.friday-engine.json`. The old tag folder stays as the rollback.
 *  2. Pinned wheels (the CUDA runtime pair, the ONNX Runtime variants): pip downloads each wheel against its
 *     SHA-256 (`--require-hashes`) before anything installed is touched, a conflicting variant is removed only then,
 *     and a failed install puts the previous versions back. The CUDA pair lands in the FRIDAY Python environment
 *     where `kernel/stt.py` looks for it (`nvidia.cublas`, `nvidia.cudnn`), never in the EXE.
 *
 * Everything is injected (download, unpack, health, pip, clock, disk, the governor's `run`), so every rule is tested
 * without a network, a GPU or Windows. Heavy steps go through `deps.run(kind, fn)`: downloads in the download lane,
 * unpack, swap and pip installs in the install lane of the resource governor.
 */
"use strict";

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const vendor = require("./vendor-sources.cjs");
const llama = require("./llama-runtime.cjs");

const MARKER = ".friday-engine.json";
const DISK_FACTOR = 1.3;
/** Zip size to unpacked size, rounded up: the downloaded zip, its copy on disk, and the unpacked files. */
const UNPACK_FACTOR = 2.5;

class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

const safeName = (text) => String(text || "release").replace(/[^A-Za-z0-9._-]/g, "_");
const passthrough = (_kind, fn) => fn();
const rmrf = (fsApi, target) => {
  try {
    fsApi.rmSync(target, { recursive: true, force: true });
  } catch {
    /* a leftover staging folder is removed on the next attempt */
  }
};

/* ------------------------------------------------------------ the engines */

const GIB = 1024 ** 3;

/** stable-diffusion.cpp names (patterns from the release list, unverified on a live release; digests are read at install). */
const SD_CPU = {
  avx512: [/-bin-win-avx512-x64\.zip$/i, /-bin-win-avx2-x64\.zip$/i],
  avx2: [/-bin-win-avx2-x64\.zip$/i],
  plain: [/-bin-win-avx-x64\.zip$/i, /-bin-win-noavx-x64\.zip$/i],
  cpu: [/-bin-win-avx2-x64\.zip$/i, /-bin-win-noavx-x64\.zip$/i],
};

function sdPlan(entry, assets) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.name && a.url);
  const named = (re) => list.find((a) => /^sd-/i.test(a.name) && re.test(a.name));
  let zips = [];
  let variant = entry.variant;
  if (entry.backend === "cuda") {
    const main = named(/-bin-win-cuda12-x64\.zip$/i);
    if (!main) return { ok: false, reason: "this release has no CUDA 12 build" };
    const rt = list.find((a) => /^cudart-.*(?:cuda12|cu12).*x64\.zip$/i.test(a.name));
    zips = rt ? [main, rt] : [main];
    variant = "cuda12";
  } else if (entry.backend === "vulkan") {
    const hit = named(/-bin-win-vulkan-x64\.zip$/i);
    if (!hit) return { ok: false, reason: "this release has no Vulkan build" };
    zips = [hit];
  } else {
    const hit = (SD_CPU[entry.variant] || SD_CPU.cpu).map(named).find(Boolean);
    if (!hit) return { ok: false, reason: "this release has no CPU build for Windows" };
    zips = [hit];
    variant = /-bin-win-(avx512|avx2|noavx|avx)-/i.exec(hit.name)?.[1]?.toLowerCase() || "cpu";
  }
  const bare = zips.find((z) => !/^[a-f0-9]{64}$/.test(z.sha256 || ""));
  if (bare) return { ok: false, reason: `the release published no SHA-256 for ${bare.name}` };
  return {
    ok: true,
    zips: zips.map((z) => ({ name: z.name, url: z.url, bytes: z.bytes || 0, sha256: z.sha256 })),
    variant,
  };
}

const FFMPEG_LGPL = /^ffmpeg-(?:n\d[\d.]*|master)-latest-win64-lgpl-shared(?:-\d[\d.]*)?\.zip$/i;

/** The LGPL shared build (a separate process, never linked): the numbered release over master, digest from the asset or checksums.sha256. */
async function ffmpegPlan(_entry, assets, ctx = {}) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a && a.name && a.url);
  const builds = list.filter((a) => FFMPEG_LGPL.test(a.name));
  const pick = builds.find((a) => /^ffmpeg-n/i.test(a.name)) || builds[0];
  if (!pick) return { ok: false, reason: "this release has no LGPL shared build for Windows" };
  let sha256 = pick.sha256 || "";
  if (!sha256) {
    const sums = list.find((a) => /^checksums?\.sha256$/i.test(a.name));
    if (sums && typeof ctx.fetchText === "function") {
      try {
        sha256 = vendor.hashFromSums(await ctx.fetchText(sums.url), pick.name) || "";
      } catch {
        sha256 = "";
      }
    }
  }
  if (!/^[a-f0-9]{64}$/.test(sha256))
    return { ok: false, reason: `no SHA-256 was published for ${pick.name}` };
  return {
    ok: true,
    zips: [{ name: pick.name, url: pick.url, bytes: pick.bytes || 0, sha256 }],
    variant: "lgpl-shared",
  };
}

/** The release `config/local-runners.json` pins for setup (the CPU zip and its SHA-256), as a chain's last source. */
let pinMemo;
function llamaPin() {
  if (pinMemo !== undefined) return pinMemo;
  pinMemo = null;
  try {
    const file = require("./resource-paths.cjs").readConfigJson("local-runners.json", null);
    const release = file?.value?.runners?.find((r) => r.id === "llamacpp")?.release;
    if (
      release?.tag &&
      release.asset &&
      release.url &&
      /^[a-f0-9]{64}$/.test(release.sha256 || "")
    ) {
      pinMemo = {
        kind: "pinned",
        version: String(release.tag).replace(/^b/, ""),
        tag: release.tag,
        assets: [
          {
            name: release.asset,
            url: release.url,
            bytes: Number(release.bytes) || 0,
            sha256: release.sha256,
          },
        ],
      };
    }
  } catch {
    pinMemo = null;
  }
  return pinMemo;
}

const ENGINES = Object.freeze({
  "llama.cpp": {
    id: "llama.cpp",
    label: "llama.cpp",
    dirName: "llama.cpp",
    binNames: process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"],
    healthArgs: ["--version"],
    depth: 2,
    chain: (facts, options) => llama.backendChain(facts, options),
    plan: (entry, assets) => llama.planAssets(entry, assets),
    sources: [
      { kind: "github-api", repo: llama.LLAMA_REPO, strip: "^b" },
      { kind: "github-atom", repo: llama.LLAMA_REPO, strip: "^b" },
    ],
    // The pinned CPU zip the setup path verifies (config/local-runners.json): the last source.
    get pinned() {
      return llamaPin();
    },
  },
  "stable-diffusion.cpp": {
    id: "stable-diffusion.cpp",
    label: "stable-diffusion.cpp",
    dirName: "stable-diffusion.cpp",
    binNames: process.platform === "win32" ? ["sd-cli.exe", "sd.exe"] : ["sd-cli", "sd"],
    healthArgs: ["--help"],
    depth: 2,
    chain: (facts, options) => llama.backendChain(facts, options),
    plan: sdPlan,
    sources: [
      { kind: "github-api", repo: "leejet/stable-diffusion.cpp", strip: "^master-" },
      { kind: "github-atom", repo: "leejet/stable-diffusion.cpp", strip: "^master-" },
    ],
    pinned: null,
  },
  "FFmpeg (LGPL, portable)": {
    id: "FFmpeg (LGPL, portable)",
    label: "FFmpeg (LGPL shared build)",
    dirName: "ffmpeg",
    binNames: process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"],
    healthArgs: ["-version"],
    depth: 3,
    chain: () => ({ chain: [{ backend: "cpu", variant: "lgpl-shared" }], skipped: [] }),
    plan: ffmpegPlan,
    sources: [
      { kind: "github-api", repo: "BtbN/FFmpeg-Builds" },
      { kind: "github-atom", repo: "BtbN/FFmpeg-Builds" },
    ],
    pinned: null,
  },
});

const engineBase = (root, spec) => nodePath.join(root, "runtime", "engines", spec.dirName);
const installersDir = (root, spec) => nodePath.join(root, "runtime", "installers", spec.dirName);

/** The source chain of an engine row for `vendor.resolveLatest` (live sources, then the pin when it has one). */
const engineSources = (spec) => [...spec.sources, ...(spec.pinned ? [spec.pinned] : [])];

/** The version a row shows for a release: FFmpeg's from its asset name (the tag is "latest"), the rest from the tag. */
function engineVersion(spec, answer) {
  if (spec.id.startsWith("FFmpeg")) {
    const hit = (answer?.assets || []).find((a) => FFMPEG_LGPL.test(a.name));
    const m = hit ? /^ffmpeg-n?(\d[\d.]*)/i.exec(hit.name) : null;
    if (m) return m[1].replace(/\.$/, "");
  }
  return String(answer?.version || "");
}

/** A release usable for an install: the chain's own answer when it carries assets, else the pin (said so). */
function releaseForInstall(spec, answer) {
  if (answer?.ok && Array.isArray(answer.assets) && answer.assets.length > 0 && !answer.pinned) {
    return {
      ...answer,
      version: engineVersion(spec, answer),
      source: answer.source || "github-api",
      usedPin: false,
    };
  }
  if (spec.pinned) {
    return {
      version: spec.pinned.version,
      tag: spec.pinned.tag,
      assets: spec.pinned.assets,
      source: "pinned",
      usedPin: true,
      ok: true,
    };
  }
  return {
    ok: false,
    error: answer?.error || "no official source listed this release's files, and none is pinned",
  };
}

/** The active engine: the first folder, in install order (see `llama.orderedFolders`), that holds one of its binaries. */
function detectEngine(root, spec, fsApi = nodeFs) {
  if (!root) return { installed: false };
  const base = engineBase(root, spec);
  for (const { name, dir, marker } of llama.orderedFolders(base, fsApi)) {
    const bin = llama.walk(dir, spec.depth, (file) => spec.binNames.includes(file.toLowerCase()));
    if (!bin) continue;
    return {
      installed: true,
      path: bin,
      version: marker?.version || name.replace(/^(?:b|master-)/i, "").replace(/-.*$/, ""),
      backend: marker?.backend || null,
      variant: marker?.variant || null,
      tag: marker?.tag || name,
      fellBack: Array.isArray(marker?.fellBack) ? marker.fellBack : [],
    };
  }
  return { installed: false };
}

/**
 * Keep the newest `keep` installs (the active one and one rollback) and remove the rest. The folder in use and every
 * name in `protect` (the one just installed) are never removed, whatever their name sorts like.
 */
function pruneOld(root, spec, keep = 2, fsApi = nodeFs, protect = []) {
  const base = engineBase(root, spec);
  const ordered = llama.orderedFolders(base, fsApi);
  const active = detectEngine(root, spec, fsApi);
  const activeName = active.installed
    ? nodePath.relative(base, active.path).split(nodePath.sep)[0]
    : null;
  const safe = new Set([activeName, ...protect].filter(Boolean));
  const gone = ordered
    .slice(keep)
    .map((f) => f.name)
    .filter((name) => !safe.has(name));
  for (const name of gone) rmrf(fsApi, nodePath.join(base, name));
  return gone;
}

/**
 * Install the best build of a release-zip engine, falling back one step at a time. Never throws. The old install is
 * only ever replaced by a copy that started.
 *
 * @param input { release: { version, tag, assets, source }, facts, computeCap }
 * @param deps  { download(url, dest, {sha256, source}), extract(zip, dest) -> {ok, error}, health(bin, args) -> {ok, reason},
 *               fetchText(url), diskFree(dir) -> bytes|null, run(kind, fn), emit(line), now(), fs }
 */
async function installEngine(root, spec, input, deps = {}) {
  const fsApi = deps.fs || nodeFs;
  const run = deps.run || passthrough;
  const say = deps.emit || (() => {});
  const now = deps.now || Date.now;
  const release = input?.release;
  if (!root) return { ok: false, error: "no FRIDAY folder is selected", attempts: [] };
  if (!release?.assets?.length) {
    return { ok: false, error: release?.error || "the release lists no files", attempts: [] };
  }
  const tag = safeName(release.tag || release.version);
  const base = engineBase(root, spec);
  const { chain, skipped } = spec.chain(input.facts, input);
  const attempts = skipped.map((s) => ({
    backend: s.backend,
    ok: false,
    stage: "skipped",
    reason: s.reason,
  }));

  for (const entry of chain) {
    const planned = await spec.plan(entry, release.assets, { fetchText: deps.fetchText });
    if (!planned.ok) {
      attempts.push({ backend: entry.backend, ok: false, stage: "plan", reason: planned.reason });
      continue;
    }
    // The vendor's digest and the catalogue's pin must agree for the same file; a disagreement is refused.
    const pinned = spec.pinned?.assets || [];
    const clash = planned.zips
      .map((z) => {
        const pin = pinned.find((p) => p.name === z.name);
        return pin
          ? vendor.agreeOnDigest(
              { version: spec.pinned.version, sha256: pin.sha256 },
              { version: release.version, sha256: z.sha256 },
            )
          : { ok: true };
      })
      .find((r) => !r.ok);
    if (clash) {
      attempts.push({ backend: entry.backend, ok: false, stage: "digest", reason: clash.error });
      continue;
    }
    const need = planned.zips.reduce((sum, z) => sum + (z.bytes || 0), 0) * UNPACK_FACTOR;
    const free = typeof deps.diskFree === "function" ? deps.diskFree(root) : null;
    if (need > 0 && free !== null && free < need * DISK_FACTOR) {
      attempts.push({
        backend: entry.backend,
        ok: false,
        stage: "disk",
        reason: `needs about ${(need / GIB).toFixed(1)} GB free, ${(free / GIB).toFixed(1)} GB is`,
      });
      continue;
    }

    const final = `${tag}-${safeName(planned.variant)}`;
    const staging = nodePath.join(base, `${final}.staging`);
    const target = nodePath.join(base, final);
    try {
      rmrf(fsApi, staging);
      fsApi.mkdirSync(staging, { recursive: true });
      for (const zip of planned.zips) {
        const file = nodePath.join(
          installersDir(root, spec),
          safeName(nodePath.basename(zip.name)),
        );
        say(`downloading ${zip.name}`);
        const got = await run("download", () =>
          vendor.downloadVerified(
            [{ url: zip.url, sha256: zip.sha256, source: release.source || "official" }],
            { download: deps.download, dest: file, fs: fsApi },
          ),
        );
        if (!got.ok) throw new StageError("download", got.error);
        say(`unpacking ${zip.name}`);
        const out = await run("install", () => deps.extract(file, staging));
        if (!out?.ok) throw new StageError("unpack", out?.error || "the zip could not be unpacked");
      }
      const bin = llama.walk(staging, spec.depth, (name) =>
        spec.binNames.includes(name.toLowerCase()),
      );
      if (!bin) throw new StageError("unpack", `the zips hold no ${spec.binNames[0]}`);
      say(`checking that ${nodePath.basename(bin)} starts`);
      const health = await deps.health(bin, spec.healthArgs);
      if (!health.ok) throw new StageError("health", health.reason || "it did not start");
    } catch (error) {
      rmrf(fsApi, staging);
      attempts.push({
        backend: entry.backend,
        variant: planned.variant,
        ok: false,
        stage: error instanceof StageError ? error.stage : "install",
        reason: String(error?.message || error).slice(0, 240),
      });
      say(`${entry.backend} build failed (${attempts.at(-1).reason}); trying the next step`);
      continue;
    }

    // The new copy started: swap it in next to the old one, with the previous folder kept for a rollback.
    const fellBack = attempts
      .filter((a) => !a.ok)
      .map((a) => ({ backend: a.backend, stage: a.stage, reason: a.reason }));
    const marker = {
      id: spec.id,
      tag: release.tag || release.version,
      version: String(release.version),
      backend: entry.backend,
      variant: planned.variant,
      source: release.source || null,
      pinnedRelease: Boolean(release.usedPin),
      installedAt: now(),
      files: planned.zips.map((z) => ({ name: z.name, sha256: z.sha256 })),
      fellBack,
    };
    const prev = `${target}.prev`;
    try {
      fsApi.writeFileSync(nodePath.join(staging, MARKER), JSON.stringify(marker, null, 2));
      rmrf(fsApi, prev);
      const hadOld = fsApi.existsSync(target);
      if (hadOld) fsApi.renameSync(target, prev);
      try {
        fsApi.renameSync(staging, target);
      } catch (error) {
        if (hadOld) fsApi.renameSync(prev, target);
        throw error;
      }
      rmrf(fsApi, prev);
    } catch (error) {
      rmrf(fsApi, staging);
      attempts.push({
        backend: entry.backend,
        ok: false,
        stage: "swap",
        reason: String(error?.message || error).slice(0, 240),
      });
      continue;
    }
    pruneOld(root, spec, 2, fsApi, [final]);
    const found = detectEngine(root, spec, fsApi);
    return {
      ok: true,
      id: spec.id,
      ...marker,
      bin: found.path || null,
      attempts: [...attempts, { backend: entry.backend, ok: true, stage: "installed" }],
    };
  }
  const why = attempts
    .filter((a) => !a.ok)
    .map((a) => `${a.backend}: ${a.reason}`)
    .join("; ");
  return {
    ok: false,
    error: `${spec.label} was not installed (${why || "no build fits"}); the previous install is untouched`,
    attempts,
  };
}

/** Remove every copy of an engine under its own folder. Returns whether anything was removed. */
function uninstallEngine(root, spec, fsApi = nodeFs) {
  if (!root) return false;
  const base = engineBase(root, spec);
  const rel = nodePath.relative(nodePath.join(root, "runtime", "engines"), base);
  if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) return false;
  const existed = fsApi.existsSync(base);
  rmrf(fsApi, base);
  return existed;
}

/* ------------------------------------------------------------ pinned wheels */

const PINNED_WHEELS = Object.freeze({
  "nvidia-cublas-cu12": {
    version: "12.9.2.10",
    assets: [
      {
        name: "nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl",
        bytes: 553162896,
        sha256: "623f43027d40d44ceadf0043f002bd25cf353e8f13ce90b9a87057019f560661",
      },
    ],
  },
  "nvidia-cudnn-cu12": {
    version: "9.28.1.4",
    assets: [
      {
        name: "nvidia_cudnn_cu12-9.28.1.4-py3-none-win_amd64.whl",
        bytes: 696300805,
        sha256: "3467aafa9b260e6adf5fbbfc0e21d180133305b42032aa1160be2d3142bb8b09",
      },
    ],
  },
  onnxruntime: {
    version: "1.32.0",
    assets: [
      {
        name: "onnxruntime-1.32.0-cp311-cp311-win_amd64.whl",
        bytes: 16695880,
        sha256: "d7e0c45cc5f456ad7805e6dd256a7662736cda9c2fd17becae194eb3c2f6df72",
      },
      {
        name: "onnxruntime-1.32.0-cp312-cp312-win_amd64.whl",
        bytes: 16698767,
        sha256: "efe7456952c243a05a53d5b8732953625144642c2f3989094277f6217f0c0c40",
      },
      {
        name: "onnxruntime-1.32.0-cp313-cp313-win_amd64.whl",
        bytes: 16697937,
        sha256: "c7f9aa98036ba2a47aa041a4a8c6d0a1f7bfe1bde44c131dcd15ce334f2f148d",
      },
      {
        name: "onnxruntime-1.32.0-cp314-cp314-win_amd64.whl",
        bytes: 17123630,
        sha256: "2b08ee990d00ab2ee129c5e039f7339963335a4d76f5bd22bfb4f896ae1cec0a",
      },
    ],
  },
  "onnxruntime-directml": {
    version: "1.24.4",
    assets: [
      {
        name: "onnxruntime_directml-1.24.4-cp311-cp311-win_amd64.whl",
        bytes: 25106000,
        sha256: "96642a787e5a6f33bf043521c0f06eb1eb663f6b830e5862a2026d03f9c90543",
      },
      {
        name: "onnxruntime_directml-1.24.4-cp312-cp312-win_amd64.whl",
        bytes: 25111930,
        sha256: "f2ecb68b7b7b259d2ef3112ae760149f9b5a1e7c0fbb73d539da6250a648a614",
      },
      {
        name: "onnxruntime_directml-1.24.4-cp313-cp313-win_amd64.whl",
        bytes: 25112253,
        sha256: "2f1031cb2281e5b27cca9efe0b9399317c7286e4d226f7a79d4ab79bbd94d19e",
      },
      {
        name: "onnxruntime_directml-1.24.4-cp314-cp314-win_amd64.whl",
        bytes: 25571098,
        sha256: "51d86bb949488e572b00422f344990a4a81d982416d73b6c0e4ced2bcd423d19",
      },
    ],
  },
  "onnxruntime-gpu": {
    version: "1.32.0",
    assets: [
      {
        name: "onnxruntime_gpu-1.32.0-cp311-cp311-win_amd64.whl",
        bytes: 157763810,
        sha256: "eb141a4b6f49f76af1d0a7bcbc3ef7d55b63a8bcdb6ed0816765e1c20449a5f5",
      },
      {
        name: "onnxruntime_gpu-1.32.0-cp312-cp312-win_amd64.whl",
        bytes: 157765830,
        sha256: "d8bc5d7668872889d605c1e7253581e021db7dea41a142ad2ab78d6d96f3f289",
      },
      {
        name: "onnxruntime_gpu-1.32.0-cp313-cp313-win_amd64.whl",
        bytes: 157777759,
        sha256: "9e7b6b5772c5cd99be9c47dace5f0b2faf4608f6ab638cdc0bccc096405baaee",
      },
      {
        name: "onnxruntime_gpu-1.32.0-cp314-cp314-win_amd64.whl",
        bytes: 158530311,
        sha256: "03905e264ed72ac091b8b77acbfa7cc191cedf912c27c6fd26ee25e7b877b53b",
      },
    ],
  },
});

/**
 * Bundles of wheels that install together. `pythonSpecific` wheels carry a `cpXY` tag; `conflicts` share a module with
 * the bundle and are removed (after the new wheels downloaded and verified) so two never sit together.
 */
const PIP_BUNDLES = Object.freeze({
  "cuda-libs": {
    id: "CUDA runtime libraries",
    parts: [
      { dist: "nvidia-cublas-cu12", pythonSpecific: false },
      { dist: "nvidia-cudnn-cu12", pythonSpecific: false },
    ],
    conflicts: [],
    withDeps: false,
    verifyImport: "import nvidia.cublas, nvidia.cudnn",
  },
  "ort-cpu": {
    id: "ONNX Runtime",
    parts: [{ dist: "onnxruntime", pythonSpecific: true }],
    conflicts: ["onnxruntime-directml", "onnxruntime-gpu"],
    withDeps: true,
    verifyImport: "import onnxruntime",
  },
  "ort-directml": {
    id: "ONNX Runtime (DirectML)",
    parts: [{ dist: "onnxruntime-directml", pythonSpecific: true }],
    conflicts: ["onnxruntime", "onnxruntime-gpu"],
    withDeps: true,
    verifyImport: "import onnxruntime",
  },
  "ort-gpu": {
    id: "ONNX Runtime (GPU)",
    parts: [{ dist: "onnxruntime-gpu", pythonSpecific: true }],
    conflicts: ["onnxruntime", "onnxruntime-directml"],
    withDeps: true,
    verifyImport: "import onnxruntime",
  },
});

/** The sources of one wheel for `vendor.resolveLatest`: PyPI JSON, PyPI Simple, then the pinned wheels above. */
function wheelSources(dist) {
  const pin = PINNED_WHEELS[dist];
  return [
    { kind: "pypi-json", pkg: dist, platform: "win_amd64" },
    { kind: "pypi-simple", pkg: dist, platform: "win_amd64" },
    ...(pin ? [{ kind: "pinned", version: pin.version, assets: pin.assets }] : []),
  ];
}

/**
 * The requirement lines of a bundle from the resolved releases: `name==version --hash=sha256:...`, one wheel per
 * part (for a Python-specific part, the one that matches `pyTag`). Refuses a wheel that has no digest.
 */
function planWheels(bundle, resolved, { pyTag = null } = {}) {
  const lines = [];
  const wheels = [];
  for (const part of bundle.parts) {
    const answer = resolved?.[part.dist];
    if (!answer?.ok || !answer.version)
      return { ok: false, error: `no version of ${part.dist} could be read` };
    const hits = (answer.assets || []).filter(
      (a) =>
        /win_amd64\.whl$/i.test(a.name) &&
        (!part.pythonSpecific || (pyTag && a.name.includes(`-${pyTag}-`))),
    );
    const wheel = hits[0];
    if (!wheel) {
      return {
        ok: false,
        error: part.pythonSpecific
          ? `${part.dist} ${answer.version} has no Windows wheel for ${pyTag || "this Python"}`
          : `${part.dist} ${answer.version} has no Windows wheel`,
      };
    }
    if (!/^[a-f0-9]{64}$/.test(wheel.sha256 || ""))
      return { ok: false, error: `no SHA-256 was published for ${wheel.name}` };
    const pin = PINNED_WHEELS[part.dist];
    const pinHit = pin?.assets.find((a) => a.name === wheel.name);
    const clash = pinHit
      ? vendor.agreeOnDigest(
          { version: pin.version, sha256: pinHit.sha256 },
          { version: answer.version, sha256: wheel.sha256 },
        )
      : { ok: true };
    if (!clash.ok) return { ok: false, error: clash.error };
    lines.push(`${part.dist}==${answer.version} --hash=sha256:${wheel.sha256}`);
    wheels.push({
      dist: part.dist,
      version: answer.version,
      name: wheel.name,
      bytes: wheel.bytes || 0,
      sha256: wheel.sha256,
    });
  }
  return { ok: true, lines, wheels };
}

/**
 * Install a bundle of pinned wheels with a rollback. Order: write the hash file, `pip download --require-hashes`
 * (the old install is untouched until this passes), remove the conflicting variants, `pip install --no-index
 * --require-hashes` from that folder, the dependencies (variants with `withDeps`), then import the module. The installed
 * version is first copied out and hashed; a failure after the removal uninstalls what was just put in and reinstalls
 * that copy (`--no-index --require-hashes`), checks every exit code and the installed set, and reports the truth. `deps.exec(exe, args, {timeoutMs}) -> { code, output }`.
 */
async function installPinnedWheels(root, bundle, plan, python, deps = {}) {
  const fsApi = deps.fs || nodeFs;
  const run = deps.run || passthrough;
  const say = deps.emit || (() => {});
  const exec = deps.exec;
  const py = (...args) =>
    exec(python.exe, [...(python.prefix || []), "-m", "pip", ...args], { timeoutMs: 30 * 60_000 });
  const dir = nodePath.join(root, "runtime", "installers", "pip-pins", safeName(bundle.id));
  const wheelDir = nodePath.join(dir, "wheels");
  const reqFile = nodePath.join(dir, "requirements.txt");
  const wanted = new Set(plan.wheels.map((w) => w.dist.toLowerCase()));

  const frozen = (await deps.freeze?.()) || new Map();
  const previous = [...frozen.entries()].filter(
    ([name]) => wanted.has(name) || bundle.conflicts.includes(name),
  );
  const removable = bundle.conflicts.filter((name) => frozen.has(name));

  try {
    rmrf(fsApi, wheelDir);
    fsApi.mkdirSync(wheelDir, { recursive: true });
    fsApi.writeFileSync(reqFile, `${plan.lines.join("\n")}\n`);
  } catch (error) {
    return {
      ok: false,
      error: `could not prepare the download folder: ${String(error?.message || error)}`,
      rolledBack: false,
    };
  }

  say(`downloading ${plan.wheels.map((w) => w.name).join(", ")} (checked against SHA-256)`);
  const dl = await run("download", () =>
    py(
      "download",
      "--no-deps",
      "--require-hashes",
      "--disable-pip-version-check",
      "--progress-bar",
      "off",
      "-r",
      reqFile,
      "-d",
      wheelDir,
    ),
  );
  if (dl.code !== 0) {
    return {
      ok: false,
      error: `pip refused the download: ${tail(dl.output)}; the installed copy is untouched`,
      rolledBack: false,
    };
  }

  // The previous variants are copied out of pip BEFORE anything is removed, then hashed here: the rollback installs
  // from that folder with --no-index --require-hashes and never reaches the network.
  const prevDir = nodePath.join(dir, "previous");
  const prevReq = nodePath.join(dir, "previous-requirements.txt");
  if (previous.length) {
    const kept = await run("download", () => keepPrevious());
    if (!kept.ok) {
      return {
        ok: false,
        error: `${kept.error}; the installed copy is untouched`,
        rolledBack: false,
      };
    }
  }

  async function keepPrevious() {
    try {
      rmrf(fsApi, prevDir);
      fsApi.mkdirSync(prevDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        error: `could not prepare a copy of the installed version: ${error?.message || error}`,
      };
    }
    // A previous version equal to the one just verified (a repair) is copied from the verified folder, not fetched again.
    const same = new Map();
    for (const [name, version] of previous) {
      const w = plan.wheels.find((x) => x.dist === name && x.version === version);
      if (w) same.set(name, w);
    }
    const fetch = previous.filter(([name]) => !same.has(name));
    if (fetch.length) {
      const got = await py(
        "download",
        "--no-deps",
        "--disable-pip-version-check",
        "--progress-bar",
        "off",
        "-d",
        prevDir,
        ...fetch.map(([name, version]) => `${name}==${version}`),
      );
      if (got.code !== 0) {
        return {
          ok: false,
          error: `a copy of the installed version could not be made for a rollback: ${tail(got.output)}`,
        };
      }
    }
    const lines = [];
    try {
      for (const [name, w] of same) {
        fsApi.copyFileSync(nodePath.join(wheelDir, w.name), nodePath.join(prevDir, w.name));
        lines.push(`${name}==${w.version} --hash=sha256:${w.sha256}`);
      }
    } catch (error) {
      return {
        ok: false,
        error: `the verified wheel could not be copied for a rollback: ${error?.message || error}`,
      };
    }
    const files = fsApi.readdirSync(prevDir).filter((f) => /\.whl$/i.test(f));
    for (const [name, version] of fetch) {
      const prefix = `${name.replace(/[-_.]+/g, "_")}-${version}-`.toLowerCase();
      const file = files.find((f) => f.toLowerCase().startsWith(prefix));
      if (!file) {
        return { ok: false, error: `no wheel of ${name} ${version} was kept for a rollback` };
      }
      const digest = fileSha256(fsApi, nodePath.join(prevDir, file));
      const pin = PINNED_WHEELS[name]?.assets.find((a) => a.name === file);
      if (pin && pin.sha256 !== digest) {
        return {
          ok: false,
          error: `${file} does not match its pinned SHA-256, so it is not kept for a rollback`,
        };
      }
      lines.push(`${name}==${version} --hash=sha256:${digest}`);
    }
    fsApi.writeFileSync(prevReq, `${lines.join("\n")}\n`);
    return { ok: true };
  }

  /**
   * Undo a failed install: remove every wheel this run may have put in that was not installed before, then put the
   * previous ones back from the hashed local copy. Every pip exit code is read, and the result is checked against the
   * installed set when `deps.freeze` can read it.
   */
  const restore = async () => {
    const problems = [];
    const before = new Set(previous.map(([name]) => name));
    const strays = plan.wheels.map((w) => w.dist).filter((dist) => !before.has(dist));
    let cleaned = true;
    if (strays.length) {
      say(`removing ${strays.join(", ")} (the new install failed)`);
      const gone = await py("uninstall", "-y", ...strays);
      if (gone.code !== 0) {
        cleaned = false;
        problems.push(`${strays.join(", ")} could not be removed: ${tail(gone.output)}`);
      }
    }
    if (previous.length && cleaned) {
      say("putting the previous version back from the checked local copy");
      const back = await py(
        "install",
        "--no-index",
        "--find-links",
        prevDir,
        "--no-deps",
        "--require-hashes",
        "--disable-pip-version-check",
        "-r",
        prevReq,
      );
      if (back.code !== 0) problems.push(`pip could not reinstall it: ${tail(back.output)}`);
    } else if (previous.length) {
      problems.push("the previous version was not reinstalled while the new one is still there");
    }
    const now = await deps.freeze?.();
    if (now) {
      const mine = (name) => wanted.has(name) || bundle.conflicts.includes(name);
      const have = new Map([...now.entries()].filter(([name]) => mine(name)));
      const want = new Map(previous);
      const same =
        have.size === want.size && [...want].every(([name, version]) => have.get(name) === version);
      if (!same && !problems.length) {
        const list = [...have].map(([name, version]) => `${name} ${version}`).join(", ") || "none";
        problems.push(`pip lists ${list} afterwards`);
      }
    }
    return { problems, restored: previous.length > 0 && !problems.length };
  };

  return run("install", async () => {
    if (removable.length) {
      say(`removing ${removable.join(", ")} (they share a module with the new one)`);
      const gone = await py("uninstall", "-y", ...removable);
      if (gone.code !== 0)
        return {
          ok: false,
          error: `pip could not remove ${removable.join(", ")}: ${tail(gone.output)}`,
          rolledBack: false,
        };
    }
    const put = await py(
      "install",
      "--no-index",
      "--find-links",
      wheelDir,
      "--no-deps",
      "--require-hashes",
      "--disable-pip-version-check",
      ...(deps.force ? ["--force-reinstall"] : []),
      "-r",
      reqFile,
    );
    let failure = put.code !== 0 ? `pip install failed: ${tail(put.output)}` : "";
    if (!failure && bundle.withDeps) {
      for (const w of plan.wheels) {
        const more = await py(
          "install",
          "--prefer-binary",
          "--disable-pip-version-check",
          `${w.dist}==${w.version}`,
        );
        if (more.code !== 0)
          failure = `its dependencies could not be installed: ${tail(more.output)}`;
      }
    }
    if (!failure && bundle.verifyImport) {
      const probe = await exec(python.exe, [...(python.prefix || []), "-c", bundle.verifyImport], {
        timeoutMs: 60_000,
      });
      if (probe.code !== 0)
        failure = `it installed but \`${bundle.verifyImport}\` failed: ${tail(probe.output)}`;
    }
    if (failure) {
      const undo = await restore();
      let note = "";
      if (undo.problems.length) {
        note = previous.length
          ? `; the previous version could NOT be put back (${undo.problems.join("; ")}); use Repair to reinstall it`
          : `; the new install could not be removed (${undo.problems.join("; ")})`;
      } else {
        note = previous.length
          ? "; the previous version was put back"
          : "; the new install was removed";
      }
      return { ok: false, error: `${failure}${note}`, rolledBack: undo.restored };
    }
    return {
      ok: true,
      versions: Object.fromEntries(plan.wheels.map((w) => [w.dist, w.version])),
      removed: removable,
    };
  });
}

const fileSha256 = (fsApi, file) =>
  require("node:crypto").createHash("sha256").update(fsApi.readFileSync(file)).digest("hex");

const tail = (text) =>
  String(text || "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-2)
    .join(" | ")
    .slice(0, 240) || "no output";

module.exports = {
  MARKER,
  ENGINES,
  PINNED_WHEELS,
  PIP_BUNDLES,
  llamaPin,
  engineBase,
  engineSources,
  releaseForInstall,
  engineVersion,
  detectEngine,
  pruneOld,
  installEngine,
  uninstallEngine,
  wheelSources,
  planWheels,
  installPinnedWheels,
  sdPlan,
  ffmpegPlan,
};
