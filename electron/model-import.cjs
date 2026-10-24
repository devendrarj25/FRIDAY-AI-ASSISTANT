/**
 * Bring a model the owner already has on this PC into FRIDAY.
 *
 * The file is checked (it exists, its type is a model type, a GGUF really is
 * one), placed under `<FRIDAY folder>\models\imported\<name>` (a hard link when
 * the drive allows it, a copy with progress otherwise), and a GGUF is then
 * registered with the local engine and given one real test prompt. Only an
 * answer earns "ready". Every step is injectable, so nothing here needs a
 * running engine to be tested.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** File extension -> the format name the Models page uses. */
const FORMATS = Object.freeze({
  ".gguf": "GGUF",
  ".safetensors": "Safetensors",
  ".onnx": "ONNX",
  ".pt": "PyTorch",
  ".pth": "PyTorch",
  ".bin": "PyTorch",
  ".ckpt": "PyTorch",
});

/** The file dialog's type filter. "All files" stays so an odd name can still be picked and checked. */
const PICK_FILTERS = Object.freeze([
  { name: "Model files", extensions: ["gguf", "safetensors", "onnx", "pt", "pth", "bin", "ckpt"] },
  { name: "All files", extensions: ["*"] },
]);

const GGUF_MAGIC = "GGUF";
const COPY_CHUNK = 8 * 1024 * 1024;

function slugOf(name) {
  const text = String(name || "model")
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,12}$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (text || "model").slice(0, 60);
}

function formatOf(file) {
  return FORMATS[path.extname(String(file)).toLowerCase()] || null;
}

async function readHead(file, bytes) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Weight files in a folder (two levels deep is enough for a downloaded repo). */
async function weightFiles(dir, depth = 0) {
  const found = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && formatOf(full)) {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.size > 0) found.push({ file: full, bytes: stat.size });
    } else if (entry.isDirectory() && depth < 2 && !entry.name.startsWith(".")) {
      found.push(...(await weightFiles(full, depth + 1)));
    }
  }
  return found;
}

/**
 * What a picked path is, before anything is copied. Never throws.
 * @returns {Promise<{ok: boolean, error?: string, kind?: string, format?: string, name?: string, bytes?: number, files?: {file: string, bytes: number}[]}>}
 */
async function inspect(target) {
  const source = String(target || "").trim();
  if (!source) return { ok: false, error: "no file or folder was chosen" };
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch {
    return { ok: false, error: `${source} was not found` };
  }
  if (stat.isDirectory()) {
    const files = await weightFiles(source);
    if (!files.length) {
      return {
        ok: false,
        error: "this folder holds no model files (.gguf, .safetensors, .onnx, .pt, .bin)",
      };
    }
    const counts = new Map();
    for (const { file } of files) counts.set(formatOf(file), (counts.get(formatOf(file)) || 0) + 1);
    const format = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return {
      ok: true,
      kind: "folder",
      format,
      name: path.basename(source),
      bytes: files.reduce((sum, row) => sum + row.bytes, 0),
      files,
    };
  }
  const format = formatOf(source);
  if (!format) {
    return {
      ok: false,
      error: `${path.basename(source)} is not a model file type FRIDAY can use (.gguf, .safetensors, .onnx, .pt, .bin)`,
    };
  }
  if (stat.size <= 0) return { ok: false, error: `${path.basename(source)} is empty` };
  if (format === "GGUF") {
    const head = await readHead(source, 4).catch(() => Buffer.alloc(0));
    if (head.toString("latin1") !== GGUF_MAGIC) {
      return { ok: false, error: `${path.basename(source)} is not a valid GGUF file` };
    }
  }
  return {
    ok: true,
    kind: "file",
    format,
    name: path.basename(source),
    bytes: stat.size,
    files: [{ file: source, bytes: stat.size }],
  };
}

/** Same name already placed with the same size: nothing to do again. */
async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return x.size === y.size;
  } catch {
    return false;
  }
}

async function copyWithProgress(source, dest, onBytes) {
  const input = await fsp.open(source, "r");
  const output = await fsp.open(dest, "w");
  try {
    const buffer = Buffer.alloc(COPY_CHUNK);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await output.write(buffer, 0, bytesRead);
      onBytes(bytesRead);
    }
  } finally {
    await input.close();
    await output.close();
  }
}

