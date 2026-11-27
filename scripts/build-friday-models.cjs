/**
 * FRIDAY Models pack: the heavy voice weights, made ready for FRIDAY's own GitHub release.
 *
 * This is NOT part of the Windows CMD chain. `npm run setup`, `npm run doctor` and `npm run build:win` never call it,
 * no workflow runs it and nothing in the app needs it. The owner runs it by hand, then uploads the result with the
 * command it prints. It never creates a release, a tag or an upload itself.
 *
 * `config/friday-models.json` is the plan: one asset per file, with its FRIDAY file name, size and SHA-256, and the pin
 * it comes from in `electron/voice-pins.cjs`. For every selected model the script
 *   1. refuses a pin the bundle gate (`bundleAllowed`) does not allow,
 *   2. fetches each file at its pinned revision with the shared downloader (SHA-256 and size checked before the file
 *      is put in place), straight into `--out` under the FRIDAY file name,
 *   3. splits a file over `partBytes` (1.9 GB, under the 2 GiB release asset limit) into `.partNNN` files,
 *   4. writes SHA256SUMS, NOTICE.md (the only place that carries the upstream licence lines) and the filled manifest.
 *
 * A recipe other than `copy` is used only with a derived file whose SHA-256 is pinned in the manifest and which the
 * owner passes in with `--derived <folder>` (made by kernel/voice_derive.py after its gate passed). Otherwise the
 * unchanged copy is used.
 *
 * Usage:
 *   node scripts/build-friday-models.cjs --out <folder outside the repository> [--max-gb 3] [--only id,id]
 *     [--part-bytes N] [--derived <folder>] [--dry-run]
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const MANIFEST_FILE = path.join(root, "config", "friday-models.json");

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^\d{4}\.\d{1,2}\.\d{1,3}$/;
const RECIPES = ["copy", "int8-dynamic", "ct2-int8"];
/** GitHub refuses a release asset of 2 GiB or more; the default part stays well under it. */
const ASSET_LIMIT = 2 * 1024 * 1024 * 1024;
const DEFAULT_PART_BYTES = 1_900_000_000;
const ASSET_COUNT_LIMIT = 1000;
const TAG_PREFIX = "friday-models-";

const CLASS_TEXT = {
  permissive: "keep the copyright and permission notice",
  attribution: "credit the upstream author, link the licence and keep the agreement text",
  "use-restricted": "pass the use limits of the licence to every recipient",
};

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function readManifest(file = MANIFEST_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// --------------------------------------------------------------------------------------------------------- split

/** How many files a file of `bytes` becomes when no part may pass `partBytes`. Zero bytes is one (empty) file. */
function partCount(bytes, partBytes = DEFAULT_PART_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 0) throw new Error("bytes must be a whole number");
  if (!Number.isInteger(partBytes) || partBytes <= 0)
    throw new Error("partBytes must be a positive whole number");
  return Math.max(1, Math.ceil(bytes / partBytes));
}

/** The name of part `index` (0-based) of `file`: `<file>.part001`. A file that is not split keeps its name. */
function partName(file, index, count) {
  return count <= 1 ? file : `${file}.part${String(index + 1).padStart(3, "0")}`;
}

/** The byte ranges of every part: contiguous, in order, every part full except the last. */
function splitPlan(file, bytes, partBytes = DEFAULT_PART_BYTES) {
  const count = partCount(bytes, partBytes);
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    const offset = i * partBytes;
    parts.push({
      file: partName(file, i, count),
      offset,
      length: Math.min(partBytes, bytes - offset),
    });
  }
  return parts;
}

/** Write the parts of `source` into `outDir`; returns `[{ file, bytes, sha256 }]`. The source is not removed. */
async function splitFile(source, outDir, file, partBytes = DEFAULT_PART_BYTES) {
  const bytes = fs.statSync(source).size;
  const plan = splitPlan(file, bytes, partBytes);
  const rows = [];
  for (const part of plan) {
    const target = path.join(outDir, part.file);
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      if (part.length === 0) {
        fs.writeFileSync(target, "");
        resolve();
        return;
      }
      const out = fs.createWriteStream(target);
      const input = fs.createReadStream(source, {
        start: part.offset,
        end: part.offset + part.length - 1,
        highWaterMark: 4 * 1024 * 1024,
      });
      input.on("data", (chunk) => hash.update(chunk));
      input.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      input.pipe(out);
    });
    rows.push({ file: part.file, bytes: part.length, sha256: hash.digest("hex") });
  }
  return rows;
}

