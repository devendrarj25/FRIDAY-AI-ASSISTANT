/**
 * FRIDAY Core: the local brain model and its weights, read from `config/friday-core.json`.
 *
 * This file is pure data handling: it reads the manifest, chooses the variant that fits this PC, plans which files to
 * fetch and from where, and checks a file against its pinned size and SHA-256. It starts no process and downloads
 * nothing; the Install Manager catalog calls it, and the downloader (`download-safety.cjs`) does the transfer.
 *
 * A file is only planned when it is pinned by a full 64-hex SHA-256 and a revision. An entry without a pin is
 * skipped and reported, never guessed. Sources come in the manifest's `mirrors` order, after a local build on this PC
 * when one holds the file: the FRIDAY Models release first (only when `config/friday-models.json` really holds a file
 * with the same SHA-256), the official upstream last.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MANIFEST_FILE = "friday-core.json";
const SHA256_RE = /^[a-f0-9]{64}$/;
const DISK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GB = 1e9;

function isSha256(value) {
  return typeof value === "string" && SHA256_RE.test(value);
}

/** The manifest, or null when it cannot be read. `deps.manifest` is injected by tests. */
function read(deps = {}) {
  if (deps.manifest !== undefined) return deps.manifest;
  const loaded = require("./resource-paths.cjs").readConfigJson(MANIFEST_FILE, null);
  const value = loaded && loaded.value;
  return value && value.schemaVersion === 1 && Array.isArray(value.variants) ? value : null;
}

function variantOf(manifest, id) {
  return (manifest?.variants || []).find((v) => v.id === id) || null;
}

/** A file is installable only with a revision, a plain disk name and a full SHA-256. */
function pinProblem(file) {
  if (!file || typeof file !== "object") return "no entry";
  if (!isSha256(file.sha256)) return "no full sha256";
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) return "no byte size";
  if (!file.upstream?.repo || !file.upstream?.revision || !file.upstream?.file)
    return "no upstream revision";
  if (!DISK_NAME_RE.test(String(file.disk || ""))) return "unsafe disk name";
  return "";
}

/** Resident memory in GB: the weights and projector, the KV cache at the served context, and the runtime buffers. */
function needGb(variant) {
  const weights = (variant.files || []).reduce((sum, f) => sum + (f.bytes || 0), 0) / GB;
  return weights + (variant.kvGbAt8k || 0) + (variant.overheadGb || 0);
}

/**
 * Which model fits this PC. `ramGb` is the installed RAM, `freeGb` the RAM free now (null or missing when unknown).
 * Windows itself (`memory.windowsGb`) and the voice stack plus the app (`memory.appReserveGb`) are counted before
 * Core gets anything, and the KV cache for the served context is part of each variant's need. The default order is
 * the default variant, then the lite one; `opts.prefer` puts one variant first (the challenger A/B). When nothing
 * fits, the answer is the existing small chat tier from the manifest, never an install that would starve the PC.
 */
function pickVariant(ramGb, freeGb, opts = {}) {
  const manifest = read(opts);
  if (!manifest) return { ok: false, reason: "the FRIDAY Core manifest could not be read" };
  if (!Number.isFinite(ramGb) || ramGb <= 0)
    return { ok: false, reason: "the installed memory is unknown" };
  const mem = manifest.memory || {};
  const windowsGb = Number.isFinite(mem.windowsGb) ? mem.windowsGb : 3.5;
  const reserveGb = Number.isFinite(mem.appReserveGb) ? mem.appReserveGb : 3.5;
  const freeKnown = Number.isFinite(freeGb) && freeGb >= 0;
  const fromTotal = ramGb - windowsGb - reserveGb;
  const budgetGb = Math.max(0, freeKnown ? Math.min(fromTotal, freeGb - reserveGb) : fromTotal);

  const brains = manifest.variants.filter((v) => v.role !== "embedder");
  const defaultFirst = ["default", "lite"].flatMap((role) => brains.filter((v) => v.role === role));
  const ranked = opts.prefer
    ? [
        ...brains.filter((v) => v.id === opts.prefer),
        ...defaultFirst.filter((v) => v.id !== opts.prefer),
      ]
    : defaultFirst;
  for (const v of ranked) {
    const need = needGb(v);
    if (need <= budgetGb + 1e-9) {
      return {
        ok: true,
        variant: v.id,
        fridayName: v.fridayName,
        needGb: Math.round(need * 100) / 100,
        budgetGb: Math.round(budgetGb * 100) / 100,
        reason: `${v.fridayName} needs about ${need.toFixed(1)} GB and ${budgetGb.toFixed(1)} GB is available after Windows and the voice stack`,
      };
    }
  }
  const tiers = [...(manifest.fallbackTiers || [])].sort((a, b) => b.minRamGb - a.minRamGb);
  const tier =
    tiers.find((t) => ramGb >= t.minRamGb && (!freeKnown || freeGb >= t.minFreeGb)) ||
    tiers[tiers.length - 1] ||
    null;
  return {
    ok: true,
    variant: null,
    fallback: tier ? { tier: tier.tier, tag: tier.tag } : null,
    budgetGb: Math.round(budgetGb * 100) / 100,
    reason: `not enough free memory for a FRIDAY Core model (${budgetGb.toFixed(1)} GB available), so the small chat tier stays`,
  };
}

