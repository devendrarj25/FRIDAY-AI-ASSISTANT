/**
 * FRIDAY · document extract (main process)
 *
 * Reads CSV, XLSX, DOCX and text-based PDFs from real bytes. XLSX/DOCX reuse
 * the ZIP+XML those formats already are — no second parser stack. A scanned
 * or fully compressed PDF that yields no text tries PyMuPDF + Tesseract OCR
 * (Install Manager packages, kernel/document_ocr.py) and only then fails
 * honestly instead of inventing clauses.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { resolveManagedPython } = require("./python.cjs");
const fridayPaths = require("./friday-paths.cjs");

const OCR_SCRIPT = path.join(__dirname, "..", "kernel", "document_ocr.py");
const INVENT_REFUSAL = "I will not invent the missing words.";

function pythonExecutable(workspaceRoot = undefined) {
  const named = process.env.FRIDAY_PYTHON;
  if (named && fs.existsSync(named)) return named;
  const selected =
    workspaceRoot !== undefined ? workspaceRoot : fridayPaths.hasRoot() ? fridayPaths.root() : null;
  if (selected) {
    const workspace = resolveManagedPython(selected);
    if (workspace.exe) return workspace.exe;
  }
  const app = resolveManagedPython(path.join(__dirname, ".."));
  if (app.exe) return app.exe;
  return process.platform === "win32" ? "python" : "python3";
}

function refusePdf(detail) {
  const body = String(detail || "This PDF has no extractable text.")
    .replace(/\s+/g, " ")
    .trim();
  const error = body.endsWith(".") ? `${body} ${INVENT_REFUSAL}` : `${body}. ${INVENT_REFUSAL}`;
  return { text: "", rows: [], error };
}

function ocrPdfFallback(buf) {
  const tmp = path.join(os.tmpdir(), `friday-pdf-ocr-${process.pid}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmp, buf);
    const stdout = execFileSync(pythonExecutable(), [OCR_SCRIPT, tmp], {
      encoding: "utf8",
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const line = String(stdout).trim().split(/\n/).filter(Boolean).pop();
    if (!line) return refusePdf("This PDF has no extractable text and OCR returned nothing");
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return refusePdf("This PDF has no extractable text and OCR output was not readable");
    }
    const text = String(parsed.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (parsed.ok && /[A-Za-z]{3,}/.test(text)) {
      return {
        text,
        rows: [],
        ocr: Boolean(parsed.ocr),
        engine: parsed.engine || "pymupdf",
      };
    }
    return refusePdf(
      parsed.error ||
        "This PDF has no extractable text (it may be scanned or compressed in a way I cannot unpack here) and OCR produced no usable words",
    );
  } catch (error) {
    return refusePdf(
      `This PDF has no extractable text and OCR failed (${String(error.message || error).slice(0, 240)})`,
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp file */
    }
  }
}

