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

/** Record a finished unpack. `bin` is relative to the tool folder, with forward slashes. */
function writeMarker(root, tool, info = {}) {
  if (!root) return false;
  try {
    const dir = toolRoot(root, tool);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({
        id: tool.id,
        version: info.version || tool.pinVersion || null,
        bin: String(info.bin || tool.archiveBin || "").replace(/\\/g, "/"),
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

module.exports = { MARKER, toolDir, toolRoot, readMarker, writeMarker, installedBin };