/** `<root>/models/friday-core/<disk>`, refusing a name that could leave the folder. */
function diskPath(root, disk, deps = {}) {
  if (!root) throw new Error("FRIDAY root is not set");
  if (!DISK_NAME_RE.test(String(disk || ""))) throw new Error(`unsafe disk name: ${disk}`);
  const dir = path.join(root, ...String(read(deps)?.diskDir || "models/friday-core").split("/"));
  return path.join(dir, disk);
}

function partName(file, index, count) {
  return count <= 1 ? file : `${file}.part${String(index + 1).padStart(3, "0")}`;
}

/** The FRIDAY Models release asset that holds this exact file (matched by SHA-256), or null. */
function releaseAssetFor(file, pack) {
  if (!pack || !Array.isArray(pack.assets) || !pack.revision) return null;
  return pack.assets.find((a) => a && a.sha256 === file.sha256 && a.file) || null;
}

/**
 * The release tag that carries one Core variant: the tag of the `packs[]` entry (brain-weights, recall-weights) that
 * lists the variant in its `core`, or the old `<tagPrefix><revision>` tag when the pack names no such entry.
 */
function packTagFor(mirror, pack, variantId) {
  const entry = (Array.isArray(pack.packs) ? pack.packs : []).find(
    (item) => item && Array.isArray(item.core) && item.core.includes(variantId) && item.tag,
  );
  return entry ? entry.tag : `${mirror.tagPrefix}${pack.revision}`;
}

/**
 * The local-bundle road to one file, or null: a build on this PC (`deps.localBundles`, from `local-sources.cjs`) that
 * holds the file under `models/friday-core` with the pinned size and SHA-256, or the parts of its release asset in a
 * local pack of the right tag. `local.parts` are the files to read, in order; there is no URL.
 */
function localCoreRoad(manifest, file, pack, variantId, deps) {
  if (!Array.isArray(deps.localBundles) || !deps.localBundles.length) return null;
  const asset = releaseAssetFor(file, pack);
  const mirror = (manifest.mirrors || []).find((m) => m.kind === "release");
  const found = require("./local-sources.cjs").planLocalCoreFile({
    bundles: deps.localBundles,
    installRoot: deps.installRoot,
    file,
    ...(asset && mirror ? { asset, tag: packTagFor(mirror, pack, variantId) } : {}),
    ...(deps.localFs ? { fs: deps.localFs } : {}),
  });
  return found
    ? {
        id: "local-bundle",
        kind: "local-bundle",
        parts: found.parts.length,
        urls: [],
        local: { origin: found.origin, dir: found.dir, via: found.via, parts: found.parts },
      }
    : null;
}

/**
 * Every road to one file, in manifest order, with a local build first when one holds the file (`deps.localBundles`).
 * A release road exists only when the pack really holds the file.
 */
