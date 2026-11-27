/**
 * What FRIDAY installed for herself under <FRIDAY folder>\runtime\<tool>.
 *
 * Every unpack writes a small marker next to the files: the version, the
 * executable's path inside the folder and where it came from. The scan reads the
 * marker, so a tool whose folder carries its version (node-v22.23.3-win-x64) is
 * still found after an update moved it, and its installed version is known
 * instead of guessed.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MARKER = ".friday-install.json";

/** Safe folder name for a tool id (same rule the installer uses). */
function toolDir(id) {
  const clean = String(id || "tool").replace(/[^\w.-]+/g, "_");
  return clean || "tool";
}

function toolRoot(root, tool) {
  return path.join(root, "runtime", toolDir(tool?.id));
}

function readMarker(root, tool) {
  if (!root) return null;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(toolRoot(root, tool), MARKER), "utf8"));
    return marker && typeof marker === "object" ? marker : null;
  } catch {
    return null;
  }
}

/** SHA-256 of a file, read in chunks (a program can be large), or "" when it cannot be read. */
function hashFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const hash = crypto.createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      hash.update(chunk.subarray(0, n));
    }
    return hash.digest("hex");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Record a finished unpack. `binSha256` is the program's own hash at that moment, for `verifyBin`. `bin` is relative to the tool folder, with forward slashes. */
function writeMarker(root, tool, info = {}) {
  if (!root) return false;
  try {
    const dir = toolRoot(root, tool);
    fs.mkdirSync(dir, { recursive: true });
    const bin = String(info.bin || tool.archiveBin || "").replace(/\\/g, "/");
    const binSha256 = bin ? hashFile(path.join(dir, ...bin.split("/"))) : "";
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({
        id: tool.id,
        version: info.version || tool.pinVersion || null,
        bin,
        ...(binSha256 ? { binSha256 } : {}),
        url: info.url || tool.installerUrl || null,
        sha256: info.sha256 || tool.sha256 || null,
        at: Date.now(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The installed executable and its version, or null. The marker wins; a folder
 * from before markers existed is found by the tool's pinned path.
 */
function installedBin(root, tool, exists = fs.existsSync) {
  if (!root || !tool) return null;
  const base = toolRoot(root, tool);
  const marker = readMarker(root, tool);
  if (marker?.bin) {
    const bin = path.join(base, ...String(marker.bin).split("/"));
    if (exists(bin)) return { bin, version: marker.version || tool.pinVersion || null, marker };
  }
  if (tool.archiveBin) {
    const bin = path.join(base, ...String(tool.archiveBin).split("/"));
    if (exists(bin)) return { bin, version: tool.pinVersion || null, marker: null };
  }
  return null;
}

/**
 * Whether the program in a FRIDAY-managed folder is still the one the marker recorded. The marker's version is only
 * believed when the program's SHA-256 equals the one stored at install time; a program that was swapped, damaged or
 * installed before hashes were recorded is `ok: false` (so it is installed again, never "reused").
 * `{ ok: true, managed: false }` when FRIDAY has no marked copy of the tool.
 */
function verifyBin(root, tool, hash = hashFile) {
  const found = installedBin(root, tool);
  if (!found?.marker) return { ok: true, managed: false };
  const recorded = String(found.marker.binSha256 || "").toLowerCase();
  if (!recorded) return { ok: false, managed: true, reason: "no program hash was recorded" };
  const actual = String(hash(found.bin) || "").toLowerCase();
  if (actual !== recorded)
    return { ok: false, managed: true, reason: "the program differs from what was installed" };
  return { ok: true, managed: true };
}

module.exports = {
  MARKER,
  toolDir,
  toolRoot,
  readMarker,
  writeMarker,
  installedBin,
  hashFile,
  verifyBin,
};