/**
 * Put the files under `destDir`, keeping their relative layout. A hard link
 * costs no disk and no time; when the drive differs the bytes are copied.
 * @returns {Promise<{dir: string, files: string[], linked: boolean}>}
 */
async function place(inspected, source, destDir, onProgress = () => {}) {
  const base = inspected.kind === "folder" ? source : path.dirname(source);
  await fsp.mkdir(destDir, { recursive: true });
  const total = inspected.files.reduce((sum, row) => sum + row.bytes, 0) || 1;
  let done = 0;
  let linked = true;
  const placed = [];
  for (const { file, bytes } of inspected.files) {
    const dest = path.join(destDir, path.relative(base, file));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (await sameFile(file, dest)) {
      done += bytes;
      placed.push(dest);
      continue;
    }
    await fsp.rm(dest, { force: true });
    try {
      await fsp.link(file, dest);
      done += bytes;
    } catch {
      linked = false;
      await copyWithProgress(file, dest, (n) => {
        done += n;
        onProgress(Math.min(98, Math.round((done / total) * 98)), done, total);
      });
    }
    placed.push(dest);
    onProgress(Math.min(98, Math.round((done / total) * 98)), done, total);
  }
  return { dir: destDir, files: placed, linked };
}

/**
 * Import one picked path.
 * deps: { root, register(name, file) -> {ok,error}, ensureEngine() -> bool,
 *         verify(name) -> {ok,error}, emit({status,progress}) }
 */
async function importModel(request, deps = {}) {
  const emit = deps.emit || (() => {});
  const source = String(request?.path || "").trim();
  const inspected = await inspect(source);
  if (!inspected.ok) return { ok: false, state: "failed", error: inspected.error };
  if (!deps.root) {
    return {
      ok: false,
      state: "failed",
      error: "no FRIDAY folder is selected, so there is nowhere to keep the model",
    };
  }
  const name = String(request?.name || "").trim() || inspected.name;
  const slug = slugOf(name);
  const destDir = path.join(deps.root, "models", "imported", slug);
  emit({ status: "checking the file", progress: 1 });
  let placed;
  try {
    placed = await place(inspected, source, destDir, (progress, done, total) =>
      emit({
        status: `copying ${Math.round(done / 1024 ** 2)} of ${Math.round(total / 1024 ** 2)} MB`,
        progress,
      }),
    );
  } catch (err) {
    return {
      ok: false,
      state: "failed",
      error: `could not store the model: ${String((err && err.message) || err)}`,
    };
  }
  const base = {
    ok: true,
    name,
    slug,
    format: inspected.format,
    bytes: inspected.bytes,
    path: inspected.kind === "folder" ? placed.dir : placed.files[0],
    linked: placed.linked,
  };
  // Only a GGUF can be served by the local engine as it is.
  if (inspected.format !== "GGUF" || inspected.kind !== "file" || !deps.register) {
    return {
      ...base,
      state: "stored",
      note:
        inspected.format === "GGUF"
          ? "stored; no local engine to register it with"
          : `${inspected.format} is stored for a runtime that reads it (vLLM, ONNX Runtime or Transformers)`,
    };
  }
  emit({ status: "starting the local engine", progress: 99 });
  const engine = deps.ensureEngine ? await deps.ensureEngine().catch(() => false) : true;
  if (!engine) {
    return {
      ...base,
      state: "stored",
      note: "stored; the local engine is not running, so it will be registered when you retry",
    };
  }
  const tag = `imported-${slug}`;
  emit({ status: "registering with the local engine", progress: 99 });
  const registered = await deps.register(tag, base.path);
  if (!registered?.ok) {
    return {
      ...base,
      state: "stored",
      registered: false,
      note: `stored; the engine did not accept it (${registered?.error || "unknown reason"})`,
    };
  }
  emit({ status: "sending a test prompt", progress: 99 });
  const verified = deps.verify
    ? await deps.verify(tag).catch((e) => ({ ok: false, error: String(e) }))
    : null;
  if (verified && !verified.ok) {
    return {
      ...base,
      state: "not-responding",
      registered: true,
      registeredAs: tag,
      note: `registered but it did not answer the test prompt (${verified.error || "empty answer"})`,
    };
  }
  return { ...base, state: "ready", registered: true, registeredAs: tag };
}

module.exports = {
  FORMATS,
  PICK_FILTERS,
  slugOf,
  formatOf,
  inspect,
  place,
  importModel,
};