/** True when every part exists with its planned size and the parts, joined, hash to `sha256`. */
async function partsIntact(outDir, file, bytes, sha256, partBytes = DEFAULT_PART_BYTES) {
  const plan = splitPlan(file, bytes, partBytes);
  for (const part of plan) {
    const target = path.join(outDir, part.file);
    if (!fs.existsSync(target) || fs.statSync(target).size !== part.length) return false;
  }
  const hash = crypto.createHash("sha256");
  for (const part of plan) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(path.join(outDir, part.file), { highWaterMark: 4 * 1024 * 1024 })
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", resolve);
    });
  }
  return hash.digest("hex") === sha256;
}

// ---------------------------------------------------------------------------------------------------- manifest

/** Group the assets of a manifest by model: `[{ fridayId, fridayName, pin, assets: [...] }]` in manifest order. */
function modelsOf(manifest) {
  const byId = new Map();
  for (const asset of manifest.assets || []) {
    if (!byId.has(asset.fridayId)) {
      byId.set(asset.fridayId, {
        fridayId: asset.fridayId,
        fridayName: asset.fridayName,
        pin: asset.from?.pin,
        assets: [],
      });
    }
    byId.get(asset.fridayId).assets.push(asset);
  }
  return [...byId.values()];
}

/**
 * Every problem in a manifest, against the pin table. Pure: an empty list means the plan is sound. A `copy` asset must
 * carry exactly the size and SHA-256 its pin carries; a derived recipe must pin the derived hash.
 */
