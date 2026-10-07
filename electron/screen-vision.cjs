/**
 * FRIDAY · screen awareness (main process)
 *
 * Real desktop capture through Electron's desktopCapturer. Nothing here runs
 * unless the owner has explicitly enabled screen vision, and every capture is
 * recorded so the renderer can show an honest "capture active" indicator.
 *
 * No simulation: if capture is not permitted or fails, the caller gets the
 * real error, never a placeholder image.
 */

const fs = require("fs");
const path = require("path");
const { desktopCapturer, screen } = require("electron");
const paths = require("./friday-paths.cjs");

/**
 * Called by the main process whenever the chosen folder is known or changes.
 * The location itself comes from the one canonical path service.
 */
function setRoot(root) {
  if (root && typeof root === "string") paths.setRoot(root);
  state = null; // re-read from the new location on next access
  return paths.root();
}

const STATE_FILE = () => paths.screenVisionFile();

const DEFAULT_STATE = {
  /** Master switch. Screen capture is impossible while this is false. */
  enabled: false,
  /** Capture the whole screen, a chosen window, or nothing. */
  scope: "screen", // "screen" | "window"
  /** Last capture, for the privacy indicator. */
  lastCaptureAt: null,
  captures: 0,
};

let state = null;

function load() {
  if (state) return state;
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) };
  } catch {
    state = { ...DEFAULT_STATE };
  }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* a settings write failure must never break capture state in memory */
  }
}

function getState() {
  return { ...load() };
}

function setState(patch) {
  load();
  if (typeof patch?.enabled === "boolean") state.enabled = patch.enabled;
  if (patch?.scope === "screen" || patch?.scope === "window") state.scope = patch.scope;
  save();
  return getState();
}

/** The real windows and displays available right now (names only, no pixels). */
async function sources() {
  const current = load();
  if (!current.enabled) return { ok: false, error: "screen vision is disabled" };
  try {
    const found = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return {
      ok: true,
      sources: found.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.startsWith("screen:") ? "screen" : "window",
        displayId: source.display_id || null,
      })),
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * Capture the screen, or one named window, as a PNG data URL.
 * `sourceId` is optional — without it the primary display is used.
 */
async function capture(options = {}) {
  const current = load();
  if (!current.enabled) return { ok: false, error: "screen vision is disabled" };

  try {
    const primary = screen.getPrimaryDisplay();
    const scale = Math.min(1, Number(options.scale) > 0 ? Number(options.scale) : 1);
    const width = Math.round(primary.size.width * scale);
    const height = Math.round(primary.size.height * scale);

    const wanted = options.sourceId ? null : current.scope === "window" ? "window" : "screen";
    const found = await desktopCapturer.getSources({
      types: wanted ? [wanted] : ["screen", "window"],
      thumbnailSize: { width, height },
    });
    if (!found.length) return { ok: false, error: "no capturable source found" };

    const source =
      (options.sourceId && found.find((entry) => entry.id === options.sourceId)) || found[0];
    const image = source.thumbnail;
    if (!image || image.isEmpty()) return { ok: false, error: "capture returned an empty frame" };

    state.lastCaptureAt = Date.now();
    state.captures += 1;
    save();

    const size = image.getSize();
    return {
      ok: true,
      dataUrl: image.toDataURL(),
      source: { id: source.id, name: source.name },
      width: size.width,
      height: size.height,
      at: state.lastCaptureAt,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

module.exports = { getState, setState, sources, capture, setRoot };