function sourcesFor(manifest, file, pack, variantId = "", deps = {}) {
  const out = [];
  const local = localCoreRoad(manifest, file, pack, variantId, deps);
  if (local) out.push(local);
  for (const mirror of manifest.mirrors || []) {
    if (mirror.kind === "release") {
      const asset = releaseAssetFor(file, pack);
      if (!asset) continue;
      const parts = Number.isInteger(asset.parts) && asset.parts > 0 ? asset.parts : 1;
      const base = `https://github.com/${mirror.repository}/releases/download/${packTagFor(mirror, pack, variantId)}/`;
      out.push({
        id: mirror.id,
        parts,
        urls: Array.from({ length: parts }, (_, i) => base + partName(asset.file, i, parts)),
      });
    } else if (mirror.kind === "upstream") {
      const u = file.upstream;
      const segments = String(u.file).split("/").map(encodeURIComponent).join("/");
      out.push({
        id: mirror.id,
        parts: 1,
        urls: [`https://huggingface.co/${u.repo}/resolve/${u.revision}/${segments}`],
      });
    } else if (mirror.kind === "modelscope") {
      // The same file on ModelScope, only for a repository the manifest lists as compared there (`repos`): the road is
      // a plain url, and the pinned size and SHA-256 decide whether the bytes are kept.
      const u = file.upstream;
      if (!Array.isArray(mirror.repos) || !mirror.repos.includes(u.repo)) continue;
      const segments = String(u.file).split("/").map(encodeURIComponent).join("/");
      out.push({
        id: mirror.id,
        parts: 1,
        urls: [
          `https://modelscope.cn/api/v1/models/${u.repo}/repo?Revision=master&FilePath=${segments}`,
        ],
      });
    }
  }
  return out;
}

/**
 * What to fetch for one variant. Returns `{ ok, variant, assets, skipped }`. Each asset carries its destination, size,
 * SHA-256, licence id and ordered sources, and `present` says whether a file of the right size is already on disk (the
 * hash is checked by `verifySha` before it is trusted). An unpinned entry lands in `skipped` with the reason.
 * `deps.pack` is the parsed `config/friday-models.json`; `deps.stat` is injected by tests.
 */
function planAssets(root, variantId, deps = {}) {
  const manifest = read(deps);
  const variant = variantOf(manifest, variantId);
  if (!variant) return { ok: false, reason: `unknown FRIDAY Core variant: ${variantId}` };
  const stat = deps.stat || ((p) => fs.statSync(p, { throwIfNoEntry: false }));
  const pack = deps.pack === undefined ? readPack() : deps.pack;
  const assets = [];
  const skipped = [];
  for (const file of variant.files || []) {
    const problem = pinProblem(file);
    if (problem) {
      skipped.push({ disk: file?.disk || "", reason: problem });
      continue;
    }
    const dest = diskPath(root, file.disk, deps);
    const found = stat(dest);
    assets.push({
      variant: variant.id,
      kind: file.kind,
      disk: file.disk,
      dest,
      bytes: file.bytes,
      sha256: file.sha256,
      licence: variant.licence?.id || "",
      sources: sourcesFor(manifest, file, pack, variant.id, deps),
      present: !!found && found.size === file.bytes,
    });
  }
  return { ok: true, variant: variant.id, fridayName: variant.fridayName, assets, skipped };
}

function readPack() {
  try {
    const loaded = require("./resource-paths.cjs").readConfigJson("friday-models.json", null);
    return loaded && loaded.value && Array.isArray(loaded.value.assets) ? loaded.value : null;
  } catch {
    return null;
  }
}

/** Check a file against its pinned size and SHA-256. A wrong or missing pin refuses the file. */
function verifySha(file, sha256, opts = {}) {
  if (!isSha256(sha256))
    return Promise.resolve({ ok: false, reason: "no full sha256 to check against" });
  return new Promise((resolve) => {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      resolve({ ok: false, reason: "the file is not on disk" });
      return;
    }
    if (Number.isInteger(opts.bytes) && size !== opts.bytes) {
      resolve({ ok: false, reason: `wrong size: ${size} bytes, expected ${opts.bytes}` });
      return;
    }
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => resolve({ ok: false, reason: "the file could not be read" }));
    stream.on("end", () => {
      const actual = hash.digest("hex");
      resolve(
        actual === sha256
          ? { ok: true, sha256: actual }
          : { ok: false, reason: "the sha256 does not match the pin", actual },
      );
    });
  });
}

module.exports = {
  MANIFEST_FILE,
  isSha256,
  read,
  variantOf,
  pinProblem,
  needGb,
  pickVariant,
  diskPath,
  partName,
  sourcesFor,
  planAssets,
  verifySha,
};