function probePdfOcr() {
  try {
    const stdout = execFileSync(pythonExecutable(), [OCR_SCRIPT, "--probe"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const line = String(stdout).trim().split(/\n/).filter(Boolean).pop();
    return line ? JSON.parse(line) : { ok: false };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (typeof bytes === "string") return Buffer.from(bytes, "binary");
  throw new Error("Need file bytes.");
}

function unzip(bytes) {
  const buf = asBuffer(bytes);
  const files = new Map();
  const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06"));
  if (eocd < 0) throw new Error("Not a ZIP archive.");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let cursor = cdOffset;
  for (let i = 0; i < cdEntries; i += 1) {
    if (buf.toString("binary", cursor, cursor + 4) !== "PK\x01\x02") break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressed = buf.readUInt32LE(cursor + 20);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const packed = buf.subarray(dataStart, dataStart + compressed);
    let data = packed;
    if (method === 8) data = zlib.inflateRawSync(packed);
    else if (method !== 0) continue;
    files.set(name.replace(/\\/g, "/"), data);
  }
  return files;
}

const MAX_ARCHIVE_MEMBERS = 40;
const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const TEXT_MEMBER =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|html?|xml|svg|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|bat|cmd|sql)$/i;
const OFFICE_MEMBER = /\.(pdf|docx|xlsx|xlsm)$/i;

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Store-method ZIP so Chat/Library can pack selected items without a second zipper. */
function packZip(files) {
  const entries = Array.isArray(files) ? files : [];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of entries) {
    const name = Buffer.from(String(file.name || "file.txt").replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.write("PK\x03\x04", 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, data]));
    const central = Buffer.alloc(46);
    central.write("PK\x01\x02", 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\x05\x06", 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function parseTar(buf) {
  const files = new Map();
  let offset = 0;
  const body = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  while (offset + 512 <= body.length) {
    const block = body.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const name = block.toString("utf8", 0, 100).replace(/\0.*$/, "").trim();
    const sizeStr = block.toString("ascii", 124, 136).replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(block[156] || 0);
    offset += 512;
    if (name && (typeFlag === "0" || typeFlag === "\0")) {
      files.set(name.replace(/\\/g, "/"), Buffer.from(body.subarray(offset, offset + size)));
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function memberKind(name) {
  if (TEXT_MEMBER.test(name)) return "text";
  if (OFFICE_MEMBER.test(name)) return "office";
  if (/\.zip$/i.test(name)) return "zip";
  return "binary";
}

function unzipCapped(bytes) {
  const buf = asBuffer(bytes);
  const files = new Map();
  const skipped = [];
  const listing = [];
  const eocd = buf.lastIndexOf(Buffer.from("PK\x05\x06"));
  if (eocd < 0) throw new Error("Not a ZIP archive.");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let cursor = cdOffset;
  for (let i = 0; i < cdEntries; i += 1) {
    if (buf.toString("binary", cursor, cursor + 4) !== "PK\x01\x02") break;
    const method = buf.readUInt16LE(cursor + 10);
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString("utf8", cursor + 46, cursor + 46 + nameLen).replace(/\\/g, "/");
    cursor += 46 + nameLen + extraLen + commentLen;
    listing.push(name);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const packed = buf.subarray(dataStart, dataStart + compressed);
    if (uncompressed === 0xffffffff || uncompressed > MAX_MEMBER_BYTES) {
      skipped.push(`${name}: skipped (member larger than 2 MB)`);
      continue;
    }
    if (compressed > 0 && uncompressed / compressed > 80) {
      skipped.push(`${name}: skipped (zip bomb ratio)`);
      continue;
    }
    let data = packed;
    try {
      if (method === 8) {
        data = zlib.inflateRawSync(packed, { maxOutputLength: MAX_MEMBER_BYTES });
      } else if (method !== 0) {
        skipped.push(`${name}: skipped (unsupported zip method ${method})`);
        continue;
      }
    } catch (error) {
      skipped.push(`${name}: skipped (${String(error.message || error).slice(0, 80)})`);
      continue;
    }
    files.set(name, data);
  }
  return { files, skipped, listing };
}

function extractArchive(bytes, { filename = "archive.zip", nested = 0 } = {}) {
  const name = String(filename || "").toLowerCase();
  const skipped = [];
  const members = [];
  const texts = [];
  let total = 0;
  let map;
  let listing = [];
  try {
    if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      map = parseTar(zlib.gunzipSync(asBuffer(bytes), { maxOutputLength: MAX_ARCHIVE_BYTES }));
      listing = [...map.keys()];
    } else {
      const capped = unzipCapped(bytes);
      map = capped.files;
      listing = capped.listing.length ? capped.listing : [...map.keys()];
      skipped.push(...capped.skipped);
    }
  } catch (error) {
    return {
      kind: name.endsWith(".gz") ? "tar.gz" : "zip",
      text: "",
      rows: [],
      members: [],
      skipped: [String(error.message || error)],
      truncated: false,
      error: `${String(error.message || error)} I will not invent the missing files.`,
    };
  }
  texts.push(
    `Archive ${filename} listing (${listing.length} member(s)): ${listing.slice(0, 40).join(", ") || "(empty)"}`,
  );
  for (const [memberName, data] of map.entries()) {
    if (members.length >= MAX_ARCHIVE_MEMBERS) {
      skipped.push(`${memberName}: skipped (member cap ${MAX_ARCHIVE_MEMBERS})`);
      continue;
    }
    const size = data.length;
    if (size > MAX_MEMBER_BYTES) {
      skipped.push(`${memberName}: skipped (member larger than 2 MB)`);
      members.push({ name: memberName, size, skipped: "too large" });
      continue;
    }
    if (total + size > MAX_ARCHIVE_BYTES) {
      skipped.push(`${memberName}: skipped (archive total cap 8 MB)`);
      members.push({ name: memberName, size, skipped: "archive too large" });
      continue;
    }
    total += size;
    const kind = memberKind(memberName);
    if (kind === "zip") {
      if (nested >= 1) {
        skipped.push(`${memberName}: nested zip beyond one level — skipped`);
        members.push({ name: memberName, size, skipped: "nested zip cap" });
        continue;
      }
      const inner = extractArchive(data, { filename: memberName, nested: nested + 1 });
      members.push({ name: memberName, size });
      if (inner.text) texts.push(`--- nested ${memberName} ---\n${inner.text}`);
      skipped.push(...(inner.skipped || []).map((row) => `${memberName}/${row}`));
      continue;
    }
    if (kind === "binary") {
      members.push({ name: memberName, size, skipped: "binary — listed only" });
      skipped.push(`${memberName}: binary — name/size only`);
      continue;
    }
    members.push({ name: memberName, size });
    if (kind === "office") {
      try {
        const nestedDoc = extract({ filename: memberName, bytes: data });
        if (nestedDoc.error) {
          skipped.push(`${memberName}: ${nestedDoc.error}`);
          texts.push(`FILE: ${memberName}\n  Could not extract: ${nestedDoc.error}`);
        } else {
          texts.push(`FILE: ${memberName}\n--- content ---\n${nestedDoc.text || ""}\n--- end ---`);
        }
      } catch (error) {
        skipped.push(`${memberName}: ${String(error.message || error)}`);
      }
      continue;
    }
    const body = data.toString("utf8");
    texts.push(`FILE: ${memberName}\n--- content ---\n${body}\n--- end ---`);
  }
  const text = texts.join("\n\n");
  const truncated = listing.length > members.length || skipped.length > 0;
  return {
    kind: name.endsWith(".gz") ? "tar.gz" : "zip",
    text,
    rows: [],
    members,
    skipped,
    truncated,
    listing,
    error: text.trim() ? undefined : skipped[0] || "This archive produced no extractable text.",
  };
}

function xmlText(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match;
  while ((match = re.exec(String(xml)))) out.push(match[1].replace(/<[^>]+>/g, ""));
  return out;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
    const row = {};
    header.forEach((key, i) => {
      row[key || `col${i}`] = cells[i] || "";
    });
    return row;
  });
}

function parseXlsx(bytes) {
  const files = unzip(bytes);
  const sharedXml = files.get("xl/sharedStrings.xml");
  const shared = sharedXml
    ? xmlText(sharedXml.toString("utf8"), "si").map((block) =>
        decodeXml(xmlText(block, "t").join("") || block.replace(/<[^>]+>/g, "")),
      )
    : [];
  const sheetName =
    [...files.keys()].find((k) => k === "xl/worksheets/sheet1.xml") ||
    [...files.keys()]
      .filter((k) => k.startsWith("xl/worksheets/sheet") && k.endsWith(".xml"))
      .sort()[0];
  const sheetXml = sheetName ? files.get(sheetName) : null;
  if (!sheetXml) throw new Error("This workbook has no sheet I can read.");
  const xml = sheetXml.toString("utf8");
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const v = (body.match(/<v[^>]*>([\s\S]*?)<\/v>/i) || [])[1] || "";
      const isString = /\bt="s"/.test(attrs);
      const inline = /\bt="inlineStr"/.test(attrs);
      let value = decodeXml(v);
      if (isString && shared[Number(v)]) value = shared[Number(v)];
      if (inline) value = decodeXml(xmlText(body, "t").join(""));
      cells.push(value);
    }
    if (cells.some((c) => String(c).trim())) rows.push(cells);
  }
  if (!rows.length) return { sheets: ["sheet1"], rows: [], text: "" };
  const header = rows[0].map((h, i) =>
    String(h || `col${i}`)
      .trim()
      .toLowerCase(),
  );
  const objects = rows.slice(1).map((cells) => {
    const row = {};
    header.forEach((key, i) => {
      row[key || `col${i}`] = String(cells[i] ?? "").trim();
    });
    return row;
  });
  const text = rows.map((r) => r.join("\t")).join("\n");
  return { sheets: ["sheet1"], rows: objects, text };
}