function manifestProblems(manifest, pins) {
  const problems = [];
  const add = (text) => problems.push(text);
  if (!manifest || typeof manifest !== "object") return ["the manifest is not an object"];
  if (manifest.pack !== "friday-models") add("pack must be friday-models");
  if (!REVISION.test(String(manifest.revision || "")))
    add("revision must look like 2026.11.1 (year.month.number)");
  if (manifest.tag !== `${TAG_PREFIX}${manifest.revision}`)
    add(`tag must be ${TAG_PREFIX}<revision>`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(manifest.repository || "")))
    add("repository must be owner/name");
  if (!String(manifest.title || "").startsWith("FRIDAY Models"))
    add("title must start with FRIDAY Models");
  const partBytes = manifest.partBytes;
  if (!Number.isInteger(partBytes) || partBytes <= 0 || partBytes >= ASSET_LIMIT)
    add("partBytes must be a whole number under 2 GiB");
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (!assets.length) add("the manifest lists no assets");
  const names = new Set();
  let total = 0;
  for (const asset of assets) {
    const where = asset?.file || "(no file)";
    for (const key of ["fridayId", "fridayName", "path", "file"]) {
      if (typeof asset?.[key] !== "string" || !asset[key]) add(`${where}: ${key} is missing`);
    }
    if (!/^friday-[a-z0-9-]+$/.test(String(asset?.fridayId || ""))) add(`${where}: bad fridayId`);
    if (!String(asset?.fridayName || "").startsWith("FRIDAY "))
      add(`${where}: fridayName must start with FRIDAY`);
    if (!String(asset?.file || "").startsWith(`${asset?.fridayId}--`))
      add(`${where}: the file name must start with <fridayId>--`);
    if (/[\\/:*?"<>|\s]/.test(String(asset?.file || "")))
      add(`${where}: the file name has a bad character`);
    const key = String(asset?.file || "").toLowerCase();
    if (names.has(key)) add(`${where}: duplicate file name`);
    names.add(key);
    if (!SHA256.test(String(asset?.sha256 || "")))
      add(`${where}: sha256 must be 64 hex characters`);
    if (!Number.isInteger(asset?.bytes) || asset.bytes <= 0)
      add(`${where}: bytes must be a whole number`);
    else if (
      Number.isInteger(partBytes) &&
      partBytes > 0 &&
      asset.parts !== partCount(asset.bytes, partBytes)
    )
      add(`${where}: parts must be ${partCount(asset.bytes, partBytes)}`);
    total += asset?.parts > 0 ? asset.parts : 1;
    const from = asset?.from || {};
    if (!RECIPES.includes(from.recipe))
      add(`${where}: recipe must be one of ${RECIPES.join(", ")}`);
    if (!Number.isInteger(from.recipeVersion) || from.recipeVersion < 1)
      add(`${where}: recipeVersion is missing`);
    const pin = pins?.[from.pin];
    const row = pin?.files?.[from.file];
    if (!pin) add(`${where}: no pin ${from.pin}`);
    else if (!row) add(`${where}: the pin has no file ${from.file}`);
    else if (from.recipe === "copy") {
      if (row.sha256 !== asset.sha256 || row.bytes !== asset.bytes)
        add(`${where}: a copy must carry the size and SHA-256 of its pin`);
    } else if (
      !SHA256.test(String(from.derivedSha256 || "")) ||
      asset.sha256 !== from.derivedSha256
    ) {
      add(`${where}: a derived recipe must pin the derived SHA-256 as the asset's own`);
    }
  }
  if (total + 3 > ASSET_COUNT_LIMIT) add("too many release assets");
  return problems;
}

/** Models whose pin the bundle gate refuses. Pure. */
function refusedModels(manifest, pins, gate) {
  const refused = [];
  for (const model of modelsOf(manifest)) {
    if (!gate(pins?.[model.pin])) refused.push(model);
  }
  return refused;
}

// ---------------------------------------------------------------------------------------------------- notice

/** One NOTICE.md line for a model: its licence, the official licence page, the origin and the duty that travels. */
function noticeLine(model, pin) {
  const rec = pin?.licenseRecord;
  if (!rec) throw new Error(`no licence record for ${model.pin}`);
  const duty = CLASS_TEXT[rec.redistribution];
  if (!duty) throw new Error(`no redistribution text for ${model.pin}`);
  const upstream = rec.upstream
    ? `; the upstream card now names ${rec.upstream.id} (${rec.upstream.url})`
    : "";
  return `- ${model.fridayName}: ${rec.id} (${rec.url}); origin ${model.pin}; unmodified copy; ${duty}${upstream}.`;
}

/** The whole NOTICE.md for the models in `built`. The only file that names an upstream licence. */
function buildNotice(manifest, built, pins) {
  const lines = [
    `# ${manifest.title}`,
    "",
    "Published by devendrarj25 as the FRIDAY Models pack, revision " + manifest.revision + ".",
    "FRIDAY downloads these files during setup and install, checks every SHA-256 in SHA256SUMS, and keeps them on the owner's PC.",
    "A file larger than one release asset is split into .part001, .part002 and so on; joined in order they give the file named in friday-models.json.",
    "",
    "## Licences of the included models",
    "",
    ...built.map((model) => noticeLine(model, pins[model.pin])),
    "",
  ];
  return lines.join("\n");
}

function sha256sumsText(rows) {
  return rows.map((row) => `${row.sha256}  ${row.file}`).join("\n") + "\n";
}

function quoteArg(value) {
  return /^[\w./:=@%+-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The command the owner runs from inside `--out`. It is printed, never run. */
function uploadCommand(manifest, files) {
  const head = [
    "gh release create",
    manifest.tag,
    `--repo ${manifest.repository}`,
    `--title ${quoteArg(manifest.title)}`,
    "--notes-file NOTICE.md",
    "--latest=false",
  ];
  return [...head, ...files].join(" ");
}

// ------------------------------------------------------------------------------------------------------ build

function hfUrl(repo, revision, file) {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/${revision}/${encoded}`;
}

/** The files of a model that are over `maxBytes`; a model with any such file is skipped as a whole. */
function oversizeFiles(model, maxBytes) {
  if (!Number.isFinite(maxBytes)) return [];
  return model.assets.filter((asset) => asset.bytes > maxBytes);
}

async function fileIsDone(target, asset) {
  if (!fs.existsSync(target) || fs.statSync(target).size !== asset.bytes) return false;
  return (await sha256File(target)) === asset.sha256;
}

/** Make one asset in `outDir`; returns the rows it left (one, or one per part). */
async function makeAsset(asset, pins, outDir, options) {
  const { download, partBytes, derived, log } = options;
  const target = path.join(outDir, asset.file);
  const count = partCount(asset.bytes, partBytes);
  if (count > 1) {
    if (await partsIntact(outDir, asset.file, asset.bytes, asset.sha256, partBytes)) {
      log(`  kept   ${asset.file} (${count} parts already checked)`);
      return splitPlan(asset.file, asset.bytes, partBytes).map((part) => ({
        file: part.file,
        bytes: part.length,
      }));
    }
  } else if (await fileIsDone(target, asset)) {
    log(`  kept   ${asset.file} (already checked)`);
    return [{ file: asset.file, bytes: asset.bytes, sha256: asset.sha256 }];
  }
  const from = asset.from;
  let source = target;
  if (from.recipe !== "copy" && derived) {
    const given = path.join(derived, ...asset.path.split("/"));
    if (fs.existsSync(given) && (await sha256File(given)) === asset.sha256) {
      fs.copyFileSync(given, target);
      log(`  derived ${asset.file}`);
    }
  }
  if (!(await fileIsDone(target, asset))) {
    if (from.recipe !== "copy")
      throw new Error(
        `${asset.file}: the derived file is missing or does not match its pinned SHA-256`,
      );
    const pin = pins[from.pin];
    await download(hfUrl(from.pin, pin.revision, from.file), source, {
      sha256: asset.sha256,
      needBytes: asset.bytes,
      label: asset.file,
    });
    log(`  fetched ${asset.file} (${asset.bytes} bytes)`);
  }
  if (count > 1) {
    const rows = await splitFile(target, outDir, asset.file, partBytes);
    fs.rmSync(target, { force: true });
    log(`  split  ${asset.file} into ${count} parts`);
    return rows;
  }
  return [{ file: asset.file, bytes: asset.bytes, sha256: asset.sha256 }];
}

/**
 * Build the pack into `outDir`. `download` is injected (the shared downloader by default) so tests need no network.
 * Returns `{ built, skipped, files, rows, manifest, command }`; nothing is uploaded.
 */
async function buildPack(options) {
  const {
    manifest,
    pins,
    gate,
    outDir,
    only = null,
    maxBytes = Infinity,
    partBytes = manifest.partBytes,
    derived = null,
    download,
    dryRun = false,
    log = () => {},
  } = options;
  const problems = manifestProblems(manifest, pins);
  if (problems.length)
    throw new Error(`the manifest is not sound:\n  ${problems.slice(0, 8).join("\n  ")}`);
  let models = modelsOf(manifest);
  if (only) {
    const unknown = only.filter((id) => !models.some((model) => model.fridayId === id));
    if (unknown.length) throw new Error(`unknown model id: ${unknown.join(", ")}`);
    models = models.filter((model) => only.includes(model.fridayId));
  }
  const refused = refusedModels({ assets: models.flatMap((m) => m.assets) }, pins, gate);
  if (refused.length)
    throw new Error(`refused by the bundle gate: ${refused.map((m) => m.fridayName).join(", ")}`);

  const skipped = [];
  const selected = [];
  for (const model of models) {
    const big = oversizeFiles(model, maxBytes);
    if (big.length)
      skipped.push({
        fridayId: model.fridayId,
        fridayName: model.fridayName,
        reason: `${big.map((a) => a.file).join(", ")} is over ${maxBytes} bytes`,
      });
    else selected.push(model);
  }
  for (const row of skipped) log(`skipped ${row.fridayName}: ${row.reason}`);
  if (dryRun) {
    for (const model of selected)
      log(`would build ${model.fridayName} (${model.assets.length} files)`);
    return { built: selected, skipped, files: [], rows: [], manifest, command: "" };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const partsOf = new Map();
  for (const model of selected) {
    log(`${model.fridayName}`);
    for (const asset of model.assets) {
      const made = await makeAsset(asset, pins, outDir, { download, partBytes, derived, log });
      for (const row of made) {
        const full = path.join(outDir, row.file);
        rows.push({
          file: row.file,
          bytes: row.bytes,
          sha256: row.sha256 || (await sha256File(full)),
        });
      }
      if (made.length > 1)
        partsOf.set(
          asset.file,
          made.map((p) => p.file),
        );
    }
  }
  const sums = new Map(rows.map((row) => [row.file, row]));
  const finalRows = [...sums.values()];
  const filled = {
    ...manifest,
    assets: selected.flatMap((model) =>
      model.assets.map((asset) => ({
        ...asset,
        ...(partsOf.has(asset.file) ? { partFiles: partsOf.get(asset.file) } : {}),
      })),
    ),
    ...(skipped.length ? { skipped } : {}),
  };
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), sha256sumsText(finalRows));
  fs.writeFileSync(path.join(outDir, "NOTICE.md"), buildNotice(manifest, selected, pins));
  fs.writeFileSync(path.join(outDir, "friday-models.json"), `${JSON.stringify(filled, null, 2)}\n`);
  const files = [
    ...finalRows.map((row) => row.file),
    "SHA256SUMS",
    "NOTICE.md",
    "friday-models.json",
  ];
  const command = uploadCommand(manifest, files);
  fs.writeFileSync(path.join(outDir, "upload-command.txt"), `${command}\n`);
  return { built: selected, skipped, files, rows: finalRows, manifest: filled, command };
}

function parseArgs(argv) {
  const out = {
    out: "",
    maxGb: Infinity,
    only: null,
    partBytes: 0,
    derived: "",
    dryRun: false,
    manifest: MANIFEST_FILE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i] || "";
    else if (arg === "--max-gb") out.maxGb = Number(argv[++i]);
    else if (arg === "--only")
      out.only = String(argv[++i] || "")
        .split(",")
        .filter(Boolean);
    else if (arg === "--part-bytes") out.partBytes = Number(argv[++i]);
    else if (arg === "--derived") out.derived = argv[++i] || "";
    else if (arg === "--manifest") out.manifest = path.resolve(argv[++i] || "");
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.out) throw new Error("--out <folder outside the repository> is required");
  const outDir = path.resolve(opts.out);
  if (outDir === root || outDir.startsWith(root + path.sep))
    throw new Error("--out must be outside the repository");
  if (!(opts.maxGb > 0)) throw new Error("--max-gb must be a positive number");
  if (opts.partBytes && !(opts.partBytes > 0 && opts.partBytes < ASSET_LIMIT))
    throw new Error("--part-bytes must be a whole number under 2 GiB");
  const voicePins = require("../electron/voice-pins.cjs");
  const manifest = readManifest(opts.manifest);
  const { downloadUrl } = require("../electron/model-download.cjs");
  const result = await buildPack({
    manifest,
    pins: voicePins.PINS,
    gate: voicePins.bundleAllowed,
    outDir,
    only: opts.only,
    maxBytes: Number.isFinite(opts.maxGb) ? Math.round(opts.maxGb * 1e9) : Infinity,
    partBytes: opts.partBytes || manifest.partBytes,
    derived: opts.derived ? path.resolve(opts.derived) : null,
    download: downloadUrl,
    dryRun: opts.dryRun,
    log: (line) => console.log(line),
  });
  const total = result.rows.reduce((sum, row) => sum + row.bytes, 0);
  console.log(
    `FRIDAY Models ${manifest.revision}: ${result.built.length} models, ${result.rows.length} files, ${total} bytes; ${result.skipped.length} skipped`,
  );
  if (!opts.dryRun) {
    console.log(`Output: ${outDir}`);
    console.log("Upload (not run here; run it inside the output folder, as the owner):");
    console.log(`  ${result.command}`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`FRIDAY Models: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  MANIFEST_FILE,
  DEFAULT_PART_BYTES,
  ASSET_LIMIT,
  RECIPES,
  readManifest,
  partCount,
  partName,
  splitPlan,
  splitFile,
  partsIntact,
  modelsOf,
  manifestProblems,
  refusedModels,
  noticeLine,
  buildNotice,
  sha256sumsText,
  uploadCommand,
  hfUrl,
  buildPack,
  parseArgs,
};
