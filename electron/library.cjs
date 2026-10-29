/**
 * FRIDAY · library (main process)
 *
 * Durable owner Library under <FRIDAY_ROOT>/library. Bytes live in
 * library/items/<id>/ ; the index is library/index.json. Chat, the Library
 * section, and Auto Mode all use this one store. Import & Build stays packs.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
let shell = { openPath: () => false };
try {
  ({ shell } = require("electron"));
} catch {
  /* vitest / node — reveal is a no-op */
}
const paths = require("./friday-paths.cjs");
const documents = require("./document-extract.cjs");

const INDEX = "index.json";

function now() {
  return Date.now();
}

function libraryDir() {
  return paths.ensureDir("library");
}

function itemsDir() {
  const dir = path.join(libraryDir(), "items");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath() {
  return path.join(libraryDir(), INDEX);
}

function readIndex() {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeIndex(items) {
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: now(), items }, null, 2));
  return items;
}

function hashBuf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeName(name) {
  return (
    String(name || "file")
      .replace(/[\\/]+/g, "_")
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .slice(0, 180) || "file"
  );
}

function classify(name, mime) {
  const lower = String(name || "").toLowerCase();
  const kind = String(mime || "").toLowerCase();
  if (kind.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(lower)) return "image";
  if (kind.startsWith("audio/") || /\.(wav|mp3|m4a|webm|ogg|flac)$/i.test(lower)) return "audio";
  if (kind.startsWith("video/") || /\.(mp4|mov|mkv|avi)$/i.test(lower)) return "video";
  if (/\.(zip|tar\.gz|tgz)$/i.test(lower)) return "zip";
  if (/\.(csv|tsv|xlsx|xlsm)$/i.test(lower)) return "sheet";
  if (/\.(pdf|docx|txt|md|markdown|json|jsonc|html?|xml)$/i.test(lower)) return "doc";
  return "other";
}