function parseDocx(bytes) {
  const files = unzip(bytes);
  const doc = files.get("word/document.xml");
  if (!doc) throw new Error("This DOCX has no document.xml.");
  const xml = doc.toString("utf8");
  const parts = xmlText(xml, "w:t").map(decodeXml);
  const text = parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!text) throw new Error("This DOCX has no extractable text.");
  return { text, rows: [] };
}

/** True when stream-extracted bytes look like language, not image payload. */
function isCleanPdfText(text) {
  const src = String(text || "");
  if (!/[A-Za-z]{3,}/.test(src)) return false;
  let printable = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable += 1;
  }
  if (src.length && printable / src.length < 0.92) return false;
  const words = src.match(/[A-Za-z]{3,}/g) || [];
  return words.length >= 2;
}

function parsePdf(bytes) {
  const buf = asBuffer(bytes);
  const raw = buf.toString("latin1");
  const chunks = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(raw))) {
    const blob = Buffer.from(match[1], "latin1");
    let text = blob.toString("latin1");
    try {
      text = zlib.inflateSync(blob).toString("utf8");
    } catch {
      try {
        text = zlib.inflateRawSync(blob).toString("utf8");
      } catch {
        /* keep latin1 */
      }
    }
    chunks.push(text);
  }
  const hay = `${raw}\n${chunks.join("\n")}`;
  const strings = [];
  const paren = /\((?:\\.|[^\\)]){2,200}\)/g;
  let hit;
  while ((hit = paren.exec(hay))) {
    const inner = hit[0].slice(1, -1).replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
    if (isCleanPdfText(inner)) strings.push(inner);
  }
  const tj = /\[((?:[^\]]|\n){0,800})\]\s*TJ/g;
  while ((hit = tj.exec(hay))) {
    const parts = [...String(hit[1]).matchAll(/\((?:\\.|[^\\)])*\)/g)].map((m) =>
      m[0].slice(1, -1).replace(/\\(.)/g, "$1"),
    );
    const joined = parts.join("");
    if (isCleanPdfText(joined)) strings.push(joined);
  }
  const text = strings.join(" ").replace(/\s+/g, " ").trim();
  if (isCleanPdfText(text)) return { text, rows: [], ocr: false, engine: "pdf-stream" };
  return ocrPdfFallback(buf);
}

