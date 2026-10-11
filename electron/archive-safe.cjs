/**
 * Pure-Node archive extract and a retrying directory replace.
 * Zip and ustar only. No PowerShell and no tar binary.
 * Entries that leave the destination are refused.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const DEFAULT_LIMITS = {
  maxMemberBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 80,
  maxEntries: 20000,
};

function limitsOf(options) {
  return { ...DEFAULT_LIMITS, ...(options && options.limits) };
}

function isTransient(err, windows) {
  const code = err && err.code;
  if (!code || !TRANSIENT.has(code)) return false;
  if (!windows && (code === "EPERM" || code === "EACCES")) return false;
  return true;
}

function sleepSync(ms) {
  if (!ms) return;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0, ms);
}

function entryParts(name) {
  const raw = String(name || "");
  if (!raw || raw.includes("\0")) throw new Error(`unsafe archive entry: ${raw}`);
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`unsafe archive entry: ${raw}`);
  }
  const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) {
    throw new Error(`unsafe archive entry: ${raw}`);
  }
  if (parts.some((part) => RESERVED.test(part))) {
    throw new Error(`unsafe archive entry: ${raw}`);
  }
  return parts;
}

function destinationFor(root, name) {
  const parts = entryParts(name);
  const resolved = path.resolve(root, ...parts);
  const base = path.resolve(root);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`unsafe archive entry: ${name}`);
  }
  return resolved;
}

function writeMember(root, name, data) {
  const target = destinationFor(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

function mkdirMember(root, name) {
  const target = destinationFor(root, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function zipCentral(buf) {
  const sig = Buffer.from("PK\x05\x06");
  const eocd = buf.lastIndexOf(sig);
  if (eocd < 0) throw new Error("truncated archive: ZIP end record is missing");
  let entries = buf.readUInt16LE(eocd + 10);
  let offset = readU32(buf, eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff) {
    const loc = buf.lastIndexOf(Buffer.from("PK\x06\x07"), eocd);
    if (loc < 0) throw new Error("truncated archive: ZIP64 locator is missing");
    const zip64 = Number(buf.readBigUInt64LE(loc + 8));
    if (buf.toString("binary", zip64, zip64 + 4) !== "PK\x06\x06") {
      throw new Error("truncated archive: ZIP64 end record is missing");
    }
    entries = Number(buf.readBigUInt64LE(zip64 + 32));
    offset = Number(buf.readBigUInt64LE(zip64 + 48));
  }
  return { entries, offset };
}

function extractZipBuffer(buf, dest, options) {
  const limits = limitsOf(options);
  const central = zipCentral(buf);
  if (central.entries > limits.maxEntries) {
    throw new Error(`archive has ${central.entries} entries, above the cap ${limits.maxEntries}`);
  }
  let cursor = central.offset;
  let total = 0;
  let wrote = 0;
  for (let i = 0; i < central.entries; i += 1) {
    if (cursor + 46 > buf.length || buf.toString("binary", cursor, cursor + 4) !== "PK\x01\x02") {
      throw new Error("truncated archive: ZIP directory entry is short");
    }
    const method = buf.readUInt16LE(cursor + 10);
    const compressed = readU32(buf, cursor + 20);
    const uncompressed = readU32(buf, cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const external = readU32(buf, cursor + 38);
    const localOffset = readU32(buf, cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;
    const mode = (external >>> 16) & 0o170000;
    if (mode === 0o120000) throw new Error(`unsafe archive entry: ${name}`);
    if (name.endsWith("/")) {
      mkdirMember(dest, name);
      continue;
    }
    if (uncompressed > limits.maxMemberBytes) {
      throw new Error(`archive member ${name} expands past ${limits.maxMemberBytes} bytes`);
    }
    if (compressed > 0 && uncompressed / compressed > limits.maxRatio) {
      throw new Error(`archive member ${name} expands past the ratio cap`);
    }
    if (localOffset + 30 > buf.length) throw new Error("truncated archive: ZIP local header is short");
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    const packed = buf.subarray(dataStart, dataStart + compressed);
    if (packed.length !== compressed) throw new Error(`truncated archive: ${name}`);
    let data = packed;
    if (method === 8) {
      data = zlib.inflateRawSync(packed, { maxOutputLength: limits.maxMemberBytes });
    } else if (method !== 0) {
      throw new Error(`unsupported archive method ${method}`);
    }
    if (data.length !== uncompressed && uncompressed !== 0) {
      throw new Error(`truncated archive: ${name}`);
    }
    total += data.length;
    if (total > limits.maxTotalBytes) {
      throw new Error(`archive expands past ${limits.maxTotalBytes} bytes`);
    }
    writeMember(dest, name, data);
    wrote += 1;
  }
  return { ok: true, via: "zip", files: wrote };
}

function octal(block, start, end) {
  const text = block.toString("ascii", start, end).replace(/\0.*$/, "").trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error("truncated archive: bad tar size");
  return value;
}

function tarChecksumOk(block) {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : block[i];
  return octal(block, 148, 156) === sum;
}

function tarName(block, longName) {
  if (longName) return longName;
  const name = block.toString("utf8", 0, 100).replace(/\0.*$/, "");
  const prefix = block.toString("utf8", 345, 500).replace(/\0.*$/, "");
  if (prefix) return `${prefix}/${name}`;
  return name;
}

function extractTarBuffer(buf, dest, options) {
  const limits = limitsOf(options);
  let offset = 0;
  let total = 0;
  let wrote = 0;
  let longName = "";
  let entries = 0;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    if (!tarChecksumOk(block)) throw new Error("truncated archive: tar checksum failed");
    const size = octal(block, 124, 136);
    const type = String.fromCharCode(block[156] || 0);
    const name = tarName(block, longName);
    offset += 512;
    const dataEnd = offset + size;
    if (dataEnd > buf.length) throw new Error(`truncated archive: ${name || "tar member"}`);
    const data = buf.subarray(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (type === "x" || type === "g" || type === "K") {
      longName = "";
      continue;
    }
    longName = "";
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new Error(`archive has more than ${limits.maxEntries} entries`);
    }
    if (!name) continue;
    if (type === "5") {
      mkdirMember(dest, name);
      continue;
    }
    if (type !== "0" && type !== "\0") continue;
    if (size > limits.maxMemberBytes) {
      throw new Error(`archive member ${name} expands past ${limits.maxMemberBytes} bytes`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new Error(`archive expands past ${limits.maxTotalBytes} bytes`);
    }
    writeMember(dest, name, data);
    wrote += 1;
  }
  if (!wrote) throw new Error("truncated archive: tar contained no files");
  return { ok: true, via: "tar", files: wrote };
}

function extractArchiveBuffer(buf, dest, options) {
  fs.mkdirSync(dest, { recursive: true });
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    const limits = limitsOf(options);
    const plain = zlib.gunzipSync(buf, { maxOutputLength: limits.maxTotalBytes });
    return extractTarBuffer(plain, dest, options);
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    return extractZipBuffer(buf, dest, options);
  }
  return extractTarBuffer(buf, dest, options);
}

function extractArchiveFile(file, dest, options) {
  const buf = fs.readFileSync(file);
  if (!buf.length) throw new Error("truncated archive: empty file");
  return extractArchiveBuffer(buf, dest, options);
}

function removeTree(target, opts = {}) {
  const rm =
    opts.rm ||
    ((file, rmOpts) => {
      fs.rmSync(file, rmOpts);
    });
  const sleep = opts.sleep || sleepSync;
  const windows = opts.windows ?? process.platform === "win32";
  const attempts = opts.attempts || 6;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (i) sleep(opts.delays ? opts.delays[i] || 20 : 20 * i);
      rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return { ok: true, attempts: i + 1 };
    } catch (error) {
      last = error;
      if (!isTransient(error, windows)) break;
    }
  }
  return { ok: false, error: last, attempts };
}

function renameWithRetry(from, to, opts = {}) {
  const rename = opts.rename || fs.renameSync;
  const sleep = opts.sleep || sleepSync;
  const windows = opts.windows ?? process.platform === "win32";
  const attempts = opts.attempts || 6;
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (i) sleep(20 * i);
      rename(from, to);
      return { ok: true, attempts: i + 1 };
    } catch (error) {
      last = error;
      if (!isTransient(error, windows)) break;
    }
  }
  return { ok: false, error: last, attempts };
}

/**
 * Put `source` in `target`'s place. An existing target is removed with the
 * retrying helper first. A failure after that copies `backup` back.
 */
function replaceDirectory({ source, target, backup, remove, copy, windows }) {
  const drop = remove || ((dir) => removeTree(dir, { windows }));
  const put =
    copy ||
    ((from, to) => {
      fs.cpSync(from, to, { recursive: true });
    });
  if (fs.existsSync(target)) {
    const removed = drop(target);
    if (!removed.ok && fs.existsSync(target)) {
      return {
        ok: false,
        error: removed.error || new Error("the previous folder could not be replaced"),
      };
    }
  }
  try {
    const renamed = renameWithRetry(source, target, { windows });
    if (!renamed.ok) put(source, target);
    return { ok: true };
  } catch (error) {
    if (backup && fs.existsSync(backup)) {
      try {
        put(backup, target);
      } catch {
        /* the caller reports the original error */
      }
    }
    return { ok: false, error };
  }
}

module.exports = {
  DEFAULT_LIMITS,
  destinationFor,
  extractArchiveBuffer,
  extractArchiveFile,
  removeTree,
  renameWithRetry,
  replaceDirectory,
};