function itemFolder(id) {
  const dir = path.join(itemsDir(), String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rel(full) {
  const root = paths.root();
  if (!root) return full;
  return path.relative(root, full).split(path.sep).join("/");
}

function newId() {
  return `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (typeof bytes === "string") return Buffer.from(bytes, "utf8");
  return Buffer.alloc(0);
}

function ingest(payload = {}) {
  const name = safeName(payload.name || payload.filename || "untitled");
  const mime = String(payload.mime || "application/octet-stream");
  const buf =
    payload.text && !payload.bytes
      ? Buffer.from(String(payload.text), "utf8")
      : asBuffer(payload.bytes);
  if (!buf.length && !payload.text) return { ok: false, error: "No file bytes were given." };
  const hash = hashBuf(buf.length ? buf : Buffer.from(String(payload.text || ""), "utf8"));
  const current = readIndex();
  const existing = current.find((item) => item.hash === hash && item.name === name);
  const id = String(payload.id || existing?.id || newId());
  const folder = itemFolder(id);
  const filePath = path.join(folder, name);
  fs.writeFileSync(filePath, buf.length ? buf : Buffer.from(String(payload.text || ""), "utf8"));
  let extract = payload.extract || null;
  const lower = name.toLowerCase();
  if (
    !extract &&
    /\.(zip|tar\.gz|tgz|pdf|docx|xlsx|xlsm|csv|tsv|txt|md|markdown|json|jsonc|html?|xml)$/i.test(
      lower,
    )
  ) {
    try {
      extract = documents.extract({
        filename: name,
        bytes: buf.length ? buf : undefined,
        text: payload.text,
      });
    } catch (error) {
      extract = { error: String(error.message || error), text: "" };
    }
  }
  const text = String((extract && extract.text) || payload.text || "");
  if (text) fs.writeFileSync(path.join(folder, "extract.txt"), text.slice(0, 2_000_000));
  const record = {
    id,
    name,
    type: classify(name, mime),
    origin: payload.origin || existing?.origin || "uploaded",
    source: payload.source || existing?.source || "chat",
    mime,
    size: buf.length || text.length,
    hash,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    relativePath: rel(filePath),
    truncated: Boolean(extract && extract.truncated) || text.length > 24_000,
    totalChars: text.length,
    chunkCount: Math.max(1, Math.ceil(Math.max(text.length, 1) / 3600)),
    memoryIds: Array.isArray(existing?.memoryIds) ? existing.memoryIds : [],
    hisabLinked: Boolean(payload.hisabLinked ?? existing?.hisabLinked),
    pinnedForAuto: Boolean(payload.pinnedForAuto ?? existing?.pinnedForAuto),
    version: existing ? Number(existing.version || 1) + 1 : Number(payload.version) || 1,
    text: text.slice(0, 200_000),
  };
  if (extract && extract.error) record.extractNote = extract.error;
  if (extract && extract.members) record.members = extract.members;
  if (extract && extract.skipped) record.skipped = extract.skipped;
  if (extract && extract.error) record.error = extract.error;
  if (payload.versionOf || existing?.versionOf)
    record.versionOf = payload.versionOf || existing.versionOf;
  const items = current.filter((item) => item.id !== id);
  items.unshift(record);
  writeIndex(items);
  return { ok: true, item: record };
}

function list() {
  return { ok: true, items: readIndex(), dir: libraryDir() };
}

function get(id) {
  const item = readIndex().find((row) => row.id === String(id || ""));
  if (!item) return { ok: false, error: "Library item not found." };
  let text = item.text || "";
  try {
    const extractFile = path.join(itemsDir(), item.id, "extract.txt");
    if (fs.existsSync(extractFile)) text = fs.readFileSync(extractFile, "utf8");
  } catch {
    /* keep index text */
  }
  return { ok: true, item, text };
}

function remove(id) {
  const target = String(id || "");
  if (!target || target.includes("..")) return { ok: false, error: "Invalid Library id." };
  const items = readIndex().filter((row) => row.id !== target);
  writeIndex(items);
  const folder = path.join(itemsDir(), target);
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    /* missing folder is fine */
  }
  return { ok: true };
}

function reveal(id) {
  const item = readIndex().find((row) => row.id === String(id || ""));
  const root = paths.root();
  if (!root) return false;
  const target = item?.relativePath ? path.join(root, item.relativePath) : libraryDir();
  shell.openPath(target);
  return true;
}

function writeText(payload = {}) {
  const name = safeName(payload.name || "note.md");
  return ingest({
    name,
    mime: "text/plain",
    text: String(payload.text || ""),
    origin: payload.origin || "generated",
    source: payload.source || "generate",
    versionOf: payload.versionOf,
    version: payload.versionOf ? 2 : 1,
  });
}

function zipSelected(ids) {
  const wanted = new Set((ids || []).map(String));
  const items = readIndex().filter((row) => wanted.has(row.id));
  if (!items.length) return { ok: false, error: "Select Library items first." };
  const files = [];
  const root = paths.root();
  for (const item of items) {
    try {
      const full =
        item.relativePath && root
          ? path.join(root, item.relativePath)
          : path.join(itemsDir(), item.id, item.name);
      if (!fs.existsSync(full)) continue;
      files.push({ name: `${item.id}-${item.name}`, data: fs.readFileSync(full) });
    } catch {
      /* skip unreadable */
    }
  }
  if (!files.length) return { ok: false, error: "None of those Library files were on disk." };
  const packed = documents.packZip(files);
  return ingest({
    name: `library-${Date.now().toString(36)}.zip`,
    mime: "application/zip",
    bytes: packed,
    origin: "generated",
    source: "library",
  });
}

function pin(id, pinned) {
  const items = readIndex();
  const item = items.find((row) => row.id === String(id || ""));
  if (!item) return { ok: false, error: "Library item not found." };
  item.pinnedForAuto = Boolean(pinned);
  item.updatedAt = now();
  writeIndex(items);
  return { ok: true, item };
}

function patch(id, fields = {}) {
  const items = readIndex();
  const item = items.find((row) => row.id === String(id || ""));
  if (!item) return { ok: false, error: "Library item not found." };
  if (fields.pinnedForAuto != null) item.pinnedForAuto = Boolean(fields.pinnedForAuto);
  if (fields.hisabLinked != null) item.hisabLinked = Boolean(fields.hisabLinked);
  if (Array.isArray(fields.memoryIds)) item.memoryIds = fields.memoryIds.map(String);
  item.updatedAt = now();
  writeIndex(items);
  return { ok: true, item };
}

function scan() {
  const listed = readIndex();
  const onDisk = new Set();
  try {
    for (const entry of fs.readdirSync(itemsDir(), { withFileTypes: true })) {
      if (entry.isDirectory()) onDisk.add(entry.name);
    }
  } catch {
    return { ok: true, items: listed };
  }
  const kept = listed.filter((item) => onDisk.has(item.id));
  for (const id of onDisk) {
    if (kept.some((item) => item.id === id)) continue;
    const folder = path.join(itemsDir(), id);
    let name = "file";
    try {
      name = fs.readdirSync(folder).find((row) => row !== "extract.txt") || "file";
    } catch {
      /* empty */
    }
    kept.unshift({
      id,
      name,
      type: classify(name, ""),
      origin: "uploaded",
      source: "library",
      mime: "application/octet-stream",
      size: 0,
      hash: "",
      createdAt: now(),
      updatedAt: now(),
      relativePath: rel(path.join(folder, name)),
      memoryIds: [],
      hisabLinked: false,
      pinnedForAuto: false,
      version: 1,
    });
  }
  writeIndex(kept);
  return { ok: true, items: kept };
}

module.exports = {
  ingest,
  list,
  get,
  remove,
  reveal,
  writeText,
  zipSelected,
  pin,
  patch,
  scan,
  libraryDir,
};