function extract({ filename = "", text = "", bytes = null } = {}) {
  const name = String(filename || "").toLowerCase();
  if (text && !bytes) {
    if (/,/.test(text) && /\n/.test(text)) return { kind: "csv", text, rows: parseCsv(text) };
    return { kind: "text", text: String(text), rows: [] };
  }
  if (!bytes)
    return { kind: "empty", text: "", rows: [], error: "No document bytes or text were given." };
  if (name.endsWith(".csv") || name.endsWith(".tsv")) {
    const body = asBuffer(bytes).toString("utf8");
    return { kind: "csv", text: body, rows: parseCsv(body) };
  }
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const sheet = parseXlsx(bytes);
    return { kind: "xlsx", ...sheet };
  }
  if (name.endsWith(".docx")) return { kind: "docx", ...parseDocx(bytes) };
  if (name.endsWith(".pdf")) return { kind: "pdf", ...parsePdf(bytes) };
  if (name.endsWith(".txt") || name.endsWith(".md")) {
    const body = asBuffer(bytes).toString("utf8");
    return { kind: "text", text: body, rows: [] };
  }
  if (name.endsWith(".zip") || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    return extractArchive(bytes, { filename: name });
  }
  return {
    kind: "unknown",
    text: "",
    rows: [],
    error: `I do not extract “${name || "this type"}” yet.`,
  };
}

module.exports = {
  unzip,
  packZip,
  parseTar,
  extractArchive,
  parseCsv,
  parseXlsx,
  parseDocx,
  parsePdf,
  extract,
  probePdfOcr,
  pythonExecutable,
};
